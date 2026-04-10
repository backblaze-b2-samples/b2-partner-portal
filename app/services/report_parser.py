"""Download, cache, and parse Backblaze usage report CSV files."""
from __future__ import annotations
import csv
import io
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings
from app.database import get_db, get_config
from app.schemas import B2ApiCall


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def fetch_report_file(client, report_date: str, file_type: str,
                             group_id: str | None = None,
                             location: str | None = None) -> tuple[Path, B2ApiCall]:
    """
    Download a report CSV from B2 and cache it locally.
    Returns (local_path, B2ApiCall).

    File naming convention from Backblaze docs:
      usage:     usage.group-{group_id}.{location}.csv
      audit:     audit.csv
      groups:    groups.csv
      locations: locations.csv
    """
    bucket_cfg = await get_config("report_bucket")
    if not bucket_cfg:
        raise RuntimeError("Report bucket not configured. Go to Settings.")

    bucket = bucket_cfg.get("bucket_name", "")
    prefix = bucket_cfg.get("prefix", "daily-reports/")

    account_id = bucket_cfg.get("account_id", "")

    if file_type == "account":
        file_name = f"{prefix}{report_date}/usage.account-{account_id}.csv"
    elif file_type == "audit":
        file_name = f"{prefix}{report_date}/usage.audit-account-{account_id}.csv"
    elif file_type == "groups":
        file_name = f"{prefix}{report_date}/usage.groups.csv"
    elif file_type == "group_locations":
        if not group_id:
            raise ValueError("group_id required for group_locations reports")
        file_name = f"{prefix}{report_date}/usage.group-{group_id}.reportingLocations.csv"
    elif file_type == "audit_group":
        if not group_id or not location:
            raise ValueError("group_id and location required for audit_group reports")
        file_name = f"{prefix}{report_date}/usage.audit-group-{group_id}.{location}.csv"
    elif file_type == "usage":
        if not group_id or not location:
            raise ValueError("group_id and location required for usage reports")
        file_name = f"{prefix}{report_date}/usage.group-{group_id}.{location}.csv"
    else:
        raise ValueError(f"Unknown file_type: {file_type}")

    # Check local cache first
    local_dir = settings.reports_dir / report_date
    local_dir.mkdir(parents=True, exist_ok=True)
    safe_name = file_name.replace("/", "_")
    local_path = local_dir / safe_name

    if local_path.exists() and local_path.stat().st_size > 0:
        # Return a synthetic B2ApiCall showing what WOULD have been called
        b2_call = B2ApiCall(
            method="GET",
            url=f"(cached) {file_name}",
            request_headers={},
            response_status=200,
            response_body={"cached": True, "local_path": str(local_path)},
            duration_ms=0,
        )
        return local_path, b2_call

    # Download from B2
    data, b2_call = await client.download_file_by_name(bucket, file_name)
    local_path.write_bytes(data)

    # Record in cache table
    row_count = None
    try:
        text = data.decode("utf-8-sig")
        row_count = sum(1 for _ in csv.reader(io.StringIO(text))) - 1  # subtract header
    except Exception:
        pass

    async with get_db() as db:
        await db.execute(
            """INSERT INTO report_cache
               (id, report_date, file_type, group_id, location, local_path, file_size, row_count, downloaded_at)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(report_date, file_type, group_id, location)
               DO UPDATE SET local_path=excluded.local_path, file_size=excluded.file_size,
               row_count=excluded.row_count, downloaded_at=excluded.downloaded_at""",
            [str(uuid.uuid4()), report_date, file_type, group_id, location,
             str(local_path), len(data), row_count, _now()],
        )

    return local_path, b2_call


def parse_csv_file(path: Path) -> tuple[list[str], list[list[str]]]:
    """Parse a CSV file into (headers, rows)."""
    text = path.read_text(encoding="utf-8-sig")
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return [], []
    return rows[0], rows[1:]
