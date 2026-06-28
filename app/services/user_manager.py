"""User creation, bulk CSV import, and password reset helpers."""
from __future__ import annotations
import csv
import io
import re
import uuid
from datetime import datetime, timezone

from app.auth import hash_password
from app.database import get_db

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def create_user(email: str, password: str, role_id: str) -> dict:
    async with get_db() as db:
        # Validate role exists
        cursor = await db.execute("SELECT id FROM roles WHERE id=?", [role_id])
        if not await cursor.fetchone():
            raise ValueError(f"Role '{role_id}' not found")

        user_id = str(uuid.uuid4())
        now = _now()
        await db.execute(
            """INSERT INTO users (id, email, password_hash, role_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?)""",
            [user_id, email.lower().strip(), hash_password(password), role_id, now, now],
        )
        return {"id": user_id, "email": email, "role_id": role_id}


async def bulk_import_csv(csv_bytes: bytes, importer_permissions: list[str] | None = None) -> dict:
    """
    Parse CSV with columns: email, role
    Returns {created, skipped, errors}
    """
    text = csv_bytes.decode("utf-8-sig")  # strip BOM if present
    reader = csv.DictReader(io.StringIO(text))

    # Normalise header names (lowercase, strip whitespace)
    if reader.fieldnames is None:
        return {"created": 0, "skipped": 0, "errors": [{"row": 0, "reason": "Empty or unreadable CSV"}]}

    fieldnames = [f.lower().strip() for f in reader.fieldnames]
    if "email" not in fieldnames or "role" not in fieldnames:
        return {"created": 0, "skipped": 0, "errors": [
            {"row": 0, "reason": f"CSV must have 'email' and 'role' columns. Found: {fieldnames}"}
        ]}

    created = 0
    skipped = 0
    errors = []
    importer_perm_set = set(importer_permissions or [])

    async with get_db() as db:
        for i, raw_row in enumerate(reader, start=2):  # row 1 is header
            row = {k.lower().strip(): v.strip() for k, v in raw_row.items()}
            email = row.get("email", "")
            role_id = row.get("role", "")
            password = row.get("password", "")  # optional column

            if not email:
                errors.append({"row": i, "reason": "Missing email"})
                continue
            if not _EMAIL_RE.match(email):
                errors.append({"row": i, "reason": f"Invalid email: {email}"})
                continue
            if not role_id:
                errors.append({"row": i, "reason": "Missing role"})
                continue

            # Check role exists
            cursor = await db.execute("SELECT id FROM roles WHERE id=?", [role_id])
            if not await cursor.fetchone():
                errors.append({"row": i, "reason": f"Unknown role: {role_id}"})
                continue

            # Privilege escalation guard: target role permissions must be ⊆ importer's permissions
            c2 = await db.execute(
                "SELECT permission FROM role_permissions WHERE role_id=?", [role_id]
            )
            target_perms = {r["permission"] for r in await c2.fetchall()}
            if not target_perms.issubset(importer_perm_set):
                errors.append({"row": i, "reason": "Cannot assign a role with permissions exceeding your own"})
                continue

            # Check email already exists
            cursor = await db.execute("SELECT id FROM users WHERE email=?", [email.lower()])
            if await cursor.fetchone():
                skipped += 1
                continue

            # Use provided password or generate one
            if not password:
                import secrets
                password = secrets.token_urlsafe(16)

            now = _now()
            await db.execute(
                """INSERT INTO users (id, email, password_hash, role_id, created_at, updated_at)
                   VALUES (?,?,?,?,?,?)""",
                [str(uuid.uuid4()), email.lower(), hash_password(password), role_id, now, now],
            )
            created += 1

    return {"created": created, "skipped": skipped, "errors": errors}
