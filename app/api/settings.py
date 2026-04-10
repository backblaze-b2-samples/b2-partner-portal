"""Partner API credentials and report bucket configuration."""
import os
from fastapi import APIRouter, Depends, HTTPException, Request

from app.auth import CurrentUser, get_current_user
from app.config import settings
from app.database import get_config, set_config
from app.rbac import SETTINGS_READ, SETTINGS_WRITE, require_permission
from app.schemas import ConnectionTestResponse, DiskUsageEntry, DiskUsageResponse, SettingsResponse, SettingsUpdate

router = APIRouter()


@router.get("/status")
async def get_settings_status(_: CurrentUser = Depends(get_current_user)):
    """Returns only whether credentials are configured. Available to all authenticated users."""
    creds = await get_config("partner_credentials") or {}
    return {"configured": bool(creds.get("account_id") and creds.get("application_key_id"))}


@router.get("", response_model=SettingsResponse)
async def get_settings(_: CurrentUser = require_permission(SETTINGS_READ)):
    creds = await get_config("partner_credentials") or {}
    bucket_cfg = await get_config("report_bucket") or {}

    key = creds.get("application_key", "")
    masked = ("B2" + "•" * (len(key) - 6) + key[-4:]) if len(key) > 6 else ("•" * len(key) if key else None)

    return SettingsResponse(
        account_id=creds.get("account_id"),
        application_key_id=creds.get("application_key_id"),
        application_key_masked=masked,
        report_bucket=bucket_cfg.get("bucket_name"),
        report_prefix=bucket_cfg.get("prefix", "daily-reports/"),
        configured=bool(creds.get("account_id") and creds.get("application_key_id")),
    )


@router.put("", response_model=SettingsResponse)
async def update_settings(body: SettingsUpdate, request: Request,
                           _: CurrentUser = require_permission(SETTINGS_WRITE)):
    await set_config("partner_credentials", {
        "account_id": body.account_id,
        "application_key_id": body.application_key_id,
        "application_key": body.application_key,
    })
    bucket_name = body.report_bucket or f"b2-reports-{body.account_id}"
    await set_config("report_bucket", {
        "bucket_name": bucket_name,
        "prefix": body.report_prefix or "",
        "account_id": body.account_id,
    })

    # Invalidate token cache so next request re-authorizes with new credentials
    client = request.app.state.b2_client
    await client.invalidate_token_cache()

    return await get_settings(_)  # type: ignore[arg-type]


@router.post("/test-connection", response_model=ConnectionTestResponse)
async def test_connection(request: Request, _: CurrentUser = require_permission(SETTINGS_READ)):
    creds = await get_config("partner_credentials")
    if not creds:
        raise HTTPException(400, "Credentials not configured")

    client = request.app.state.b2_client
    try:
        result, b2_call = await client.authorize_account(
            creds["account_id"], creds["application_key_id"], creds["application_key"]
        )
        # Cache the fresh token
        groups_api_url = result.get("apiInfo", {}).get("groupsApi", {}).get("groupsApiUrl", "")
        await client._cache_token(result, groups_api_url)
        return ConnectionTestResponse(
            success=True,
            message=f"Connected successfully. Account: {result['accountId']}",
            b2_api_call=b2_call,
        )
    except Exception as e:
        return ConnectionTestResponse(success=False, message=str(e))


@router.get("/disk-usage", response_model=DiskUsageResponse)
async def get_disk_usage(_: CurrentUser = require_permission(SETTINGS_READ)):
    def dir_size(path) -> tuple[int, int]:
        """Return (total_bytes, file_count) for a directory tree."""
        from pathlib import Path as _Path
        path = _Path(path)
        total, count = 0, 0
        if not path.exists():
            return 0, 0
        for entry in os.scandir(path):
            if entry.is_file(follow_symlinks=False):
                total += entry.stat().st_size
                count += 1
            elif entry.is_dir(follow_symlinks=False):
                sub_bytes, sub_count = dir_size(entry.path)
                total += sub_bytes
                count += sub_count
        return total, count

    def file_size(path) -> int:
        try:
            return path.stat().st_size if path.exists() else 0
        except OSError:
            return 0

    # ── Database ────────────────────────────────────────────────────────────
    db_bytes = (
        file_size(settings.db_path)
        + file_size(settings.db_path.with_suffix(".db-wal"))
        + file_size(settings.db_path.with_suffix(".db-shm"))
    )

    # ── Cached report CSVs ──────────────────────────────────────────────────
    reports_bytes, reports_file_count = dir_size(settings.reports_dir)

    # Count distinct day directories
    reports_day_count = 0
    if settings.reports_dir.exists():
        reports_day_count = sum(
            1 for e in os.scandir(settings.reports_dir) if e.is_dir()
        )

    entries = [
        DiskUsageEntry(
            label="Database",
            bytes=db_bytes,
            file_count=1,
            description="SQLite database — users, audit log, config, cached group/member metadata",
        ),
        DiskUsageEntry(
            label="Report Cache",
            bytes=reports_bytes,
            file_count=reports_file_count,
            description=(
                f"{reports_day_count} day{'s' if reports_day_count != 1 else ''} cached "
                "— downloaded usage CSVs from your report bucket"
                if reports_file_count else
                "No reports cached yet"
            ),
        ),
    ]

    total_bytes = sum(e.bytes for e in entries)

    return DiskUsageResponse(
        entries=entries,
        total_bytes=total_bytes,
        data_dir=str(settings.data_dir.resolve()),
    )
