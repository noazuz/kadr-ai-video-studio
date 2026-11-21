from array import array
from io import BytesIO
from math import cos, sin, tau
from pathlib import Path
from shutil import rmtree
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from replicate.exceptions import ReplicateError
import imageio_ffmpeg

from .models import AccountProfile
from .rendering import ffmpeg, process_next, segment_lengths
from .soundtrack import music_loop


@patch.dict("os.environ", {"REPLICATE_API_TOKEN": "test-provider-token"})
@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
    MAILERS={"default": {"BACKEND": "django.core.mail.backends.locmem.EmailBackend"}},
    GENERATION_PRICE_MILLS_PER_SECOND=25,
)
class AccountVideoTests(TestCase):
    password = "Forest!Password-47"

    def write(self, client, path, data, method="post"):
        return getattr(client, method)(
            f"/api/{path}/", data, content_type="application/json",
            headers={"X-CSRFToken": client.cookies["csrftoken"].value},
        )

    def register(self, email):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.get("/api/account/").json(), {"account": None})
        response = self.write(client, "auth/register", {"email": email, "password": self.password, "name": "Олена"})
        self.assertEqual(response.status_code, 201, response.content)
        return client

    def fund(self, client, amount):
        account_id = client.get("/api/account/").json()["account"]["id"]
        AccountProfile.objects.filter(user_id=account_id).update(balance_cents=amount)

    def test_topup_requests_and_admin_decisions(self):
        alice = self.register("alice@example.com")
        bob = self.register("bob@example.com")
        topup = {"amount_cents": 1234, "request_id": str(uuid4()), "status": "approved"}
        before = alice.get("/api/account/").json()["account"]
        path = "account/top-up-requests"
        self.assertEqual(Client().get(f"/api/{path}/").status_code, 401)
        self.assertEqual(self.write(alice, path, {**topup, "amount_cents": 0}).status_code, 400)
        self.assertEqual(self.write(alice, "account/demo-top-up", topup).status_code, 404)
        submitted = self.write(alice, path, topup)
        self.assertEqual(submitted.status_code, 201)
        entry = submitted.json()
        self.assertEqual(entry["status"], "pending")
        self.assertEqual(self.write(alice, path, topup).json()["id"], entry["id"])
        self.assertEqual(self.write(alice, path, {**topup, "amount_cents": 55}).status_code, 409)
        other = self.write(alice, path, {"amount_cents": 1, "request_id": str(uuid4())}).json()
        canceled = self.write(alice, path, {"amount_cents": 50, "request_id": str(uuid4())}).json()
        cancel_path = f"{path}/{canceled['id']}/cancel"
        self.assertEqual(self.write(bob, cancel_path, {}).status_code, 404)
        self.assertEqual(alice.post(f"/api/{cancel_path}/").status_code, 403)
        self.assertEqual(self.write(alice, cancel_path, {}).json()["status"], "canceled")
        self.assertEqual(self.write(alice, cancel_path, {}).json()["status"], "canceled")
        self.assertEqual(alice.get("/api/account/").json()["account"], before)
        self.assertEqual(bob.get(f"/api/{path}/").json()["results"], [])
        self.assertEqual(bob.get(f"/api/{path}/?cursor={entry['id']}").status_code, 400)

        admin = get_user_model().objects.create_superuser("operator", "admin@example.com", self.password)
        operator = Client()
        operator.force_login(admin)
        self.assertNotContains(operator.get(reverse("admin:index")), "/admin/auth/group/")
        queue = reverse("admin:api_topuprequest_changelist")
        self.assertEqual(alice.get(queue).status_code, 302)
        profile = AccountProfile.objects.get(email=before["email"])
        self.assertContains(operator.get(reverse("admin:api_accountprofile_change", args=[profile.pk])), "$12.34")
        self.assertContains(operator.get(queue, {"owner__id__exact": profile.pk}), "$12.34")
        approve = {"action": "approve", "_selected_action": entry["id"], "index": 0}
        self.assertEqual(operator.post(queue, approve).status_code, 302)
        shown = operator.get(queue).context["cl"].result_list
        self.assertEqual([str(item.pk) for item in shown], [other["id"]])
        self.assertEqual(self.write(alice, f"{path}/{entry['id']}/cancel", {}).status_code, 409)
        reject = {"action": "reject", "_selected_action": other["id"], "index": 0}
        self.assertEqual(operator.post(queue, reject).status_code, 302)
        self.assertEqual(operator.post(queue, {**approve, "_selected_action": other["id"]}).status_code, 302)
        entries = alice.get(f"/api/{path}/").json()["results"]
        self.assertEqual([item["status"] for item in entries], ["canceled", "rejected", "approved"])
        self.assertTrue(all(item["resolved_at"] for item in entries))
        self.assertEqual(alice.get("/api/account/").json()["account"]["balance_cents"], 1234)
        self.assertEqual(bob.get("/api/account/").json()["account"]["balance_cents"], 0)

    def test_account_lifecycle(self):
        client = self.register("owner@example.com")
        self.assertEqual(client.post("/api/auth/logout/").status_code, 403)
        fields = {"name": "Ірина", "email": "new@example.com", "current_password": self.password}
        self.assertEqual(self.write(client, "account", fields, "patch").json()["account"]["name"], "Ірина")
        new_password = "Second-Password!73"
        self.assertEqual(self.write(client, "account/password", {
            "current_password": self.password, "new_password": new_password,
        }).status_code, 204)
        self.assertEqual(client.get("/api/account/").json()["account"]["email"], fields["email"])
        self.assertEqual(self.write(client, "auth/logout", {}).status_code, 204)
        self.assertEqual(self.write(client, "auth/login", {
            "email": fields["email"], "password": new_password,
        }).status_code, 200)
        self.assertEqual(self.write(client, "auth/password-reset", {"email": fields["email"]}).status_code, 204)
        fragment = urlsplit(mail.outbox[0].body.splitlines()[-1]).fragment
        reset = {key: values[0] for key, values in parse_qs(fragment.split("?", 1)[1]).items()}
        reset["new_password"] = "Another-Password!91"
        self.assertEqual(self.write(client, "auth/password-reset/confirm", reset).status_code, 204)
        self.assertEqual(self.write(client, "auth/password-reset/confirm", reset).status_code, 400)
        self.assertEqual(client.get("/api/account/").json(), {"account": None})

    def test_generation_billing_and_owner_permissions(self):
        alice = self.register("alice@example.com")
        bob = self.register("bob@example.com")
        self.fund(alice, 500)
        quote = self.write(alice, "generation/quote", {"duration": 30, "aspect_ratio": "9:16"}).json()
        self.assertEqual(quote["balance_cents"], 500)
        payload = {
            "quote_id": quote["quote_id"], "topic": "Ранок у Карпатах", "duration": 30, "aspect_ratio": "9:16",
            "image_url": "https://example.com/photo.jpg",
        }
        self.assertEqual(self.write(bob, "generate-video", payload).status_code, 409)
        self.assertEqual(alice.post("/api/generate-video/", payload).status_code, 403)
        media_dir = Path(settings.BASE_DIR) / f".test-media-{uuid4().hex}"
        media_dir.mkdir()
        self.addCleanup(rmtree, media_dir)
        with self.settings(MEDIA_ROOT=media_dir):
            generated = alice.post(
                "/api/generate-video/", {**payload, "image": SimpleUploadedFile("start.jpg", b"example jpeg")},
                headers={"X-CSRFToken": alice.cookies["csrftoken"].value},
            )
            self.assertEqual(generated.status_code, 202, generated.content)
            self.assertEqual(generated.json()["segments_total"], 3)
            status_url = f"/api/generation/jobs/{quote['quote_id']}/"
            self.assertEqual(bob.get(status_url).status_code, 404)
            self.assertEqual(alice.get(status_url).json()["status"], "queued")
            self.assertEqual(self.write(alice, "generate-video", payload).status_code, 202)

            def render(job, directory):
                output = directory / "result.mp4"
                output.write_bytes(b"private mp4")
                return output

            with patch("api.rendering.render", side_effect=render) as worker:
                self.assertTrue(process_next())
                self.assertFalse(process_next())
                worker.assert_called_once()
            clip = alice.get(status_url).json()["project"]
            self.assertEqual(clip["duration"], 30)
            self.assertEqual(self.write(alice, "generate-video", payload).json()["project"], clip)
            self.assertEqual(alice.get("/api/videos/").json()["results"], [clip])
            self.assertEqual(bob.get("/api/videos/").json()["results"], [])
            self.assertEqual(bob.get(clip["videoUrl"]).status_code, 404)
            self.assertEqual(Client().get(clip["videoUrl"]).status_code, 401)
            video = alice.get(clip["videoUrl"], headers={"Range": "bytes=0-6"})
            self.assertEqual(video.status_code, 206)
            self.assertEqual(b"".join(video.streaming_content), b"private")
            video.close()
            self.assertIn("no-store", video.headers["Cache-Control"])

            detail = "videos/" + clip["id"]
            self.assertEqual(self.write(bob, detail, {"title": "Чуже"}, "patch").status_code, 404)
            self.assertEqual(self.write(bob, detail, {}, "delete").status_code, 404)
            self.assertEqual(self.write(alice, detail, {"title": "Світанок"}, "patch").json()["title"], "Світанок")
            self.assertEqual(self.write(alice, detail, {}, "delete").status_code, 204)
            self.assertEqual(alice.get(clip["videoUrl"]).status_code, 404)
            self.assertFalse(list(Path(media_dir).rglob("*.mp4")))
        self.assertEqual(alice.get("/api/account/").json()["account"]["balance_cents"], 425)
        self.assertEqual(alice.get("/api/account/expenses/").json()["results"][0]["amount_cents"], 75)
        self.assertEqual(bob.get("/api/account/expenses/").json()["results"], [])

    @patch("api.rendering.replicate.Client.run", side_effect=ReplicateError(status=422))
    def test_failed_generation_refunds_balance(self, provider):
        client = self.register("retry@example.com")
        self.fund(client, 500)
        quote = self.write(client, "generation/quote", {"duration": 30, "aspect_ratio": "16:9"}).json()
        response = self.write(client, "generate-video", {
            "quote_id": quote["quote_id"], "topic": "Ліс після дощу", "duration": 30, "aspect_ratio": "16:9",
            "image_url": "https://example.com/photo.jpg",
        })
        self.assertEqual(response.status_code, 202)
        self.assertTrue(process_next())
        job = client.get(f"/api/generation/jobs/{quote['quote_id']}/").json()
        self.assertEqual(job["status"], "failed")
        self.assertIn("422", job["detail"])
        provider.assert_called_once()
        self.assertEqual(client.get("/api/account/").json()["account"]["balance_cents"], 500)
        self.assertEqual(client.get("/api/account/expenses/").json()["results"], [])

    def test_in_flight_generation_reserves_the_available_balance(self):
        client = self.register("exact@example.com")
        self.fund(client, 75)
        params = {"duration": 30, "aspect_ratio": "16:9"}
        first = self.write(client, "generation/quote", params).json()["quote_id"]
        second = self.write(client, "generation/quote", params).json()["quote_id"]
        payload = {**params, "topic": "Ліс після дощу", "image_url": "https://example.com/photo.jpg"}
        observed = []

        def provider(*args, **kwargs):
            observed.append(client.get("/api/account/").json()["account"]["balance_cents"])
            overlap = self.write(client, "generate-video", {**payload, "quote_id": second, "price_cents": 1})
            observed.append(overlap.status_code)
            raise RuntimeError("Provider unavailable")

        response = self.write(client, "generate-video", {**payload, "quote_id": first})
        self.assertEqual(response.status_code, 202)
        with patch("api.rendering.replicate.Client.run", side_effect=provider) as run:
            self.assertTrue(process_next())
            run.assert_called_once()
        self.assertEqual(observed, [0, 402])
        self.assertEqual(client.get("/api/account/").json()["account"]["balance_cents"], 75)

    def test_too_long_narration_is_rejected_before_reserving_balance(self):
        client = self.register("narration@example.com")
        self.fund(client, 200)
        params = {"duration": 45, "aspect_ratio": "16:9"}
        quote = self.write(client, "generation/quote", params).json()
        issue = self.write(client, "generate-video", {
            **params, "quote_id": quote["quote_id"], "topic": "Покинутий маєток",
            "script": "слово " * 151, "voice": "Поліна", "rate": "1",
        })
        self.assertEqual(issue.status_code, 400)
        self.assertIn("Сценарій задовгий", issue.json()["detail"])
        self.assertEqual(client.get("/api/account/").json()["account"]["balance_cents"], 200)
        self.assertEqual(client.get(f"/api/generation/jobs/{quote['quote_id']}/").status_code, 404)

    def test_text_only_job_starts_without_an_image_and_chains_the_next_clip(self):
        client = self.register("text@example.com")
        self.fund(client, 100)
        params = {"duration": 11, "aspect_ratio": "16:9"}
        quote = self.write(client, "generation/quote", params).json()
        topic = "x" * 1994 + " фінал"
        self.assertEqual(self.write(client, "generate-video", {
            **params, "quote_id": quote["quote_id"], "topic": topic + "!",
        }).status_code, 400)
        queued = self.write(client, "generate-video", {
            **params, "quote_id": quote["quote_id"], "topic": topic,
        })
        self.assertEqual(queued.status_code, 202)
        media_dir = Path(settings.BASE_DIR) / f".test-media-{uuid4().hex}"
        media_dir.mkdir()
        self.addCleanup(rmtree, media_dir)
        calls = []

        def predict(provider, inputs):
            calls.append((inputs["duration"], "image" in inputs, inputs["prompt"]))
            return "https://replicate.delivery/output.mp4"

        with (
            self.settings(MEDIA_ROOT=media_dir),
            patch("api.rendering.predict_segment", side_effect=predict),
            patch("api.rendering.download_video"),
            patch("api.rendering.last_frame", side_effect=lambda source, target, *args: target.touch()),
            patch("api.rendering.stitch", side_effect=lambda clips, target, ratio: target.write_bytes(b"video")),
        ):
            self.assertTrue(process_next())

        self.assertEqual([(duration, photo) for duration, photo, _ in calls], [(10, False), (1, True)])
        self.assertIn("Establish the scene", calls[0][2])
        self.assertTrue(all(prompt.startswith(topic) for _, _, prompt in calls))
        state = client.get(f"/api/generation/jobs/{quote['quote_id']}/").json()
        self.assertEqual(state["status"], "completed")
        self.assertFalse(state["project"]["useStartImage"])

    def test_worker_stitches_exact_frames_with_audio_and_chains_the_last_frame(self):
        client = self.register("video@example.com")
        self.fund(client, 100)
        params = {"duration": 12, "aspect_ratio": "1:1"}
        quote = self.write(client, "generation/quote", params).json()
        self.assertEqual(segment_lengths(12), [10, 2])
        self.assertEqual(quote["price_cents"], 30)
        media_dir = Path(settings.BASE_DIR) / f".test-media-{uuid4().hex}"
        media_dir.mkdir()
        self.addCleanup(rmtree, media_dir)
        fixture = media_dir / "sample.mp4"
        ffmpeg("-f", "lavfi", "-i", "color=green:size=160x120:rate=30",
               "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
               "-t", "1.5", "-c:v", "libx264", "-c:a", "aac", fixture)
        image = media_dir / "image.png"
        ffmpeg("-i", fixture, "-frames:v", "1", "-update", "1", image)
        narration_fixture = media_dir / "voice.wav"
        ffmpeg("-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", narration_fixture)
        calls = []

        def predict(model, input, *, wait):
            self.assertFalse(wait)
            calls.append((model, input["duration"], Path(input["image"].name).name, input["draft"]))
            return "https://replicate.delivery/output.mp4"

        with self.settings(MEDIA_ROOT=media_dir):
            extra_audio = media_dir / "music.wav"
            music_loop("Легкий акустичний фон", extra_audio)
            queued = client.post("/api/generate-video/", {
                **params, "quote_id": quote["quote_id"], "topic": "Світанок у Карпатах",
                "script": "Сонце сходить над Карпатами.", "voice": "Поліна", "rate": "0.9",
                "music": "Спокійна атмосфера", "music_volume": "35", "subtitles": "true",
                "image": SimpleUploadedFile("start.png", image.read_bytes()),
                "materials": [SimpleUploadedFile("still.png", image.read_bytes()),
                              SimpleUploadedFile("insert.mp4", fixture.read_bytes()),
                              SimpleUploadedFile("track.wav", extra_audio.read_bytes())],
            }, headers={"X-CSRFToken": client.cookies["csrftoken"].value})
            self.assertEqual(queued.status_code, 202)

            def narrate(project, duration, path):
                self.assertEqual((project["voice"], project["rate"]), ("Поліна", 0.9))
                pending = client.get(f"/api/generation/jobs/{quote['quote_id']}/").json()
                self.assertEqual(pending["status"], "preparing")
                path.write_bytes(narration_fixture.read_bytes())
                return 1, [(0.1, 2.2, project["script"])]

            with (
                patch("api.rendering.narrate", side_effect=narrate) as voice,
                patch("api.rendering.replicate.Client.run", side_effect=predict),
                patch("api.rendering.urlopen", side_effect=lambda *args, **kwargs: BytesIO(fixture.read_bytes())),
            ):
                self.assertTrue(process_next())
                voice.assert_called_once()
            self.assertEqual(calls, [("prunaai/p-video", 10, "first.png", True),
                                     ("prunaai/p-video", 2, "frame-0.png", True)])
            state = client.get(f"/api/generation/jobs/{quote['quote_id']}/").json()
            self.assertEqual(state["status"], "completed", state)
            self.assertEqual(state["segments_done"], 2)
            output = next((media_dir / "generated").glob("*.mp4"))
            self.assertEqual(imageio_ffmpeg.count_frames_and_secs(str(output)), (288, 12.0))
            samples = array("h", ffmpeg("-i", output, "-map", "0:a:0", "-ac", "1", "-ar", "48000",
                                        "-t", "0.5", "-f", "s16le", "pipe:1"))

            def signal_at(frequency):
                phase = tau * frequency / 48000
                return abs(complex(
                    sum(sample * cos(index * phase) for index, sample in enumerate(samples)),
                    sum(sample * sin(index * phase) for index, sample in enumerate(samples)),
                ))

            self.assertGreater(signal_at(880), 100 * signal_at(440))
            poster_url = state["project"]["posterUrl"]
            other = self.register("poster-visitor@example.com")
            self.assertEqual(other.get(poster_url).status_code, 404)
            poster = client.get(poster_url)
            self.assertEqual(poster.status_code, 200)
            self.assertEqual(poster.headers["Content-Type"], "image/jpeg")
            self.assertTrue(poster.content.startswith(b"\xff\xd8"))
            self.assertEqual(output.with_suffix(".jpg").read_bytes(), poster.content)
