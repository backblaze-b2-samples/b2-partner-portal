"""Aggregate cached report CSVs into time-series data for the analytics UI."""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

from app.config import settings

ALL_METRICS = [
    "stored_gb",
    "downloaded_gb",
    "uploaded_gb",
    "deleted_gb",
    "downloaded_bytes",
    "downloaded_favored_bytes",
    "storage_byte_hours",
    "api_txn_class_a",
    "api_txn_class_b",
    "api_txn_class_c",
]

METRIC_LABELS = {
    "stored_gb":                "Storage",
    "downloaded_gb":            "Downloaded",
    "uploaded_gb":              "Uploaded",
    "deleted_gb":               "Deleted",
    "downloaded_bytes":         "Downloaded (bytes)",
    "downloaded_favored_bytes": "Downloaded Favored (bytes)",
    "storage_byte_hours":       "Storage (byte-hours)",
    "api_txn_class_a":          "API Class A (free)",
    "api_txn_class_b":          "API Class B",
    "api_txn_class_c":          "API Class C",
}

METRIC_UNITS = {
    "stored_gb":                "GB",
    "downloaded_gb":            "GB",
    "uploaded_gb":              "GB",
    "deleted_gb":               "GB",
    "downloaded_bytes":         "bytes",
    "downloaded_favored_bytes": "bytes",
    "storage_byte_hours":       "byte-hours",
    "api_txn_class_a":          "txn",
    "api_txn_class_b":          "txn",
    "api_txn_class_c":          "txn",
}

# Snapshot metrics: use LAST day's value per period, not sum
SNAPSHOT_METRICS: set[str] = {"stored_gb", "storage_byte_hours"}


def _period_key(d: date, group_by: str) -> str:
    if group_by == "week":
        monday = d - timedelta(days=d.weekday())
        return monday.isoformat()
    if group_by == "month":
        return d.strftime("%Y-%m")
    return d.isoformat()


def _period_label(key: str, group_by: str) -> str:
    if group_by == "month":
        # key is "YYYY-MM"
        d = date(int(key[:4]), int(key[5:7]), 1)
        return d.strftime("%b %Y")
    d = date.fromisoformat(key)
    if group_by == "week":
        return d.strftime("%b %-d") + " week"
    return d.strftime("%b %-d")


def _parse_csv(path: Path) -> tuple[list[str], list[dict]]:
    text = path.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []
    rows = list(reader)
    return list(headers), rows


def _is_index_file(name: str) -> bool:
    return name == "usage.groups.csv" or name.endswith(".reportingLocations.csv")


def _bucket_label(row: dict) -> str:
    name = (row.get("bucket_name") or "").strip()
    bid = (row.get("bucket_id") or "").strip()
    if name:
        return name
    if bid:
        return bid
    return "(account)"


def _snap_add(store: dict, metric: str, period: str, key: str, date_str: str, val: float) -> None:
    """Accumulate snapshot values per (metric, period, key, date) — sums across rows on the same date."""
    slot = store[metric][period][key]
    slot[date_str] = slot.get(date_str, 0.0) + val


def _snap_read(store: dict, metric: str, period: str, key: str) -> float:
    """Return the last-date accumulated value for a snapshot dimension/metric."""
    dm = store[metric][period].get(key, {})
    return dm[max(dm)] if dm else 0.0


async def aggregate_reports(
    start_date: date,
    end_date: date,
    group_by: str = "day",
    metrics: list[str] | None = None,
    bucket_filter: str | None = None,
    location_filter: str | None = None,
    account_id_filter: str | None = None,
    group_id_filter: str | None = None,
) -> dict:
    if metrics is None:
        metrics = ALL_METRICS

    # Snapshot stores: snap_X[metric][period][key][date] = accumulated value
    # Cumulative stores: cum_X[period][key][metric] = accumulated value
    def _snap_store() -> dict:
        return defaultdict(lambda: defaultdict(lambda: defaultdict(dict)))

    snap_bucket:  dict = _snap_store()
    snap_group:   dict = _snap_store()
    snap_account: dict = _snap_store()

    cum_bucket:  dict = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    cum_group:   dict = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    cum_account: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))

    # ── Metadata ──────────────────────────────────────────────────────────
    account_email_map: dict[str, str] = {}
    found_dates:  list[str] = []
    missing_dates: list[str] = []
    all_locations: set[str] = set()

    reports_dir = settings.reports_dir
    current = start_date
    while current <= end_date:
        date_str = current.isoformat()
        day_dir = reports_dir / date_str

        csv_files: list[Path] = []
        if day_dir.is_dir():
            for p in day_dir.iterdir():
                if p.suffix != ".csv":
                    continue
                if _is_index_file(p.name):
                    continue
                if "audit" in p.name:
                    continue
                csv_files.append(p)

        if not csv_files:
            missing_dates.append(date_str)
            current += timedelta(days=1)
            continue

        found_dates.append(date_str)
        period = _period_key(current, group_by)

        for csv_path in csv_files:
            try:
                _, rows = _parse_csv(csv_path)
            except Exception:
                continue

            for row in rows:
                # ── Dimension extraction ──────────────────────────────────
                row_account_id = (row.get("account_id") or "").strip()
                row_group_id   = (row.get("group_id")   or "").strip()
                row_email      = (row.get("account_email") or "").strip()

                if row_account_id and row_email:
                    account_email_map[row_account_id] = row_email

                # ── Filters ───────────────────────────────────────────────
                if account_id_filter and row_account_id != account_id_filter:
                    continue
                if group_id_filter and row_group_id != group_id_filter:
                    continue

                loc = (row.get("reporting_location") or "").strip()
                if location_filter and loc != location_filter:
                    continue
                if loc:
                    all_locations.add(loc)

                bucket = _bucket_label(row)
                if bucket_filter and bucket != bucket_filter:
                    continue

                # ── Metric accumulation ───────────────────────────────────
                for metric in metrics:
                    raw = (row.get(metric) or "0").strip()
                    try:
                        val = float(raw)
                    except ValueError:
                        val = 0.0

                    if metric in SNAPSHOT_METRICS:
                        # Buckets: overwrite (one canonical value per bucket per day)
                        snap_bucket[metric][period][bucket][date_str] = val
                        # Groups / accounts: sum across all members/buckets within the same day
                        if row_group_id:
                            _snap_add(snap_group, metric, period, row_group_id, date_str, val)
                        if row_account_id:
                            _snap_add(snap_account, metric, period, row_account_id, date_str, val)
                    else:
                        cum_bucket[period][bucket][metric]             += val
                        if row_group_id:
                            cum_group[period][row_group_id][metric]    += val
                        if row_account_id:
                            cum_account[period][row_account_id][metric] += val

        current += timedelta(days=1)

    # ── Collect all dimension keys ─────────────────────────────────────────
    all_periods: set[str] = set(cum_bucket) | set(cum_group) | set(cum_account)
    for m_data in snap_bucket.values():  all_periods.update(m_data)
    for m_data in snap_group.values():   all_periods.update(m_data)
    for m_data in snap_account.values(): all_periods.update(m_data)
    sorted_periods = sorted(all_periods)

    all_buckets:  set[str] = set()
    all_groups:   set[str] = set()
    all_accounts: set[str] = set()
    # snap_X is metric→period→key, so iterate over the period-level dicts
    for m_data in snap_bucket.values():
        for pd in m_data.values(): all_buckets.update(pd)
    for pd in cum_bucket.values(): all_buckets.update(pd)
    for m_data in snap_group.values():
        for pd in m_data.values(): all_groups.update(pd)
    for pd in cum_group.values(): all_groups.update(pd)
    for m_data in snap_account.values():
        for pd in m_data.values(): all_accounts.update(pd)
    for pd in cum_account.values(): all_accounts.update(pd)

    # ── Build per-metric time-series ───────────────────────────────────────
    result_metrics: dict[str, dict] = {}
    totals: dict[str, float] = {}
    # {dim_key: {metric: total}}
    totals_by_group:   dict[str, dict[str, float]] = {g: {} for g in all_groups}
    totals_by_account: dict[str, dict[str, float]] = {a: {} for a in all_accounts}

    for metric in metrics:
        is_snap = metric in SNAPSHOT_METRICS

        by_bucket:  dict[str, list[float]] = {b: [] for b in all_buckets}
        by_group:   dict[str, list[float]] = {g: [] for g in all_groups}
        by_account: dict[str, list[float]] = {a: [] for a in all_accounts}
        totals_per_period: list[float] = []

        for period in sorted_periods:
            period_total = 0.0

            for bucket in all_buckets:
                val = (_snap_read(snap_bucket, metric, period, bucket) if is_snap
                       else cum_bucket[period].get(bucket, {}).get(metric, 0.0))
                by_bucket[bucket].append(val)
                period_total += val

            for group in all_groups:
                gval = (_snap_read(snap_group, metric, period, group) if is_snap
                        else cum_group[period].get(group, {}).get(metric, 0.0))
                by_group[group].append(gval)

            for account in all_accounts:
                aval = (_snap_read(snap_account, metric, period, account) if is_snap
                        else cum_account[period].get(account, {}).get(metric, 0.0))
                by_account[account].append(aval)

            totals_per_period.append(period_total)

        overall_total = (totals_per_period[-1] if totals_per_period else 0.0) if is_snap else sum(totals_per_period)
        totals[metric] = overall_total

        for group in all_groups:
            vals = by_group[group]
            totals_by_group[group][metric] = (vals[-1] if vals else 0.0) if is_snap else sum(vals)
        for account in all_accounts:
            vals = by_account[account]
            totals_by_account[account][metric] = (vals[-1] if vals else 0.0) if is_snap else sum(vals)

        result_metrics[metric] = {
            "label":      METRIC_LABELS.get(metric, metric),
            "unit":       METRIC_UNITS.get(metric, ""),
            "values":     totals_per_period,
            "by_bucket":  dict(by_bucket),
            "by_group":   dict(by_group),
            "by_account": dict(by_account),
        }

    # ── Sort dimensions by stored_gb desc ─────────────────────────────────
    def _last_stored(dim_dict: dict) -> float:
        vals = result_metrics.get("stored_gb", {}).get(dim_dict, {})
        return 0.0  # fallback; real sort keys built below

    def _sort_key_bucket(b: str) -> float:
        v = result_metrics.get("stored_gb", {}).get("by_bucket", {}).get(b, [])
        return v[-1] if v else 0.0

    def _sort_key_group(g: str) -> float:
        v = result_metrics.get("stored_gb", {}).get("by_group", {}).get(g, [])
        return v[-1] if v else 0.0

    def _sort_key_account(a: str) -> float:
        v = result_metrics.get("stored_gb", {}).get("by_account", {}).get(a, [])
        return v[-1] if v else 0.0

    sorted_buckets  = sorted(all_buckets,  key=_sort_key_bucket,  reverse=True)
    sorted_groups   = sorted(all_groups,   key=_sort_key_group,   reverse=True)
    sorted_accounts = sorted(all_accounts, key=_sort_key_account, reverse=True)

    return {
        "start_date":        start_date.isoformat(),
        "end_date":          end_date.isoformat(),
        "group_by":          group_by,
        "periods":           sorted_periods,
        "period_labels":     [_period_label(p, group_by) for p in sorted_periods],
        "metrics":           result_metrics,
        "totals":            totals,
        "buckets":           sorted_buckets,
        "groups":            sorted_groups,
        "accounts":          sorted_accounts,
        "totals_by_group":   totals_by_group,
        "totals_by_account": totals_by_account,
        "account_emails":    account_email_map,
        "locations":         sorted(all_locations),
        "found_dates":       sorted(found_dates),
        "missing_dates":     sorted(missing_dates),
        "all_metrics":       ALL_METRICS,
        "metric_labels":     METRIC_LABELS,
    }
