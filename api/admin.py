from urllib.parse import urlencode

from django.contrib import admin, messages
from django.contrib.auth.models import Group
from django.urls import reverse
from django.utils.html import format_html

from .models import AccountProfile, TopUpRequest
from .topups import resolve_request

admin.site.unregister(Group)


def dollars(cents):
    return f"${cents // 100:,}.{cents % 100:02d}"


class TopUpInline(admin.TabularInline):
    model = TopUpRequest
    fields = ("amount", "status", "created_at", "resolved_at", "resolved_by")
    readonly_fields = fields
    extra = 0
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False

    @admin.display(description="Сума")
    def amount(self, entry):
        return dollars(entry.amount_cents)


@admin.register(AccountProfile)
class AccountAdmin(admin.ModelAdmin):
    list_display = ("email", "name", "balance", "requests_link")
    search_fields = ("email", "user__first_name")
    list_select_related = ("user",)
    fields = ("email", "name", "balance", "requests_link")
    readonly_fields = fields
    inlines = (TopUpInline,)

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="Ім’я")
    def name(self, profile):
        return profile.user.first_name

    @admin.display(description="Баланс", ordering="balance_cents")
    def balance(self, profile):
        return dollars(profile.balance_cents)

    @admin.display(description="Заявки")
    def requests_link(self, profile):
        url = reverse("admin:api_topuprequest_changelist")
        return format_html('<a href="{}?{}">Переглянути заявки</a>', url, urlencode({"owner__id__exact": profile.pk}))


@admin.register(TopUpRequest)
class TopUpRequestAdmin(admin.ModelAdmin):
    list_display = ("owner", "amount", "status", "created_at", "resolved_at", "resolved_by")
    list_filter = ("status",)
    search_fields = ("owner__email", "owner__user__first_name")
    list_select_related = ("owner", "resolved_by")
    ordering = ("-created_at",)
    fields = ("owner", "amount", "status", "created_at", "resolved_at", "resolved_by")
    readonly_fields = fields
    actions = ("approve", "reject")

    def get_queryset(self, request):
        queryset = super().get_queryset(request)
        if request.resolver_match.url_name == "api_topuprequest_changelist":
            return queryset.exclude(status__in=(TopUpRequest.Status.APPROVED, TopUpRequest.Status.CANCELED))
        return queryset

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="Сума", ordering="amount_cents")
    def amount(self, entry):
        return dollars(entry.amount_cents)

    def resolve_selected(self, request, queryset, status):
        ids = list(queryset.values_list("pk", flat=True))
        changed = sum(resolve_request(pk, status, request.user) for pk in ids)
        self.message_user(request, f"Заявок оброблено: {changed}. Пропущено: {len(ids) - changed}.",
                          level=messages.SUCCESS if changed else messages.WARNING)

    @admin.action(description="Підтвердити після поповнення Replicate та зарахувати баланс", permissions=["change"])
    def approve(self, request, queryset):
        self.resolve_selected(request, queryset, TopUpRequest.Status.APPROVED)

    @admin.action(description="Відхилити заявки", permissions=["change"])
    def reject(self, request, queryset):
        self.resolve_selected(request, queryset, TopUpRequest.Status.REJECTED)
