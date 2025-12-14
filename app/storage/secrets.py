import base64
import hashlib
from typing import Optional


def _to_bytes(value: object) -> bytes:
    if value is None:
        return b""
    if isinstance(value, bytes):
        return value
    try:
        return str(value).encode("utf-8")
    except Exception:
        return bytes(value)  # type: ignore[arg-type]


def _fernet_from_secret_key(secret_key: object):
    """Create a Fernet instance derived from the app's SECRET_KEY.

    We derive a stable 32-byte key using SHA-256 and urlsafe-base64 encode it.
    This means secrets persist across restarts as long as SECRET_KEY is stable
    (this app persists it in DATA_DIR/secret.key by default).
    """
    from cryptography.fernet import Fernet

    raw = _to_bytes(secret_key)
    digest = hashlib.sha256(raw).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt_str(secret_key: object, plaintext: Optional[str]) -> str:
    if not plaintext:
        return ""
    f = _fernet_from_secret_key(secret_key)
    token = f.encrypt(str(plaintext).encode("utf-8"))
    return token.decode("utf-8")


def decrypt_str(secret_key: object, token: Optional[str]) -> str:
    if not token:
        return ""
    try:
        f = _fernet_from_secret_key(secret_key)
        raw = f.decrypt(str(token).encode("utf-8"))
        return raw.decode("utf-8")
    except Exception:
        return ""
