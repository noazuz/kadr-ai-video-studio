from datetime import timedelta
from subprocess import SubprocessError
from uuid import UUID

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F, Q
from django.http import FileResponse, HttpResponse, JsonResponse, StreamingHttpResponse
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods, require_POST

from .accounts import error, fields, profile_for, string, validated
from .models import AccountProfile, Generation
from .posters import first_frame, poster_path

FORMATS = {"9:16", "16:9", "1:1"}
SEGMENT_SECONDS = 10
ACTIVE_GENERATION_STATUSES = ("preparing", "running")


def price_for(duration):
    return (duration * settings.GENERATION_PRICE_MILLS_PER_SECOND + 9) // 10


@never_cache
@require_POST
@validated
def quote(request):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    body = fields(request)
    requested = body.get("duration")
    ratio = string(body, "aspect_ratio")
    if type(requested) is not int or not 1 <= requested <= 60 or ratio not in FORMATS:
        return error("Перевір тривалість і формат відео.")
    generation = Generation.objects.create(
        owner=owner, requested_duration=requested, aspect_ratio=ratio,
        duration=requested, price_cents=price_for(requested),
    )
    return JsonResponse({
        "quote_id": str(generation.pk), "price_cents": generation.price_cents,
        "balance_cents": owner.balance_cents, "duration": generation.duration, "account_id": str(owner.user_id),
    })


def reserve(owner, quote_id, duration, ratio):
    try:
        key, requested = UUID(quote_id), int(duration)
    except (TypeError, ValueError, AttributeError):
        return None, error("Отримай актуальну ціну генерації.", 409)
    with transaction.atomic():
        scoped = Generation.objects.filter(pk=key, owner=owner, requested_duration=requested, aspect_ratio=ratio)
        claimed = scoped.filter(
            status="quoted", duration=requested, price_cents=price_for(requested),
            created_at__gte=timezone.now() - timedelta(minutes=15),
        ).update(status="queued")
        job = scoped.first()
        if not claimed:
            if job and job.status in ("queued", *ACTIVE_GENERATION_STATUSES, "completed") and not job.hidden:
                return None, JsonResponse(job_data(job), status=200 if job.status == "completed" else 202)
            return None, error("Генерація вже обробляється або ціна застаріла. Онови ціну.", 409)
        balance = AccountProfile.objects.filter(pk=owner.pk, balance_cents__gte=job.price_cents)
        if not balance.update(balance_cents=F("balance_cents") - job.price_cents):
            scoped.update(status="quoted")
            return None, error("Недостатньо коштів на балансі акаунта.", 402)
    return job, None


def refund(job, detail, stale_before=None):
    running = Generation.objects.filter(pk=job.pk, status__in=ACTIVE_GENERATION_STATUSES)
    if stale_before is not None:
        running = running.filter(updated_at__lt=stale_before)
    with transaction.atomic():
        if running.update(status="failed", failure_detail=detail, updated_at=timezone.now()):
            AccountProfile.objects.filter(pk=job.owner_id).update(balance_cents=F("balance_cents") + job.price_cents)
            return True
    return False


def project_data(job):
    return {
        **job.project, "id": str(job.pk), "status": "ready", "duration": job.duration,
        "format": job.aspect_ratio, "createdAt": job.completed_at.isoformat(),
        "updatedAt": job.updated_at.isoformat(), "videoUrl": reverse("video_file", args=[job.pk]),
        "posterUrl": reverse("video_poster", args=[job.pk]),
    }


def job_data(job):
    data = {
        "id": str(job.pk), "status": job.status, "segments_done": job.segments_done,
        "segments_total": (job.duration + SEGMENT_SECONDS - 1) // SEGMENT_SECONDS,
    }
    if job.status == "completed":
        data["project"] = project_data(job)
    if job.status == "failed":
        data["detail"] = job.failure_detail
    return data


@never_cache
@require_http_methods(["GET"])
def generation_job(request, pk):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    job = Generation.objects.filter(owner=owner, pk=pk, hidden=False,
                                    status__in=("queued", *ACTIVE_GENERATION_STATUSES, "failed", "completed")).first()
    if job is None:
        return error("Завдання не знайдено.", 404)
    return JsonResponse(job_data(job))


@never_cache
@require_http_methods(["GET"])
def expenses(request):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    records = Generation.objects.filter(owner=owner, status="completed", price_cents__gt=0)
    cursor = request.GET.get("cursor")
    if cursor:
        try:
            anchor = records.get(pk=UUID(cursor))
        except (ValueError, Generation.DoesNotExist):
            return error("Некоректна сторінка витрат.")
        records = records.filter(Q(completed_at__lt=anchor.completed_at) |
                                 Q(completed_at=anchor.completed_at, pk__lt=anchor.pk))
    page = list(records.order_by("-completed_at", "-pk")[:21])
    return JsonResponse({
        "account_id": str(owner.user_id), "results": [{
            "id": str(job.pk), "created_at": job.completed_at.isoformat(),
            "project_title": job.expense_title or None, "amount_cents": job.price_cents,
        } for job in page[:20]],
        "next_cursor": str(page[19].pk) if len(page) > 20 else None,
    })


def visible_videos(owner):
    return Generation.objects.filter(owner=owner, status="completed", hidden=False)


@never_cache
@require_http_methods(["GET"])
def videos(request):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    return JsonResponse({
        "account_id": str(owner.user_id),
        "results": [project_data(job) for job in visible_videos(owner).order_by("-completed_at")],
    })


@never_cache
@require_http_methods(["PATCH", "DELETE"])
@validated
def video_detail(request, pk):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    job = visible_videos(owner).filter(pk=pk).first()
    if job is None:
        return error("Відео не знайдено.", 404)
    if request.method == "DELETE":
        job.hidden = True
        job.save(update_fields=["hidden", "updated_at"])
        if job.file:
            poster = poster_path(job.file)
            job.file.delete(save=False)
            poster.unlink(missing_ok=True)
        return HttpResponse(status=204)
    title = string(fields(request), "title").strip()
    if not 1 <= len(title) <= 70:
        raise ValidationError("Введи назву довжиною від 1 до 70 символів.")
    job.project["title"] = title
    job.save(update_fields=["project", "updated_at"])
    return JsonResponse(project_data(job))


@never_cache
@require_http_methods(["GET", "HEAD"])
def video_poster(request, pk):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    job = visible_videos(owner).filter(pk=pk).first()
    if job is None or not job.file:
        return error("Відео не знайдено.", 404)
    try:
        frame = first_frame(job.file)
    except (OSError, SubprocessError):
        return error("Не вдалося отримати перший кадр відео.", 404)
    return HttpResponse(frame, content_type="image/jpeg", headers={"Cross-Origin-Resource-Policy": "same-origin"})


def read_range(file, start, length):
    with file.open("rb") as handle:
        handle.seek(start)
        while length:
            chunk = handle.read(min(length, 64 * 1024))
            if not chunk:
                return
            length -= len(chunk)
            yield chunk


@never_cache
@require_http_methods(["GET", "HEAD"])
def video_file(request, pk):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    job = visible_videos(owner).filter(pk=pk).first()
    if job is None:
        return error("Відео не знайдено.", 404)
    try:
        size = job.file.size
    except FileNotFoundError:
        return error("Відео не знайдено.", 404)
    byte_range = request.headers.get("Range", "")
    if not byte_range.startswith("bytes=") or "," in byte_range:
        try:
            response = FileResponse(job.file.open("rb"), content_type="video/mp4", filename="video.mp4")
        except FileNotFoundError:
            return error("Відео не знайдено.", 404)
    else:
        first, _, last = byte_range[6:].partition("-")
        try:
            start = int(first) if first else max(0, size - int(last))
            end = min(int(last), size - 1) if first and last else size - 1
            if "-" not in byte_range[6:] or not 0 <= start <= end:
                raise ValueError
        except ValueError:
            return HttpResponse(status=416, headers={"Content-Range": f"bytes */{size}"})
        length = end - start + 1
        response = StreamingHttpResponse(read_range(job.file, start, length), status=206, content_type="video/mp4")
        response["Content-Range"] = f"bytes {start}-{end}/{size}"
        response["Content-Length"] = length
    response["Accept-Ranges"] = "bytes"
    response["Cross-Origin-Resource-Policy"] = "same-origin"
    return response
