import json
import logging
from functools import wraps
from urllib.parse import urlencode
from uuid import uuid4

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.http import HttpResponse, JsonResponse
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods, require_POST

from .models import AccountProfile, Generation

User = get_user_model()
logger = logging.getLogger(__name__)


def error(detail, status=400):
    return JsonResponse({"detail": detail}, status=status)


def fields(request):
    try:
        body = json.loads(request.body)
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise ValidationError("Надішли коректні дані форми.")
    return body


def validated(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        try:
            return view(*args, **kwargs)
        except ValidationError as exc:
            return error(" ".join(exc.messages))
    return wrapped


def string(body, key):
    value = body.get(key, "")
    if not isinstance(value, str):
        raise ValidationError("Надішли коректні дані форми.")
    return value


def email_from(body):
    email = string(body, "email").strip().lower()
    try:
        validate_email(email)
    except ValidationError:
        raise ValidationError("Введи коректну адресу електронної пошти.") from None
    if len(email) > 254:
        raise ValidationError("Адреса електронної пошти задовга.")
    return email


def name_from(body):
    name = string(body, "name").strip()
    if not 1 <= len(name) <= 100:
        raise ValidationError("Введи ім’я довжиною від 1 до 100 символів.")
    return name


def new_password(body, key, user):
    password = string(body, key)
    if not 8 <= len(password) <= 128:
        raise ValidationError("Пароль має містити від 8 до 128 символів.")
    validate_password(password, user)
    user.set_password(password)


def profile_for(request):
    if request.user.is_authenticated:
        return AccountProfile.objects.select_related("user").filter(user=request.user).first()
    return None


def account_response(profile, status=200):
    if profile is None:
        return JsonResponse({"account": None}, status=status)
    spent = Generation.objects.filter(owner=profile, status="completed").aggregate(total=Sum("price_cents"))
    return JsonResponse({"account": {
        "id": str(profile.user_id),
        "name": profile.user.first_name,
        "email": profile.email,
        "balance_cents": profile.balance_cents,
        "total_spent_cents": spent["total"] or 0,
    }}, status=status)


@never_cache
@require_http_methods(["GET"])
@ensure_csrf_cookie
def csrf(request):
    return HttpResponse(status=204)


@never_cache
@require_http_methods(["GET", "PATCH"])
@ensure_csrf_cookie
@validated
def account(request):
    profile = profile_for(request)
    if request.method == "GET":
        return account_response(profile)
    if profile is None:
        return error("Увійди до акаунта.", 401)

    body = fields(request)
    email, name = email_from(body), name_from(body)
    user = profile.user
    changed_email = email != profile.email
    if changed_email and not user.check_password(string(body, "current_password")):
        return error("Поточний пароль неправильний.")
    try:
        with transaction.atomic():
            user.first_name = name
            if changed_email:
                user.email = profile.email = email
                profile.save(update_fields=["email"])
            user.save(update_fields=["first_name", "email"] if changed_email else ["first_name"])
    except IntegrityError:
        if AccountProfile.objects.filter(email=email).exclude(pk=profile.pk).exists():
            return error("Акаунт із цією поштою вже існує.", 409)
        raise
    profile.refresh_from_db(fields=["balance_cents"])
    return account_response(profile)


@never_cache
@require_POST
@validated
def register(request):
    body = fields(request)
    email = email_from(body)
    user = User(username=uuid4().hex, email=email, first_name=name_from(body))
    new_password(body, "password", user)
    try:
        with transaction.atomic():
            user.save()
            profile = AccountProfile.objects.create(user=user, email=email)
    except IntegrityError:
        if AccountProfile.objects.filter(email=email).exists():
            return error("Акаунт із цією поштою вже існує.", 409)
        raise
    login(request, user)
    return account_response(profile, 201)


@never_cache
@require_POST
@validated
def sign_in(request):
    body = fields(request)
    profile = AccountProfile.objects.select_related("user").filter(email=email_from(body)).first()
    user = authenticate(request, username=profile.user.username if profile else "", password=string(body, "password"))
    if profile is None or user is None:
        return error("Неправильна пошта або пароль.", 401)
    login(request, user)
    return account_response(profile)


@never_cache
@require_POST
def sign_out(request):
    logout(request)
    return HttpResponse(status=204)


@never_cache
@require_POST
@validated
def change_password(request):
    profile = profile_for(request)
    if profile is None:
        return error("Увійди до акаунта.", 401)
    user, body = profile.user, fields(request)
    if not user.check_password(string(body, "current_password")):
        return error("Поточний пароль неправильний.")
    previous_hash = user.password
    new_password(body, "new_password", user)
    if not User.objects.filter(pk=user.pk, password=previous_hash).update(password=user.password):
        return error("Пароль уже змінився. Увійди ще раз.", 409)
    update_session_auth_hash(request, user)
    return HttpResponse(status=204)


@never_cache
@require_POST
@validated
def request_reset(request):
    email = email_from(fields(request))
    profile = AccountProfile.objects.select_related("user").filter(email=email, user__is_active=True).first()
    if profile and profile.user.has_usable_password():
        query = urlencode({
            "uid": urlsafe_base64_encode(str(profile.user_id).encode()),
            "token": default_token_generator.make_token(profile.user),
        })
        link = f"{settings.FRONTEND_URL.rstrip('/')}/#reset-password?{query}"
        try:
            send_mail("Відновлення пароля в Кадрі", f"Відкрий це посилання, щоб змінити пароль:\n{link}",
                      settings.DEFAULT_FROM_EMAIL, [email])
        except OSError:
            logger.exception("Не вдалося надіслати лист відновлення пароля.")
    return HttpResponse(status=204)


@never_cache
@require_POST
@validated
def confirm_reset(request):
    body = fields(request)
    invalid = "Посилання недійсне або прострочене. Запроси нове."
    try:
        uid = int(urlsafe_base64_decode(string(body, "uid")))
    except ValueError:
        return error(invalid)
    if not 0 < uid < 2**63:
        return error(invalid)
    user = User.objects.filter(pk=uid, is_active=True, accountprofile__isnull=False).first()
    if user is None or not default_token_generator.check_token(user, string(body, "token")):
        return error(invalid)
    previous_hash = user.password
    new_password(body, "new_password", user)
    if not User.objects.filter(pk=uid, password=previous_hash, email=user.email, is_active=True).update(password=user.password):
        return error(invalid)
    return HttpResponse(status=204)
