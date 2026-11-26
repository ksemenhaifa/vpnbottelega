"""SEO panel: password-protected dashboard over Google and Yandex data."""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import re
import secrets
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import views
from .auth import LoginLimiter, SignedCodec, verify_password
from .config import Settings, load_settings
from .connectors import google, yandex
from .connectors.http import ApiError
from .db import Store
from .refresher import Refresher
from .sites import normalize_domain

HERE = Path(__file__).parent
SESSION_COOKIE = "sp_session"
STATE_COOKIE = "sp_oauth"
MAX_PHRASES_PER_SUBMIT = 20
MAX_PHRASE_LENGTH = 200
MAX_PASSWORD_LENGTH = 1024
# Local paths only: nothing a browser could read as another host.
SAFE_PATH = re.compile(r"^/[A-Za-z0-9._~%/-]*$")

log = logging.getLogger("seo-panel")


class NotAuthenticated(Exception):
    pass


class StripPrefix:
    """Accept requests with or without the public URL prefix.

    A reverse proxy may forward "/panel/x" either as-is or as "/x"; handling
    both here keeps the proxy configuration from being a source of breakage.
    """

    def __init__(self, app, prefix: str):
        self.app = app
        self.prefix = prefix

    async def __call__(self, scope, receive, send):
        if self.prefix and scope["type"] in ("http", "websocket"):
            path = scope["path"]
            if path == self.prefix or path.startswith(self.prefix + "/"):
                scope = dict(scope, path=path[len(self.prefix):] or "/")
                scope.pop("raw_path", None)
        await self.app(scope, receive, send)


class BadRequest(Exception):
    def __init__(self, message: str, status: int = 400):
        self.message = message
        self.status = status


def create_app(settings: Settings | None = None, *, client: httpx.AsyncClient | None = None, **refresher_kwargs) -> FastAPI:
    settings = settings or load_settings()
    base = settings.base_path
    cookie_path = base or "/"
    sessions = SignedCodec(settings.secret_key, "session")
    oauth_states = SignedCodec(settings.secret_key, "oauth-state")
    limiter = LoginLimiter()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        owned = client is None
        http = client or httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))
        store = Store(settings.data_dir)
        refresher = Refresher(settings, store, http, **refresher_kwargs)
        app.state.store, app.state.refresher, app.state.http = store, refresher, http
        timer = asyncio.create_task(refresher.periodic()) if settings.refresh_hours > 0 else None
        try:
            yield
        finally:
            if timer:
                timer.cancel()
            if owned:
                await http.aclose()
            store.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
    templates = Jinja2Templates(directory=HERE / "templates")
    views.register_filters(templates.env)

    # helpers

    def url(path: str) -> str:
        return f"{base}{path}"

    def redirect(path: str) -> RedirectResponse:
        return RedirectResponse(url(path), status_code=303)

    def client_address(request: Request) -> str:
        if settings.trust_proxy:
            forwarded = request.headers.get("x-forwarded-for", "")
            if forwarded:
                # The right-most entry is the one our own proxy appended.
                return forwarded.split(",")[-1].strip()
        return request.client.host if request.client else "unknown"

    def session(request: Request) -> dict:
        data = sessions.decode(request.cookies.get(SESSION_COOKIE))
        if not data:
            raise NotAuthenticated()
        return data

    def check_csrf(token: str, sess: dict) -> None:
        if not hmac.compare_digest(token or "", sess.get("csrf", "")):
            raise BadRequest("Сессия устарела — обновите страницу и повторите.", 403)

    def render(request: Request, name: str, sess: dict | None = None, status: int = 200, **context) -> HTMLResponse:
        refresher: Refresher = request.app.state.refresher
        store: Store = request.app.state.store
        sites_entry = store.get("sites")
        return templates.TemplateResponse(
            request, name,
            {
                "base": base,
                "csrf": sess.get("csrf", "") if sess else "",
                "authed": sess is not None,
                "refresh": refresher.state,
                "last_refresh": sites_entry["fetched_at"] if sites_entry else None,
                **context,
            },
            status_code=status,
        )

    @app.exception_handler(NotAuthenticated)
    async def _login_required(request: Request, exc: NotAuthenticated) -> Response:
        return redirect("/login")

    @app.exception_handler(BadRequest)
    async def _bad_request(request: Request, exc: BadRequest) -> Response:
        return render(request, "message.html", status=exc.status, title="Не получилось", message=exc.message)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; form-action 'self' https://accounts.google.com https://oauth.yandex.ru; "
            "base-uri 'none'; frame-ancestors 'none'",
        )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Robots-Tag", "noindex, nofollow")
        if not request.url.path.startswith("/static"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    app.add_middleware(StripPrefix, prefix=base)

    # auth

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"ok": True}

    @app.get("/login")
    async def login_form(request: Request) -> Response:
        if sessions.decode(request.cookies.get(SESSION_COOKIE)):
            return redirect("/")
        return render(request, "login.html", error=None)

    @app.post("/login")
    async def login(request: Request, password: str = Form("")) -> Response:
        address = client_address(request)
        if limiter.is_blocked(address):
            return render(request, "login.html", status=429,
                          error="Слишком много попыток. Подождите 15 минут.")
        # Run scrypt off the event loop: it is deliberately slow.
        ok = len(password) <= MAX_PASSWORD_LENGTH and await asyncio.to_thread(
            verify_password, password, settings.password_hash)
        if not ok:
            limiter.record_failure(address)
            log.warning("failed login from %s", address)
            return render(request, "login.html", status=401, error="Неверный пароль.")
        limiter.reset(address)
        ttl = settings.session_hours * 3600
        response = redirect("/")
        response.set_cookie(
            SESSION_COOKIE, sessions.encode({"csrf": secrets.token_urlsafe(24)}, ttl),
            max_age=int(ttl), path=cookie_path, httponly=True, secure=settings.cookie_secure, samesite="lax",
        )
        return response

    @app.post("/logout")
    async def logout(csrf: str = Form(""), sess: dict = Depends(session)) -> Response:
        check_csrf(csrf, sess)
        response = redirect("/login")
        response.delete_cookie(SESSION_COOKIE, path=cookie_path)
        return response

    # pages

    @app.get("/")
    async def overview(request: Request, sess: dict = Depends(session)) -> Response:
        store: Store = request.app.state.store
        return render(request, "overview.html", sess, **views.overview(store, settings))

    @app.get("/site/{domain}")
    async def site_page(request: Request, domain: str, sess: dict = Depends(session)) -> Response:
        store: Store = request.app.state.store
        context = views.site(store, normalize_domain(domain))
        if context is None:
            raise BadRequest("Такого сайта в панели нет.", 404)
        return render(request, "site.html", sess, **context)

    @app.get("/status")
    async def status(request: Request, sess: dict = Depends(session)) -> JSONResponse:
        return JSONResponse({"running": request.app.state.refresher.state["running"],
                             "step": request.app.state.refresher.state["step"]})

    @app.post("/refresh")
    async def refresh(request: Request, csrf: str = Form(""), back: str = Form("/"), sess: dict = Depends(session)) -> Response:
        check_csrf(csrf, sess)
        request.app.state.refresher.start()
        return redirect(back if SAFE_PATH.match(back) and "//" not in back else "/")

    @app.post("/sites/add")
    async def add_site(request: Request, domain: str = Form(""), csrf: str = Form(""), sess: dict = Depends(session)) -> Response:
        check_csrf(csrf, sess)
        normalized = normalize_domain(domain)
        if not normalized:
            raise BadRequest("Не похоже на адрес сайта. Пример: example.ru")
        request.app.state.store.add_manual_site(normalized)
        request.app.state.refresher.start()
        return redirect("/")

    @app.post("/site/{domain}/remove")
    async def remove_site(request: Request, domain: str, csrf: str = Form(""), sess: dict = Depends(session)) -> Response:
        check_csrf(csrf, sess)
        store: Store = request.app.state.store
        normalized = normalize_domain(domain)
        store.remove_manual_site(normalized)
        index = store.data("sites", {})
        entry = index.get(normalized)
        if entry and not any(entry.get(k) for k in ("gsc", "ga4", "ywm", "ym")):
            index.pop(normalized)
            store.put("sites", index)
        return redirect("/")

    @app.post("/site/{domain}/urls")
    async def set_urls(request: Request, domain: str, urls: str = Form(""), csrf: str = Form(""), sess: dict = Depends(session)) -> Response:
        check_csrf(csrf, sess)
        normalized = normalize_domain(domain)
        if normalized not in request.app.state.store.data("sites", {}):
            raise BadRequest("Такого сайта в панели нет.", 404)
        cleaned = []
        for line in urls.splitlines():
            line = line.strip()
            if line and normalize_domain(line) == normalized and line.startswith(("http://", "https://")):
                cleaned.append(line)
        request.app.state.store.set_site_urls(normalized, cleaned[:20])
        request.app.state.refresher.start()
        return redirect(f"/site/{normalized}")

    # connections

    @app.get("/connections")
    async def connections(request: Request, sess: dict = Depends(session)) -> Response:
        return render(request, "connections.html", sess, **views.connections(request.app.state.store, settings))

    def start_oauth(provider: str, target: str, state: str) -> Response:
        response = RedirectResponse(target, status_code=303)
        response.set_cookie(
            STATE_COOKIE, oauth_states.encode({"state": state, "provider": provider}, 600),
            max_age=600, path=cookie_path, httponly=True, secure=settings.cookie_secure, samesite="lax",
        )
        return response

    def finish_oauth(request: Request, provider: str, state: str, error: str) -> None:
        expected = oauth_states.decode(request.cookies.get(STATE_COOKIE))
        if error:
            raise BadRequest("Доступ не выдан: подключение отменено.")
        if not expected or expected.get("provider") != provider or not hmac.compare_digest(expected["state"], state or ""):
            raise BadRequest("Запрос на подключение устарел. Начните подключение заново.")

    @app.get("/connect/google")
    async def connect_google(sess: dict = Depends(session)) -> Response:
        if not settings.google_configured:
            raise BadRequest("На сервере не заданы GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET.")
        state = secrets.token_urlsafe(24)
        return start_oauth("google", google.authorize_url(
            settings.google_client_id, f"{settings.base_url}/connect/google/callback", state), state)

    @app.get("/connect/google/callback")
    async def google_callback(request: Request, code: str = "", state: str = "", error: str = "", sess: dict = Depends(session)) -> Response:
        finish_oauth(request, "google", state, error)
        try:
            token = await google.exchange_code(
                request.app.state.http, settings.google_client_id, settings.google_client_secret,
                code, f"{settings.base_url}/connect/google/callback")
        except ApiError as exc:
            raise BadRequest(f"Google не принял подключение: {exc}") from exc
        request.app.state.store.set_token("google", token)
        request.app.state.refresher.start()
        response = redirect("/connections")
        response.delete_cookie(STATE_COOKIE, path=cookie_path)
        return response

    @app.get("/connect/yandex")
    async def connect_yandex(sess: dict = Depends(session)) -> Response:
        if not settings.yandex_configured:
            raise BadRequest("На сервере не заданы YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET.")
        state = secrets.token_urlsafe(24)
        return start_oauth("yandex", yandex.authorize_url(
            settings.yandex_client_id, f"{settings.base_url}/connect/yandex/callback", state), state)

    @app.get("/connect/yandex/callback")
    async def yandex_callback(request: Request, code: str = "", state: str = "", error: str = "", sess: dict = Depends(session)) -> Response:
        finish_oauth(request, "yandex", state, error)
        try:
            token = await yandex.exchange_code(
                request.app.state.http, settings.yandex_client_id, settings.yandex_client_secret, code)
        except ApiError as exc:
            raise BadRequest(f"Яндекс не принял подключение: {exc}") from exc
        request.app.state.store.set_token("yandex", token)
        request.app.state.refresher.start()
        response = redirect("/connections")
        response.delete_cookie(STATE_COOKIE, path=cookie_path)
        return response

    @app.post("/disconnect/{provider}")
    async def disconnect(request: Request, provider: str, csrf: str = Form(""), sess: dict = Depends(session)) -> Response:
        check_csrf(csrf, sess)
        if provider not in ("google", "yandex"):
            raise BadRequest("Неизвестный источник.", 404)
        store: Store = request.app.state.store
        store.delete_token(provider)
        for prefix in {"google": ("disc:gsc", "disc:ga4", "gsc:", "ga4:"), "yandex": ("disc:ywm", "disc:ym", "ywm:", "ym:")}[provider]:
            store.delete_prefix(prefix)
        request.app.state.refresher.start()
        return redirect("/connections")

    # keywords (Wordstat)

    @app.get("/keywords")
    async def keywords(request: Request, sess: dict = Depends(session)) -> Response:
        return render(request, "keywords.html", sess, **views.keywords(request.app.state.store, settings))

    @app.post("/keywords")
    async def add_keywords(
        request: Request, phrases: str = Form(""), regions: str = Form(""), domain: str = Form(""),
        csrf: str = Form(""), sess: dict = Depends(session),
    ) -> Response:
        check_csrf(csrf, sess)
        store: Store = request.app.state.store
        refresher: Refresher = request.app.state.refresher
        try:
            region_ids = [int(r) for r in regions.replace(" ", "").split(",") if r]
        except ValueError:
            raise BadRequest("Регионы — это числовые коды через запятую, например: 225")
        region_key = ",".join(str(r) for r in region_ids)
        wanted = list(dict.fromkeys(p.strip().lower() for p in phrases.splitlines() if p.strip()))
        if not wanted:
            raise BadRequest("Введите хотя бы одну фразу.")
        if len(wanted) > MAX_PHRASES_PER_SUBMIT:
            raise BadRequest(f"За один раз — не больше {MAX_PHRASES_PER_SUBMIT} фраз.")
        if any(len(p) > MAX_PHRASE_LENGTH for p in wanted):
            raise BadRequest(f"Фраза длиннее {MAX_PHRASE_LENGTH} символов.")
        try:
            token = await refresher.wordstat_token()
        except ApiError as exc:
            raise BadRequest(f"Яндекс не обновил доступ: {exc}") from exc
        if not token:
            raise BadRequest("Сначала подключите Яндекс на странице «Подключения».")
        site_domain = normalize_domain(domain)
        for phrase in wanted:
            store.add_phrase(phrase, region_key, site_domain)
            key = views.wordstat_key(phrase, region_key)
            try:
                store.put(key, await yandex.wordstat_top_requests(request.app.state.http, token, phrase, region_ids))
            except ApiError as exc:
                store.put(key, error=str(exc))
        return redirect("/keywords")

    @app.post("/keywords/remove")
    async def remove_keyword(request: Request, phrase: str = Form(""), regions: str = Form(""), csrf: str = Form(""), sess: dict = Depends(session)) -> Response:
        check_csrf(csrf, sess)
        request.app.state.store.remove_phrase(phrase, regions)
        return redirect("/keywords")

    return app
