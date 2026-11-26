import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.auth import hash_password
from app.config import Settings
from app.main import create_app
from tests import fakes

PASSWORD_HASH = hash_password(fakes.PASSWORD, n=2**10)


def make_settings(tmp_path: Path, **overrides) -> Settings:
    values = dict(
        secret_key=b"t" * 32, password_hash=PASSWORD_HASH, base_url="http://testserver/panel",
        data_dir=tmp_path, google_client_id="gid", google_client_secret="gsecret",
        yandex_client_id="yid", yandex_client_secret="ysecret", refresh_hours=0, cookie_secure=False,
    )
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def panel(tmp_path):
    app = create_app(make_settings(tmp_path), client=fakes.client(), host_checker=fakes.any_host)
    with TestClient(app, base_url="http://testserver/panel", follow_redirects=False) as client:
        yield client


def csrf_of(client: TestClient) -> str:
    return re.search(r'name="csrf" value="([^"]+)"', client.get("/").text).group(1)


def login(client: TestClient) -> str:
    response = client.post("/login", data={"password": fakes.PASSWORD})
    assert response.status_code == 303 and response.headers["location"] == "/panel/"
    return csrf_of(client)


def wait_for_refresh(client: TestClient) -> None:
    deadline = time.time() + 20
    while client.get("/status").json()["running"]:
        assert time.time() < deadline, "refresh did not finish"
        time.sleep(0.05)


def connect(client: TestClient, provider: str) -> None:
    start = client.get(f"/connect/{provider}")
    assert start.status_code == 303
    target = urlparse(start.headers["location"])
    query = parse_qs(target.query)
    assert query["redirect_uri"] == [f"http://testserver/panel/connect/{provider}/callback"]
    done = client.get(f"/connect/{provider}/callback", params={"code": "auth-code", "state": query["state"][0]})
    assert done.status_code == 303 and done.headers["location"] == "/panel/connections"


def test_everything_requires_login(panel):
    for path in ("/", "/site/example-shop.ru", "/keywords", "/connections", "/status", "/connect/google"):
        response = panel.get(path)
        assert response.status_code == 303 and response.headers["location"] == "/panel/login", path
    for path in ("/refresh", "/sites/add", "/keywords", "/disconnect/google", "/logout"):
        response = panel.post(path, data={"csrf": "x"})
        assert response.status_code == 303 and response.headers["location"] == "/panel/login", path
    assert panel.get("/healthz").json() == {"ok": True}


def test_wrong_password_is_rejected_and_throttled(panel):
    for _ in range(5):
        assert panel.post("/login", data={"password": "nope"}).status_code == 401
    # Even the right password is refused while the address is blocked.
    assert panel.post("/login", data={"password": fakes.PASSWORD}).status_code == 429
    assert panel.get("/").status_code == 303


def test_session_cookie_flags_and_security_headers(panel):
    response = panel.post("/login", data={"password": fakes.PASSWORD})
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/panel" in cookie
    page = panel.get("/")
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert page.headers["cache-control"] == "no-store"
    assert page.headers["x-robots-tag"] == "noindex, nofollow"


def test_post_without_valid_csrf_is_refused(panel):
    login(panel)
    assert panel.post("/sites/add", data={"domain": "example-shop.ru", "csrf": "forged"}).status_code == 403
    assert panel.post("/sites/add", data={"domain": "example-shop.ru"}).status_code == 403
    assert "example-shop.ru" not in panel.get("/").text


def test_manual_site_is_audited_without_any_connection(panel):
    csrf = login(panel)
    assert panel.post("/sites/add", data={"domain": "https://www.example-shop.ru/x", "csrf": csrf}).status_code == 303
    wait_for_refresh(panel)
    overview = panel.get("/").text
    assert "example-shop.ru" in overview and "В sitemap есть страницы с noindex" in overview
    page = panel.get("/site/example-shop.ru").text
    assert "https://example-shop.ru/promo/" in page and "noindex" in page
    assert "https://example-shop.ru/gone/" in page and "код 404" in page
    assert "Сайта нет среди ресурсов подключённого аккаунта Search Console" in page
    assert panel.post("/sites/add", data={"domain": "not a site", "csrf": csrf}).status_code == 400


def test_oauth_state_is_checked(panel):
    login(panel)
    panel.get("/connect/google")
    forged = panel.get("/connect/google/callback", params={"code": "c", "state": "forged"})
    assert forged.status_code == 400
    assert "Подключить Google" in panel.get("/connections").text


def test_full_flow_with_google_and_yandex(panel):
    csrf = login(panel)
    connect(panel, "google")
    connect(panel, "yandex")
    wait_for_refresh(panel)

    connections = panel.get("/connections").text
    assert connections.count("Подключено") == 2
    assert "g-access" not in connections and "g-refresh" not in connections and "gsecret" not in connections

    overview = panel.get("/").text
    assert "example-shop.ru" in overview
    assert "someone-else.ru" not in overview and "unverified.ru" not in overview

    page = panel.get("/site/example-shop.ru").text
    assert "sc-domain:example-shop.ru" in page            # domain property preferred
    assert "фильтр для воды самара" in page               # GSC query
    assert "Organic Search" in page                        # GA4 channel
    assert "Переходы из поисковых систем" in page          # Metrika source
    assert "Ошибки в файле Sitemap" in page                # Yandex diagnostics, PRESENT only
    assert "Нет файла robots.txt" not in page              # ABSENT problem is not shown
    assert "Submitted and indexed" in page

    # Watched URL: inspected by Google and by the direct audit.
    saved = panel.post("/site/example-shop.ru/urls", data={
        "csrf": csrf, "urls": "https://example-shop.ru/promo/\nhttps://evil.example/x\nnot-a-url"})
    assert saved.status_code == 303
    wait_for_refresh(panel)
    page = panel.get("/site/example-shop.ru").text
    assert "запрещено мета-тегом noindex" in page and "Страница не в индексе Google" in page
    assert "evil.example" not in page

    # Wordstat
    added = panel.post("/keywords", data={"csrf": csrf, "phrases": "Фильтр для воды\n", "regions": "225", "domain": "example-shop.ru"})
    assert added.status_code == 303
    keywords = panel.get("/keywords").text
    assert "фильтр для воды цена" in keywords and "18 400" in keywords
    assert panel.post("/keywords", data={"csrf": csrf, "phrases": "x", "regions": "abc"}).status_code == 400

    # Disconnecting removes the provider's data but keeps the rest.
    assert panel.post("/disconnect/google", data={"csrf": csrf}).status_code == 303
    wait_for_refresh(panel)
    page = panel.get("/site/example-shop.ru").text
    assert "фильтр для воды самара" not in page and "Переходы из поисковых систем" in page


def test_upstream_errors_are_shown_not_hidden(tmp_path):
    def broken(request):
        if request.url.host == "api-metrika.yandex.net":
            return fakes.httpx.Response(403, json={"message": "Access is denied"})
        return fakes.handler(request)

    client = fakes.httpx.AsyncClient(transport=fakes.httpx.MockTransport(broken))
    app = create_app(make_settings(tmp_path), client=client, host_checker=fakes.any_host)
    with TestClient(app, base_url="http://testserver/panel", follow_redirects=False) as panel:
        login(panel)
        connect(panel, "yandex")
        wait_for_refresh(panel)
        connections = panel.get("/connections").text
        assert "Яндекс Метрика: HTTP 403 — Access is denied" in connections
        assert "Вебмастер — сайтов" in connections


def test_logout_ends_the_session(panel):
    csrf = login(panel)
    assert panel.post("/logout", data={"csrf": csrf}).status_code == 303
    assert panel.get("/").status_code == 303


def test_refresh_never_redirects_off_site(panel):
    csrf = login(panel)
    for back in ("//evil.example", "/\\evil.example", "https://evil.example", "/site/example-shop.ru"):
        response = panel.post("/refresh", data={"csrf": csrf, "back": back})
        expected = "/panel/site/example-shop.ru" if back.startswith("/site") else "/panel/"
        assert response.headers["location"] == expected, back
        wait_for_refresh(panel)
