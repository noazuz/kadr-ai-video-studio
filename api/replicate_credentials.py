import ctypes
import os
from ctypes import wintypes
from pathlib import Path


class DataBlob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def decrypt_windows_secret(encrypted):
    buffer = (ctypes.c_ubyte * len(encrypted)).from_buffer_copy(encrypted)
    source = DataBlob(len(encrypted), buffer)
    result = DataBlob()
    decrypt = ctypes.windll.crypt32.CryptUnprotectData
    decrypt.argtypes = [
        ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob),
    ]
    decrypt.restype = wintypes.BOOL
    if not decrypt(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise OSError("Could not decrypt the local Replicate token")
    try:
        return ctypes.string_at(result.data, result.size).decode("utf-16-le").strip()
    finally:
        release = ctypes.windll.kernel32.LocalFree
        release.argtypes = [ctypes.c_void_p]
        release.restype = ctypes.c_void_p
        release(result.data)


def replicate_token():
    token = os.environ.get("REPLICATE_API_TOKEN", "").strip()
    if token:
        return token
    local_app_data = os.environ.get("LOCALAPPDATA")
    if os.name != "nt" or not local_app_data:
        return ""
    path = Path(local_app_data) / "Kadr" / "replicate-token.dpapi"
    try:
        return decrypt_windows_secret(bytes.fromhex(path.read_text(encoding="utf-8").strip()))
    except (OSError, ValueError):
        return ""
