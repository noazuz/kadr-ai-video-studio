import logging
import shutil
import subprocess
from contextlib import nullcontext
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit
from urllib.error import URLError
from urllib.request import urlopen

import imageio_ffmpeg
import httpx
import replicate
from replicate.exceptions import ModelError, ReplicateError
from django.conf import settings
from django.core.files import File
from django.utils import timezone

from .library import ACTIVE_GENERATION_STATUSES, SEGMENT_SECONDS, refund
from .models import Generation
from .replicate_credentials import replicate_token
from .soundtrack import MUSIC, RenderInputError, music_loop, narrate, write_captions

logger = logging.getLogger(__name__)
MODEL = "prunaai/p-video"
FPS = 24
SAMPLE_RATE = 48000
SIZES = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (720, 720)}


def segment_lengths(duration):
    return [min(SEGMENT_SECONDS, duration - start) for start in range(0, duration, SEGMENT_SECONDS)]


def ffmpeg(*args, cwd=None):
    return subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-filter_threads", "2", "-filter_complex_threads", "2", *map(str, args)],
        check=True, capture_output=True, timeout=300, cwd=cwd,
    ).stdout


def frame_geometry(ratio):
    width, height = SIZES[ratio]
    return (f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},setsar=1")


def video_filter(duration, ratio):
    return (f"fps={FPS},tpad=stop_mode=clone:stop_duration={duration},"
            f"trim=end_frame={duration * FPS},setpts=N/({FPS}*TB),{frame_geometry(ratio)},format=yuv420p")


def last_frame(source, target, duration, ratio):
    ffmpeg("-i", source, "-vf", video_filter(duration, ratio) + f",select=eq(n\\,{duration * FPS - 1})",
           "-frames:v", "1", "-update", "1", target)
    if not target.exists():
        raise ValueError("Video has no final frame")


def stitch(clips, output, ratio):
    inputs, filters, streams = [], [], []
    for path, _ in clips:
        inputs.extend(["-i", path])
    next_input = len(clips)
    for index, (path, duration) in enumerate(clips):
        audio_index = index
        try:
            ffmpeg("-i", path, "-map", "0:a:0", "-t", "0.01", "-f", "null", "-")
        except subprocess.CalledProcessError as exc:
            if b"matches no streams" not in exc.stderr:
                raise
            inputs.extend(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"])
            audio_index = next_input
            next_input += 1
        filters.extend([
            f"[{index}:v:0]{video_filter(duration, ratio)}[v{index}]",
            f"[{audio_index}:a:0]aresample={SAMPLE_RATE}:async=1:first_pts=0,"
            f"aformat=sample_fmts=fltp:channel_layouts=stereo,apad,"
            f"atrim=end_sample={duration * SAMPLE_RATE},asetpts=N/SR/TB,"
            f"afade=t=in:d=0.015,afade=t=out:st={duration - 0.015:.3f}:d=0.015[a{index}]",
        ])
        streams.append(f"[v{index}][a{index}]")
    filters.append("".join(streams) + f"concat=n={len(clips)}:v=1:a=1[v][a]")
    ffmpeg(*inputs, "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-threads", "4", "-preset", "veryfast", "-crf", "20",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output)


def download_video(result, target):
    url = str(getattr(result, "url", result))
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not (
        parsed.hostname == "replicate.delivery" or (parsed.hostname or "").endswith(".replicate.delivery")
    ):
        raise ValueError("Invalid Replicate output URL")
    for attempt in range(2):
        try:
            with urlopen(url, timeout=60) as source, target.open("wb") as destination:
                shutil.copyfileobj(source, destination)
            return
        except OSError:
            if attempt == 1:
                raise


def predict_segment(client, inputs):
    try:
        return client.run(MODEL, input=inputs, wait=False)
    except ModelError as exc:
        if not any(marker in str(exc).lower() for marker in ("temporarily unavailable", "timed out", "internal server error")):
            raise
        image = inputs.get("image")
        if hasattr(image, "seek"):
            image.seek(0)
        return client.run(MODEL, input=inputs, wait=False)


def segment_prompt(project, offset, duration, total, has_image):
    words = project["script"].split()
    text = " ".join(words[len(words) * offset // total:len(words) * (offset + duration) // total])
    tone = {"Натхненний": "inspiring", "Інформативний": "documentary", "Розмовний": "conversational"}
    framing = "Continue naturally from the starting frame." if has_image else "Establish the scene from the visual description."
    return (
        f"{project['topic']}. Visual style: {tone[project['tone']]}. "
        f"Show the meaning of this narration without speaking it: {text[:1500]}. "
        f"Visual reference keywords: {', '.join(project['tags'])[:200]}. "
        f"{framing} Time in story: {offset}–{offset + duration} seconds. "
        "Generate only natural ambient sound. No speech or music."
    )


MATERIAL_FORMATS = {
    ".jpg": ("image", "image2"), ".jpeg": ("image", "image2"), ".png": ("image", "image2"),
    ".webp": ("image", "image2"), ".mp4": ("video", "mov"), ".webm": ("video", "matroska"),
    ".mp3": ("audio", "mp3"), ".wav": ("audio", "wav"),
}


def material_paths(job, directory):
    for row in job.materials.order_by("pk"):
        suffix = Path(row.file.name).suffix.lower()
        kind, demuxer = MATERIAL_FORMATS[suffix]
        path = directory / f"material-{row.pk}{suffix}"
        with row.file.open("rb") as source, path.open("wb") as output:
            shutil.copyfileobj(source, output)
        options = ["-pattern_type", "none"] if kind == "image" else []
        stream = ["-map", "0:a:0", "-t", "0.1"] if kind == "audio" else ["-map", "0:v:0", "-frames:v", "1"]
        try:
            ffmpeg("-xerror", "-protocol_whitelist", "file,pipe", "-f", demuxer, *options, "-i", path,
                   *stream, "-f", "null", "-")
        except subprocess.CalledProcessError as exc:
            raise RenderInputError("Один із доданих матеріалів має некоректний формат або пошкоджений.") from exc
        yield kind, demuxer, path


def finish_video(job, directory, source, narration, tempo, captions, materials):
    output = directory / "result.mp4"
    inputs = ["-i", source]
    filters = []
    audio = []
    video = "0:v:0"
    index = 1
    if narration:
        inputs.extend(["-i", narration])
        filters.append(f"[{index}:a:0]atempo={tempo:.8f},apad[a{index}]")
        audio.append(f"[a{index}]")
        index += 1
    tracks = [path for kind, _, path in materials if kind == "audio"]
    preset = job.project["music"]
    if preset in MUSIC and job.project["musicVolume"] > 0:
        path = directory / "music.wav"
        music_loop(preset, path)
        tracks.append(path)
    volume = job.project["musicVolume"] / 100
    for path in tracks:
        inputs.extend(["-stream_loop", "-1", "-protocol_whitelist", "file,pipe",
                       "-f", MATERIAL_FORMATS[path.suffix][1], "-i", path])
        filters.append(f"[{index}:a:0]volume={volume / len(tracks):.6f}[a{index}]")
        audio.append(f"[a{index}]")
        index += 1
    visuals = [(kind, demuxer, path) for kind, demuxer, path in materials if kind != "audio"]
    total_frames = job.duration * FPS
    span = max(1, total_frames // (len(visuals) + 1) // 2)
    for position, (kind, demuxer, path) in enumerate(visuals, 1):
        start = total_frames * position // (len(visuals) + 1)
        loop = ["-loop", "1", "-pattern_type", "none", "-framerate", str(FPS)] if kind == "image" else ["-stream_loop", "-1"]
        inputs.extend([*loop, "-protocol_whitelist", "file,pipe", "-f", demuxer, "-i", path])
        filters.extend([
            f"[{index}:v:0]{frame_geometry(job.aspect_ratio)},fps={FPS},trim=end_frame={span},"
            f"setpts=PTS-STARTPTS+{start}/{FPS}/TB[x{index}]",
            f"[{video}][x{index}]overlay=enable='between(n,{start + 1},{start + span})':eof_action=pass[v{index}]",
        ])
        video = f"v{index}"
        index += 1
    if captions and job.project["subtitles"]:
        write_captions(directory / "captions.ass", captions, tempo, *SIZES[job.aspect_ratio])
        filters.append(f"[{video}]ass=captions.ass[captioned]")
        video = "captioned"
    if audio:
        if not narration:
            filters.append("[0:a:0]volume=0.7[ambient]")
            audio.insert(0, "[ambient]")
        filters.append("".join(audio) +
                       f"amix=inputs={len(audio)}:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]")
    if not filters:
        return source
    video_options = ["-map", "0:v:0", "-c:v", "copy"] if video == "0:v:0" else [
        "-map", f"[{video}]", "-c:v", "libx264", "-threads", "4", "-preset", "veryfast", "-crf", "20",
    ]
    audio_options = ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] if audio else ["-map", "0:a:0", "-c:a", "copy"]
    ffmpeg(*inputs, "-filter_complex", ";".join(filters), *video_options, *audio_options,
           "-t", job.duration, "-movflags", "+faststart", output, cwd=directory)
    return output


def render(job, directory):
    narration = None
    tempo, captions = 1, []
    if job.project["script"].strip():
        narration = directory / "narration.wav"
        tempo, captions = narrate(job.project, job.duration, narration)
    materials = list(material_paths(job, directory))
    client = replicate.Client(api_token=replicate_token())
    image = job.source_url
    if job.source_image:
        suffix = Path(job.source_image.name).suffix.lower()
        still = directory / f"source{suffix}"
        with job.source_image.open("rb") as source, still.open("wb") as output:
            shutil.copyfileobj(source, output)
        image = directory / "first.png"
        decoder = {".png": "png", ".webp": "webp"}.get(suffix, "mjpeg")
        ffmpeg("-f", "image2", "-pattern_type", "none", "-c:v", decoder, "-i", still,
               "-vf", frame_geometry(job.aspect_ratio), "-frames:v", "1", "-update", "1", image)

    clips = []
    offset = 0
    lengths = segment_lengths(job.duration)
    if not Generation.objects.filter(pk=job.pk, status="preparing").update(status="running", updated_at=timezone.now()):
        raise RuntimeError("Generation expired before the first clip")
    for index, duration in enumerate(lengths):
        prompt = segment_prompt(job.project, offset, duration, job.duration, bool(image))
        with image.open("rb") if isinstance(image, Path) else nullcontext(image) as image_input:
            result = predict_segment(client, {
                "prompt": prompt, "duration": duration,
                **({"image": image_input} if image_input else {}),
                "resolution": "720p", "draft": True, "fps": FPS,
                "aspect_ratio": job.aspect_ratio, "prompt_upsampling": False,
                "seed": job.pk.int % (2**31),
            })
        clip = directory / f"clip-{index}.mp4"
        download_video(result, clip)
        clips.append((clip, duration))
        offset += duration
        if index + 1 < len(lengths):
            image = directory / f"frame-{index}.png"
            last_frame(clip, image, duration, job.aspect_ratio)
        if not Generation.objects.filter(pk=job.pk, status="running").update(
            segments_done=index + 1, updated_at=timezone.now(),
        ):
            raise RuntimeError("Generation expired")

    output = directory / "stitched.mp4"
    stitch(clips, output, job.aspect_ratio)
    return finish_video(job, directory, output, narration, tempo, captions, materials)


def clean_inputs(job, directory):
    try:
        if job.source_image:
            job.source_image.delete(save=False)
    except OSError:
        logger.warning("Could not delete input for %s", job.pk)
    Generation.objects.filter(pk=job.pk).update(source_image="", source_url="")
    for material in job.materials.all():
        try:
            material.file.delete(save=False)
        except OSError:
            logger.warning("Could not delete material for %s", job.pk)
    job.materials.all().delete()
    shutil.rmtree(directory, ignore_errors=True)


def failure_message(exc):
    if isinstance(exc, RenderInputError):
        return str(exc)
    if isinstance(exc, ReplicateError):
        status = exc.status
        if status == 402 or "insufficient credit" in str(exc).lower():
            return "На спільному рахунку Replicate недостатньо коштів."
        if status == 401:
            return "Replicate відхилив токен (401). Перевір, який токен використовує воркер."
        if status == 403:
            return "Replicate відхилив доступ до генерації (403)."
        if status in (400, 422):
            return f"Replicate не прийняв параметри генерації ({status})."
        if status == 429:
            return "Replicate тимчасово обмежив кількість запитів (429)."
        return f"Replicate повернув помилку ({status})." if status else "Replicate повернув помилку під час запиту."
    if isinstance(exc, ModelError):
        return "P-Video прийняла завдання, але не завершила генерацію."
    if isinstance(exc, httpx.TransportError):
        return "Воркер не зміг встановити зв’язок із Replicate."
    if isinstance(exc, URLError):
        return "Не вдалося завантажити згенерований кліп із Replicate."
    if isinstance(exc, (subprocess.CalledProcessError, subprocess.TimeoutExpired)):
        return "Не вдалося обробити відео через FFmpeg."
    return "Не вдалося завершити відео. Резерв повернено на баланс."


def process_next():
    work_root = Path(settings.MEDIA_ROOT) / "render-work"
    stale_before = timezone.now() - timedelta(hours=1)
    for expired in Generation.objects.filter(status__in=ACTIVE_GENERATION_STATUSES, updated_at__lt=stale_before):
        if refund(expired, "Генерацію перервано. Резерв повернено на баланс.", stale_before=stale_before):
            clean_inputs(expired, work_root / str(expired.pk))
    key = Generation.objects.filter(status="queued").order_by("updated_at", "pk").values_list("pk", flat=True).first()
    if not key or not Generation.objects.filter(pk=key, status="queued").update(status="preparing", updated_at=timezone.now()):
        return False
    job = Generation.objects.get(pk=key)
    directory = work_root / str(job.pk)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        output = render(job, directory)
        with output.open("rb") as handle:
            job.file.save(f"{job.pk}.mp4", File(handle), save=False)
        now = timezone.now()
        if not Generation.objects.filter(pk=job.pk, status__in=ACTIVE_GENERATION_STATUSES).update(
            file=job.file.name, completed_at=now, status="completed", updated_at=now,
        ):
            raise RuntimeError("Generation expired before saving")
    except (Exception, KeyboardInterrupt) as exc:
        logger.warning("Video render %s failed: %s (status=%s)", key, type(exc).__name__,
                       getattr(exc, "status", getattr(exc, "code", None)))
        if isinstance(exc, RenderInputError):
            logger.warning("%s", exc)
        if isinstance(exc, subprocess.CalledProcessError):
            logger.warning("FFmpeg: %s", exc.stderr.decode(errors="replace")[-1000:])
        refund(job, failure_message(exc))
        if job.file:
            job.file.delete(save=False)
        if isinstance(exc, KeyboardInterrupt):
            raise
    finally:
        clean_inputs(job, directory)
    return True
