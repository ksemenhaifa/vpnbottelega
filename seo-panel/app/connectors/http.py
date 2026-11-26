"""Shared HTTP helper for the API connectors."""
from __future__ import annotations

import asyncio
from typing import Any

import httpx


class ApiError(Exception):
    """An upstream API refused or failed a request.

    The message is shown in the panel, so it must never contain credentials.
    """

    def __init__(self, source: str, status: int | None, message: str):
        self.source = source
        self.status = status
        self.message = message
        label = f"{source}: HTTP {status}" if status else source
        super().__init__(f"{label} — {message}" if message else label)


def _error_text(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200].strip()
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("status") or error)[:300]
        for key in ("error_description", "error_message", "message", "error"):
            if body.get(key):
                return str(body[key])[:300]
    return str(body)[:300]


async def request_json(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    source: str,
    retries: int = 1,
    **kwargs: Any,
) -> Any:
    """Send a request and return parsed JSON; retry once on 429/5xx/network errors."""
    attempt = 0
    while True:
        try:
            response = await client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            if attempt < retries:
                attempt += 1
                await asyncio.sleep(1.5 * attempt)
                continue
            raise ApiError(source, None, f"сеть: {type(exc).__name__}") from exc
        if response.status_code in (429, 500, 502, 503, 504) and attempt < retries:
            attempt += 1
            await asyncio.sleep(1.5 * attempt)
            continue
        if response.status_code >= 400:
            raise ApiError(source, response.status_code, _error_text(response))
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError as exc:
            raise ApiError(source, response.status_code, "ответ не в формате JSON") from exc
