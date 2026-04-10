"""Auth endpoints: login, logout, refresh, /me."""
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from app.auth import (
    CurrentUser, create_access_token, create_refresh_token,
    get_current_user, hash_password, make_session_cookie, verify_password,
    verify_password_always,
)
from app.config import settings
from app.database import get_db
from app.limiter import limiter
from app.schemas import LoginRequest, MeResponse, RefreshRequest, TokenResponse

router = APIRouter()

_LOCKOUT_THRESHOLD = 5       # failed attempts before lockout
_LOCKOUT_MINUTES   = 30      # how long to lock the account


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _audit_login(user_id: str | None, email: str, success: bool,
                       ip: str, details: dict | None = None) -> None:
    async with get_db() as db:
        await db.execute(
            """INSERT INTO audit_log
               (user_id, user_email, action, target_type, target_id, details, ip_address, occurred_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            [user_id, email,
             "auth.login" if success else "auth.login_failed",
             "portal_user", user_id or "",
             json.dumps(details or {}),
             ip, _now()],
        )


@router.post("/login", response_model=TokenResponse)
@limiter.limit("20/minute")
async def login(request: Request, response: Response, body: LoginRequest = Body()):
    ip = request.client.host if request.client else ""

    async with get_db() as db:
        cursor = await db.execute(
            """SELECT id, email, password_hash, role_id, is_active,
                      failed_login_attempts, locked_until
               FROM users WHERE email=?""",
            [body.email.lower().strip()],
        )
        user = await cursor.fetchone()

    # Account lockout check (before expensive bcrypt)
    if user and user["locked_until"]:
        locked_until = datetime.fromisoformat(user["locked_until"])
        if datetime.now(timezone.utc) < locked_until:
            raise HTTPException(
                status_code=429,
                detail="Account temporarily locked due to too many failed attempts. "
                       "Please try again later.",
            )

    # Always run bcrypt — even for unknown emails — to prevent timing-based
    # user enumeration. verify_password_always() uses a dummy hash when no
    # real hash is available, keeping response time constant.
    password_ok = verify_password_always(
        body.password, user["password_hash"] if user else None
    )
    valid = user is not None and bool(user["is_active"]) and password_ok

    if not valid:
        if user:
            attempts = (user["failed_login_attempts"] or 0) + 1
            lock_until_val = None
            if attempts >= _LOCKOUT_THRESHOLD:
                lock_until_val = (
                    datetime.now(timezone.utc) + timedelta(minutes=_LOCKOUT_MINUTES)
                ).isoformat()
            async with get_db() as db:
                await db.execute(
                    "UPDATE users SET failed_login_attempts=?, locked_until=? WHERE id=?",
                    [attempts, lock_until_val, user["id"]],
                )
        await _audit_login(
            user["id"] if user else None,
            body.email.lower().strip(),
            False, ip,
        )
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Successful login — reset lockout, issue tokens, audit
    token_id, expires_at = create_refresh_token()
    async with get_db() as db:
        await db.execute(
            """INSERT INTO refresh_tokens (id, user_id, issued_at, expires_at, user_agent, ip_address)
               VALUES (?,?,?,?,?,?)""",
            [token_id, user["id"], _now(), expires_at.isoformat(),
             request.headers.get("user-agent", ""), ip],
        )
        await db.execute(
            """UPDATE users
               SET last_login_at=?, failed_login_attempts=0, locked_until=NULL
               WHERE id=?""",
            [_now(), user["id"]],
        )

    await _audit_login(user["id"], user["email"], True, ip)

    access_token = create_access_token(user["id"], token_id)

    response.set_cookie(
        "session", make_session_cookie(user["id"]),
        httponly=True, samesite="lax", max_age=settings.refresh_token_expire_days * 86400, secure=True,
    )

    return TokenResponse(access_token=access_token, refresh_token=token_id)


@router.post("/logout")
async def logout(body: RefreshRequest, response: Response):
    async with get_db() as db:
        await db.execute(
            "UPDATE refresh_tokens SET revoked=1 WHERE id=?", [body.refresh_token]
        )
    response.delete_cookie("session")
    return {"message": "Logged out"}


@router.post("/refresh", response_model=TokenResponse)
@limiter.limit("30/minute")
async def refresh(body: RefreshRequest, request: Request):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM refresh_tokens WHERE id=? AND revoked=0", [body.refresh_token]
        )
        token_row = await cursor.fetchone()

    if not token_row:
        raise HTTPException(status_code=401, detail="Invalid or revoked refresh token")

    expires_at = datetime.fromisoformat(token_row["expires_at"])
    if datetime.now(timezone.utc) >= expires_at:
        raise HTTPException(status_code=401, detail="Refresh token expired")

    # Rotate: revoke old token, issue new one (prevents replay if token is leaked)
    new_token_id, new_expires_at = create_refresh_token()
    async with get_db() as db:
        await db.execute("UPDATE refresh_tokens SET revoked=1 WHERE id=?", [token_row["id"]])
        await db.execute(
            """INSERT INTO refresh_tokens (id, user_id, issued_at, expires_at, user_agent, ip_address)
               VALUES (?,?,?,?,?,?)""",
            [new_token_id, token_row["user_id"], _now(), new_expires_at.isoformat(),
             token_row["user_agent"], token_row["ip_address"]],
        )

    access_token = create_access_token(token_row["user_id"], new_token_id)
    return TokenResponse(access_token=access_token, refresh_token=new_token_id)


@router.get("/me", response_model=MeResponse)
async def me(current_user: CurrentUser = Depends(get_current_user)):
    return MeResponse(
        id=current_user.id,
        email=current_user.email,
        role_id=current_user.role_id,
        permissions=sorted(current_user.permissions),
        api_inspector_enabled=settings.api_inspector_enabled,
    )
