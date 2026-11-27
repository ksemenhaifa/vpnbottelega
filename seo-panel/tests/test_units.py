import asyncio
import time
from datetime import date

import pytest

from app import audit
from app.auth import LoginLimiter, SignedCodec, hash_password, verify_password
from app.config import ConfigError, load_settings
from app.issues import audit_issues
from app.refresher import periods, sum_period
from app.sites import build_site_index, display_domain, normalize_domain
from app.views import delta, fmt_num
from tests import fakes


def test_password_hash_roundtrip():
    stored = hash_password("s3cret-passphrase", n=2**10)
    assert verify_password("s3cret-passphrase", stored)
    assert not verify_password("wrong", stored)
    assert not verify_password("anything", "not-a-hash")


def test_signed_codec_rejects_tampering_and_expiry():
    codec = SignedCodec(b"k" * 32, "session")
    token = codec.encode({"csrf": "abc"}, 60)
    assert codec.decode(token)["csrf"] == "abc"
    body, signature = token.split(".")
    assert codec.decode(body + "x." + signature) is None
    assert SignedCodec(b"k" * 32, "other-purpose").decode(token) is None
    assert codec.decode(codec.encode({}, -1)) is None
    assert codec.decode(None) is None and codec.decode("garbage") is None


def test_login_limiter_blocks_after_max_attempts():
    limiter = LoginLimiter(max_attempts=3, window_seconds=60)
    for _ in range(3):
        assert not limiter.is_blocked("1.2.3.4")
        limiter.record_failure("1.2.3.4")
    assert limiter.is_blocked("1.2.3.4")
    assert not limiter.is_blocked("5.6.7.8")
    limiter.reset("1.2.3.4")
    assert not limiter.is_blocked("1.2.3.4")


def test_config_fails_closed_without_secrets():
    with pytest.raises(ConfigError):
        load_settings({})
    with pytest.raises(ConfigError):
        load_settings({"PANEL_SECRET_KEY": "short", "PANEL_PASSWORD_HASH": "scrypt$x", "PANEL_BASE_URL": "https://a.b"})
    settings = load_settings({"PANEL_SECRET_KEY": "x" * 32, "PANEL_PASSWORD_HASH": "scrypt$1$1$1$a$b",
                              "PANEL_BASE_URL": "https://host.example/panel/"})
    assert settings.base_path == "/panel" and settings.cookie_secure


@pytest.mark.parametrize("raw,expected", [
    ("https://www.Example.com/path?q=1", "example.com"),
    ("sc-domain:example.com", "example.com"),
    ("example.com:443", "example.com"),
    ("газтехника-самара.рф", "xn----7sbaabhjc3ccd6bgcm5a.xn--p1ai"),
    ("https://газтехника-самара.рф/", "xn----7sbaabhjc3ccd6bgcm5a.xn--p1ai"),
    ("localhost", ""),
    ("not a domain", ""),
    ("", ""),
])
def test_normalize_domain(raw, expected):
    if expected.startswith("xn--"):
        expected = "газтехника-самара.рф".encode("idna").decode()
    assert normalize_domain(raw) == expected


def test_display_domain_shows_cyrillic():
    assert display_domain("газтехника-самара.рф".encode("idna").decode()) == "газтехника-самара.рф"


def test_site_index_merges_sources_and_prefers_domain_property():
    index = build_site_index(
        gsc_sites=[{"siteUrl": "https://shop.ru/"}, {"siteUrl": "sc-domain:shop.ru"}],
        ga4_properties=[{"property": "properties/1", "urls": ["https://www.shop.ru"]}],
        wm_hosts=[{"host_id": "http:shop.ru:80", "ascii_host_url": "http://shop.ru/"},
                  {"host_id": "https:shop.ru:443", "ascii_host_url": "https://shop.ru/"}],
        metrika_counters=[{"id": 5, "site": "shop.ru"}, {"id": 6, "site": "other.ru"}],
        manual=["manual.ru"],
    )
    assert index["shop.ru"] == {"domain": "shop.ru", "name": "shop.ru", "gsc": "sc-domain:shop.ru",
                                "ga4": "properties/1", "ywm": "https:shop.ru:443", "ym": 5}
    assert index["other.ru"]["ym"] == 6 and index["manual.ru"]["manual"] is True


def test_robots_matching_follows_google_rules():
    robots = audit.parse_robots(
        "User-agent: *\nDisallow: /private/\nAllow: /private/open/\nDisallow: /*.pdf$\nDisallow: /*?sort=\n\n"
        "User-agent: Googlebot\nUser-agent: Yandex\nDisallow: /only-bots/\n"
    )
    allows = lambda agent, path: audit.robots_allows(robots, agent, "https://s.ru" + path)
    assert allows("bingbot", "/")
    assert not allows("bingbot", "/private/x")
    assert allows("bingbot", "/private/open/x")          # longer Allow wins
    assert not allows("bingbot", "/files/a.pdf")
    assert allows("bingbot", "/files/a.pdf?x=1")          # "$" anchors the end
    assert not allows("bingbot", "/catalog/?sort=price")
    # A bot with its own group ignores the "*" group entirely.
    assert allows("googlebot", "/private/x") and not allows("googlebot", "/only-bots/")
    assert not allows("yandex", "/only-bots/")


def test_robots_disallow_all_and_empty_disallow():
    closed = audit.parse_robots("User-agent: *\nDisallow: /\n")
    assert not audit.robots_allows(closed, "googlebot", "https://s.ru/")
    opened = audit.parse_robots("User-agent: *\nDisallow:\n")
    assert audit.robots_allows(opened, "googlebot", "https://s.ru/anything")


def _page(html, headers=None, url="https://s.ru/a/"):
    result = {"url": url, "final_url": url, "status": 200, "chain": [], "error": None,
              "headers": {"content-type": "text/html", **(headers or {})}, "body": html.encode()}
    return audit.inspect_page(result, None)


def test_inspect_page_detects_noindex_and_canonical():
    assert _page('<meta name="robots" content="NOINDEX, follow">')["noindex"]
    assert _page('<meta name="googlebot" content="none">')["noindex"]
    assert _page("<p>plain</p>", {"x-robots-tag": "noindex"})["noindex"]
    assert not _page('<meta name="robots" content="index, follow">')["noindex"]
    assert not _page('<meta name="description" content="noindex is a word here">')["noindex"]
    same = _page('<link rel="canonical" href="/a/">')
    assert same["canonical"] == "https://s.ru/a/" and not same["canonical_mismatch"]
    assert _page('<link rel="canonical" href="https://s.ru/b/">')["canonical_mismatch"]


def test_parse_sitemap_handles_index_and_rejects_dtd():
    pages, children = audit.parse_sitemap(
        b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc> https://s.ru/a </loc></url></urlset>')
    assert pages == ["https://s.ru/a"] and children == []
    pages, children = audit.parse_sitemap(
        b'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://s.ru/s1.xml</loc></sitemap></sitemapindex>')
    assert pages == [] and children == ["https://s.ru/s1.xml"]
    with pytest.raises(ValueError):
        audit.parse_sitemap(b'<!DOCTYPE x [<!ENTITY a "b">]><urlset/>')
    with pytest.raises(ValueError):
        audit.parse_sitemap(b"<html>not a sitemap")


def test_audit_site_finds_every_kind_of_problem():
    async def run():
        async with fakes.client() as client:
            return await audit.audit_site(client, fakes.SITE, host_checker=fakes.any_host)

    result = asyncio.run(run())
    assert result["home"]["status"] == 200 and not result["home"]["noindex"]
    assert result["robots"]["exists"] and not result["robots"]["blocks_google"]
    assert result["sitemap"]["total_urls"] == 7
    assert result["summary"] == {
        "checked": 7, "noindex": 1, "redirect": 1, "not_found": 1, "server_error": 0,
        "canonical_mismatch": 1, "blocked_google": 1, "blocked_yandex": 2,
    }
    titles = [i["title"] for i in audit_issues(result)]
    assert "В sitemap есть страницы с noindex" in titles
    assert "В sitemap есть несуществующие страницы (404)" in titles


def test_audit_refuses_non_public_hosts():
    async def private(host):
        return False

    async def run():
        async with fakes.client() as client:
            return await audit.audit_site(client, fakes.SITE, host_checker=private)

    result = asyncio.run(run())
    assert result["home"]["error"] and result["home"]["status"] is None
    assert result["sitemap"]["total_urls"] == 0


def test_is_public_host_rejects_loopback():
    assert asyncio.run(audit.is_public_host("127.0.0.1")) is False
    assert asyncio.run(audit.is_public_host("10.0.0.5")) is False


def test_periods_are_adjacent_28_day_windows():
    p = periods(date(2026, 11, 26), 3)
    assert p["cur"] == ("2026-10-27", "2026-11-23")
    assert p["prev"] == ("2026-09-29", "2026-10-26")
    daily = [{"date": "2026-10-26", "clicks": 5}, {"date": "2026-10-27", "clicks": 7}, {"date": "2026-11-23", "clicks": 1}]
    assert sum_period(daily, p["cur"], ("clicks",)) == {"clicks": 8}
    assert sum_period(daily, p["prev"], ("clicks",)) == {"clicks": 5}


def test_delta_and_number_formatting():
    assert delta(120, 100)["text"] == "+20 %" and delta(120, 100)["tone"] == "up"
    assert delta(80, 100)["tone"] == "down"
    assert delta(8.0, 10.0, lower_is_better=True)["tone"] == "up"   # position improved
    assert delta(5, 0) is None and delta(None, 5) is None
    assert fmt_num(1234567) == "1 234 567" and fmt_num(None) == "—" and fmt_num(12.34) == "12,3"


def test_parse_sitemap_ignores_image_entries():
    pages, _ = audit.parse_sitemap(
        b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        b'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">'
        b'<url><loc>https://s.ru/a</loc><image:image><image:loc>https://s.ru/a.jpg</image:loc></image:image></url></urlset>')
    assert pages == ["https://s.ru/a"]


def test_whole_domain_redirect_is_reported_as_such():
    def handler(request):
        if request.url.host == "old.ru":
            return fakes.httpx.Response(301, headers={"location": f"https://new.ru{request.url.path}"})
        return fakes.httpx.Response(200, text="<title>New</title>", headers={"content-type": "text/html"})

    async def run():
        async with fakes.httpx.AsyncClient(transport=fakes.httpx.MockTransport(handler)) as client:
            return await audit.audit_site(client, "old.ru", host_checker=fakes.any_host)

    issues = audit_issues(asyncio.run(run()))
    assert [i["title"] for i in issues] == ["Домен целиком перенаправляет на другой сайт"]
    assert "new.ru" in issues[0]["detail"] and issues[0]["severity"] == "warning"


def test_single_dropped_connection_is_retried():
    calls = {"n": 0}

    def handler(request):
        if request.url.path == "/" :
            calls["n"] += 1
            if calls["n"] == 1:
                raise fakes.httpx.ConnectError("dropped", request=request)
        return fakes.handler(request)

    async def run():
        async with fakes.httpx.AsyncClient(transport=fakes.httpx.MockTransport(handler)) as client:
            return await audit.audit_site(client, fakes.SITE, host_checker=fakes.any_host)

    assert asyncio.run(run())["home"]["status"] == 200
