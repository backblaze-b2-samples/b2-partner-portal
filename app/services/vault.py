"""Credential vault — Fernet-encrypted storage for B2 member credentials."""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings
from app.database import get_db

log = logging.getLogger(__name__)


def _fernet() -> Fernet:
    key = settings.credential_vault_key
    if not key:
        raise RuntimeError("CREDENTIAL_VAULT_KEY is not set — cannot encrypt/decrypt credentials")
    return Fernet(key.encode())


async def store_credentials(
    account_id: str,
    account_email: str,
    group_id: str,
    application_key_id: str,
    application_key: str,
    created_by_user_id: str,
    region: str = "",
    s3_endpoint: str = "",
) -> None:
    f = _fernet()
    enc_key_id = f.encrypt(application_key_id.encode()).decode()
    enc_key = f.encrypt(application_key.encode()).decode()
    now = datetime.now(timezone.utc).isoformat()
    async with get_db() as db:
        await db.execute(
            """INSERT INTO credential_vault
               (member_account_id, account_email, group_id, encrypted_key_id, encrypted_key,
                region, s3_endpoint, created_at, created_by_user_id)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(member_account_id) DO UPDATE SET
                 encrypted_key_id=excluded.encrypted_key_id,
                 encrypted_key=excluded.encrypted_key,
                 account_email=excluded.account_email,
                 group_id=excluded.group_id,
                 region=excluded.region,
                 s3_endpoint=excluded.s3_endpoint,
                 created_at=excluded.created_at,
                 created_by_user_id=excluded.created_by_user_id""",
            [account_id, account_email, group_id, enc_key_id, enc_key,
             region, s3_endpoint, now, created_by_user_id],
        )


async def retrieve_credentials(account_id: str) -> dict | None:
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM credential_vault WHERE member_account_id=?", [account_id]
        )
        row = await cursor.fetchone()
    if row is None:
        return None
    f = _fernet()
    try:
        return {
            "member_account_id": row["member_account_id"],
            "account_email": row["account_email"],
            "group_id": row["group_id"],
            "region": row["region"] or "",
            "s3_endpoint": row["s3_endpoint"] or "",
            "application_key_id": f.decrypt(row["encrypted_key_id"].encode()).decode(),
            "application_key": f.decrypt(row["encrypted_key"].encode()).decode(),
            "created_at": row["created_at"],
        }
    except InvalidToken:
        log.error("Decryption failed for account %s — vault key may have changed", account_id)
        raise RuntimeError("Decryption failed: vault key mismatch or data is corrupted")
