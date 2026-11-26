"""A fake internet for tests and local preview: Google, Yandex and one small site.

Nothing here is real data. tests/preview.py serves the panel on top of it so
the UI can be looked at without any credentials.
"""
from __future__ import annotations

import json
import math
from datetime import date, timedelta
from urllib.parse import unquote

import httpx

SITE = "example-shop.ru"
PASSWORD = "correct horse battery"

ROBOTS = """User-agent: *
Disallow: /cart/
Disallow: /*?sort=
Allow: /

User-agent: Yandex
Disallow: /cart/
Disallow: /promo/

Sitemap: https://example-shop.ru/sitemap.xml
"""

PAGES = {
    "/": ('<html><head><title>Example Shop — фильтры для воды</title>'
          '<link rel="canonical" href="https://example-shop.ru/"></head><body>ok</body></html>'),
    "/catalog/": '<html><head><title>Каталог</title><link rel="canonical" href="https://example-shop.ru/catalog/"></head></html>',
    "/promo/": '<html><head><title>Акция</title><meta name="robots" content="noindex, follow"></head></html>',
    "/delivery/": '<html><head><title>Доставка</title><link rel="canonical" href="https://example-shop.ru/dostavka/"></head></html>',
    "/dostavka/": '<html><head><title>Доставка</title></head></html>',
    "/cart/": '<html><head><title>Корзина</title></head></html>',
}
SITEMAP_PATHS = ["/", "/catalog/", "/promo/", "/delivery/", "/old-page/", "/gone/", "/cart/"]


def _sitemap() -> str:
    urls = "".join(f"<url><loc>https://{SITE}{p}</loc></url>" for p in SITEMAP_PATHS)
    return f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>'


def _site(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/robots.txt":
        return httpx.Response(200, text=ROBOTS, headers={"content-type": "text/plain"})
    if path == "/sitemap.xml":
        return httpx.Response(200, text=_sitemap(), headers={"content-type": "application/xml"})
    if path == "/old-page/":
        return httpx.Response(301, headers={"location": "/catalog/"})
    if path in PAGES:
        return httpx.Response(200, text=PAGES[path], headers={"content-type": "text/html; charset=utf-8"})
    return httpx.Response(404, text="not found", headers={"content-type": "text/html"})


def _wave(day: date, base: float, swing: float) -> int:
    return max(0, round(base + swing * math.sin(day.toordinal() / 3.0) + (day.toordinal() % 7) * swing / 6))


def _days(start: str, end: str) -> list[date]:
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]


def _google(request: httpx.Request) -> httpx.Response:
    host, path = request.url.host, unquote(request.url.path)
    body = json.loads(request.content) if request.content and request.headers.get("content-type", "").startswith("application/json") else {}
    if host == "oauth2.googleapis.com":
        return httpx.Response(200, json={"access_token": "g-access", "refresh_token": "g-refresh", "expires_in": 3600})
    if request.headers.get("authorization") != "Bearer g-access":
        return httpx.Response(401, json={"error": {"message": "Invalid Credentials"}})
    if path.endswith("/webmasters/v3/sites"):
        return httpx.Response(200, json={"siteEntry": [
            {"siteUrl": f"https://{SITE}/", "permissionLevel": "siteOwner"},
            {"siteUrl": f"sc-domain:{SITE}", "permissionLevel": "siteOwner"},
            {"siteUrl": "https://someone-else.ru/", "permissionLevel": "siteUnverifiedUser"},
        ]})
    if path.endswith("/searchAnalytics/query"):
        dims = body.get("dimensions", [])
        if dims == ["date"]:
            rows = [{"keys": [d.isoformat()], "clicks": _wave(d, 40, 12), "impressions": _wave(d, 900, 200),
                     "ctr": 0.04, "position": 11.5} for d in _days(body["startDate"], body["endDate"])]
        elif dims == ["query"]:
            rows = [{"keys": ["фильтр для воды самара"], "clicks": 210, "impressions": 4100, "ctr": 0.051, "position": 6.2},
                    {"keys": ["обратный осмос купить"], "clicks": 95, "impressions": 3900, "ctr": 0.024, "position": 14.8}]
        else:
            rows = [{"keys": [f"https://{SITE}/catalog/"], "clicks": 300, "impressions": 7000, "ctr": 0.043, "position": 9.1}]
        return httpx.Response(200, json={"rows": rows})
    if path.endswith("/sitemaps"):
        return httpx.Response(200, json={"sitemap": [
            {"path": f"https://{SITE}/sitemap.xml", "errors": "0", "warnings": "2",
             "lastDownloaded": "2026-11-20T08:00:00Z", "isPending": False}]})
    if path.endswith("urlInspection/index:inspect"):
        blocked = body["inspectionUrl"].endswith("/promo/")
        return httpx.Response(200, json={"inspectionResult": {"indexStatusResult": {
            "verdict": "NEUTRAL" if blocked else "PASS",
            "coverageState": "Excluded by 'noindex' tag" if blocked else "Submitted and indexed",
            "robotsTxtState": "ALLOWED",
            "indexingState": "BLOCKED_BY_META_TAG" if blocked else "INDEXING_ALLOWED",
            "lastCrawlTime": "2026-11-22T05:10:00Z"}}})
    if path.endswith("/accountSummaries"):
        return httpx.Response(200, json={"accountSummaries": [{"propertySummaries": [
            {"property": "properties/111", "displayName": "Example Shop"}]}]})
    if path.endswith("/dataStreams"):
        return httpx.Response(200, json={"dataStreams": [{"webStreamData": {"defaultUri": f"https://www.{SITE}"}}]})
    if path.endswith(":runReport"):
        rng = body["dateRanges"][0]
        if body["dimensions"][0]["name"] == "date":
            rows = [{"dimensionValues": [{"value": d.strftime("%Y%m%d")}],
                     "metricValues": [{"value": str(_wave(d, 120, 30))}, {"value": str(_wave(d, 95, 25))}]}
                    for d in _days(rng["startDate"], rng["endDate"])]
        else:
            rows = [{"dimensionValues": [{"value": name}], "metricValues": [{"value": str(v)}]}
                    for name, v in (("Organic Search", 2100), ("Direct", 640), ("Referral", 180), ("Organic Social", 75))]
        return httpx.Response(200, json={"rows": rows})
    return httpx.Response(404, json={"error": {"message": f"fake: no route {path}"}})


def _yandex(request: httpx.Request) -> httpx.Response:
    host, path = request.url.host, unquote(request.url.path)
    if host == "oauth.yandex.ru":
        return httpx.Response(200, json={"access_token": "y-access", "refresh_token": "y-refresh", "expires_in": 31536000})
    if host == "api.wordstat.yandex.net":
        if request.headers.get("authorization") != "Bearer y-access":
            return httpx.Response(401, json={"message": "Unauthorized"})
        phrase = json.loads(request.content)["phrase"]
        return httpx.Response(200, json={
            "requestPhrase": phrase, "totalCount": 18400,
            "topRequests": [{"phrase": phrase, "count": 18400}, {"phrase": phrase + " цена", "count": 3100}],
            "associations": [{"phrase": "очистка воды", "count": 9200}]})
    if request.headers.get("authorization") != "OAuth y-access":
        return httpx.Response(403, json={"error_message": "Invalid OAuth token"})
    if host == "api.webmaster.yandex.net":
        if path.endswith("/user"):
            return httpx.Response(200, json={"user_id": 42})
        if path.endswith("/hosts"):
            return httpx.Response(200, json={"hosts": [
                {"host_id": f"https:{SITE}:443", "ascii_host_url": f"https://{SITE}/", "verified": True},
                {"host_id": "https:unverified.ru:443", "ascii_host_url": "https://unverified.ru/", "verified": False}]})
        if path.endswith("/summary"):
            return httpx.Response(200, json={"sqi": 30, "searchable_pages_count": 184, "excluded_pages_count": 57})
        if path.endswith("/diagnostics"):
            return httpx.Response(200, json={"problems": {
                "ERRORS_IN_SITEMAPS": {"severity": "POSSIBLE_PROBLEM", "state": "PRESENT", "last_state_update": "2026-11-18T00:00:00Z"},
                "NO_ROBOTS_TXT": {"severity": "POSSIBLE_PROBLEM", "state": "ABSENT"}}})
        if path.endswith("/search-queries/popular"):
            return httpx.Response(200, json={"queries": [
                {"query_text": "фильтр для воды", "indicators": {"TOTAL_SHOWS": 5200, "TOTAL_CLICKS": 310, "AVG_SHOW_POSITION": 7.4}}]})
    if host == "api-metrika.yandex.net":
        params = request.url.params
        if path.endswith("/management/v1/counters"):
            return httpx.Response(200, json={"counters": [{"id": 7001, "name": "Example Shop", "site": SITE}]})
        if path.endswith("/stat/v1/data/bytime"):
            days = _days(params["date1"], params["date2"])
            return httpx.Response(200, json={
                "time_intervals": [[d.isoformat(), d.isoformat()] for d in days],
                "data": [{"metrics": [[_wave(d, 150, 40) for d in days], [_wave(d, 110, 30) for d in days]]}]})
        if path.endswith("/stat/v1/data"):
            return httpx.Response(200, json={"data": [
                {"dimensions": [{"name": "Переходы из поисковых систем"}], "metrics": [2900]},
                {"dimensions": [{"name": "Прямые заходы"}], "metrics": [820]},
                {"dimensions": [{"name": "Переходы по ссылкам на сайтах"}], "metrics": [140]}]})
    return httpx.Response(404, json={"error_message": f"fake: no route {host}{path}"})


def handler(request: httpx.Request) -> httpx.Response:
    host = request.url.host
    if host in (SITE, f"www.{SITE}"):
        return _site(request)
    if host.endswith("googleapis.com"):
        return _google(request)
    if "yandex" in host:
        return _yandex(request)
    raise httpx.ConnectError(f"fake internet: {host} is unreachable", request=request)


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def any_host(host: str) -> bool:
    return True
