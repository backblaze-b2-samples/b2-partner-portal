"""Background scheduler: automatic report fetching and local retention enforcement."""
from __future__ import annotations

import asyncio
import logging
import shutil
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from app.config import settings
from app.database import get_config, set_config, get_db
from app.services.report_parser import fetch_report_file, parse_csv_file

log = logging.getLogger(__name__)

# In-memory guard: "YYYY-MM-DD HH:MM" of the last scheduled fetch attempt,
# so we don't fire twice within the same minute if the event loop is slow.
_last_scheduled_minute: str | None = None


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Single-date cascade fetch ─────────────────────────────────────────────────

async def fetch_date(client, date_str: str) -> dict:
    """
    Cascade-fetch all report files for one date:
      1. account-level usage + audit
      2. usage.groups.csv → discover group IDs
      3. per-group reportingLocations → discover regions
      4. per-group+region usage + audit

    Returns the same shape as the /fetch/{date} route.
    """
    results: list[dict] = []

    async def _fetch(file_type, gid=None, loc=None):
        try:
            path, b2_call = await fetch_report_file(client, date_str, file_type, gid, loc)
            results.append({
                "file_type": file_type, "group_id": gid, "location": loc,
                "status": "ok", "b2_api_call": b2_call.model_dump(),
            })
            return path
        except FileNotFoundError as e:
            results.append({"file_type": file_type, "group_id": gid, "location": loc,
                            "status": "not_found", "message": str(e)})
            return None
        except Exception as e:
            results.append({"file_type": file_type, "group_id": gid, "location": loc,
                            "status": "error", "message": str(e)})
            return None

    await _fetch("account")
    await _fetch("audit")
    groups_path = await _fetch("groups")

    if groups_path:
        headers, rows = parse_csv_file(groups_path)
        try:
            gid_col = headers.index("group_id")
        except ValueError:
            gid_col = 0

        seen_groups: set[str] = set()
        for row in rows:
            if not row or len(row) <= gid_col:
                continue
            gid = row[gid_col].strip()
            if not gid or gid in seen_groups:
                continue
            seen_groups.add(gid)

            locs_path = await _fetch("group_locations", gid=gid)
            locations: list[str] = []
            if locs_path:
                lh, lr = parse_csv_file(locs_path)
                try:
                    loc_col = lh.index("reporting_location")
                except ValueError:
                    loc_col = 2
                locations = [r[loc_col].strip() for r in lr if len(r) > loc_col and r[loc_col].strip()]

            for loc in locations:
                await _fetch("usage",       gid=gid, loc=loc)
                await _fetch("audit_group", gid=gid, loc=loc)

    any_ok        = any(r["status"] == "ok" for r in results)
    core_missing  = all(r["status"] == "not_found" for r in results
                        if r["file_type"] in ("account", "audit") and not r.get("group_id"))
    summary = "ok" if any_ok else ("no_reports" if core_missing else "error")
    return {"date": date_str, "results": results, "summary": summary}


# ── Date-range fetch (skips already-cached dates) ─────────────────────────────

async def fetch_date_range(client, start: date, end: date) -> dict:
    """Fetch reports for start..end, skipping dates that already have cached files."""
    fetched = skipped = failed = 0
    results: list[dict] = []
    current = start

    while current <= end:
        date_str = current.isoformat()
        day_dir = settings.reports_dir / date_str

        has_data = False
        if day_dir.is_dir():
            for p in day_dir.iterdir():
                if (p.suffix == ".csv"
                        and p.name != "usage.groups.csv"
                        and not p.name.endswith(".reportingLocations.csv")):
                    has_data = True
                    break

        if has_data:
            skipped += 1
            results.append({"date": date_str, "status": "cached"})
            current += timedelta(days=1)
            continue

        r = await fetch_date(client, date_str)
        if r["summary"] == "ok":
            fetched += 1
            results.append({"date": date_str, "status": "fetched"})
        elif r["summary"] == "no_reports":
            results.append({"date": date_str, "status": "no_data"})
        else:
            failed += 1
            results.append({"date": date_str, "status": "error"})

        current += timedelta(days=1)

    return {"fetched": fetched, "skipped": skipped, "failed": failed, "results": results}


# ── Retention enforcement ──────────────────────────────────────────────────────

async def enforce_retention(retention_days: int) -> dict:
    """
    Delete local report files and DB records older than retention_days.
    retention_days=0 means keep forever (no-op).
    """
    if retention_days <= 0:
        return {"deleted_dates": 0, "deleted_files": 0}

    cutoff = (date.today() - timedelta(days=retention_days)).isoformat()
    deleted_files = 0
    deleted_dates: set[str] = set()

    async with get_db() as db:
        cursor = await db.execute(
            "SELECT report_date, local_path FROM report_cache WHERE report_date < ?",
            [cutoff],
        )
        rows = await cursor.fetchall()

        for row in rows:
            deleted_dates.add(row["report_date"])
            path = Path(row["local_path"])
            try:
                if path.exists():
                    path.unlink()
                    deleted_files += 1
            except Exception as e:
                log.warning("Could not delete report file %s: %s", path, e)

        await db.execute("DELETE FROM report_cache WHERE report_date < ?", [cutoff])

    # Remove empty date directories
    reports_dir = settings.reports_dir
    if reports_dir.is_dir():
        for day_dir in sorted(reports_dir.iterdir()):
            if day_dir.is_dir() and day_dir.name < cutoff:
                try:
                    # Only remove if empty (don't touch dirs with files we don't know about)
                    if not any(day_dir.iterdir()):
                        day_dir.rmdir()
                except Exception:
                    pass

    log.info(
        "Retention cleanup: removed %d records across %d dates, %d files (cutoff: %s)",
        len(rows), len(deleted_dates), deleted_files, cutoff,
    )
    return {"deleted_dates": len(deleted_dates), "deleted_files": deleted_files}


# ── Background scheduler loop ──────────────────────────────────────────────────

async def scheduler_loop(app) -> None:
    """
    Asyncio background task — started in app lifespan.
    Wakes every 60 s, checks if a scheduled fetch is due, and runs it.
    """
    global _last_scheduled_minute
    log.info("Report scheduler started")

    while True:
        await asyncio.sleep(60)

        try:
            cfg = await get_config("report_schedule") or {}
            if not cfg.get("auto_fetch"):
                continue

            fetch_time   = cfg.get("fetch_time", "02:00")
            now_local    = datetime.now()
            current_hhmm = now_local.strftime("%H:%M")

            if current_hhmm != fetch_time:
                continue

            # Guard against firing twice in the same minute
            run_key = now_local.strftime("%Y-%m-%d %H:%M")
            if run_key == _last_scheduled_minute:
                continue
            _last_scheduled_minute = run_key

            lookback_days  = max(1, int(cfg.get("lookback_days", 2)))
            retention_days = max(0, int(cfg.get("retention_days", 90)))

            end   = date.today() - timedelta(days=1)  # yesterday
            start = end - timedelta(days=lookback_days - 1)

            log.info("Scheduled fetch: %s → %s", start, end)
            fetch_result = await fetch_date_range(app.state.b2_client, start, end)

            retention_result: dict = {}
            if retention_days > 0:
                retention_result = await enforce_retention(retention_days)

            status = {
                "last_run_at":     _now_utc(),
                "fetch_result":    fetch_result,
                "retention_result": retention_result,
            }
            await set_config("report_schedule_status", status)
            log.info(
                "Scheduled fetch done — fetched=%d skipped=%d failed=%d",
                fetch_result["fetched"], fetch_result["skipped"], fetch_result["failed"],
            )

        except asyncio.CancelledError:
            log.info("Report scheduler cancelled")
            raise
        except Exception:
            log.exception("Report scheduler error")
