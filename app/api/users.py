"""User CRUD, bulk import, and password reset."""
from __future__ import annotations
import uuid
from datetime import datetime, timezone

import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request, UploadFile, File
from itsdangerous import URLSafeTimedSerializer

from app.auth import CurrentUser, hash_password
from app.config import settings
from app.database import get_db
from app.limiter import limiter
from app.rbac import USERS_READ, USERS_WRITE, require_permission
from app.schemas import BulkImportResult, UserCreate, UserResponse, UserUpdate
from app.services.user_manager import bulk_import_csv, create_user

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _audit(actor: CurrentUser | None, action: str, target_id: str,
                 details: dict, request: Request) -> None:
    async with get_db() as db:
        await db.execute(
            """INSERT INTO audit_log
               (user_id, user_email, action, target_type, target_id, details, ip_address, occurred_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            [actor.id if actor else None,
             actor.email if actor else None,
             action, "portal_user", target_id,
             json.dumps(details),
             request.client.host if request.client else "",
             _now()],
        )


async def _check_role_assignable(role_id: str, current_user: CurrentUser) -> None:
    """Raise 403 if the target role has any permission the current user does not hold."""
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT permission FROM role_permissions WHERE role_id=?", [role_id]
        )
        rows = await cursor.fetchall()
    target_perms = {r["permission"] for r in rows}
    if not target_perms.issubset(set(current_user.permissions)):
        raise HTTPException(403, "Cannot assign a role with permissions exceeding your own")


async def _user_response(row) -> UserResponse:
    async with get_db() as db:
        cursor = await db.execute("SELECT name FROM roles WHERE id=?", [row["role_id"]])
        role_row = await cursor.fetchone()
    return UserResponse(
        id=row["id"], email=row["email"], role_id=row["role_id"],
        role_name=role_row["name"] if role_row else row["role_id"],
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        last_login_at=row["last_login_at"],
        auth_source=row["auth_source"] if "auth_source" in row.keys() else "local",
    )


@router.get("", response_model=list[UserResponse])
async def list_users(_: CurrentUser = require_permission(USERS_READ)):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.created_at DESC"
        )
        rows = await cursor.fetchall()
    return [UserResponse(
        id=r["id"], email=r["email"], role_id=r["role_id"], role_name=r["role_name"],
        is_active=bool(r["is_active"]), created_at=r["created_at"], last_login_at=r["last_login_at"],
        auth_source=r["auth_source"] if "auth_source" in r.keys() else "local",
    ) for r in rows]


@router.post("", response_model=UserResponse, status_code=201)
async def create_user_endpoint(body: UserCreate, request: Request,
                                current_user: CurrentUser = require_permission(USERS_WRITE)):
    await _check_role_assignable(body.role_id, current_user)
    try:
        result = await create_user(body.email, body.password, body.role_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(409, "Email already registered")
        raise HTTPException(500, str(e))

    async with get_db() as db:
        cursor = await db.execute(
            "SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?",
            [result["id"]],
        )
        row = await cursor.fetchone()

    await _audit(current_user, "user.create", result["id"],
                 {"email": body.email, "role_id": body.role_id}, request)

    return UserResponse(
        id=row["id"], email=row["email"], role_id=row["role_id"], role_name=row["role_name"],
        is_active=True, created_at=row["created_at"], last_login_at=None,
        auth_source="local",
    )


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: str, _: CurrentUser = require_permission(USERS_READ)):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?",
            [user_id],
        )
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    return UserResponse(
        id=row["id"], email=row["email"], role_id=row["role_id"], role_name=row["role_name"],
        is_active=bool(row["is_active"]), created_at=row["created_at"], last_login_at=row["last_login_at"],
        auth_source=row["auth_source"] if "auth_source" in row.keys() else "local",
    )


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(user_id: str, body: UserUpdate, request: Request,
                       current_user: CurrentUser = require_permission(USERS_WRITE)):
    # Prevent users from changing their own role
    if user_id == current_user.id and body.role_id is not None:
        raise HTTPException(400, "Cannot change your own role")
    # Privilege escalation guard: cannot grant permissions you don't hold
    if body.role_id is not None:
        await _check_role_assignable(body.role_id, current_user)

    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM users WHERE id=?", [user_id])
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "User not found")

        if body.email is not None:
            await db.execute("UPDATE users SET email=?, updated_at=? WHERE id=?",
                             [body.email.lower(), _now(), user_id])
        if body.role_id is not None:
            cursor2 = await db.execute("SELECT id FROM roles WHERE id=?", [body.role_id])
            if not await cursor2.fetchone():
                raise HTTPException(400, f"Role '{body.role_id}' not found")
            await db.execute("UPDATE users SET role_id=?, updated_at=? WHERE id=?",
                             [body.role_id, _now(), user_id])
        if body.is_active is not None:
            await db.execute("UPDATE users SET is_active=?, updated_at=? WHERE id=?",
                             [1 if body.is_active else 0, _now(), user_id])
            if not body.is_active:
                # Revoke all refresh tokens for this user
                await db.execute("UPDATE refresh_tokens SET revoked=1 WHERE user_id=?", [user_id])

        cursor = await db.execute(
            "SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?",
            [user_id],
        )
        updated = await cursor.fetchone()

    changes = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    await _audit(current_user, "user.update", user_id,
                 {"target_email": updated["email"], **changes}, request)

    return UserResponse(
        id=updated["id"], email=updated["email"], role_id=updated["role_id"],
        role_name=updated["role_name"], is_active=bool(updated["is_active"]),
        created_at=updated["created_at"], last_login_at=updated["last_login_at"],
        auth_source=updated["auth_source"] if "auth_source" in updated.keys() else "local",
    )


@router.delete("/{user_id}")
async def delete_user(user_id: str, request: Request,
                       current_user: CurrentUser = require_permission(USERS_WRITE)):
    if user_id == current_user.id:
        raise HTTPException(400, "Cannot delete your own account")
    async with get_db() as db:
        cursor = await db.execute("SELECT id, email FROM users WHERE id=?", [user_id])
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "User not found")
        await db.execute("UPDATE users SET is_active=0, updated_at=? WHERE id=?", [_now(), user_id])
        await db.execute("UPDATE refresh_tokens SET revoked=1 WHERE user_id=?", [user_id])

    await _audit(current_user, "user.deactivate", user_id,
                 {"target_email": row["email"]}, request)
    return {"message": "User deactivated"}


@router.post("/bulk-import", response_model=BulkImportResult)
async def bulk_import(request: Request, file: UploadFile = File(...),
                       current_user: CurrentUser = require_permission(USERS_WRITE)):
    content = await file.read()
    if len(content) > 5 * 1024 * 1024:  # 5 MB cap
        raise HTTPException(400, "CSV file too large (max 5 MB)")
    result = await bulk_import_csv(content, importer_permissions=list(current_user.permissions))
    await _audit(current_user, "user.bulk_import", "",
                 {"created": result["created"], "skipped": result["skipped"],
                  "errors": len(result["errors"])}, request)
    return BulkImportResult(**result)


@router.post("/{user_id}/reset-password")
@limiter.limit("10/minute")
async def reset_password(user_id: str, request: Request,
                          current_user: CurrentUser = require_permission(USERS_WRITE)):
    async with get_db() as db:
        cursor = await db.execute("SELECT id, email FROM users WHERE id=?", [user_id])
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "User not found")
        s = URLSafeTimedSerializer(settings.secret_key)
        token = s.dumps(user_id, salt="password-reset")
        from datetime import timedelta
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        await db.execute(
            "UPDATE users SET password_reset_token=?, password_reset_expires_at=? WHERE id=?",
            [token, expires_at, user_id],
        )
    await _audit(current_user, "user.password_reset_issued", user_id,
                 {"target_email": row["email"]}, request)
    return {"reset_url": f"/reset-password?token={token}", "note": "Send this URL to the user out-of-band"}


@router.post("/complete-reset")
@limiter.limit("10/minute")
async def complete_password_reset(
    request: Request,
    token: str = Body(...),
    new_password: str = Body(...),
):
    s = URLSafeTimedSerializer(settings.secret_key)
    try:
        user_id = s.loads(token, salt="password-reset", max_age=3600)
    except Exception:
        raise HTTPException(400, "Invalid or expired reset token")

    if len(new_password) < 12:
        raise HTTPException(400, "Password must be at least 12 characters")

    async with get_db() as db:
        cursor = await db.execute(
            "SELECT id, email FROM users WHERE id=? AND password_reset_token=?", [user_id, token]
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(400, "Token already used or invalid")
        await db.execute(
            "UPDATE users SET password_hash=?, password_reset_token=NULL, "
            "password_reset_expires_at=NULL, updated_at=? WHERE id=?",
            [hash_password(new_password), _now(), user_id],
        )
        await db.execute("UPDATE refresh_tokens SET revoked=1 WHERE user_id=?", [user_id])

    await _audit(None, "user.password_reset_complete", user_id,
                 {"email": row["email"]}, request)
    return {"message": "Password updated"}
