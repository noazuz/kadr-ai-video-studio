import uuid

from django.conf import settings
from django.db import models


class AccountProfile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    email = models.EmailField(unique=True)
    balance_cents = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "акаунт"
        verbose_name_plural = "акаунти"

    def __str__(self):
        return self.email


class DemoTopUp(models.Model):
    owner = models.ForeignKey(AccountProfile, on_delete=models.CASCADE)
    request_id = models.UUIDField()
    amount_cents = models.PositiveIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "request_id"], name="unique_demo_topup_request")]


class TopUpRequest(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Очікує підтвердження"
        APPROVED = "approved", "Зараховано"
        REJECTED = "rejected", "Відхилено"
        CANCELED = "canceled", "Скасовано"

    owner = models.ForeignKey(AccountProfile, on_delete=models.CASCADE, verbose_name="Акаунт")
    request_id = models.UUIDField()
    amount_cents = models.PositiveIntegerField()
    status = models.CharField(max_length=8, choices=Status, default=Status.PENDING, verbose_name="Статус")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="Подано")
    resolved_at = models.DateTimeField(null=True, blank=True, verbose_name="Оброблено")
    resolved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
                                    verbose_name="Адміністратор")

    class Meta:
        verbose_name = "заявка на поповнення"
        verbose_name_plural = "заявки на поповнення"
        constraints = [
            models.UniqueConstraint(fields=["owner", "request_id"], name="unique_topup_request"),
            models.CheckConstraint(condition=models.Q(amount_cents__gte=1, amount_cents__lte=1_000_000),
                                   name="topup_request_amount_range"),
        ]


class Generation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(AccountProfile, on_delete=models.CASCADE)
    aspect_ratio = models.CharField(max_length=4)
    requested_duration = models.PositiveSmallIntegerField()
    duration = models.PositiveSmallIntegerField()
    price_cents = models.PositiveIntegerField()
    status = models.CharField(max_length=12, default="quoted")
    project = models.JSONField(default=dict)
    expense_title = models.CharField(max_length=70, blank=True)
    file = models.FileField(upload_to="generated/", blank=True)
    source_image = models.FileField(upload_to="generation-inputs/", blank=True)
    source_url = models.URLField(max_length=2048, blank=True)
    segments_done = models.PositiveSmallIntegerField(default=0)
    failure_detail = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True)
    updated_at = models.DateTimeField(auto_now=True)
    hidden = models.BooleanField(default=False)

    class Meta:
        indexes = [models.Index(fields=["owner", "status", "-completed_at"])]

class GenerationMaterial(models.Model):
    job = models.ForeignKey(Generation, on_delete=models.CASCADE, related_name="materials")
    file = models.FileField(upload_to="generation-inputs/extras/")


class VideoProject(models.Model):
    title = models.CharField(max_length=255, default="Без назви")
    topic = models.TextField()                   
    script = models.TextField()                   
    format_type = models.CharField(max_length=20, default="9:16") 
    duration = models.IntegerField(default=30)    
    tone = models.CharField(max_length=50, default="Натхненний")
    voice = models.CharField(max_length=50, default="Остап")   
    music = models.CharField(max_length=100, default="Без музики") 
    status = models.CharField(max_length=20, default="ready")    
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.title
