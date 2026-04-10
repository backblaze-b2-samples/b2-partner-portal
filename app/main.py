"""
Backblaze Partner API Portal
FastAPI app with dual-auth middleware (JWT Bearer + session cookie).
"""
from contextlib import asynccontextmanager
import asyncio
import logging

import aiohttp
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config import settings
from app.database import init_db
from app.limiter import limiter
from app.services.backblaze_client import BackblazeClient
from app.services.report_scheduler import scheduler_loop
from app.auth import verify_session_cookie
from app.api import auth, users, roles, settings as settings_api, groups, members, reports, credentials, audit, pricing, oidc as oidc_api

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

_PUBLIC_PATHS = {"/health", "/login", "/reset-password", "/api/auth/login", "/api/auth/refresh",
                 "/api/auth/oidc/status", "/api/auth/oidc/login", "/api/auth/oidc/callback",
                 "/api/auth/oidc/exchange"}
_PUBLIC_PREFIXES = ("/static/", "/api/users/complete-reset")

_STATIC_DIR = Path(__file__).parent / "static"


# ── Auth Middleware ───────────────────────────────────────────────────────────

class AuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope["path"]
        if path in _PUBLIC_PATHS or any(path.startswith(p) for p in _PUBLIC_PREFIXES):
            await self.app(scope, receive, send)
            return

        # Check Authorization: Bearer header
        authed = False
        for name, value in scope.get("headers", []):
            if name == b"authorization":
                val = value.decode()
                if val.startswith("Bearer "):
                    from jwt import PyJWTError as JWTError
                    try:
                        from app.auth import decode_access_token
                        decode_access_token(val[7:])
                        authed = True
                    except JWTError:
                        pass
                break

        # Fall back to session cookie
        if not authed:
            for name, value in scope.get("headers", []):
                if name == b"cookie":
                    for part in value.decode().split(";"):
                        part = part.strip()
                        if part.startswith("session="):
                            if verify_session_cookie(part[8:]):
                                authed = True
                            break
                    break

        if authed:
            await self.app(scope, receive, send)
            return

        if path.startswith("/api/"):
            response = Response(status_code=401, content="Unauthorized",
                                media_type="application/json")
        else:
            response = RedirectResponse("/login", status_code=302)
        await response(scope, receive, send)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    log.info("Database initialized")

    session = aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=30),
        connector=aiohttp.TCPConnector(limit=20),
    )
    app.state.b2_client = BackblazeClient(session)
    log.info("Backblaze HTTP client started")

    scheduler_task = asyncio.create_task(scheduler_loop(app))

    yield

    scheduler_task.cancel()
    try:
        await scheduler_task
    except asyncio.CancelledError:
        pass
    await session.close()
    log.info("Shutdown complete")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Backblaze Partner Portal",
    version="1.0.0",
    description="Management portal for the Backblaze Partner API — with self-documenting B2 API calls.",
    lifespan=lifespan,
    docs_url="/api/docs"  if settings.api_docs_enabled else None,
    redoc_url="/api/redoc" if settings.api_docs_enabled else None,
    openapi_url="/api/openapi.json" if settings.api_docs_enabled else None,
)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Suppress uvicorn's Server header
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    # Remove server fingerprint
    try:
        del response.headers["server"]
    except KeyError:
        pass
    # Prevent MIME-type sniffing
    response.headers["X-Content-Type-Options"] = "nosniff"
    # Deny framing (clickjacking)
    response.headers["X-Frame-Options"] = "DENY"
    # Tell browsers to always use HTTPS for this origin (1 year)
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # Content-Security-Policy: lock down to same origin; allow inline scripts
    # (needed for the vanilla-JS SPA) and Chart.js loaded from /static/
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'"
    )
    return response

app.add_middleware(AuthMiddleware)

app.include_router(auth.router,        prefix="/api/auth",    tags=["auth"])
app.include_router(users.router,       prefix="/api/users",   tags=["users"])
app.include_router(roles.router,       prefix="/api/roles",   tags=["roles"])
app.include_router(settings_api.router, prefix="/api/settings", tags=["settings"])
app.include_router(groups.router,      prefix="/api/groups",  tags=["groups"])
app.include_router(members.router,     prefix="/api/groups",  tags=["members"])
app.include_router(reports.router,     prefix="/api/reports",      tags=["reports"])
app.include_router(credentials.router, prefix="/api/credentials",  tags=["credentials"])
app.include_router(audit.router,       prefix="/api/audit",         tags=["audit"])
app.include_router(pricing.router,     prefix="/api/pricing",       tags=["pricing"])
app.include_router(oidc_api.router,    prefix="/api/auth/oidc",      tags=["oidc"])

if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


@app.get("/login")
async def login_page():
    return FileResponse(str(_STATIC_DIR / "login.html"))


@app.get("/reset-password")
async def reset_password_page():
    return FileResponse(str(_STATIC_DIR / "reset-password.html"))


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    """Serve the SPA shell for all non-API routes."""
    return FileResponse(str(_STATIC_DIR / "index.html"))
