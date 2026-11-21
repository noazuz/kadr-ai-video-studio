import time

from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections

from api.rendering import imageio_ffmpeg, process_next
from api.replicate_credentials import replicate_token


class Command(BaseCommand):
    help = "Process queued P-Video generations."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Process at most one queued job.")

    def handle(self, *args, **options):
        if not replicate_token():
            raise CommandError("Save the token with scripts/set-replicate-token.ps1 or set REPLICATE_API_TOKEN.")
        imageio_ffmpeg.get_ffmpeg_exe()
        self.stdout.write("P-Video worker is running.")
        try:
            while True:
                close_old_connections()
                processed = process_next()
                if options["once"]:
                    break
                if not processed:
                    time.sleep(2)
        except KeyboardInterrupt:
            self.stdout.write("P-Video worker stopped.")
