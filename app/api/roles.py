"""Role CRUD — allows adding new roles + permission sets without code changes."""
from __future__ import annotations
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from app.auth import CurrentUser
from app.database import get_db
from app.rbac import ROLES_READ, ROLES_WRITE, require_permission
from app.schemas import RoleCreate, RoleResponse, RoleUpdate

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get("", response_model=list[RoleResponse])
async def list_roles(_: CurrentUser = require_permission(ROLES_READ)):
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM roles ORDER BY name")
        roles = await cursor.fetchall()
        result = []
        for role in roles:
            c = await db.execute(
                "SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission",
                [role["id"]],
            )
            perms = [r["permission"] for r in await c.fetchall()]
            result.append(RoleResponse(
                id=role["id"], name=role["name"], description=role["description"],
                permissions=perms, created_at=role["created_at"],
            ))
    return result


@router.post("", response_model=RoleResponse, status_code=201)
async def create_role(body: RoleCreate, _: CurrentUser = require_permission(ROLES_WRITE)):
    now = _now()
    async with get_db() as db:
        cursor = await db.execute("SELECT id FROM roles WHERE id=?", [body.id])
        if await cursor.fetchone():
            raise HTTPException(409, f"Role '{body.id}' already exists")
        await db.execute(
            "INSERT INTO roles (id, name, description, created_at) VALUES (?,?,?,?)",
            [body.id, body.name, body.description, now],
        )
        for p in set(body.permissions):
            await db.execute(
                "INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?,?)",
                [body.id, p],
            )
    return RoleResponse(id=body.id, name=body.name, description=body.description,
                         permissions=sorted(set(body.permissions)), created_at=now)


@router.patch("/{role_id}", response_model=RoleResponse)
async def update_role(role_id: str, body: RoleUpdate,
                       _: CurrentUser = require_permission(ROLES_WRITE)):
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM roles WHERE id=?", [role_id])
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "Role not found")

        if body.name is not None:
            await db.execute("UPDATE roles SET name=? WHERE id=?", [body.name, role_id])
        if body.description is not None:
            await db.execute("UPDATE roles SET description=? WHERE id=?", [body.description, role_id])
        if body.permissions is not None:
            await db.execute("DELETE FROM role_permissions WHERE role_id=?", [role_id])
            for p in set(body.permissions):
                await db.execute(
                    "INSERT INTO role_permissions (role_id, permission) VALUES (?,?)", [role_id, p]
                )

        cursor = await db.execute("SELECT * FROM roles WHERE id=?", [role_id])
        updated = await cursor.fetchone()
        c = await db.execute(
            "SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission", [role_id]
        )
        perms = [r["permission"] for r in await c.fetchall()]

    return RoleResponse(id=updated["id"], name=updated["name"], description=updated["description"],
                         permissions=perms, created_at=updated["created_at"])


@router.delete("/{role_id}")
async def delete_role(role_id: str, _: CurrentUser = require_permission(ROLES_WRITE)):
    if role_id in ("admin", "viewer"):
        raise HTTPException(400, "Cannot delete built-in roles")
    async with get_db() as db:
        cursor = await db.execute("SELECT COUNT(*) FROM users WHERE role_id=?", [role_id])
        count = (await cursor.fetchone())[0]
        if count > 0:
            raise HTTPException(409, f"Cannot delete role: {count} user(s) assigned to it")
        await db.execute("DELETE FROM roles WHERE id=?", [role_id])
    return {"message": f"Role '{role_id}' deleted"}
