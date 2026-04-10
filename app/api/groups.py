"""Groups list and cache refresh — Partner API passthrough."""
from __future__ import annotations
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request

from app.auth import CurrentUser
from app.database import get_db
from app.rbac import GROUPS_READ, require_permission
from app.schemas import GroupResponse, GroupsListResponse

router = APIRouter()

_CACHE_TTL_SECONDS = 300  # 5 minutes


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _groups_from_cache() -> list[dict] | None:
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM groups_cache ORDER BY group_name")
        rows = await cursor.fetchall()
    if not rows:
        return None
    # Check freshness using the most recent cached_at
    most_recent = max(r["cached_at"] for r in rows)
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(most_recent)).total_seconds()
    if age > _CACHE_TTL_SECONDS:
        return None
    return [dict(r) for r in rows]


async def _refresh_groups_cache(client) -> tuple[list[dict], list]:
    groups, api_calls = await client.list_all_groups_with_retry()
    now = _now()
    async with get_db() as db:
        await db.execute("DELETE FROM groups_cache")
        for g in groups:
            await db.execute(
                "INSERT INTO groups_cache (group_id, group_name, raw_json, cached_at) VALUES (?,?,?,?)",
                [g["groupId"], g.get("groupName", ""), json.dumps(g), now],
            )
    return groups, api_calls


@router.get("", response_model=GroupsListResponse)
async def list_groups(
    request: Request,
    refresh: bool = Query(False, description="Force re-fetch from Backblaze"),
    _: CurrentUser = require_permission(GROUPS_READ),
):
    client = request.app.state.b2_client
    b2_call = None

    try:
        if refresh:
            groups_raw, api_calls = await _refresh_groups_cache(client)
            b2_call = api_calls[-1] if api_calls else None
        else:
            cached = await _groups_from_cache()
            if cached is None:
                groups_raw, api_calls = await _refresh_groups_cache(client)
                b2_call = api_calls[-1] if api_calls else None
            else:
                groups_raw = [{"groupId": r["group_id"], "groupName": r["group_name"], **json.loads(r["raw_json"])}
                              for r in cached]
    except RuntimeError as e:
        msg = str(e)
        if "[bad_auth_token]" in msg or "[expired_auth_token]" in msg:
            raise HTTPException(401, "Backblaze authentication failed. Check your credentials in Settings.")
        if "[unauthorized]" in msg:
            raise HTTPException(403, "The configured API key does not have Partner API access.")
        raise HTTPException(502, msg.replace("[bad_request] ", ""))

    async with get_db() as db:
        cursor = await db.execute("SELECT MAX(cached_at) as latest FROM groups_cache")
        row = await cursor.fetchone()
        cached_at = row["latest"] if row else None

    groups = [GroupResponse(
        group_id=g["groupId"],
        group_name=g.get("groupName", ""),
        raw=g,
        cached_at=cached_at or _now(),
    ) for g in groups_raw]

    return GroupsListResponse(groups=groups, total=len(groups), cached_at=cached_at, b2_api_call=b2_call)


@router.post("/refresh", response_model=GroupsListResponse)
async def force_refresh(request: Request, _: CurrentUser = require_permission(GROUPS_READ)):
    return await list_groups(request, refresh=True, _=_)


@router.get("/{group_id}", response_model=GroupResponse)
async def get_group(group_id: str, _: CurrentUser = require_permission(GROUPS_READ)):
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM groups_cache WHERE group_id=?", [group_id])
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Group not found. Try refreshing the groups list.")
    return GroupResponse(
        group_id=row["group_id"],
        group_name=row["group_name"],
        raw=json.loads(row["raw_json"]),
        cached_at=row["cached_at"],
    )
