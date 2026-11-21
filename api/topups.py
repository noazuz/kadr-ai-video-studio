from uuid import UUID

from django.db import transaction
from django.db.models import F
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods, require_POST

from .accounts import error, fields, profile_for, string, validated
from .models import AccountProfile, TopUpRequest


def entry_data(entry):
    return {
        "id": str(entry.pk), "amount_cents": entry.amount_cents, "status": entry.status,
        "created_at": entry.created_at.isoformat(),
        "resolved_at": entry.resolved_at.isoformat() if entry.resolved_at else None,
    }


@never_cache
@require_http_methods(["GET", "POST"])
@validated
def requests(request):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    own_requests = TopUpRequest.objects.filter(owner=owner)
    if request.method == "GET":
        cursor = request.GET.get("cursor")
        if cursor:
            try:
                pk = int(cursor)
                if not 0 < pk < 2**63 or not own_requests.filter(pk=pk).exists():
                    raise ValueError
            except ValueError:
                return error("Некоректна сторінка заявок.")
            own_requests = own_requests.filter(pk__lt=pk)
        page = list(own_requests.order_by("-pk")[:21])
        return JsonResponse({
            "account_id": str(owner.user_id), "results": [entry_data(entry) for entry in page[:20]],
            "next_cursor": str(page[19].pk) if len(page) > 20 else None,
        })

    body = fields(request)
    if "account_id" in body and body["account_id"] != str(owner.user_id):
        return error("Сеанс акаунта змінився.", 401)
    amount = body.get("amount_cents")
    if type(amount) is not int or not 1 <= amount <= 1_000_000:
        return error("Введи суму від $0.01 до $10,000.00.")
    try:
        request_id = UUID(string(body, "request_id"))
    except ValueError:
        return error("Некоректний ідентифікатор заявки.")
    entry, created = own_requests.get_or_create(
        request_id=request_id, defaults={"owner": owner, "amount_cents": amount},
    )
    if entry.amount_cents != amount:
        return error("Цей ідентифікатор уже використано для іншої суми.", 409)
    return JsonResponse(entry_data(entry), status=201 if created else 200)


@never_cache
@require_POST
def cancel(request, pk):
    owner = profile_for(request)
    if owner is None:
        return error("Увійди до акаунта.", 401)
    if not 0 < pk < 2**63:
        return error("Заявку не знайдено.", 404)
    own_request = TopUpRequest.objects.filter(pk=pk, owner=owner)
    if own_request.filter(status=TopUpRequest.Status.PENDING).update(
        status=TopUpRequest.Status.CANCELED, resolved_at=timezone.now(),
    ):
        return JsonResponse(entry_data(own_request.get()))
    entry = own_request.first()
    if entry is None:
        return error("Заявку не знайдено.", 404)
    if entry.status == TopUpRequest.Status.CANCELED:
        return JsonResponse(entry_data(entry))
    return error("Цю заявку вже оброблено.", 409)


@transaction.atomic
def resolve_request(pk, status, admin_user):
    if status not in (TopUpRequest.Status.APPROVED, TopUpRequest.Status.REJECTED):
        raise ValueError("Invalid top-up decision")
    updated = TopUpRequest.objects.filter(pk=pk, status=TopUpRequest.Status.PENDING).update(
        status=status, resolved_at=timezone.now(), resolved_by=admin_user,
    )
    if updated and status == TopUpRequest.Status.APPROVED:
        entry = TopUpRequest.objects.get(pk=pk)
        AccountProfile.objects.filter(pk=entry.owner_id).update(balance_cents=F("balance_cents") + entry.amount_cents)
    return bool(updated)
