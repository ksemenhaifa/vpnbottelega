"""Google OAuth, Search Console and Analytics (GA4) clients.

Only read-only scopes are requested.
"""
from __future__ import annotations

import time
from urllib.parse import quote, urlencode

import httpx

from .http import ApiError, request_json

SCOPES = (
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/analytics.readonly",
)
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
GSC = "https://www.googleapis.com/webmasters/v3"
INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
GA_ADMIN = "https://analyticsadmin.googleapis.com/v1beta"
GA_DATA = "https://analyticsdata.googleapis.com/v1beta"


def authorize_url(client_id: str, redirect_uri: str, state: str) -> str:
    return AUTH_URL + "?" + urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            # offline + consent: Google returns a refresh token every time.
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
    )


def _with_expiry(token: dict) -> dict:
    token["expires_at"] = time.time() + float(token.get("expires_in", 3600))
    return token


async def exchange_code(client: httpx.AsyncClient, client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    token = await request_json(
        client, "POST", TOKEN_URL, source="Google OAuth", retries=0,
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
    )
    if not token.get("refresh_token"):
        raise ApiError("Google OAuth", None, "Google не выдал refresh_token — отзовите доступ приложения и подключите заново")
    return _with_expiry(token)


async def refresh(client: httpx.AsyncClient, client_id: str, client_secret: str, token: dict) -> dict:
    fresh = await request_json(
        client, "POST", TOKEN_URL, source="Google OAuth", retries=0,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": token["refresh_token"],
            "grant_type": "refresh_token",
        },
    )
    return _with_expiry({**token, **fresh})


def _auth(access_token: str) -> dict:
    return {"Authorization": f"Bearer {access_token}"}


# Search Console

async def gsc_sites(client: httpx.AsyncClient, access_token: str) -> list[dict]:
    body = await request_json(client, "GET", f"{GSC}/sites", source="Search Console", headers=_auth(access_token))
    return [s for s in body.get("siteEntry", []) if s.get("permissionLevel") != "siteUnverifiedUser"]


async def gsc_search_analytics(
    client: httpx.AsyncClient, access_token: str, site_url: str, *,
    start: str, end: str, dimensions: list[str], row_limit: int = 1000,
) -> list[dict]:
    body = await request_json(
        client, "POST", f"{GSC}/sites/{quote(site_url, safe='')}/searchAnalytics/query",
        source="Search Console", headers=_auth(access_token),
        json={"startDate": start, "endDate": end, "dimensions": dimensions, "rowLimit": row_limit},
    )
    return body.get("rows", [])


async def gsc_sitemaps(client: httpx.AsyncClient, access_token: str, site_url: str) -> list[dict]:
    body = await request_json(
        client, "GET", f"{GSC}/sites/{quote(site_url, safe='')}/sitemaps",
        source="Search Console", headers=_auth(access_token),
    )
    return body.get("sitemap", [])


async def gsc_inspect(client: httpx.AsyncClient, access_token: str, site_url: str, url: str) -> dict:
    body = await request_json(
        client, "POST", INSPECT_URL, source="Search Console", headers=_auth(access_token),
        json={"inspectionUrl": url, "siteUrl": site_url, "languageCode": "ru"},
    )
    return body.get("inspectionResult", {}).get("indexStatusResult", {})


# Analytics (GA4)

async def ga4_properties(client: httpx.AsyncClient, access_token: str) -> list[dict]:
    """Every GA4 property the account can read, with the site URL of its web stream."""
    properties: list[dict] = []
    page_token = ""
    while True:
        params = {"pageSize": 200}
        if page_token:
            params["pageToken"] = page_token
        body = await request_json(
            client, "GET", f"{GA_ADMIN}/accountSummaries", source="Google Analytics",
            headers=_auth(access_token), params=params,
        )
        for account in body.get("accountSummaries", []):
            for prop in account.get("propertySummaries", []):
                properties.append({"property": prop["property"], "name": prop.get("displayName", ""), "urls": []})
        page_token = body.get("nextPageToken", "")
        if not page_token:
            break
    for prop in properties:
        streams = await request_json(
            client, "GET", f"{GA_ADMIN}/{prop['property']}/dataStreams", source="Google Analytics",
            headers=_auth(access_token),
        )
        prop["urls"] = [
            s["webStreamData"]["defaultUri"]
            for s in streams.get("dataStreams", [])
            if s.get("webStreamData", {}).get("defaultUri")
        ]
    return properties


async def ga4_report(
    client: httpx.AsyncClient, access_token: str, property_name: str, *,
    start: str, end: str, dimensions: list[str], metrics: list[str], limit: int = 1000,
) -> list[dict]:
    """Rows as {"dimension": value, ..., "metric": float, ...}."""
    body = await request_json(
        client, "POST", f"{GA_DATA}/{property_name}:runReport", source="Google Analytics",
        headers=_auth(access_token),
        json={
            "dateRanges": [{"startDate": start, "endDate": end}],
            "dimensions": [{"name": d} for d in dimensions],
            "metrics": [{"name": m} for m in metrics],
            "limit": limit,
        },
    )
    rows = []
    for row in body.get("rows", []):
        item: dict = {d: v.get("value", "") for d, v in zip(dimensions, row.get("dimensionValues", []))}
        for m, v in zip(metrics, row.get("metricValues", [])):
            item[m] = float(v.get("value") or 0)
        rows.append(item)
    return rows
