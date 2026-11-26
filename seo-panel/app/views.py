"""Builds template contexts from the cache; formatting filters for the UI."""
from __future__ import annotations

import time
from datetime import datetime

from .config import Settings
from .db import Store
from .issues import SEVERITY_LABEL, site_issues, worst

NBSP = " "
SOURCES = (
    ("gsc", "Google Search Console"),
    ("ga4", "Google Analytics"),
    ("ywm", "Яндекс Вебмастер"),
    ("ym", "Яндекс Метрика"),
    ("audit", "Проверка сайта"),
)


def wordstat_key(phrase: str, regions: str) -> str:
    return f"ws:{regions}|{phrase}"


# formatting

def fmt_num(value) -> str:
    if value is None:
        return "—"
    if isinstance(value, float) and not value.is_integer():
        return f"{value:,.1f}".replace(",", NBSP).replace(".", ",")
    return f"{int(value):,}".replace(",", NBSP)


def fmt_pct(value) -> str:
    return "—" if value is None else f"{value * 100:.1f}".replace(".", ",") + f"{NBSP}%"


def fmt_pos(value) -> str:
    return "—" if value is None else f"{value:.1f}".replace(".", ",")


def fmt_when(timestamp) -> str:
    if not timestamp:
        return "ещё не обновлялось"
    return datetime.fromtimestamp(timestamp).strftime("%d.%m.%Y %H:%M")


def fmt_day(iso: str | None) -> str:
    if not iso:
        return "—"
    try:
        return datetime.fromisoformat(iso[:10]).strftime("%d.%m.%Y")
    except ValueError:
        return iso


def delta(cur, prev, lower_is_better: bool = False) -> dict | None:
    """Change against the previous period, or None when it cannot be computed."""
    if cur is None or prev is None or not prev:
        return None
    change = (cur - prev) / prev
    if abs(change) < 0.005:
        return {"text": f"0{NBSP}%", "tone": "flat", "arrow": "→"}
    improved = (change < 0) if lower_is_better else (change > 0)
    return {
        "text": f"{'+' if change > 0 else '−'}{abs(change) * 100:.0f}{NBSP}%",
        "tone": "up" if improved else "down",
        "arrow": "↑" if change > 0 else "↓",
    }


def register_filters(env) -> None:
    env.filters.update(num=fmt_num, pct=fmt_pct, pos=fmt_pos, when=fmt_when, day=fmt_day)
    env.globals.update(delta=delta, severity_label=SEVERITY_LABEL)


# contexts

def _site_data(store: Store, domain: str) -> dict:
    data, errors = {}, {}
    for key, label in SOURCES:
        entry = store.get(f"{key}:{domain}")
        data[key] = entry["data"] if entry else None
        if entry and entry["error"]:
            errors[label] = entry["error"]
    return {"data": data, "errors": errors}


def _total(rows: list[dict], source: str, period: str, field: str):
    values = [r[source][period][field] for r in rows if r.get(source)]
    return sum(values) if values else None


def overview(store: Store, settings: Settings) -> dict:
    index = store.data("sites", {})
    rows = []
    for domain, site in index.items():
        bundle = _site_data(store, domain)
        d = bundle["data"]
        issues = site_issues(audit=d["audit"], gsc=d["gsc"], ywm=d["ywm"])
        rows.append({
            "domain": domain, "name": site["name"], "site": site,
            "gsc": d["gsc"], "ga4": d["ga4"], "ywm": d["ywm"], "ym": d["ym"],
            "issues": issues, "worst": worst(issues), "errors": bundle["errors"],
            "counts": {s: sum(i["severity"] == s for i in issues) for s in ("critical", "serious", "warning")},
        })
    order = {"critical": 0, "serious": 1, "warning": 2, "good": 3}
    rows.sort(key=lambda r: (order[r["worst"]], r["name"]))
    return {
        "rows": rows,
        "totals": {
            "clicks": _total(rows, "gsc", "cur", "clicks"), "clicks_prev": _total(rows, "gsc", "prev", "clicks"),
            "sessions": _total(rows, "ga4", "cur", "sessions"), "sessions_prev": _total(rows, "ga4", "prev", "sessions"),
            "visits": _total(rows, "ym", "cur", "visits"), "visits_prev": _total(rows, "ym", "prev", "visits"),
            "urgent": sum(r["worst"] == "critical" for r in rows),
        },
        "google_connected": store.get_token("google") is not None,
        "yandex_connected": store.get_token("yandex") is not None,
    }


def _series(daily: list[dict] | None, field: str) -> list[dict]:
    return [{"date": r["date"], "value": r.get(field) or 0} for r in (daily or [])]


def _share_rows(rows: list[dict], label: str, value: str) -> list[dict]:
    top = max((r[value] or 0 for r in rows), default=0)
    return [{"label": r[label], "value": r[value], "share": round((r[value] or 0) / top * 100) if top else 0} for r in rows]


def site(store: Store, domain: str) -> dict | None:
    index = store.data("sites", {})
    if domain not in index:
        return None
    bundle = _site_data(store, domain)
    d = bundle["data"]
    audit = d["audit"]
    problem_pages = []
    if audit:
        for page in audit["pages"]:
            flags = []
            if page["error"]:
                flags.append("не открывается")
            elif page["status"] != 200:
                flags.append(f"код {page['status']}")
            if page["noindex"]:
                flags.append("noindex")
            if page["redirected"]:
                flags.append("редирект")
            if page["blocked_google"]:
                flags.append("закрыта в robots.txt для Google")
            if page["blocked_yandex"]:
                flags.append("закрыта в robots.txt для Яндекса")
            if page["canonical_mismatch"]:
                flags.append("canonical на другой адрес")
            if flags:
                problem_pages.append({**page, "flags": flags})
    return {
        "site": index[domain],
        "d": d,
        "errors": bundle["errors"],
        "issues": site_issues(audit=audit, gsc=d["gsc"], ywm=d["ywm"]),
        "problem_pages": problem_pages,
        "watch_urls": store.site_urls(domain),
        "charts": {
            "gsc_clicks": _series(d["gsc"] and d["gsc"]["daily"], "clicks"),
            "gsc_impressions": _series(d["gsc"] and d["gsc"]["daily"], "impressions"),
            "ga4_sessions": _series(d["ga4"] and d["ga4"]["daily"], "sessions"),
            "ym_visits": _series(d["ym"] and d["ym"]["daily"], "visits"),
        },
        "channels": _share_rows(d["ga4"]["channels"], "channel", "sessions") if d["ga4"] else [],
        "ym_sources": _share_rows(d["ym"]["sources"], "source", "visits") if d["ym"] else [],
    }


def connections(store: Store, settings: Settings) -> dict:
    def source(key: str, label: str) -> dict:
        entry = store.get(key)
        data = entry["data"] if entry else None
        count = len(data.get("hosts", [])) if isinstance(data, dict) else len(data or [])
        return {"label": label, "count": count if entry and data is not None else None,
                "error": entry["error"] if entry else None, "fetched_at": entry["fetched_at"] if entry else None}

    google_token = store.get_token("google")
    yandex_token = store.get_token("yandex")
    return {
        "google": {
            "configured": settings.google_configured,
            "connected": google_token is not None,
            "redirect_uri": f"{settings.base_url}/connect/google/callback",
            "sources": [source("disc:gsc", "Search Console — ресурсов"), source("disc:ga4", "Analytics — ресурсов")],
        },
        "yandex": {
            "configured": settings.yandex_configured,
            "connected": yandex_token is not None,
            "redirect_uri": f"{settings.base_url}/connect/yandex/callback",
            "expires_at": (yandex_token or {}).get("expires_at"),
            "sources": [source("disc:ywm", "Вебмастер — сайтов"), source("disc:ym", "Метрика — счётчиков")],
        },
        "wordstat_separate_token": bool(settings.wordstat_token),
        "now": time.time(),
    }


def keywords(store: Store, settings: Settings) -> dict:
    index = store.data("sites", {})
    items = []
    for row in store.phrases():
        entry = store.get(wordstat_key(row["phrase"], row["regions"]))
        items.append({
            **row,
            "site_name": index.get(row["domain"], {}).get("name", ""),
            "result": entry["data"] if entry else None,
            "error": entry["error"] if entry else None,
            "fetched_at": entry["fetched_at"] if entry else None,
        })
    return {
        "items": items,
        "sites": list(index.values()),
        "ready": bool(settings.wordstat_token) or store.get_token("yandex") is not None,
    }
