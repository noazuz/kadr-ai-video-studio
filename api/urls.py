from django.urls import path
from . import accounts, library, topups
from .views import generate_video_api, preview_voice

urlpatterns = [
    path('account/', accounts.account),
    path('account/password/', accounts.change_password),
    path('account/top-up-requests/', topups.requests),
    path('account/top-up-requests/<int:pk>/cancel/', topups.cancel),
    path('account/expenses/', library.expenses),
    path('auth/csrf/', accounts.csrf),
    path('auth/register/', accounts.register),
    path('auth/login/', accounts.sign_in),
    path('auth/logout/', accounts.sign_out),
    path('auth/password-reset/', accounts.request_reset),
    path('auth/password-reset/confirm/', accounts.confirm_reset),
    path('generation/quote/', library.quote),
    path('generation/voice-preview/', preview_voice),
    path('generation/jobs/<uuid:pk>/', library.generation_job),
    path('videos/', library.videos),
    path('videos/<uuid:pk>/', library.video_detail),
    path('videos/<uuid:pk>/file/', library.video_file, name='video_file'),
    path('videos/<uuid:pk>/poster/', library.video_poster, name='video_poster'),
    path('generate-video/', generate_video_api, name='generate_video'),
]
