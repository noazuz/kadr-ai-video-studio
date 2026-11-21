import math
import json
import os
import re
import wave
from array import array
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from textwrap import wrap

from django.conf import settings

VOICES = {"Остап": "uk_UA-mykyta-high", "Поліна": "uk_UA-tetiana-high"}
ESTIMATED_WORDS_PER_SECOND = 2.2
MAX_NARRATION_TEMPO = 1.4
LONG_SCRIPT_MESSAGE = "Сценарій задовгий для обраної тривалості. Скороти його або додай секунд."
MUSIC = {
    "Спокійна атмосфера": (2.0, (48, 55, 52, 57), 0.3),
    "Натхненний ритм": (0.4, (48, 60, 55, 60, 50, 62, 57, 62), 3.5),
    "Легкий акустичний фон": (0.65, (48, 55, 60, 64, 45, 52, 57, 60), 2.2),
}


class RenderInputError(ValueError):
    pass


def estimated_narration_seconds(script, rate):
    return len(script.split()) / (ESTIMATED_WORDS_PER_SECOND * rate)


@lru_cache(maxsize=2)
def load_voice(path):
    import onnxruntime
    from piper import PiperVoice
    from piper.config import PiperConfig
    if not path.is_file() or not path.with_suffix(".onnx.json").is_file():
        raise RenderInputError("Локальні голоси ще не встановлено. Попроси адміністратора налаштувати озвучку.")
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_BASIC
    session = onnxruntime.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
    config = PiperConfig.from_dict(json.loads(path.with_suffix(".onnx.json").read_text(encoding="utf-8")))
    return PiperVoice(session, config)


def narrate(project, duration, path):
    from piper import SynthesisConfig

    folder = Path(os.environ.get("KADR_VOICES_DIR") or Path(settings.MEDIA_ROOT) / "voices")
    voice = load_voice(folder / (VOICES[project["voice"]] + ".onnx"))
    config = SynthesisConfig(length_scale=1 / project["rate"])
    sample_rate = voice.config.sample_rate
    max_samples = duration * sample_rate * MAX_NARRATION_TEMPO
    captions = []
    cursor = 0
    script = re.sub(r"\s+", " ", project["script"]).strip()
    with wave.open(str(path) if isinstance(path, Path) else path, "wb") as audio:
        audio.setparams((1, 2, sample_rate, 0, "NONE", "not compressed"))
        for sentence in re.split(r"(?<=[.!?…]) +", script):
            for phrase in wrap(sentence, width=72, break_long_words=False, break_on_hyphens=False):
                start = cursor
                for chunk in voice.synthesize(phrase, config):
                    raw = chunk.audio_int16_bytes
                    cursor += len(raw) // 2
                    if cursor > max_samples:
                        raise RenderInputError(LONG_SCRIPT_MESSAGE)
                    audio.writeframesraw(raw)
                if cursor > start:
                    captions.append((start / sample_rate, cursor / sample_rate, phrase))
    if not cursor:
        raise RenderInputError("Не вдалося озвучити сценарій.")
    tempo = max(1.0, cursor / sample_rate / duration)
    return tempo, captions


@lru_cache(maxsize=14)
def voice_sample(voice, rate):
    target = BytesIO()
    narrate({
        "voice": voice, "rate": rate,
        "script": "Привіт! Це Кадр. Так звучатиме мій голос у твоєму відео.",
    }, 12, target)
    return target.getvalue()


def music_loop(preset, path):
    beat, notes, decay = MUSIC[preset]
    rate = 24000
    samples = array("h")
    for note in notes:
        frequency = 440 * 2 ** ((note - 69) / 12)
        for i in range(round(beat * rate)):
            t = i / rate
            envelope = min(1, t / 0.025, (beat - t) / 0.035) * math.exp(-decay * t)
            tone = math.sin(math.tau * frequency * t) + 0.3 * math.sin(math.tau * frequency * 1.5 * t)
            samples.append(round(4200 * envelope * tone))
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(samples.tobytes())


def ass_time(seconds):
    seconds = round(seconds * 100)
    minutes, ticks = divmod(seconds, 6000)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{ticks // 100:02d}.{ticks % 100:02d}"


def write_captions(path, captions, tempo, width, height):
    header = (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Default,Arial,36,&H00FFFFFF,&H00FFFFFF,&H00111111,&H77111111,"
        "-1,0,0,0,100,100,0,0,1,3,1,2,36,36,50,1\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = []
    for start, end, text in captions:
        text = text.replace("\\", "＼").replace("{", "(").replace("}", ")")
        lines.append(f"Dialogue: 0,{ass_time(start / tempo)},{ass_time(end / tempo)},Default,,0,0,0,,{text}\n")
    path.write_text(header + "".join(lines), encoding="utf-8-sig")
