"""Credential vault retrieval endpoints."""
from __future__ import annotations
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from app.auth import CurrentUser
from app.config import settings
from app.database import get_db
from app.rbac import CREDENTIALS_READ, require_permission
from app.schemas import VaultedCredentialResponse
from app.services.vault import retrieve_credentials

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _audit_vault_access(user: CurrentUser, account_id: str, request: Request) -> None:
    async with get_db() as db:
        await db.execute(
            """INSERT INTO audit_log
               (user_id, user_email, action, target_type, target_id, details, ip_address, occurred_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            [user.id, user.email, "credentials.retrieve", "member", account_id,
             json.dumps({"vault_access": True}),
             request.client.host if request.client else "",
             _now()],
        )


@router.get("/{account_id}", response_model=VaultedCredentialResponse)
async def get_stored_credentials(
    account_id: str,
    request: Request,
    current_user: CurrentUser = require_permission(CREDENTIALS_READ),
):
    """Retrieve the stored (encrypted-at-rest) credentials for a B2 member account."""
    if not settings.credential_vault_enabled:
        raise HTTPException(404, "Credential vault is not enabled on this instance.")
    try:
        creds = await retrieve_credentials(account_id)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    if creds is None:
        raise HTTPException(404, f"No stored credentials found for account {account_id}.")
    await _audit_vault_access(current_user, account_id, request)
    return VaultedCredentialResponse(**creds)
