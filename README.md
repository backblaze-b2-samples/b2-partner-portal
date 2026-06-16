# Backblaze Partner Portal

A self-hosted web portal for [Backblaze Partner API](https://www.backblaze.com/docs/cloud-storage-partner-program) administrators. Manage partner groups, provision member accounts, download usage reports, and audit all activity — through a clean browser UI backed by a documented REST API.

Built with [FastAPI](https://fastapi.tiangolo.com/) and vanilla JavaScript. Designed to be easy to run, easy to understand, and easy to extend.

> **This is not an official Backblaze product.** It is a community-built reference implementation of the Backblaze Partner API, provided as-is under the MIT license. See [Disclaimers](#disclaimers) for important limitations.

---

## Features

### Partner API Management
- **Groups** — browse your partner groups with a 5-minute cache and on-demand refresh
- **Members** — list, provision (single or CSV bulk import), and eject members
- **Credentials** — every B2 API call is surfaced in the UI so you can see exactly what the portal is doing

### Usage Reports
- Download daily usage reports from your B2 reporting bucket
- View and filter data in-browser, or export as CSV
- Aggregate metrics (stored GB, downloaded GB, transactions) by day, week, or month across groups and locations
- Filter by group, location, account, or bucket
- **Report Automation** — scheduled daily fetch with configurable lookback window and local retention period; configured in Settings
- **Per-Group Pricing** — configure a $/TB rate per partner group; the cost view shows estimated revenue alongside raw usage data

### Portal Administration
- **Users** — manage who can access the portal (single or CSV bulk import); each user is labelled as `Local` or `SSO` so you can see at a glance how they authenticate
- **Roles** — built-in `admin` and `viewer` roles, fully customizable with 13 granular permissions
- **SSO** — optional OIDC single sign-on with any standards-compliant provider (Azure Entra ID, Okta, Google Workspace, Keycloak, etc.); group memberships map to portal roles; users are JIT-provisioned on first login
- **Audit log** — all member, credential, and user-management actions are logged with user, timestamp, and IP; filterable and exportable as CSV

### Credential Vault (optional)
- Encrypts and stores B2 `applicationKeyId` / `applicationKey` at the moment of member creation
- Uses Fernet (AES-128-CBC + HMAC-SHA256) with a key that lives only in your environment
- Every retrieval is audit-logged; access requires the `credentials:read` permission

### Security
- JWT access tokens (15 min) + refresh tokens (30 days, revocable) + signed session cookies
- Bcrypt password hashing with constant-time verification
- Role-based access control on every endpoint
- Account lockout after repeated failed login attempts
- Rate limiting on all authentication endpoints
- HSTS, X-Frame-Options, X-Content-Type-Options, and CSP security headers
- Authorization headers masked in all logged API calls
- OIDC `email_verified` enforcement — tokens with an explicitly unverified email are rejected
- SSO account-takeover protection — SSO cannot silently merge into a pre-existing local account

---

## Disclaimers

**Not an official Backblaze product.** This portal is a community reference implementation. It is not developed, maintained, or supported by Backblaze. Use it at your own risk.

**Cost estimates are approximate.** The per-group pricing and cost view produce best-effort estimates based on end-of-period storage snapshots. They are not invoices and should not be presented to customers as billing statements. Actual charges are determined by Backblaze's billing systems.

**Partner API rate limits apply.** Every action in this portal makes real API calls to Backblaze. Aggressive use — bulk imports, rapid report fetching, frequent cache refreshes — may approach Backblaze Partner API rate limits. Review the [Partner API documentation](https://www.backblaze.com/docs/cloud-storage-partner-program) for current limits.

**You are responsible for your deployment.** This portal handles sensitive credentials and partner account data. Before running it in production:
- Deploy behind a TLS-terminating reverse proxy
- Restrict filesystem access to `DATA_DIR`
- Back up `DATA_DIR` and your `CREDENTIAL_VAULT_KEY` regularly
- Change the default admin credentials immediately on first run
- Review the [security documentation](SECURITY.md)

**No warranty.** This software is provided "as is", without warranty of any kind. See [LICENSE](LICENSE) for the full terms.

---

## Requirements

- Python 3.11+
- A Backblaze account enrolled in the [Partner Program](https://www.backblaze.com/docs/cloud-storage-partner-program)
- A Backblaze **Master Application Key** (required by the Partner API)

---

## Quick Start

```bash
git clone https://github.com/your-org/b2-partner-portal.git
cd b2-partner-portal
cp .env.example .env
```

Edit `.env` and set at minimum:

```dotenv
SECRET_KEY=<random 32-byte hex>   # python3 -c "import secrets; print(secrets.token_hex(32))"
```

Then start the server:

```bash
bash run.sh
```

Open http://localhost:8080 and log in with the initial admin credentials (default: `admin@example.com` / `changeme123`). **Change these immediately** via Settings → Users.

Configure your Backblaze Partner API credentials under **Settings** in the portal.

---

## Configuration

All configuration is via environment variables or a `.env` file in the project root.

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | _(required)_ | Signing key for JWT tokens and session cookies. Generate with `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `DATA_DIR` | `./data` | Directory for the SQLite database and downloaded report files. |
| `HOST` | `127.0.0.1` | Server bind address. |
| `PORT` | `8080` | Server listen port. |
| `INITIAL_ADMIN_EMAIL` | `admin@example.com` | Email for the admin account created on first startup. |
| `INITIAL_ADMIN_PASSWORD` | `changeme123` | Password for the initial admin. **Change immediately after first login.** |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `15` | JWT access token lifetime. |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | Refresh token lifetime. |
| `CREDENTIAL_VAULT_ENABLED` | `false` | Enable encrypted credential storage. See [Credential Vault](#credential-vault). |
| `CREDENTIAL_VAULT_KEY` | _(none)_ | Fernet encryption key. Required when vault is enabled. |
| `API_DOCS_ENABLED` | `false` | Enable Swagger UI (`/api/docs`) and ReDoc (`/api/redoc`). Off by default — exposes full API schema to authenticated users. Enable only for development. |
| `API_INSPECTOR_ENABLED` | `false` | Show the **B2 API Call** inspector panels in the UI. Each action that calls Backblaze will display the raw request and response inline. Useful for demos and learning how the Partner API works. Off by default. |

---

## Running in Production

```bash
venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080 --workers 2
```

Key steps before going live:

1. **Set a strong `SECRET_KEY`** — the app will refuse to start if it is missing or weak.
2. **Put it behind a reverse proxy** (nginx, Caddy, etc.) for TLS termination. The portal itself binds to `127.0.0.1` by default.
3. **Restrict `DATA_DIR`** — it contains the SQLite database, session state, and downloaded report files.
4. **Back up `DATA_DIR` regularly** — it is the only persistent state.
5. **Change the default admin password** on first login.
6. **Keep `API_DOCS_ENABLED=false`** (the default) in production.

The `run.sh` script is a convenience for development. For production, use systemd, supervisor, or your platform's process manager.

### systemd example

```ini
[Unit]
Description=Backblaze Partner Portal
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/b2-partner-portal
EnvironmentFile=/opt/b2-partner-portal/.env
ExecStart=/opt/b2-partner-portal/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080 --workers 2
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## Single Sign-On (OIDC)

The portal supports SSO via any standards-compliant OIDC provider — Azure Entra ID, Okta, Google Workspace, Keycloak, AWS Cognito, Auth0, and others. Local accounts remain active alongside SSO as a fallback.

### Setup overview

1. Create an application/client registration in your identity provider.
2. Set the redirect URI to `https://your-portal.example.com/api/auth/oidc/callback`.
3. Enable group claims in your provider's token configuration (the claim name is typically `groups`).
4. In the portal, go to **Settings → Single Sign-On** and enter:
   - **Issuer URL** — the base URL for your provider's OIDC discovery document
   - **Client ID** and **Client Secret**
   - **Redirect URI** (must match exactly what you registered)
   - **Groups claim name** (default: `groups`)
   - **Button label** (shown on the login page, e.g. "Sign in with Acme SSO")
5. Add group → role mappings. When a user logs in, the portal checks their group memberships against the mapping table (first match wins) and assigns the corresponding portal role.

### Provider issuer URLs

| Provider | Issuer URL |
|---|---|
| Azure Entra ID | `https://login.microsoftonline.com/{tenant-id}/v2.0` |
| Google Workspace | `https://accounts.google.com` |
| Okta | `https://{org}.okta.com` |
| Keycloak | `https://{host}/realms/{realm}` |
| Auth0 | `https://{tenant}.auth0.com` |

### Notes

- **JIT provisioning:** Users who authenticate via SSO are automatically created in the portal on first login with the role determined by their group memberships. Their role is re-evaluated on every login.
- **Group identifiers:** Azure sends group Object IDs (GUIDs). Okta and Keycloak typically send group names. Use whatever string your provider sends in the configured claim.
- **Group claim limit:** Some providers (notably Azure) stop embedding groups in the token if a user belongs to more than ~150 groups, requiring a separate API call. If you hit this, configure a service account with Graph API access or reduce group memberships.
- **Local account fallback:** Local username/password login always remains available, even when SSO is enabled. Keep at least one local admin account as a recovery option in case your identity provider is unavailable.
- **Email verification:** The portal rejects ID tokens where `email_verified` is explicitly `false`. Providers that omit the claim (Azure, Google) are accepted — they verify addresses at the directory level. Providers that allow unverified addresses (some Okta/Cognito configurations) will be blocked until the user verifies their email with the IdP.
- **Account conflict protection:** SSO cannot take over a pre-existing local account. If a local account already exists for the SSO email, login is blocked with an `account_conflict` error. To migrate a local user to SSO: remove the local account in **Portal Users**, then have the user log in via SSO to re-provision.

---

## Permissions Reference

| Permission | What it controls |
|---|---|
| `users:read` | View portal users |
| `users:write` | Create, update, and deactivate portal users |
| `settings:read` | View Partner API credentials, SSO config, and report bucket config |
| `settings:write` | Update Partner API credentials, SSO config, and report bucket config |
| `groups:read` | List and view partner groups |
| `members:read` | List group members |
| `members:write` | Provision new group members |
| `members:eject` | Remove members from groups |
| `reports:read` | Fetch and view usage reports |
| `roles:read` | View roles and their permissions |
| `roles:write` | Create, update, and delete roles |
| `credentials:read` | Retrieve credentials from the vault |
| `audit:read` | View and export the audit log |

**Built-in roles:**

| Role | Permissions |
|---|---|
| `admin` | All of the above |
| `viewer` | `groups:read`, `members:read`, `reports:read` |

Custom roles can be created through the portal or via the API.

---

## Credential Vault

When `CREDENTIAL_VAULT_ENABLED=true`, the portal encrypts and stores the `applicationKeyId` and `applicationKey` returned by Backblaze whenever a new group member is provisioned. Admins can retrieve them later — useful since Backblaze only returns the `applicationKey` once at creation time.

### Setup

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Add to `.env`:

```dotenv
CREDENTIAL_VAULT_ENABLED=true
CREDENTIAL_VAULT_KEY=<your-generated-key>
```

### Important

- **Back up your vault key.** If `CREDENTIAL_VAULT_KEY` is lost, stored credentials cannot be decrypted. There is no recovery path.
- The key is never stored in the database — it must be present in the environment at runtime.
- Every vault retrieval is written to the audit log and requires the `credentials:read` permission.
- The vault is a recovery mechanism, not a primary credential store. Always hand credentials to the end user securely at provisioning time.

---

## API Reference

Interactive docs are disabled by default. Set `API_DOCS_ENABLED=true` to enable Swagger UI at `/api/docs` and ReDoc at `/api/redoc`.

### Authentication

All endpoints (except `/health`, `/login`, and `/api/auth/*`) require:

- `Authorization: Bearer <access_token>` header, **or**
- A valid `session` cookie (set automatically on login)

### Endpoints summary

#### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Log in with email/password, receive access + refresh tokens |
| `POST` | `/api/auth/logout` | Revoke refresh token, clear session cookie |
| `POST` | `/api/auth/refresh` | Exchange refresh token for a new access token |
| `GET` | `/api/auth/me` | Get current user info and permissions |
| `GET` | `/api/auth/oidc/status` | Check if SSO is configured (used by login page) |
| `GET` | `/api/auth/oidc/login` | Initiate SSO login (redirects to provider) |
| `GET` | `/api/auth/oidc/callback` | OIDC callback (handles provider redirect) |
| `POST` | `/api/auth/oidc/exchange` | Exchange SSO one-time code for tokens |
| `GET/PUT` | `/api/auth/oidc/config` | Get/update SSO configuration |
| `GET/POST` | `/api/auth/oidc/mappings` | List/create group→role mappings |
| `PUT/DELETE` | `/api/auth/oidc/mappings/{id}` | Update/delete a mapping |
| `POST` | `/api/auth/oidc/mappings/reorder` | Set mapping priority order |

#### Users
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/users` | `users:read` | List portal users |
| `POST` | `/api/users` | `users:write` | Create a portal user |
| `GET` | `/api/users/{id}` | `users:read` | Get a portal user |
| `PATCH` | `/api/users/{id}` | `users:write` | Update a portal user |
| `DELETE` | `/api/users/{id}` | `users:write` | Deactivate a portal user |
| `POST` | `/api/users/bulk-import` | `users:write` | Bulk import users from CSV |
| `POST` | `/api/users/{id}/reset-password` | `users:write` | Generate a password reset link |
| `POST` | `/api/users/complete-reset` | _(public)_ | Complete a password reset |

#### Roles
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/roles` | `roles:read` | List roles |
| `POST` | `/api/roles` | `roles:write` | Create a role |
| `PATCH` | `/api/roles/{id}` | `roles:write` | Update a role |
| `DELETE` | `/api/roles/{id}` | `roles:write` | Delete a role |

#### Settings
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/settings` | `settings:read` | Get Partner API config (key masked) |
| `GET` | `/api/settings/status` | _(any auth)_ | Returns `{"configured": bool}` — used by dashboard for all roles |
| `GET` | `/api/settings/disk-usage` | `settings:read` | Local disk usage breakdown (DB + report cache) |
| `PUT` | `/api/settings` | `settings:write` | Update Partner API credentials |
| `POST` | `/api/settings/test-connection` | `settings:read` | Test B2 connection |

#### Groups
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/groups` | `groups:read` | List groups (5-min cache; `?refresh=true` to force) |
| `POST` | `/api/groups/refresh` | `groups:read` | Force refresh group cache |
| `GET` | `/api/groups/{group_id}` | `groups:read` | Get a single group |

#### Members
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/groups/{group_id}/members` | `members:read` | List members (cursor pagination) |
| `POST` | `/api/groups/{group_id}/members` | `members:write` | Provision a member, returns credentials |
| `POST` | `/api/groups/{group_id}/members/bulk` | `members:write` | Bulk provision from CSV |
| `DELETE` | `/api/groups/{group_id}/members/{account_id}` | `members:eject` | Eject a member |

#### Credentials Vault
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/credentials/{account_id}` | `credentials:read` | Retrieve stored (encrypted) credentials |

#### Audit Log
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/audit` | `audit:read` | List audit log entries (filterable, paginated) |
| `GET` | `/api/audit/export` | `audit:read` | Export audit log as CSV |

#### Reports
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/reports/available` | `reports:read` | List cached reports |
| `POST` | `/api/reports/fetch/{date}` | `reports:read` | Download all reports for a date |
| `POST` | `/api/reports/fetch-range` | `reports:read` | Download reports for a date range |
| `GET` | `/api/reports/aggregate` | `reports:read` | Aggregate usage metrics |
| `GET` | `/api/reports/schedule` | `settings:read` | Get report automation schedule |
| `PUT` | `/api/reports/schedule` | `settings:write` | Update report automation schedule |
| `POST` | `/api/reports/retention/enforce` | `settings:write` | Run retention cleanup immediately |

#### Pricing
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/pricing` | `settings:read` | List all per-group pricing configs |
| `PUT` | `/api/pricing/{group_id}` | `settings:write` | Set price per TB for a group |
| `DELETE` | `/api/pricing/{group_id}` | `settings:write` | Remove a pricing config |

---

## Self-Documenting B2 API Calls

Every response that involves a Backblaze API call includes a `b2_api_call` object:

```json
{
  "b2_api_call": {
    "method": "POST",
    "url": "https://api.backblaze.com/b2api/v3/b2_create_group_member",
    "request_headers": { "Authorization": "Bearer B2••••••••...key4" },
    "request_body": { "groupId": "...", "memberEmail": "..." },
    "response_status": 200,
    "response_body": { ... },
    "duration_ms": 312.4
  }
}
```

Authorization tokens are masked (first 8 + last 4 characters only). This is intentional — the portal is designed to serve as a learning reference for the Partner API, showing exactly what HTTP calls each action makes.

---

## Architecture

```
app/
├── main.py              # FastAPI app, auth middleware, security headers, lifespan
├── config.py            # Pydantic settings (reads from .env)
├── database.py          # SQLite schema, migrations, helpers
├── auth.py              # JWT, bcrypt, session cookie helpers
├── rbac.py              # Permission constants, require_permission() dependency
├── limiter.py           # slowapi rate-limiter instance
├── schemas.py           # Pydantic request/response models
├── api/
│   ├── auth.py          # Login, logout, refresh, /me
│   ├── oidc.py          # OIDC SSO: login, callback, config, group-role mappings
│   ├── users.py         # Portal user management, password reset
│   ├── roles.py         # Role management
│   ├── settings.py      # Partner API credentials
│   ├── groups.py        # Group listing (with cache)
│   ├── members.py       # Member provisioning, ejection, bulk import
│   ├── reports.py       # Report download, aggregation, schedule, retention
│   ├── credentials.py   # Credential vault retrieval
│   ├── audit.py         # Audit log read and CSV export
│   └── pricing.py       # Per-group pricing configuration
└── services/
    ├── backblaze_client.py  # B2 API client (auth, retry, response masking)
    ├── oidc_client.py       # OIDC discovery, token exchange, JWT validation
    ├── vault.py             # Fernet encrypt/decrypt for credential vault
    ├── report_parser.py     # Report CSV download and caching
    ├── report_aggregator.py # Usage metric aggregation
    └── report_scheduler.py  # Background scheduler: auto-fetch and retention
```

**Storage:** A single SQLite file at `$DATA_DIR/portal.db`. No external database required.

**No build step:** The frontend is vanilla JavaScript served as static files. No Node.js, no bundler.

---

## Development

```bash
git clone https://github.com/your-org/b2-partner-portal.git
cd b2-partner-portal
python3 -m venv venv
venv/bin/pip install -r requirements.txt
cp .env.example .env
# Edit .env — set SECRET_KEY at minimum
# Add API_DOCS_ENABLED=true for Swagger UI during development
venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080 --reload
```

### Adding a permission

1. Add the constant to `app/rbac.py`.
2. Add it to the relevant default role(s) in `app/database.py` (`_DEFAULT_ROLES`).
3. Add a migration `INSERT OR IGNORE` in `init_db()` so existing deployments pick it up on restart.
4. Use `require_permission(YOUR_PERMISSION)` as a FastAPI dependency on the new endpoint.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for the security policy and how to report vulnerabilities.

## License

MIT — see [LICENSE](LICENSE).

Copyright 2025 Backblaze, Inc.
