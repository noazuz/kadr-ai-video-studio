import os
from pathlib import Path
from uuid import uuid4


def poster_path(video):
    return Path(video.path).with_suffix(".jpg")


def first_frame(video):
    from .rendering import ffmpeg

    source = Path(video.path)
    path = poster_path(video)
    if not source.is_file():
        raise FileNotFoundError(source)
    try:
        return path.read_bytes()
    except FileNotFoundError:
        pass
    frame = ffmpeg("-i", source, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease",
                   "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1")
    if not frame:
        raise FileNotFoundError("The video has no first frame")
    temporary = path.with_name(f"{path.stem}-{uuid4().hex}.tmp")
    try:
        temporary.write_bytes(frame)
        os.replace(temporary, path)
        if not source.is_file():
            path.unlink(missing_ok=True)
            raise FileNotFoundError(source)
    finally:
        temporary.unlink(missing_ok=True)
    return frame
