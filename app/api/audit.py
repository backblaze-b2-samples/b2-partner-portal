"""Audit log — read and export."""
from __future__ import annotations
import csv
import io
import json

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.database import get_db
from app.rbac import AUDIT_READ, require_permission

router = APIRouter()


@router.get("")
async def list_audit_log(
    action: str | None = Query(None, description="Filter by action (e.g. member.create)"),
    user_email: str | None = Query(None, description="Filter by portal user email (partial match)"),
    since: str | None = Query(None, description="ISO date lower bound, e.g. 2025-01-01"),
    until: str | None = Query(None, description="ISO date upper bound, e.g. 2025-12-31"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    _=require_permission(AUDIT_READ),
):
    where, params = _build_where(action, user_email, since, until)
    query = f"""
        SELECT id, user_id, user_email, action, target_type, target_id,
               details, ip_address, occurred_at
        FROM audit_log
        {where}
        ORDER BY occurred_at DESC
        LIMIT ? OFFSET ?
    """
    count_query = f"SELECT COUNT(*) FROM audit_log {where}"

    async with get_db() as db:
        cur = await db.execute(count_query, params)
        total = (await cur.fetchone())[0]
        cur = await db.execute(query, params + [limit, offset])
        rows = await cur.fetchall()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "entries": [_row(r) for r in rows],
    }


@router.get("/export")
async def export_audit_log(
    action: str | None = Query(None),
    user_email: str | None = Query(None),
    since: str | None = Query(None),
    until: str | None = Query(None),
    _=require_permission(AUDIT_READ),
):
    where, params = _build_where(action, user_email, since, until)
    query = f"""
        SELECT id, occurred_at, user_email, action, target_type, target_id,
               details, ip_address
        FROM audit_log
        {where}
        ORDER BY occurred_at DESC
    """
    async with get_db() as db:
        cur = await db.execute(query, params)
        rows = await cur.fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "occurred_at", "user_email", "action",
                     "target_type", "target_id", "details", "ip_address"])
    for r in rows:
        writer.writerow([
            r["id"], r["occurred_at"], _csv_safe(r["user_email"] or ""),
            r["action"], r["target_type"] or "", _csv_safe(r["target_id"] or ""),
            _csv_safe(r["details"] or ""), r["ip_address"] or "",
        ])

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=audit_log.csv"},
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _csv_safe(v: str) -> str:
    """Prevent CSV formula injection by prefixing dangerous leading characters."""
    s = str(v)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "\t" + s
    return s


def _build_where(action, user_email, since, until):
    clauses, params = [], []
    if action:
        clauses.append("action = ?")
        params.append(action)
    if user_email:
        clauses.append("user_email LIKE ?")
        params.append(f"%{user_email}%")
    if since:
        clauses.append("occurred_at >= ?")
        params.append(since)
    if until:
        clauses.append("occurred_at <= ?")
        params.append(until + "T23:59:59")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def _row(r) -> dict:
    details = {}
    if r["details"]:
        try:
            details = json.loads(r["details"])
        except ValueError:
            details = {"raw": r["details"]}
    return {
        "id":          r["id"],
        "occurred_at": r["occurred_at"],
        "user_email":  r["user_email"],
        "action":      r["action"],
        "target_type": r["target_type"],
        "target_id":   r["target_id"],
        "details":     details,
        "ip_address":  r["ip_address"],
    }
