"""JWT + session cookie auth helpers and get_current_user dependency."""
from __future__ import annotations
import uuid
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field

import bcrypt as _bcrypt
import jwt as _jwt
from fastapi import Depends, HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

from app.config import settings

JWTError = _jwt.PyJWTError
from app.database import get_db

ALGORITHM = "HS256"


# ── Password helpers ──────────────────────────────────────────────────────────

# Pre-computed dummy hash used in verify_password_always() to ensure constant
# response time regardless of whether the email address exists in the database.
# This prevents timing-based user enumeration on the login endpoint.
_DUMMY_HASH = _bcrypt.hashpw(b"dummy", _bcrypt.gensalt()).decode()


def hash_password(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


def verify_password_always(plain: str, hashed: str | None) -> bool:
    """Always runs bcrypt regardless of whether a hash was found.
    Use on login endpoints to prevent timing-based user enumeration.
    """
    return _bcrypt.checkpw(plain.encode(), (hashed or _DUMMY_HASH).encode())


# ── Session cookie ────────────────────────────────────────────────────────────

def _signer() -> TimestampSigner:
    return TimestampSigner(settings.secret_key)


def make_session_cookie(user_id: str) -> str:
    return _signer().sign(user_id).decode()


def verify_session_cookie(value: str, max_age: int = 86400) -> str | None:
    """Return user_id if cookie is valid, else None."""
    try:
        return _signer().unsign(value, max_age=max_age).decode()
    except (BadSignature, SignatureExpired):
        return None


# ── JWT ───────────────────────────────────────────────────────────────────────

def create_access_token(user_id: str, refresh_token_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return _jwt.encode(
        {"sub": user_id, "jti": refresh_token_id, "exp": expire, "type": "access"},
        settings.secret_key, algorithm=ALGORITHM,
    )


def create_refresh_token() -> tuple[str, datetime]:
    """Return (token_id, expires_at)."""
    token_id = str(uuid.uuid4())
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    return token_id, expires_at


def decode_access_token(token: str) -> dict:
    """Decode and validate. Raises JWTError on failure."""
    payload = _jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    if payload.get("type") != "access":
        raise JWTError("Not an access token")
    return payload


# ── Current user ──────────────────────────────────────────────────────────────

@dataclass
class CurrentUser:
    id: str
    email: str
    role_id: str
    permissions: set[str] = field(default_factory=set)
    is_active: bool = True


async def _load_user(user_id: str) -> CurrentUser | None:
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT id, email, role_id, is_active FROM users WHERE id=?", [user_id]
        )
        row = await cursor.fetchone()
        if not row or not row["is_active"]:
            return None
        cursor = await db.execute(
            "SELECT permission FROM role_permissions WHERE role_id=?", [row["role_id"]]
        )
        perms = {r["permission"] for r in await cursor.fetchall()}
        return CurrentUser(
            id=row["id"], email=row["email"],
            role_id=row["role_id"], permissions=perms,
        )


async def get_current_user(request: Request) -> CurrentUser:
    """FastAPI dependency. Accepts Bearer token or session cookie."""
    user_id: str | None = None

    # 1. Try Authorization: Bearer header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        try:
            payload = decode_access_token(token)
            user_id = payload["sub"]
        except JWTError:
            pass

    # 2. Fall back to session cookie
    if not user_id:
        cookie = request.cookies.get("session", "")
        user_id = verify_session_cookie(cookie) if cookie else None

    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user = await _load_user(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user
