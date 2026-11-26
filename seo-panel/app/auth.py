"""Password check, signed session cookies and login throttling."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from collections import defaultdict, deque


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str, *, n: int = 2**14, r: int = 8, p: int = 1) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${_b64e(salt)}${_b64e(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = _b64d(digest)
        actual = hashlib.scrypt(
            password.encode(), salt=_b64d(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


class SignedCodec:
    """Tamper-proof (not encrypted) JSON payloads with an expiry."""

    def __init__(self, secret: bytes, purpose: str):
        self._key = hmac.new(secret, purpose.encode(), hashlib.sha256).digest()

    def _sign(self, body: str) -> str:
        return _b64e(hmac.new(self._key, body.encode(), hashlib.sha256).digest())

    def encode(self, payload: dict, ttl_seconds: float) -> str:
        body = _b64e(json.dumps({**payload, "exp": int(time.time() + ttl_seconds)}).encode())
        return f"{body}.{self._sign(body)}"

    def decode(self, token: str | None) -> dict | None:
        if not token or token.count(".") != 1:
            return None
        body, signature = token.split(".")
        if not hmac.compare_digest(signature, self._sign(body)):
            return None
        try:
            payload = json.loads(_b64d(body))
        except (ValueError, TypeError):
            return None
        if not isinstance(payload, dict) or payload.get("exp", 0) < time.time():
            return None
        return payload


class LoginLimiter:
    """Blocks an address after too many failed logins inside a time window."""

    def __init__(self, max_attempts: int = 5, window_seconds: float = 900):
        self.max_attempts = max_attempts
        self.window = window_seconds
        self._failures: dict[str, deque[float]] = defaultdict(deque)

    def _prune(self, address: str) -> deque[float]:
        failures = self._failures[address]
        cutoff = time.monotonic() - self.window
        while failures and failures[0] < cutoff:
            failures.popleft()
        return failures

    def is_blocked(self, address: str) -> bool:
        return len(self._prune(address)) >= self.max_attempts

    def record_failure(self, address: str) -> None:
        self._prune(address).append(time.monotonic())

    def reset(self, address: str) -> None:
        self._failures.pop(address, None)
