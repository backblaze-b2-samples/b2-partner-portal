"""Group member management — Partner API passthrough with audit logging."""
from __future__ import annotations
import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File

from app.auth import CurrentUser
from app.config import settings
from app.database import get_db
from app.rbac import MEMBERS_EJECT, MEMBERS_READ, MEMBERS_WRITE, require_permission
from app.services import vault as credential_vault
from app.schemas import (
    BulkMemberImportResponse, BulkMemberResult,
    MemberCreate, MemberCreateResponse, MemberEject, MemberEjectResponse,
    MemberResponse, MembersListResponse,
)

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_member(m: dict) -> MemberResponse:
    return MemberResponse(
        account_id=m.get("accountId", ""),
        email=m.get("email", ""),
        region=m.get("region", ""),
        s3_endpoint=m.get("s3Endpoint"),
        raw=m,
    )


async def _audit(user: CurrentUser, action: str, target_type: str,
                  target_id: str, details: dict, request: Request):
    import json
    async with get_db() as db:
        await db.execute(
            """INSERT INTO audit_log (user_id, user_email, action, target_type, target_id, details, ip_address, occurred_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            [user.id, user.email, action, target_type, target_id,
             json.dumps(details),
             request.client.host if request.client else "",
             _now()],
        )


@router.get("/{group_id}/members", response_model=MembersListResponse)
async def list_members(
    group_id: str,
    request: Request,
    cursor: str | None = Query(None, description="Pagination cursor (email from previous response)"),
    limit: int = Query(100, ge=1, le=1000),
    _: CurrentUser = require_permission(MEMBERS_READ),
):
    client = request.app.state.b2_client
    try:
        result, b2_call = await client.list_group_members_with_retry(group_id, cursor=cursor, max_count=limit)
    except RuntimeError as e:
        msg = str(e)
        if "[invalid_group_id]" in msg:
            raise HTTPException(404, "Group not found or you are not an admin for this group.")
        if "[bad_auth_token]" in msg or "[expired_auth_token]" in msg:
            raise HTTPException(401, "Backblaze authentication failed. Check your credentials in Settings.")
        if "[unauthorized]" in msg:
            raise HTTPException(403, "The configured API key does not have access to this group.")
        if "[out_of_range]" in msg:
            raise HTTPException(400, "maxMemberCount is out of range (1–1000).")
        raise HTTPException(502, msg.replace("[bad_request] ", ""))

    members = [_parse_member(m) for m in result.get("groupMembers", [])]
    return MembersListResponse(
        group_id=group_id,
        group_name=result.get("groupName"),
        members=members,
        next_cursor=result.get("nextEmail"),
        b2_api_call=b2_call,
    )


@router.post("/{group_id}/members", response_model=MemberCreateResponse, status_code=201)
async def create_member(
    group_id: str,
    body: MemberCreate,
    request: Request,
    current_user: CurrentUser = require_permission(MEMBERS_WRITE),
):
    client = request.app.state.b2_client
    try:
        result, b2_call = await client.create_group_member_with_retry(group_id, body.email, body.region)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    gm = result.get("groupMember", {})
    member = _parse_member(gm)

    account_id = gm.get("accountId", "")
    app_key_id = result.get("applicationKeyId", "")
    app_key = result.get("applicationKey", "")

    await _audit(current_user, "member.create", "member",
                 account_id,
                 {"email": body.email, "region": body.region, "group_id": group_id},
                 request)

    if settings.credential_vault_enabled and account_id and app_key_id and app_key:
        await credential_vault.store_credentials(
            account_id=account_id,
            account_email=body.email,
            group_id=group_id,
            application_key_id=app_key_id,
            application_key=app_key,
            created_by_user_id=current_user.id,
            region=member.region,
            s3_endpoint=member.s3_endpoint or "",
        )

    return MemberCreateResponse(
        member=member,
        credentials={
            "application_key_id": app_key_id,
            "application_key": app_key,
            "note": "Store these credentials securely — the application_key will not be shown again."
                    + (" A copy has been saved to the credential vault." if settings.credential_vault_enabled else ""),
        },
        b2_api_call=b2_call,
    )


@router.post("/{group_id}/members/bulk", response_model=BulkMemberImportResponse)
async def bulk_create_members(
    group_id: str,
    request: Request,
    file: UploadFile = File(...),
    current_user: CurrentUser = require_permission(MEMBERS_WRITE),
):
    """Accept a CSV with 'email' and 'region' columns and create each as a group member."""
    content = await file.read()
    try:
        reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
        rows = list(reader)
    except Exception as e:
        raise HTTPException(400, f"Could not parse CSV: {e}")

    if not rows:
        raise HTTPException(400, "CSV is empty")
    if "email" not in (reader.fieldnames or []):
        raise HTTPException(400, "CSV must have an 'email' column")

    client = request.app.state.b2_client
    results: list[BulkMemberResult] = []

    for row in rows:
        email = row.get("email", "").strip()
        region = row.get("region", "us-west").strip() or "us-west"
        if not email:
            continue
        try:
            result, b2_call = await client.create_group_member_with_retry(group_id, email, region)
            gm = result.get("groupMember", {})
            acct_id = gm.get("accountId", "")
            bulk_key_id = result.get("applicationKeyId", "")
            bulk_key = result.get("applicationKey", "")
            await _audit(current_user, "member.create", "member",
                         acct_id,
                         {"email": email, "region": region, "group_id": group_id, "bulk": True},
                         request)
            if settings.credential_vault_enabled and acct_id and bulk_key_id and bulk_key:
                await credential_vault.store_credentials(
                    account_id=acct_id,
                    account_email=email,
                    group_id=group_id,
                    application_key_id=bulk_key_id,
                    application_key=bulk_key,
                    created_by_user_id=current_user.id,
                    region=region,
                    s3_endpoint=gm.get("s3Endpoint") or "",
                )
            results.append(BulkMemberResult(
                email=email, region=region, success=True,
                account_id=acct_id,
                s3_endpoint=gm.get("s3Endpoint") or "",
                application_key_id=bulk_key_id,
                application_key=bulk_key,
                b2_api_call=b2_call,
            ))
        except Exception as e:
            results.append(BulkMemberResult(email=email, region=region, success=False, error=str(e)))

    return BulkMemberImportResponse(
        created=sum(1 for r in results if r.success),
        failed=sum(1 for r in results if not r.success),
        results=results,
    )


@router.delete("/{group_id}/members/{member_account_id}", response_model=MemberEjectResponse)
async def eject_member(
    group_id: str,
    member_account_id: str,
    request: Request,
    body: MemberEject = MemberEject(),
    current_user: CurrentUser = require_permission(MEMBERS_EJECT),
):
    client = request.app.state.b2_client
    try:
        result, b2_call = await client.eject_group_member(group_id, member_account_id, email=body.email or None)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    await _audit(current_user, "member.eject", "member",
                 member_account_id,
                 {"group_id": group_id, "email": result.get("email", "")},
                 request)

    return MemberEjectResponse(
        success=True,
        message=f"Member {result.get('email', member_account_id)} ejected from group.",
        b2_api_call=b2_call,
    )
