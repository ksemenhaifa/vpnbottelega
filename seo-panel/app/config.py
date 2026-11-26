"""Runtime configuration, read from environment variables only.

Secrets never live in the repository: the server keeps them in an env file
that systemd loads (see deploy/seo-panel.service and .env.example).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlparse


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    secret_key: bytes
    password_hash: str
    base_url: str
    data_dir: Path
    google_client_id: str = ""
    google_client_secret: str = ""
    yandex_client_id: str = ""
    yandex_client_secret: str = ""
    wordstat_token: str = ""
    refresh_hours: float = 6.0
    cookie_secure: bool = True
    trust_proxy: bool = False
    session_hours: float = 24.0 * 14

    @property
    def base_path(self) -> str:
        """URL prefix the panel is served under, e.g. "/panel" or ""."""
        return urlparse(self.base_url).path.rstrip("/")

    @property
    def google_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def yandex_configured(self) -> bool:
        return bool(self.yandex_client_id and self.yandex_client_secret)


def _flag(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    problems = []

    secret = env.get("PANEL_SECRET_KEY", "")
    if len(secret) < 32:
        problems.append("PANEL_SECRET_KEY must be set to at least 32 random characters")

    password_hash = env.get("PANEL_PASSWORD_HASH", "")
    if not password_hash.startswith("scrypt$"):
        problems.append(
            "PANEL_PASSWORD_HASH must be set (generate it with: python -m app.hashpw)"
        )

    base_url = env.get("PANEL_BASE_URL", "").rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        problems.append("PANEL_BASE_URL must be the public URL of the panel, e.g. https://example.com/panel")

    if problems:
        raise ConfigError("; ".join(problems))

    # Cookies are Secure unless the panel is explicitly served over plain http
    # (local development only).
    cookie_secure = parsed.scheme == "https"

    return Settings(
        secret_key=secret.encode(),
        password_hash=password_hash,
        base_url=base_url,
        data_dir=Path(env.get("PANEL_DATA_DIR", "./data")),
        google_client_id=env.get("GOOGLE_CLIENT_ID", ""),
        google_client_secret=env.get("GOOGLE_CLIENT_SECRET", ""),
        yandex_client_id=env.get("YANDEX_CLIENT_ID", ""),
        yandex_client_secret=env.get("YANDEX_CLIENT_SECRET", ""),
        wordstat_token=env.get("WORDSTAT_TOKEN", ""),
        refresh_hours=float(env.get("PANEL_REFRESH_HOURS", "6")),
        cookie_secure=cookie_secure,
        trust_proxy=_flag(env.get("PANEL_TRUST_PROXY", "")),
    )
