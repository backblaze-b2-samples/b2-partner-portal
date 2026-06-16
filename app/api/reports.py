"""Usage report endpoints — download from B2, parse, and serve."""
from __future__ import annotations
from datetime import date, timedelta
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.auth import CurrentUser
from app.database import get_db, get_config, set_config
from app.rbac import REPORTS_READ, SETTINGS_READ, SETTINGS_WRITE, require_permission
from app.schemas import ReportDataResponse, ReportFileInfo
from app.services.report_parser import fetch_report_file, parse_csv_file
from app.services.report_aggregator import aggregate_reports as _aggregate, ALL_METRICS
from app.services.report_scheduler import fetch_date, fetch_date_range, enforce_retention
from app.config import settings

router = APIRouter()


@router.get("/aggregate")
async def aggregate_usage(
    start_date: str = Query(...),
    end_date: str = Query(...),
    group_by: str = Query("day"),
    metrics: str = Query("stored_gb,downloaded_gb,uploaded_gb"),
    bucket: str | None = Query(None),
    location: str | None = Query(None),
    account_id: str | None = Query(None),
    group_id: str | None = Query(None),
    _: CurrentUser = require_permission(REPORTS_READ),
):
    try:
        sd = date.fromisoformat(start_date)
        ed = date.fromisoformat(end_date)
    except ValueError:
        raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD.")
    if sd > ed:
        raise HTTPException(400, "start_date must be <= end_date.")
    if group_by not in ("day", "week", "month"):
        raise HTTPException(400, "group_by must be day, week, or month.")

    requested_metrics = [m.strip() for m in metrics.split(",") if m.strip() in ALL_METRICS]
    if not requested_metrics:
        requested_metrics = ALL_METRICS

    return await _aggregate(
        start_date=sd,
        end_date=ed,
        group_by=group_by,
        metrics=requested_metrics,
        bucket_filter=bucket or None,
        location_filter=location or None,
        account_id_filter=account_id or None,
        group_id_filter=group_id or None,
    )


_MAX_FETCH_RANGE_DAYS = 90


@router.post("/fetch-range")
async def fetch_reports_range(
    start_date: str = Query(...),
    end_date: str = Query(...),
    request: Request = None,
    _: CurrentUser = require_permission(REPORTS_READ),
):
    try:
        sd = date.fromisoformat(start_date)
        ed = date.fromisoformat(end_date)
    except ValueError:
        raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD.")
    if sd > ed:
        raise HTTPException(400, "start_date must be <= end_date.")
    if (ed - sd).days > _MAX_FETCH_RANGE_DAYS:
        raise HTTPException(400, f"Date range cannot exceed {_MAX_FETCH_RANGE_DAYS} days.")
    return await fetch_date_range(request.app.state.b2_client, sd, ed)


@router.get("/available", response_model=list[ReportFileInfo])
async def list_available_reports(
    group_id: str | None = Query(None),
    _: CurrentUser = require_permission(REPORTS_READ),
):
    async with get_db() as db:
        if group_id:
            cursor = await db.execute(
                "SELECT * FROM report_cache WHERE group_id=? ORDER BY report_date DESC", [group_id]
            )
        else:
            cursor = await db.execute("SELECT * FROM report_cache ORDER BY report_date DESC")
        rows = await cursor.fetchall()
    return [ReportFileInfo(
        report_date=r["report_date"], file_type=r["file_type"],
        group_id=r["group_id"], location=r["location"],
        file_size=r["file_size"], row_count=r["row_count"],
        downloaded_at=r["downloaded_at"],
    ) for r in rows]


@router.post("/fetch/{report_date}")
async def fetch_reports_for_date(
    report_date: str,
    request: Request,
    _: CurrentUser = require_permission(REPORTS_READ),
):
    """
    Trigger download of all report files for a given date.

    Cascades automatically:
    1. Always fetches account-level usage + audit files.
    2. Tries usage.groups.csv — if present, parses it for group IDs.
    3. For each group, fetches the reportingLocations file to discover regions.
    4. For each group+region, fetches the usage and audit files.
    """
    return await fetch_date(request.app.state.b2_client, report_date)


@router.get("/{report_date}/usage/{group_id}/{location}", response_model=ReportDataResponse)
async def get_usage_report(
    report_date: str,
    group_id: str,
    location: str,
    request: Request,
    _: CurrentUser = require_permission(REPORTS_READ),
):
    client = request.app.state.b2_client
    try:
        path, b2_call = await fetch_report_file(client, report_date, "usage", group_id, location)
    except FileNotFoundError:
        raise HTTPException(404, f"No usage report for {report_date} / group {group_id} / {location}. Reports are only generated on days when groups are active.")
    except Exception as e:
        raise HTTPException(404, str(e))

    headers, rows = parse_csv_file(path)
    return ReportDataResponse(
        report_date=report_date, file_type="usage",
        headers=headers, rows=rows, row_count=len(rows),
        b2_api_call=b2_call,
    )


@router.get("/{report_date}/{file_type}", response_model=ReportDataResponse)
async def get_report(
    report_date: str,
    file_type: str,
    request: Request,
    _: CurrentUser = require_permission(REPORTS_READ),
):
    if file_type not in ("account", "audit", "groups", "group_locations", "audit_group"):
        raise HTTPException(400, f"Unknown file_type: {file_type}")

    client = request.app.state.b2_client
    try:
        path, b2_call = await fetch_report_file(client, report_date, file_type)
    except FileNotFoundError:
        raise HTTPException(404, f"No {file_type} report for {report_date}. Reports are only generated on days when groups are active.")
    except Exception as e:
        raise HTTPException(404, str(e))

    headers, rows = parse_csv_file(path)
    return ReportDataResponse(
        report_date=report_date, file_type=file_type,
        headers=headers, rows=rows, row_count=len(rows),
        b2_api_call=b2_call,
    )


@router.get("/{report_date}/usage/{group_id}/{location}/download")
async def download_usage_report(
    report_date: str,
    group_id: str,
    location: str,
    request: Request,
    _: CurrentUser = require_permission(REPORTS_READ),
):
    client = request.app.state.b2_client
    try:
        path, _ = await fetch_report_file(client, report_date, "usage", group_id, location)
    except Exception as e:
        raise HTTPException(404, str(e))
    return FileResponse(path, media_type="text/csv",
                        filename=f"usage.group-{group_id}.{location}.{report_date}.csv")


@router.get("/{report_date}/{file_type}/download")
async def download_report(
    report_date: str,
    file_type: str,
    request: Request,
    _: CurrentUser = require_permission(REPORTS_READ),
):
    client = request.app.state.b2_client
    try:
        path, _ = await fetch_report_file(client, report_date, file_type)
    except Exception as e:
        raise HTTPException(404, str(e))
    return FileResponse(path, media_type="text/csv", filename=f"{file_type}.{report_date}.csv")


# ── Report schedule & retention ────────────────────────────────────────────────

class ScheduleConfig(BaseModel):
    auto_fetch:     bool = False
    fetch_time:     str  = Field("02:00", pattern=r"^\d{2}:\d{2}$")
    lookback_days:  int  = Field(2, ge=1, le=30)
    retention_days: int  = Field(90, ge=0)


@router.get("/schedule")
async def get_schedule(_: CurrentUser = require_permission(SETTINGS_READ)):
    cfg    = await get_config("report_schedule") or {}
    status = await get_config("report_schedule_status") or {}
    return {
        "auto_fetch":     cfg.get("auto_fetch", False),
        "fetch_time":     cfg.get("fetch_time", "02:00"),
        "lookback_days":  cfg.get("lookback_days", 2),
        "retention_days": cfg.get("retention_days", 90),
        "last_run_at":    status.get("last_run_at"),
        "last_result":    status.get("fetch_result"),
    }


@router.put("/schedule")
async def update_schedule(body: ScheduleConfig, _: CurrentUser = require_permission(SETTINGS_WRITE)):
    await set_config("report_schedule", body.model_dump())
    return body


@router.post("/retention/enforce")
async def run_retention(_: CurrentUser = require_permission(SETTINGS_WRITE)):
    cfg = await get_config("report_schedule") or {}
    retention_days = max(0, int(cfg.get("retention_days", 90)))
    if retention_days == 0:
        return {"message": "Retention is set to unlimited — nothing deleted.", "deleted_dates": 0, "deleted_files": 0}
    result = await enforce_retention(retention_days)
    return result
