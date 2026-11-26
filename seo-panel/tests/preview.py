"""Local preview on fake data: python -m tests.preview  (password: see fakes.PASSWORD)

Serves the panel at http://127.0.0.1:8765/panel/ on top of tests/fakes.py.
Every number shown is made up; this exists only to look at the interface.
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

import uvicorn

from app.auth import hash_password
from app.config import Settings
from app.db import Store
from app.main import create_app
from tests import fakes


def main() -> None:
    data_dir = Path(tempfile.mkdtemp(prefix="seo-panel-preview-"))
    store = Store(data_dir)
    far = time.time() + 86400
    store.set_token("google", {"access_token": "g-access", "refresh_token": "g-refresh", "expires_at": far})
    store.set_token("yandex", {"access_token": "y-access", "refresh_token": "y-refresh", "expires_at": far})
    store.close()
    settings = Settings(
        secret_key=b"preview-only-secret-key-0123456789", password_hash=hash_password(fakes.PASSWORD),
        base_url="http://127.0.0.1:8765/panel", data_dir=data_dir,
        google_client_id="preview", google_client_secret="preview",
        yandex_client_id="preview", yandex_client_secret="preview",
        refresh_hours=6, cookie_secure=False,
    )
    app = create_app(settings, client=fakes.client(), host_checker=fakes.any_host)
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
