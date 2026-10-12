from __future__ import annotations

import asyncio
import logging
import time
import threading
from html import escape
import weakref
from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import __version__
from app.adapters.llm_client import LLMClient
from app.adapters.stt_client import STTClient
from app.agent.dispatcher import Dispatcher
from app.agent.planner import Planner
from app.agent.policy import PolicyError
from app.api import actions, audio, auth, chat, notes
from app.config import Settings
from app.observability import configure_logging, event, http_route, new_trace_id
from app.security.auth import Authenticator
from app.storage.database import Database
from app.storage.repositories import Repository, RepositoryError


class RateLimit:
    def __init__(self):
        self.events = {}
        self.lock = threading.Lock()

    def check(self, key: str, limit: int):
        with self.lock:
            now = time.monotonic()
            events = self.events.setdefault(key, deque())
            while events and events[0] < now - 60:
                events.popleft()
            if len(events) >= limit:
                raise HTTPException(429, detail={"code": "rate_limited", "message": "請求太頻繁，請稍後重試"})
            events.append(now)


class TooLarge(Exception):
    pass


class BodyLimitMiddleware:
    def __init__(self, app, settings):
        self.app, self.settings = app, settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        cap = self.settings.max_audio_bytes if scope["path"] == "/v1/audio" else 128 * 1024
        headers = dict(scope.get("headers", []))
        length = headers.get(b"content-length", b"")
        if length.isdigit() and int(length) > cap:
            response = JSONResponse({"error": {"code": "body_too_large", "message": "請求內容超過上限"}}, 413)
            return await response(scope, receive, send)
        used = 0
        started = False
        async def bounded_receive():
            nonlocal used
            message = await receive()
            if message["type"] == "http.request":
                used += len(message.get("body", b""))
                if used > cap:
                    raise HTTPException(413, detail={"code": "body_too_large", "message": "請求內容超過上限"})
            return message
        async def tracked_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)
        try:
            await self.app(scope, bounded_receive, tracked_send)
        except TooLarge:
            if not started:
                response = JSONResponse({"error": {"code": "body_too_large", "message": "請求內容超過上限"}}, 413)
                await response(scope, receive, send)


def create_app(settings: Settings | None = None, *, llm_transport=None, stt_transport=None) -> FastAPI:
    configured = settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        cfg = configured or Settings.from_env()
        cfg.validate()
        app.state.settings = cfg
        configure_logging(cfg.log_level)
        event(app.state, "backend.starting", component="backend", version=__version__, port=cfg.port)
        app.state.database = Database(cfg.data_dir / "assistant.sqlite3", cfg.data_dir / "data.key")
        app.state.repo = Repository(app.state.database)
        app.state.auth = Authenticator(app.state.repo, cfg.admin_bootstrap_token)
        app.state.llm = LLMClient(cfg, transport=llm_transport)
        app.state.stt = STTClient(cfg, transport=stt_transport)
        app.state.planner = Planner(app.state.llm)
        app.state.dispatcher = Dispatcher(app.state.repo, cfg)
        app.state.audio_tasks = set()
        app.state.model_semaphore = asyncio.Semaphore(4)
        app.state.rate_limit = RateLimit()
        locks = weakref.WeakValueDictionary()
        def request_lock(key):
            lock = locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                locks[key] = lock
            return lock
        app.state.request_lock = request_lock
        if hasattr(app.state.repo, "recover_jobs"):
            app.state.repo.recover_jobs()
        event(app.state, "backend.ready", component="backend", version=__version__, port=cfg.port)
        try:
            yield
        finally:
            tasks = list(app.state.audio_tasks)
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            await app.state.llm.aclose()
            await app.state.stt.aclose()
            event(app.state, "backend.stopped", component="backend", version=__version__)

    # Configuration is read once at factory construction to set static routes and middleware;
    # default module app defers validation until startup so importing tests needs no .env.
    cfg_for_routes = configured
    if cfg_for_routes is None:
        try:
            cfg_for_routes = Settings.from_env()
        except ValueError:
            cfg_for_routes = None
    app = FastAPI(title="Local Assistant", version=__version__, lifespan=lifespan,
                  docs_url=None,
                  redoc_url=None, openapi_url="/openapi.json" if cfg_for_routes and cfg_for_routes.enable_api_docs else None)
    # Middleware settings must match those used at startup; fallback only affects failed startup.
    middleware_cfg = cfg_for_routes or Settings()
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=middleware_cfg.trusted_hosts)
    app.add_middleware(BodyLimitMiddleware, settings=middleware_cfg)

    @app.middleware("http")
    async def privacy_headers(request: Request, call_next):
        http_id = new_trace_id()
        request.state.http_request_id = http_id
        route = http_route(request.url.path)
        method = request.method if request.method in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"} else "OTHER"
        level = logging.DEBUG if method in {"GET", "HEAD"} else logging.INFO
        started = time.monotonic()
        event(app.state, "http.received", level=level, http_request_id=http_id, method=method, route=route)
        try:
            response = await call_next(request)
        except Exception:
            # Do not let Uvicorn print a traceback containing provider/request data.
            event(app.state, "http.failed", level=logging.ERROR, http_request_id=http_id,
                  method=method, route=route, code="internal_error")
            response = JSONResponse({"error": {"code": "internal_error", "message": "服務未能完成請求，請檢查終端的追蹤編號"}}, 500)
        event(app.state, "http.completed", level=logging.ERROR if response.status_code >= 500 else
              logging.WARNING if response.status_code >= 400 else level,
              http_request_id=http_id, method=method, route=route,
              status_code=response.status_code, duration_ms=round((time.monotonic()-started)*1000, 2))
        response.headers["X-Request-ID"] = http_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'"
        return response

    @app.exception_handler(RepositoryError)
    async def repository_error(request: Request, exc: RepositoryError):
        event(app.state, "http.rejected", level=logging.WARNING,
              http_request_id=getattr(request.state, "http_request_id", None), code=exc.code)
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, exc.status_code)

    @app.exception_handler(PolicyError)
    async def policy_error(request: Request, exc: PolicyError):
        event(app.state, "http.rejected", level=logging.WARNING,
              http_request_id=getattr(request.state, "http_request_id", None), code=exc.code)
        return JSONResponse({"error": {"code": exc.code, "message": str(exc)}}, 422)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        event(app.state, "http.rejected", level=logging.WARNING,
              http_request_id=getattr(request.state, "http_request_id", None), code="invalid_request")
        # FastAPI's default includes raw input; return only safe field locations/types.
        return JSONResponse({"error": {"code": "invalid_request", "message": "請求欄位不合法", "fields": [{"loc": e["loc"], "type": e["type"]} for e in exc.errors()]}}, 422)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": str(exc.detail)}
        event(app.state, "http.rejected", level=logging.WARNING,
              http_request_id=getattr(request.state, "http_request_id", None), code=detail.get("code", "http_error"))
        return JSONResponse({"error": detail}, exc.status_code)

    @app.get("/health")
    def health():
        return {"status": "ok", "component": "backend", "version": __version__}

    for router in (auth.router, chat.router, actions.router, notes.router, audio.router):
        app.include_router(router)
    if cfg_for_routes and cfg_for_routes.enable_api_docs:
        @app.get("/docs", response_class=HTMLResponse, include_in_schema=False)
        def api_directory():
            rows = []
            for path, methods in app.openapi()["paths"].items():
                for method, info in methods.items():
                    rows.append(f"<tr><td>{escape(method.upper())}</td><td>{escape(path)}</td><td>{escape(info.get('summary', ''))}</td></tr>")
            return "<!doctype html><html lang='zh-Hant'><meta charset='utf-8'><title>本地中樞 API</title><h1>本地中樞 API 路由</h1><p><a href='/openapi.json'>OpenAPI JSON</a>。本頁不載入外部資源，測試請使用 curl 或 API 客戶端。</p><table><thead><tr><th>方法</th><th>路徑</th><th>功能</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table></html>"
    if cfg_for_routes and (cfg_for_routes.web_dir / "index.html").is_file():
        app.mount("/", StaticFiles(directory=cfg_for_routes.web_dir, html=True), name="web")
    return app


app = create_app()
