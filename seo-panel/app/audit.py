"""Direct technical check of a site: robots.txt, home page and sitemap URLs.

Needs no API access. It answers the questions search consoles only hint at:
which sitemap URLs carry noindex, redirect, return 404 or are blocked by
robots.txt.
"""
from __future__ import annotations

import asyncio
import gzip
import io
import ipaddress
import re
import socket
from html.parser import HTMLParser
from typing import Awaitable, Callable
from urllib.parse import urljoin, urlsplit, urlunsplit
from xml.etree import ElementTree

import httpx

USER_AGENT = "Mozilla/5.0 (compatible; SEO-Panel-Audit/1.0)"
MAX_HTML = 512 * 1024
MAX_SITEMAP = 8 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_SITEMAP_FILES = 6
MAX_SITEMAP_URLS = 5000

HostChecker = Callable[[str], Awaitable[bool]]


async def is_public_host(host: str) -> bool:
    """True only if every address the host resolves to is publicly routable.

    The panel fetches URLs taken from sitemaps; this keeps it from being
    pointed at the server's own internal network.
    """
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    addresses = {info[4][0] for info in infos}
    return bool(addresses) and all(ipaddress.ip_address(a).is_global for a in addresses)


class _Fetcher:
    def __init__(self, client: httpx.AsyncClient, host_checker: HostChecker):
        self.client = client
        self.host_checker = host_checker
        self._verdicts: dict[str, bool] = {}

    async def _allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            return False
        host = parts.hostname
        if host not in self._verdicts:
            self._verdicts[host] = await self.host_checker(host)
        return self._verdicts[host]

    async def get(self, url: str, limit: int) -> dict:
        """Follow redirects by hand so every hop is checked; never raises."""
        chain: list[dict] = []
        current = url
        retries_left = 1
        for _ in range(MAX_REDIRECTS + 2):
            if not await self._allowed(current):
                return {"url": url, "final_url": current, "status": None, "chain": chain,
                        "headers": {}, "body": b"", "error": "адрес недоступен для проверки"}
            try:
                async with self.client.stream(
                    "GET", current, headers={"User-Agent": USER_AGENT}, follow_redirects=False
                ) as response:
                    if response.status_code in (301, 302, 303, 307, 308) and response.headers.get("location"):
                        target = urljoin(current, response.headers["location"])
                        chain.append({"url": current, "status": response.status_code})
                        current = target
                        continue
                    body = b""
                    async for chunk in response.aiter_bytes():
                        body += chunk
                        if len(body) >= limit:
                            break
                    return {"url": url, "final_url": current, "status": response.status_code, "chain": chain,
                            "headers": dict(response.headers), "body": body[:limit], "error": None}
            except httpx.HTTPError as exc:
                if retries_left:
                    retries_left -= 1
                    await asyncio.sleep(1.0)
                    continue
                return {"url": url, "final_url": current, "status": None, "chain": chain,
                        "headers": {}, "body": b"", "error": f"нет ответа ({type(exc).__name__})"}
        return {"url": url, "final_url": current, "status": None, "chain": chain,
                "headers": {}, "body": b"", "error": "слишком длинная цепочка редиректов"}


# robots.txt, matched the way Google and Yandex document it:
# the most specific user-agent group applies, the longest matching rule wins,
# Allow wins a tie, "*" matches any run of characters and "$" anchors the end.

def parse_robots(text: str) -> dict:
    groups: list[dict] = []
    sitemaps: list[str] = []
    current: dict | None = None
    expecting_agents = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        field, value = (part.strip() for part in line.split(":", 1))
        field = field.lower()
        if field == "user-agent":
            if not expecting_agents or current is None:
                current = {"agents": [], "rules": []}
                groups.append(current)
            current["agents"].append(value.lower())
            expecting_agents = True
        elif field in ("allow", "disallow"):
            expecting_agents = False
            if current is not None and value:
                current["rules"].append((field == "allow", value))
        elif field == "sitemap":
            sitemaps.append(value)
        else:
            expecting_agents = False
    return {"groups": groups, "sitemaps": sitemaps}


def _rule_regex(pattern: str) -> re.Pattern:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    regex = "".join(".*" if ch == "*" else re.escape(ch) for ch in body)
    return re.compile(regex + ("$" if anchored else ""))


def robots_rules_for(robots: dict, agent: str) -> list[tuple[bool, str]]:
    agent = agent.lower()
    best: list[tuple[bool, str]] = []
    best_len = -1
    for group in robots["groups"]:
        for name in group["agents"]:
            specificity = 0 if name == "*" else len(name) if name in agent else -1
            if specificity > best_len:
                best, best_len = group["rules"], specificity
    return best


def robots_allows(robots: dict, agent: str, url: str) -> bool:
    parts = urlsplit(url)
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    verdict, length = True, -1
    for allow, pattern in robots_rules_for(robots, agent):
        if _rule_regex(pattern).match(path):
            size = len(pattern)
            if size > length or (size == length and allow):
                verdict, length = allow, size
    return verdict


class _HeadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.robots: list[str] = []
        self.canonical = ""
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta" and values.get("name", "").lower() in {"robots", "googlebot", "yandex"}:
            self.robots.append(values.get("content", "").lower())
        elif tag == "link" and "canonical" in values.get("rel", "").lower().split() and not self.canonical:
            self.canonical = values.get("href", "").strip()
        elif tag == "title" and not self.title:
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data


def _has_noindex(directives: str) -> bool:
    tokens = {t.strip() for t in re.split(r"[,\s]+", directives.lower())}
    return bool(tokens & {"noindex", "none"})


def _comparable(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return urlunsplit((parts.scheme.lower(), host, parts.path or "/", parts.query, ""))


def inspect_page(result: dict, robots: dict | None) -> dict:
    """Turn a fetch result into the facts that matter for indexing."""
    page = {
        "url": result["url"],
        "final_url": result["final_url"],
        "status": result["status"],
        "redirected": bool(result["chain"]),
        "error": result["error"],
        "noindex": False,
        "robots_meta": "",
        "canonical": "",
        "canonical_mismatch": False,
        "title": "",
        "blocked_google": False,
        "blocked_yandex": False,
    }
    if robots is not None:
        page["blocked_google"] = not robots_allows(robots, "googlebot", result["url"])
        page["blocked_yandex"] = not robots_allows(robots, "yandex", result["url"])
    if result["error"] or result["status"] != 200:
        return page
    header = result["headers"].get("x-robots-tag", "")
    directives = [header] if header else []
    if "html" in result["headers"].get("content-type", "html"):
        parser = _HeadParser()
        try:
            parser.feed(result["body"].decode("utf-8", errors="replace"))
        except Exception:  # malformed markup must not abort the whole audit
            pass
        directives += parser.robots
        page["title"] = " ".join(parser.title.split())[:200]
        if parser.canonical:
            page["canonical"] = urljoin(result["final_url"], parser.canonical)
            page["canonical_mismatch"] = _comparable(page["canonical"]) != _comparable(result["final_url"])
    page["robots_meta"] = ", ".join(d for d in directives if d)
    page["noindex"] = any(_has_noindex(d) for d in directives)
    return page


def parse_sitemap(body: bytes) -> tuple[list[str], list[str]]:
    """Returns (page URLs, child sitemap URLs). Raises ValueError on bad XML."""
    if body[:2] == b"\x1f\x8b":
        body = gzip.GzipFile(fileobj=io.BytesIO(body)).read(MAX_SITEMAP)
    if b"<!DOCTYPE" in body or b"<!ENTITY" in body:
        raise ValueError("sitemap содержит DTD")
    try:
        root = ElementTree.fromstring(body)
    except ElementTree.ParseError as exc:
        raise ValueError("sitemap не является корректным XML") from exc
    # Only <loc> directly under <url>/<sitemap>: image and video extensions
    # carry their own <image:loc> elements, which are not pages.
    locs = []
    for entry in root:
        for child in entry:
            if child.tag.rsplit("}", 1)[-1] == "loc" and "image" not in child.tag and "video" not in child.tag:
                if child.text and child.text.strip():
                    locs.append(child.text.strip())
    if root.tag.endswith("sitemapindex"):
        return [], locs
    return locs, []


def _belongs(url: str, domain: str) -> bool:
    try:
        host = (urlsplit(url).hostname or "").encode("idna").decode("ascii").lower()
    except UnicodeError:
        return False
    return host == domain or host.endswith("." + domain)


def _sample(urls: list[str], size: int) -> list[str]:
    if len(urls) <= size:
        return urls
    step = len(urls) / size
    return [urls[int(i * step)] for i in range(size)]


async def audit_site(
    client: httpx.AsyncClient,
    domain: str,
    extra_urls: list[str] | None = None,
    *,
    sample_size: int = 40,
    host_checker: HostChecker = is_public_host,
) -> dict:
    fetcher = _Fetcher(client, host_checker)
    home_url = f"https://{domain}/"

    home_result, robots_result = await asyncio.gather(
        fetcher.get(home_url, MAX_HTML), fetcher.get(f"https://{domain}/robots.txt", MAX_HTML)
    )

    robots: dict | None = None
    robots_info = {"status": robots_result["status"], "exists": False, "sitemaps": [],
                   "blocks_google": False, "blocks_yandex": False, "error": robots_result["error"]}
    if robots_result["status"] == 200 and not robots_result["error"]:
        robots = parse_robots(robots_result["body"].decode("utf-8", errors="replace"))
        robots_info.update(
            exists=True,
            sitemaps=robots["sitemaps"],
            blocks_google=not robots_allows(robots, "googlebot", home_url),
            blocks_yandex=not robots_allows(robots, "yandex", home_url),
        )

    home = inspect_page(home_result, robots)

    # Collect sitemap URLs.
    queue = list(robots["sitemaps"]) if robots and robots["sitemaps"] else [f"https://{domain}/sitemap.xml"]
    sitemap_info = {"files": [], "total_urls": 0, "error": None}
    urls: list[str] = []
    seen: set[str] = set()
    while queue and len(sitemap_info["files"]) < MAX_SITEMAP_FILES and len(urls) < MAX_SITEMAP_URLS:
        sitemap_url = queue.pop(0)
        if sitemap_url in seen:
            continue
        seen.add(sitemap_url)
        result = await fetcher.get(sitemap_url, MAX_SITEMAP)
        file_info = {"url": sitemap_url, "status": result["status"], "urls": 0, "error": result["error"]}
        if result["status"] == 200 and not result["error"]:
            try:
                pages, children = parse_sitemap(result["body"])
                file_info["urls"] = len(pages)
                urls.extend(pages)
                queue.extend(children)
            except (ValueError, OSError) as exc:
                file_info["error"] = str(exc)
        elif not result["error"]:
            file_info["error"] = f"HTTP {result['status']}"
        sitemap_info["files"].append(file_info)
    urls = list(dict.fromkeys(u for u in urls if _belongs(u, domain)))[:MAX_SITEMAP_URLS]
    sitemap_info["total_urls"] = len(urls)
    if not urls:
        sitemap_info["error"] = "sitemap не найден или пуст"

    to_check = list(dict.fromkeys([u for u in (extra_urls or []) if _belongs(u, domain)] + _sample(urls, sample_size)))
    in_sitemap = set(urls)
    gate = asyncio.Semaphore(5)

    async def check(url: str) -> dict:
        async with gate:
            page = inspect_page(await fetcher.get(url, MAX_HTML), robots)
        page["in_sitemap"] = url in in_sitemap
        return page

    pages = await asyncio.gather(*(check(u) for u in to_check))
    listed = [p for p in pages if p["in_sitemap"]]
    summary = {
        "checked": len(listed),
        "noindex": sum(p["noindex"] for p in listed),
        "redirect": sum(p["redirected"] for p in listed),
        "not_found": sum(p["status"] in (404, 410) for p in listed),
        "server_error": sum((p["status"] or 0) >= 500 or bool(p["error"]) for p in listed),
        "canonical_mismatch": sum(p["canonical_mismatch"] for p in listed),
        "blocked_google": sum(p["blocked_google"] for p in listed),
        "blocked_yandex": sum(p["blocked_yandex"] for p in listed),
    }
    return {"domain": domain, "home": home, "robots": robots_info, "sitemap": sitemap_info,
            "pages": pages, "summary": summary}
