
import json
from pathlib import Path
from urllib.parse import urlsplit

from django.db import transaction
from django.http import HttpResponse, JsonResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET
from rest_framework.decorators import api_view

from .accounts import error, profile_for
from .library import job_data, reserve
from .models import GenerationMaterial
from .replicate_credentials import replicate_token
from .soundtrack import (
    LONG_SCRIPT_MESSAGE, MAX_NARRATION_TEMPO, MUSIC, VOICES, RenderInputError,
    estimated_narration_seconds, voice_sample,
)


@require_GET
def preview_voice(request):
    voice = request.GET.get("voice", "")
    try:
        rate = int(request.GET.get("rate", ""))
    except ValueError:
        return error("Перевір налаштування голосу.")
    if voice not in VOICES or not 7 <= rate <= 13:
        return error("Перевір налаштування голосу.")
    try:
        return HttpResponse(voice_sample(voice, rate / 10), content_type="audio/wav")
    except RenderInputError as exc:
        return error(str(exc), 503)


@never_cache
@api_view(["POST"])
def generate_video_api(request):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    data = request.data
    project = project_from(data)
    if project is None:
        return error("Перевір тему, сценарій і параметри проєкту.")
    try:
        duration = int(data.get("duration"))
    except (TypeError, ValueError, OverflowError):
        duration = 0
    if 1 <= duration <= 60 and estimated_narration_seconds(project["script"], project["rate"]) > duration * MAX_NARRATION_TEMPO:
        return error(LONG_SCRIPT_MESSAGE)
    materials = request.FILES.getlist("materials")
    extensions = {".jpg", ".jpeg", ".png", ".webp", ".mp4", ".webm", ".mp3", ".wav"}
    if len(materials) > 12 or sum(item.size for item in materials) > 100 * 1024 * 1024 or any(
        Path(item.name).suffix.lower() not in extensions or not 0 < item.size <= 30 * 1024 * 1024
        for item in materials
    ):
        return error("Додай до 12 матеріалів, до 30 МБ кожен і до 100 МБ разом.")
    image = request.FILES.get("image")
    image_url = data.get("image_url", "")
    if image:
        suffix = Path(image.name).suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png", ".webp"} or not 0 < image.size <= 10 * 1024 * 1024:
            return error("Обери зображення JPG, PNG або WebP розміром до 10 МБ.")
    elif image_url != "":
        if not isinstance(image_url, str) or len(image_url) > 2048:
            return error("Некоректне посилання на стартове фото.")
        try:
            parsed = urlsplit(image_url)
            valid_url = parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password
        except ValueError:
            valid_url = False
        if not valid_url:
            return error("Некоректне посилання на стартове фото.")
    if not replicate_token():
        return error("Збережи токен Replicate через scripts/set-replicate-token.ps1 або налаштуй REPLICATE_API_TOKEN на сервері.", 503)

    with transaction.atomic():
        job, rejection = reserve(owner, data.get("quote_id"), data.get("duration"), data.get("aspect_ratio"))
        if rejection is not None:
            return rejection
        job.project = project
        job.project["useStartImage"] = bool(image or image_url)
        job.expense_title = project["title"]
        if image:
            job.source_image.save(f"{job.pk}{suffix}", image, save=False)
        else:
            job.source_url = image_url
        job.save(update_fields=["project", "expense_title", "source_image", "source_url", "updated_at"])
        for index, upload in enumerate(materials):
            item = GenerationMaterial(job=job)
            item.file.save(f"{job.pk}-{index}{Path(upload.name).suffix.lower()}", upload)
    return JsonResponse(job_data(job), status=202)


def project_from(data):
    topic = data.get("topic", "")
    script = data.get("script", "")
    if not isinstance(topic, str) or not isinstance(script, str) or not 5 <= len(topic.strip()) <= 2000 or len(script) > 20000:
        return None
    try:
        media_ids = json.loads(data.get("media_ids", "[]"))
        tags = json.loads(data.get("tags", "[]"))
        rate = float(data.get("rate", 1))
        volume = float(data.get("music_volume", 50))
    except (ValueError, TypeError):
        return None
    if not all(isinstance(items, list) and all(isinstance(item, str) for item in items) for items in (tags, media_ids)):
        return None
    if not 0.7 <= rate <= 1.3 or not 0 <= volume <= 100:
        return None
    tone = data.get("tone", "Натхненний")
    voice, music = data.get("voice", "Остап"), data.get("music", "Без музики")
    if (tone not in ("Натхненний", "Інформативний", "Розмовний")
            or not isinstance(voice, str) or voice not in VOICES
            or not isinstance(music, str) or music not in (MUSIC.keys() | {"Без музики"})):
        return None
    return {
        "title": topic.strip()[:70], "topic": topic.strip(), "script": script, "tone": tone, "voice": voice,
        "music": music, "rate": rate, "musicVolume": volume, "mediaIds": media_ids[:100],
        "tags": tags[:10], "subtitles": data.get("subtitles") in (True, "true"),
    }
