"""Yandex OAuth, Webmaster, Metrika and Wordstat clients.

The request formats below follow the public Yandex API documentation as the
author knew it; they could not be re-checked against the live docs when this
was written. The Wordstat API (api.wordstat.yandex.net) is the least certain:
it is new and access is granted per application on request. Every call
surfaces the upstream error text in the panel, so a format mismatch shows up
on the first refresh instead of producing wrong numbers.
"""
from __future__ import annotations

import time
from urllib.parse import quote, urlencode

import httpx

from .http import request_json

AUTH_URL = "https://oauth.yandex.ru/authorize"
TOKEN_URL = "https://oauth.yandex.ru/token"
WEBMASTER = "https://api.webmaster.yandex.net/v4"
METRIKA = "https://api-metrika.yandex.net"
WORDSTAT = "https://api.wordstat.yandex.net"


def authorize_url(client_id: str, redirect_uri: str, state: str) -> str:
    # Scopes are fixed in the application's registration at oauth.yandex.ru.
    return AUTH_URL + "?" + urlencode(
        {"response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri, "state": state}
    )


def _with_expiry(token: dict) -> dict:
    token["expires_at"] = time.time() + float(token.get("expires_in", 3600))
    return token


async def exchange_code(client: httpx.AsyncClient, client_id: str, client_secret: str, code: str) -> dict:
    token = await request_json(
        client, "POST", TOKEN_URL, source="Яндекс OAuth", retries=0,
        data={"grant_type": "authorization_code", "code": code, "client_id": client_id, "client_secret": client_secret},
    )
    return _with_expiry(token)


async def refresh(client: httpx.AsyncClient, client_id: str, client_secret: str, token: dict) -> dict:
    fresh = await request_json(
        client, "POST", TOKEN_URL, source="Яндекс OAuth", retries=0,
        data={
            "grant_type": "refresh_token",
            "refresh_token": token["refresh_token"],
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )
    return _with_expiry({**token, **fresh})


def _auth(access_token: str) -> dict:
    return {"Authorization": f"OAuth {access_token}"}


# Webmaster

async def wm_user_id(client: httpx.AsyncClient, access_token: str) -> int:
    body = await request_json(client, "GET", f"{WEBMASTER}/user", source="Яндекс Вебмастер", headers=_auth(access_token))
    return body["user_id"]


async def wm_hosts(client: httpx.AsyncClient, access_token: str, user_id: int) -> list[dict]:
    body = await request_json(
        client, "GET", f"{WEBMASTER}/user/{user_id}/hosts", source="Яндекс Вебмастер", headers=_auth(access_token)
    )
    return [h for h in body.get("hosts", []) if h.get("verified")]


def _host(user_id: int, host_id: str) -> str:
    return f"{WEBMASTER}/user/{user_id}/hosts/{quote(host_id, safe='')}"


async def wm_summary(client: httpx.AsyncClient, access_token: str, user_id: int, host_id: str) -> dict:
    return await request_json(
        client, "GET", f"{_host(user_id, host_id)}/summary", source="Яндекс Вебмастер", headers=_auth(access_token)
    )


async def wm_diagnostics(client: httpx.AsyncClient, access_token: str, user_id: int, host_id: str) -> dict:
    body = await request_json(
        client, "GET", f"{_host(user_id, host_id)}/diagnostics", source="Яндекс Вебмастер", headers=_auth(access_token)
    )
    return body.get("problems", {})


async def wm_popular_queries(client: httpx.AsyncClient, access_token: str, user_id: int, host_id: str, limit: int = 25) -> list[dict]:
    body = await request_json(
        client, "GET", f"{_host(user_id, host_id)}/search-queries/popular",
        source="Яндекс Вебмастер", headers=_auth(access_token),
        params=[
            ("order_by", "TOTAL_SHOWS"),
            ("query_indicator", "TOTAL_SHOWS"),
            ("query_indicator", "TOTAL_CLICKS"),
            ("query_indicator", "AVG_SHOW_POSITION"),
            ("limit", str(limit)),
        ],
    )
    return body.get("queries", [])


# Metrika

async def metrika_counters(client: httpx.AsyncClient, access_token: str) -> list[dict]:
    body = await request_json(
        client, "GET", f"{METRIKA}/management/v1/counters", source="Яндекс Метрика",
        headers=_auth(access_token), params={"per_page": 1000},
    )
    return body.get("counters", [])


async def metrika_daily(client: httpx.AsyncClient, access_token: str, counter_id: int, *, start: str, end: str) -> list[dict]:
    """Daily visits and users as [{"date", "visits", "users"}]."""
    body = await request_json(
        client, "GET", f"{METRIKA}/stat/v1/data/bytime", source="Яндекс Метрика", headers=_auth(access_token),
        params={"ids": counter_id, "metrics": "ym:s:visits,ym:s:users", "date1": start, "date2": end, "group": "day"},
    )
    series = body.get("data", [{}])[0].get("metrics", [[], []]) if body.get("data") else [[], []]
    days = [interval[0] for interval in body.get("time_intervals", [])]
    visits, users = (series + [[], []])[:2]
    return [
        {"date": day, "visits": visits[i] if i < len(visits) else 0, "users": users[i] if i < len(users) else 0}
        for i, day in enumerate(days)
    ]


async def metrika_sources(client: httpx.AsyncClient, access_token: str, counter_id: int, *, start: str, end: str) -> list[dict]:
    body = await request_json(
        client, "GET", f"{METRIKA}/stat/v1/data", source="Яндекс Метрика", headers=_auth(access_token),
        params={
            "ids": counter_id,
            "metrics": "ym:s:visits",
            "dimensions": "ym:s:lastsignTrafficSource",
            "date1": start,
            "date2": end,
            "sort": "-ym:s:visits",
            "limit": 20,
        },
    )
    return [
        {"source": (row.get("dimensions") or [{}])[0].get("name", "—"), "visits": (row.get("metrics") or [0])[0]}
        for row in body.get("data", [])
    ]


# Wordstat

async def wordstat_top_requests(client: httpx.AsyncClient, token: str, phrase: str, regions: list[int] | None = None) -> dict:
    """Search volume for a phrase plus the popular queries that contain it."""
    payload: dict = {"phrase": phrase}
    if regions:
        payload["regions"] = regions
    body = await request_json(
        client, "POST", f"{WORDSTAT}/v1/topRequests", source="Wordstat",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json;charset=utf-8"},
        json=payload,
    )
    return {
        "phrase": body.get("requestPhrase", phrase),
        "total": body.get("totalCount"),
        "top": [{"phrase": r.get("phrase", ""), "count": r.get("count")} for r in body.get("topRequests", [])],
        "related": [{"phrase": r.get("phrase", ""), "count": r.get("count")} for r in body.get("associations", [])],
    }
