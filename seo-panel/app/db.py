"""Small SQLite store: OAuth tokens, cached API responses, sites and phrases."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS tokens (
    provider TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    payload TEXT,
    error TEXT,
    fetched_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_sites (
    domain TEXT PRIMARY KEY,
    added_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS site_urls (
    domain TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (domain, url)
);
CREATE TABLE IF NOT EXISTS phrases (
    phrase TEXT NOT NULL,
    regions TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    added_at REAL NOT NULL,
    PRIMARY KEY (phrase, regions)
);
"""


class Store:
    def __init__(self, data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = data_dir / "panel.sqlite3"
        # The database holds OAuth tokens: create it readable by the service user only.
        os.close(os.open(self.path, os.O_CREAT | os.O_WRONLY, 0o600))
        os.chmod(self.path, 0o600)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock, self._db:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    def _write(self, sql: str, args: tuple = ()) -> None:
        with self._lock, self._db:
            self._db.execute(sql, args)

    def _rows(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    # tokens
    def get_token(self, provider: str) -> dict | None:
        rows = self._rows("SELECT data FROM tokens WHERE provider = ?", (provider,))
        return json.loads(rows[0]["data"]) if rows else None

    def set_token(self, provider: str, data: dict) -> None:
        self._write(
            "INSERT INTO tokens (provider, data, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(provider) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (provider, json.dumps(data), time.time()),
        )

    def delete_token(self, provider: str) -> None:
        self._write("DELETE FROM tokens WHERE provider = ?", (provider,))

    # cache
    def put(self, key: str, payload: Any = None, error: str | None = None) -> None:
        """Store a fresh result. A failed fetch keeps the last good payload."""
        if error is not None:
            self._write(
                "INSERT INTO cache (key, payload, error, fetched_at) VALUES (?, NULL, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET error = excluded.error",
                (key, error, time.time()),
            )
            return
        self._write(
            "INSERT INTO cache (key, payload, error, fetched_at) VALUES (?, ?, NULL, ?) "
            "ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, error = NULL, "
            "fetched_at = excluded.fetched_at",
            (key, json.dumps(payload), time.time()),
        )

    def get(self, key: str) -> dict | None:
        """Returns {"data", "error", "fetched_at"} or None if never fetched."""
        rows = self._rows("SELECT payload, error, fetched_at FROM cache WHERE key = ?", (key,))
        if not rows:
            return None
        row = rows[0]
        return {
            "data": json.loads(row["payload"]) if row["payload"] is not None else None,
            "error": row["error"],
            "fetched_at": row["fetched_at"],
        }

    def data(self, key: str, default: Any = None) -> Any:
        entry = self.get(key)
        return default if entry is None or entry["data"] is None else entry["data"]

    def delete_prefix(self, prefix: str) -> None:
        self._write("DELETE FROM cache WHERE key LIKE ? ESCAPE '\\'", (_like_prefix(prefix),))

    # manually added sites
    def manual_sites(self) -> list[str]:
        return [r["domain"] for r in self._rows("SELECT domain FROM manual_sites ORDER BY domain")]

    def add_manual_site(self, domain: str) -> None:
        self._write(
            "INSERT OR IGNORE INTO manual_sites (domain, added_at) VALUES (?, ?)", (domain, time.time())
        )

    def remove_manual_site(self, domain: str) -> None:
        self._write("DELETE FROM manual_sites WHERE domain = ?", (domain,))

    # URLs the owner wants checked on every refresh
    def site_urls(self, domain: str) -> list[str]:
        return [r["url"] for r in self._rows("SELECT url FROM site_urls WHERE domain = ? ORDER BY url", (domain,))]

    def set_site_urls(self, domain: str, urls: list[str]) -> None:
        with self._lock, self._db:
            self._db.execute("DELETE FROM site_urls WHERE domain = ?", (domain,))
            self._db.executemany(
                "INSERT OR IGNORE INTO site_urls (domain, url) VALUES (?, ?)", [(domain, u) for u in urls]
            )

    # Wordstat phrases
    def phrases(self) -> list[dict]:
        return [dict(r) for r in self._rows("SELECT phrase, regions, domain, added_at FROM phrases ORDER BY added_at DESC")]

    def add_phrase(self, phrase: str, regions: str, domain: str) -> None:
        self._write(
            "INSERT INTO phrases (phrase, regions, domain, added_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(phrase, regions) DO UPDATE SET domain = excluded.domain",
            (phrase, regions, domain, time.time()),
        )

    def remove_phrase(self, phrase: str, regions: str) -> None:
        self._write("DELETE FROM phrases WHERE phrase = ? AND regions = ?", (phrase, regions))


def _like_prefix(prefix: str) -> str:
    escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped + "%"
