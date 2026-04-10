"""SQLite schema, connection helpers, and seeding."""
from __future__ import annotations
import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import aiosqlite

from app.config import settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@asynccontextmanager
async def get_db():
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(settings.db_path)) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA synchronous=NORMAL")
        await db.execute("PRAGMA foreign_keys=ON")
        yield db
        await db.commit()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS roles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS users (
    id                        TEXT PRIMARY KEY,
    email                     TEXT NOT NULL UNIQUE,
    password_hash             TEXT NOT NULL,
    role_id                   TEXT NOT NULL REFERENCES roles(id),
    is_active                 INTEGER NOT NULL DEFAULT 1,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    last_login_at             TEXT,
    password_reset_token      TEXT,
    password_reset_expires_at TEXT,
    failed_login_attempts     INTEGER NOT NULL DEFAULT 0,
    locked_until              TEXT
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issued_at  TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked    INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT,
    ip_address TEXT
);

CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_token_cache (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    auth_token   TEXT NOT NULL,
    api_url      TEXT NOT NULL,
    download_url TEXT NOT NULL,
    account_id   TEXT NOT NULL,
    groups_api_url TEXT NOT NULL DEFAULT '',
    issued_at    TEXT NOT NULL,
    expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups_cache (
    group_id    TEXT PRIMARY KEY,
    group_name  TEXT NOT NULL,
    raw_json    TEXT NOT NULL,
    cached_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_cache (
    id            TEXT PRIMARY KEY,
    report_date   TEXT NOT NULL,
    file_type     TEXT NOT NULL,
    group_id      TEXT,
    location      TEXT,
    local_path    TEXT NOT NULL,
    file_size     INTEGER NOT NULL DEFAULT 0,
    row_count     INTEGER,
    downloaded_at TEXT NOT NULL,
    UNIQUE(report_date, file_type, group_id, location)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT REFERENCES users(id),
    user_email  TEXT,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    details     TEXT,
    ip_address  TEXT,
    occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user  ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_exp   ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_report_cache_date    ON report_cache(report_date);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred   ON audit_log(occurred_at);

CREATE TABLE IF NOT EXISTS group_pricing (
    group_id     TEXT PRIMARY KEY,
    group_label  TEXT NOT NULL DEFAULT '',
    price_per_tb REAL NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_states (
    state      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_exchange_codes (
    code          TEXT PRIMARY KEY,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_group_mappings (
    id              TEXT PRIMARY KEY,
    azure_group_id  TEXT NOT NULL,
    role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    label           TEXT NOT NULL DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credential_vault (
    member_account_id   TEXT PRIMARY KEY,
    account_email       TEXT NOT NULL,
    group_id            TEXT NOT NULL,
    encrypted_key_id    TEXT NOT NULL,
    encrypted_key       TEXT NOT NULL,
    region              TEXT NOT NULL DEFAULT '',
    s3_endpoint         TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL,
    created_by_user_id  TEXT REFERENCES users(id)
);
"""

_DEFAULT_ROLES = [
    ("admin",  "Administrator", "Full access to all resources",
     ["users:read", "users:write", "settings:read", "settings:write",
      "groups:read", "members:read", "members:write", "members:eject",
      "reports:read", "roles:read", "roles:write", "credentials:read", "audit:read"]),
    ("viewer", "Viewer",        "Read-only access",
     ["groups:read", "members:read", "reports:read"]),
]


async def init_db():
    """Create schema and seed default data on first run."""
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.reports_dir.mkdir(parents=True, exist_ok=True)

    async with get_db() as db:
        await db.executescript(_SCHEMA)

        # Seed roles if empty
        cursor = await db.execute("SELECT COUNT(*) FROM roles")
        if (await cursor.fetchone())[0] == 0:
            now = _now()
            for role_id, name, description, perms in _DEFAULT_ROLES:
                await db.execute(
                    "INSERT INTO roles (id, name, description, created_at) VALUES (?,?,?,?)",
                    [role_id, name, description, now],
                )
                for p in perms:
                    await db.execute(
                        "INSERT INTO role_permissions (role_id, permission) VALUES (?,?)",
                        [role_id, p],
                    )

        # Migrate: add account-lockout columns to existing databases
        for _col in [
            "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN locked_until TEXT",
        ]:
            try:
                await db.execute(_col)
            except Exception:
                pass  # column already exists

        # Migrate: add region and s3_endpoint to credential_vault
        for _col in [
            "ALTER TABLE credential_vault ADD COLUMN region TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE credential_vault ADD COLUMN s3_endpoint TEXT NOT NULL DEFAULT ''",
        ]:
            try:
                await db.execute(_col)
            except Exception:
                pass  # column already exists

        # Migrate: add auth_source column to users
        try:
            await db.execute(
                "ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'"
            )
        except Exception:
            pass  # column already exists

        # Migrate: add user_id to oidc_exchange_codes for session cookie issuance
        try:
            await db.execute(
                "ALTER TABLE oidc_exchange_codes ADD COLUMN user_id TEXT NOT NULL DEFAULT ''"
            )
        except Exception:
            pass  # column already exists

        # Migrate: ensure credentials:read and audit:read are granted to the admin role
        await db.execute(
            "INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES ('admin', 'credentials:read')"
        )
        await db.execute(
            "INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES ('admin', 'audit:read')"
        )

        # Create initial admin user if no users exist
        cursor = await db.execute("SELECT COUNT(*) FROM users")
        if (await cursor.fetchone())[0] == 0:
            from app.auth import hash_password
            now = _now()
            await db.execute(
                """INSERT INTO users (id, email, password_hash, role_id, created_at, updated_at)
                   VALUES (?,?,?,?,?,?)""",
                [str(uuid.uuid4()), settings.initial_admin_email,
                 hash_password(settings.initial_admin_password), "admin", now, now],
            )


async def get_config(key: str, default=None):
    async with get_db() as db:
        cursor = await db.execute("SELECT value FROM app_config WHERE key=?", [key])
        row = await cursor.fetchone()
        if row is None:
            return default
        return json.loads(row["value"])


async def set_config(key: str, value):
    async with get_db() as db:
        await db.execute(
            "INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            [key, json.dumps(value), _now()],
        )
