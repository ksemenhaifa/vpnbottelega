"""Pulls data from every connected source into the local cache."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import date, timedelta
from typing import Awaitable, Callable

import httpx

from . import audit as audit_mod
from .config import Settings
from .connectors import google, yandex
from .connectors.http import ApiError
from .db import Store
from .sites import build_site_index

log = logging.getLogger("seo-panel")

PERIOD_DAYS = 28
GSC_LAG_DAYS = 3  # Search Console publishes final data a few days late
MAX_INSPECT_URLS = 10


def periods(today: date, lag: int) -> dict:
    """Current and previous 28-day windows, both ending `lag` days ago."""
    cur_end = today - timedelta(days=lag)
    cur_start = cur_end - timedelta(days=PERIOD_DAYS - 1)
    prev_end = cur_start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=PERIOD_DAYS - 1)
    return {"cur": (cur_start.isoformat(), cur_end.isoformat()), "prev": (prev_start.isoformat(), prev_end.isoformat())}


def sum_period(daily: list[dict], window: tuple[str, str], fields: tuple[str, ...]) -> dict:
    rows = [r for r in daily if window[0] <= r["date"] <= window[1]]
    return {f: sum(r.get(f) or 0 for r in rows) for f in fields}


def _error_text(exc: Exception) -> str:
    return str(exc) if isinstance(exc, ApiError) else f"внутренняя ошибка ({type(exc).__name__})"


class Refresher:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        client: httpx.AsyncClient,
        *,
        host_checker: audit_mod.HostChecker = audit_mod.is_public_host,
        today: Callable[[], date] = date.today,
    ):
        self.settings = settings
        self.store = store
        self.client = client
        self.host_checker = host_checker
        self.today = today
        self.state = {"running": False, "started_at": None, "finished_at": None, "step": ""}
        self._task: asyncio.Task | None = None
        self._token_lock = asyncio.Lock()

    # tokens

    async def _fresh_token(self, provider: str, refresh: Callable[[dict], Awaitable[dict]]) -> str | None:
        async with self._token_lock:
            token = self.store.get_token(provider)
            if not token:
                return None
            if token.get("refresh_token") and token.get("expires_at", 0) < time.time() + 120:
                token = await refresh(token)
                self.store.set_token(provider, token)
            return token.get("access_token")

    async def google_token(self) -> str | None:
        s = self.settings
        return await self._fresh_token(
            "google", lambda t: google.refresh(self.client, s.google_client_id, s.google_client_secret, t)
        )

    async def yandex_token(self) -> str | None:
        s = self.settings
        return await self._fresh_token(
            "yandex", lambda t: yandex.refresh(self.client, s.yandex_client_id, s.yandex_client_secret, t)
        )

    async def wordstat_token(self) -> str | None:
        return self.settings.wordstat_token or await self.yandex_token()

    # orchestration

    def start(self) -> bool:
        """Start a refresh in the background; False if one is already running."""
        if self.state["running"]:
            return False
        self._task = asyncio.create_task(self.run())
        return True

    async def run(self) -> None:
        if self.state["running"]:
            return
        self.state.update(running=True, started_at=time.time(), step="Список сайтов")
        try:
            index = await self._discover()
            gate = asyncio.Semaphore(3)
            done = 0

            async def one(site: dict) -> None:
                nonlocal done
                async with gate:
                    await self._refresh_site(site)
                done += 1
                self.state["step"] = f"Сайты: {done} из {len(index)}"

            await asyncio.gather(*(one(site) for site in index.values()))
        except Exception:  # keep the service alive; the next run retries
            log.exception("refresh failed")
        finally:
            self.state.update(running=False, finished_at=time.time(), step="")

    async def _capture(self, key: str, fetch: Callable[[], Awaitable]) -> object | None:
        """Run one fetch and cache its result or its error message."""
        try:
            data = await fetch()
        except Exception as exc:
            if not isinstance(exc, ApiError):
                log.exception("fetch %s failed", key)
            self.store.put(key, error=_error_text(exc))
            return None
        self.store.put(key, data)
        return data

    async def _discover(self) -> dict[str, dict]:
        gsc_sites: list = []
        ga4_props: list = []
        wm_hosts: list = []
        counters: list = []

        try:
            g_token = await self.google_token()
        except ApiError as exc:
            g_token = None
            self.store.put("disc:gsc", error=str(exc))
        if g_token:
            gsc_sites = await self._capture("disc:gsc", lambda: google.gsc_sites(self.client, g_token)) or []
            ga4_props = await self._capture("disc:ga4", lambda: google.ga4_properties(self.client, g_token)) or []

        try:
            y_token = await self.yandex_token()
        except ApiError as exc:
            y_token = None
            self.store.put("disc:ywm", error=str(exc))
        if y_token:
            async def hosts() -> dict:
                user_id = await yandex.wm_user_id(self.client, y_token)
                return {"user_id": user_id, "hosts": await yandex.wm_hosts(self.client, y_token, user_id)}

            wm = await self._capture("disc:ywm", hosts) or {}
            wm_hosts = wm.get("hosts", [])
            counters = await self._capture("disc:ym", lambda: yandex.metrika_counters(self.client, y_token)) or []

        index = build_site_index(
            gsc_sites=gsc_sites, ga4_properties=ga4_props, wm_hosts=wm_hosts,
            metrika_counters=counters, manual=self.store.manual_sites(),
        )
        self.store.put("sites", index)
        return index

    async def _refresh_site(self, site: dict) -> None:
        domain = site["domain"]
        jobs = [self._capture(f"audit:{domain}", lambda: audit_mod.audit_site(
            self.client, domain, self.store.site_urls(domain), host_checker=self.host_checker))]
        if site.get("gsc") or site.get("ga4"):
            try:
                token = await self.google_token()
            except ApiError:
                token = None
            if token and site.get("gsc"):
                jobs.append(self._capture(f"gsc:{domain}", lambda: self._gsc(token, domain, site["gsc"])))
            if token and site.get("ga4"):
                jobs.append(self._capture(f"ga4:{domain}", lambda: self._ga4(token, site["ga4"])))
        if site.get("ywm") or site.get("ym"):
            try:
                token_y = await self.yandex_token()
            except ApiError:
                token_y = None
            if token_y and site.get("ywm"):
                jobs.append(self._capture(f"ywm:{domain}", lambda: self._ywm(token_y, site["ywm"])))
            if token_y and site.get("ym"):
                jobs.append(self._capture(f"ym:{domain}", lambda: self._ym(token_y, site["ym"])))
        await asyncio.gather(*jobs)

    # per-source fetchers

    async def _gsc(self, token: str, domain: str, site_url: str) -> dict:
        p = periods(self.today(), GSC_LAG_DAYS)
        start, end = p["prev"][0], p["cur"][1]
        by_date, queries, pages, sitemaps = await asyncio.gather(
            google.gsc_search_analytics(self.client, token, site_url, start=start, end=end, dimensions=["date"]),
            google.gsc_search_analytics(self.client, token, site_url, start=p["cur"][0], end=p["cur"][1],
                                        dimensions=["query"], row_limit=50),
            google.gsc_search_analytics(self.client, token, site_url, start=p["cur"][0], end=p["cur"][1],
                                        dimensions=["page"], row_limit=50),
            google.gsc_sitemaps(self.client, token, site_url),
        )
        daily = [
            {"date": r["keys"][0], "clicks": r.get("clicks", 0), "impressions": r.get("impressions", 0),
             "position": r.get("position", 0)}
            for r in by_date
        ]

        def totals(window: tuple[str, str]) -> dict:
            rows = [r for r in daily if window[0] <= r["date"] <= window[1]]
            clicks = sum(r["clicks"] for r in rows)
            shown = sum(r["impressions"] for r in rows)
            return {
                "clicks": clicks,
                "impressions": shown,
                "ctr": clicks / shown if shown else None,
                "position": sum(r["position"] * r["impressions"] for r in rows) / shown if shown else None,
            }

        def table(rows: list[dict], name: str) -> list[dict]:
            return [
                {name: r["keys"][0], "clicks": r.get("clicks", 0), "impressions": r.get("impressions", 0),
                 "ctr": r.get("ctr"), "position": r.get("position")}
                for r in rows
            ]

        home = f"https://{domain}/"
        targets = list(dict.fromkeys([home] + self.store.site_urls(domain)))[:MAX_INSPECT_URLS]
        inspections = []
        for url in targets:
            item = {"url": url, "is_home": url == home, "error": None}
            try:
                item.update(await google.gsc_inspect(self.client, token, site_url, url))
            except ApiError as exc:
                item["error"] = str(exc)
            inspections.append(item)

        return {
            "site_url": site_url,
            "range": p,
            "daily": daily,
            "cur": totals(p["cur"]),
            "prev": totals(p["prev"]),
            "queries": table(queries, "query"),
            "pages": table(pages, "page"),
            "sitemaps": [
                {"path": s.get("path"), "errors": s.get("errors"), "warnings": s.get("warnings"),
                 "last_downloaded": s.get("lastDownloaded"), "pending": s.get("isPending", False)}
                for s in sitemaps
            ],
            "inspections": inspections,
        }

    async def _ga4(self, token: str, property_name: str) -> dict:
        p = periods(self.today(), 1)
        by_date, channels = await asyncio.gather(
            google.ga4_report(self.client, token, property_name, start=p["prev"][0], end=p["cur"][1],
                              dimensions=["date"], metrics=["sessions", "totalUsers"]),
            google.ga4_report(self.client, token, property_name, start=p["cur"][0], end=p["cur"][1],
                              dimensions=["sessionDefaultChannelGroup"], metrics=["sessions"], limit=20),
        )
        daily = sorted(
            ({"date": f"{r['date'][:4]}-{r['date'][4:6]}-{r['date'][6:]}", "sessions": r["sessions"], "users": r["totalUsers"]}
             for r in by_date),
            key=lambda r: r["date"],
        )
        return {
            "property": property_name,
            "range": p,
            "daily": daily,
            "cur": sum_period(daily, p["cur"], ("sessions", "users")),
            "prev": sum_period(daily, p["prev"], ("sessions", "users")),
            "channels": sorted(
                ({"channel": r["sessionDefaultChannelGroup"], "sessions": r["sessions"]} for r in channels),
                key=lambda r: -r["sessions"],
            ),
        }

    async def _ywm(self, token: str, host_id: str) -> dict:
        user_id = (self.store.data("disc:ywm") or {}).get("user_id") or await yandex.wm_user_id(self.client, token)
        summary, problems, queries = await asyncio.gather(
            yandex.wm_summary(self.client, token, user_id, host_id),
            yandex.wm_diagnostics(self.client, token, user_id, host_id),
            yandex.wm_popular_queries(self.client, token, user_id, host_id),
        )
        return {
            "host_id": host_id,
            "sqi": summary.get("sqi"),
            "searchable": summary.get("searchable_pages_count"),
            "excluded": summary.get("excluded_pages_count"),
            "problems": [
                {"code": code, "severity": info.get("severity", ""), "updated": info.get("last_state_update")}
                for code, info in problems.items()
                if info.get("state") == "PRESENT"
            ],
            "queries": [
                {"query": q.get("query_text", ""),
                 "shows": (q.get("indicators") or {}).get("TOTAL_SHOWS"),
                 "clicks": (q.get("indicators") or {}).get("TOTAL_CLICKS"),
                 "position": (q.get("indicators") or {}).get("AVG_SHOW_POSITION")}
                for q in queries
            ],
        }

    async def _ym(self, token: str, counter_id: int) -> dict:
        p = periods(self.today(), 1)
        daily, sources = await asyncio.gather(
            yandex.metrika_daily(self.client, token, counter_id, start=p["prev"][0], end=p["cur"][1]),
            yandex.metrika_sources(self.client, token, counter_id, start=p["cur"][0], end=p["cur"][1]),
        )
        return {
            "counter_id": counter_id,
            "range": p,
            "daily": daily,
            "cur": sum_period(daily, p["cur"], ("visits", "users")),
            "prev": sum_period(daily, p["prev"], ("visits", "users")),
            "sources": sources,
        }

    async def periodic(self) -> None:
        """Refresh on a timer for as long as the service runs."""
        interval = max(self.settings.refresh_hours, 0.25) * 3600
        while True:
            entry = self.store.get("sites")
            age = time.time() - entry["fetched_at"] if entry else None
            if age is None or age >= interval:
                await self.run()
                age = 0
            await asyncio.sleep(max(interval - age, 60))
