"""Domain normalisation and matching of one site across all data sources."""
from __future__ import annotations

import re
from urllib.parse import urlparse

_DOMAIN_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$")


def normalize_domain(value: str) -> str:
    """Reduce a URL, GSC property or host name to a bare ASCII domain ("" if invalid).

    "https://www.Example.com/x", "sc-domain:example.com" and "example.com" all
    map to "example.com"; Cyrillic domains map to their punycode form.
    """
    text = (value or "").strip().lower()
    if text.startswith("sc-domain:"):
        text = text[len("sc-domain:"):]
    if "://" in text:
        text = urlparse(text).hostname or ""
    else:
        text = text.split("/")[0].split(":")[0]
    text = text.strip(".")
    if text.startswith("www."):
        text = text[4:]
    try:
        text = text.encode("idna").decode("ascii")
    except UnicodeError:
        return ""
    return text if _DOMAIN_RE.match(text) else ""


def display_domain(domain: str) -> str:
    try:
        return domain.encode("ascii").decode("idna")
    except UnicodeError:
        return domain


def _gsc_rank(site_url: str) -> int:
    """Lower is better: a domain property covers every protocol and subdomain."""
    if site_url.startswith("sc-domain:"):
        return 0
    if site_url.startswith("https://") and "://www." not in site_url:
        return 1
    if site_url.startswith("https://"):
        return 2
    return 3


def build_site_index(
    *,
    gsc_sites: list[dict],
    ga4_properties: list[dict],
    wm_hosts: list[dict],
    metrika_counters: list[dict],
    manual: list[str],
) -> dict[str, dict]:
    """Map each domain to the identifiers it has in every connected source."""
    index: dict[str, dict] = {}

    def entry(domain: str) -> dict:
        return index.setdefault(domain, {"domain": domain, "name": display_domain(domain)})

    for site in gsc_sites:
        domain = normalize_domain(site.get("siteUrl", ""))
        if not domain:
            continue
        current = entry(domain).get("gsc")
        if current is None or _gsc_rank(site["siteUrl"]) < _gsc_rank(current):
            entry(domain)["gsc"] = site["siteUrl"]

    for prop in ga4_properties:
        for url in prop.get("urls", []):
            domain = normalize_domain(url)
            if domain:
                entry(domain).setdefault("ga4", prop["property"])

    for host in wm_hosts:
        domain = normalize_domain(host.get("ascii_host_url", ""))
        if not domain:
            continue
        # Prefer the https host when both protocols are registered.
        if "ywm" not in entry(domain) or str(host.get("host_id", "")).startswith("https:"):
            entry(domain)["ywm"] = host["host_id"]

    for counter in metrika_counters:
        domain = normalize_domain(counter.get("site") or (counter.get("site2") or {}).get("site", ""))
        if domain:
            entry(domain).setdefault("ym", counter["id"])

    for domain in manual:
        entry(domain)["manual"] = True

    return dict(sorted(index.items(), key=lambda kv: kv[1]["name"]))
