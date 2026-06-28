"""Generic OIDC SSO — login, callback, config, and group-role mappings.

Works with any standards-compliant OIDC provider: Azure Entra ID, Google
Workspace, Okta, Auth0, Keycloak, AWS Cognito, etc.
"""
from __future__ import annotations
import json
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app.auth import CurrentUser, create_access_token, create_refresh_token, make_session_cookie
from app.config import settings
from app.database import get_db, get_config, set_config
from app.limiter import limiter
from app.rbac import require_permission, SETTINGS_READ, SETTINGS_WRITE
from app.schemas import (
    OidcConfig, OidcConfigResponse,
    OidcGroupMapping, OidcGroupMappingCreate, OidcGroupMappingUpdate,
    OidcMappingsReorder,
)
from app.services import oidc_client as oidc

router = APIRouter()

_STATE_TTL_MINUTES = 10


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _load_config() -> dict:
    return await get_config("oidc_config") or {}


async def _require_oidc_config() -> dict:
    cfg = await _load_config()
    if not cfg.get("enabled") or not cfg.get("issuer_url") or not cfg.get("client_id"):
        raise HTTPException(400, "SSO is not configured or disabled.")
    return cfg


# ── Public: login page checks this to decide whether to show SSO button ───────

@router.get("/status")
async def oidc_status():
    cfg = await _load_config()
    enabled = bool(cfg.get("enabled") and cfg.get("issuer_url") and cfg.get("client_id"))
    return {
        "enabled":      enabled,
        "button_label": cfg.get("button_label") or "Sign in with SSO",
    }


# ── Public: initiate SSO login ─────────────────────────────────────────────────

@router.get("/login")
@limiter.limit("20/minute")
async def oidc_login(request: Request):
    cfg = await _require_oidc_config()

    state = str(uuid.uuid4())
    async with get_db() as db:
        await db.execute(
            "INSERT INTO oidc_states (state, created_at) VALUES (?,?)",
            [state, _now()],
        )

    redirect_uri = cfg.get("redirect_uri") or str(request.base_url).rstrip("/") + "/api/auth/oidc/callback"
    try:
        url = await oidc.build_auth_url(cfg["issuer_url"], cfg["client_id"], redirect_uri, state)
    except Exception as e:
        raise HTTPException(502, f"Could not reach SSO provider discovery endpoint: {e}")

    return RedirectResponse(url, status_code=302)


# ── Public: OIDC callback ──────────────────────────────────────────────────────

@router.get("/callback")
async def oidc_callback(
    request: Request,
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    error_description: str | None = Query(None),
):
    if error:
        return RedirectResponse(
            f"/login?sso=1&error={quote(str(error))}&error_description={quote(str(error_description or ''))}",
            status_code=302,
        )

    if not code or not state:
        return RedirectResponse("/login?sso=1&error=missing_params", status_code=302)

    # Validate and consume state (CSRF protection)
    async with get_db() as db:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=_STATE_TTL_MINUTES)).isoformat()
        cursor = await db.execute(
            "SELECT state FROM oidc_states WHERE state=? AND created_at > ?",
            [state, cutoff],
        )
        if not await cursor.fetchone():
            return RedirectResponse("/login?sso=1&error=invalid_state", status_code=302)
        await db.execute("DELETE FROM oidc_states WHERE state=?", [state])
        await db.execute("DELETE FROM oidc_states WHERE created_at <= ?", [cutoff])

    cfg = await _require_oidc_config()
    redirect_uri    = cfg.get("redirect_uri") or str(request.base_url).rstrip("/") + "/api/auth/oidc/callback"
    groups_claim    = cfg.get("groups_claim") or "groups"

    # Exchange code for tokens and validate ID token
    try:
        tokens = await oidc.exchange_code(
            cfg["issuer_url"], cfg["client_id"], cfg["client_secret"], redirect_uri, code,
        )
        claims = await oidc.decode_id_token(
            tokens["id_token"], cfg["issuer_url"], cfg["client_id"],
        )
    except RuntimeError as e:
        return RedirectResponse(
            f"/login?sso=1&error=token_error&error_description={quote(str(e))}",
            status_code=302,
        )

    email = oidc.extract_email(claims)
    if not email:
        return RedirectResponse("/login?sso=1&error=no_email", status_code=302)

    user_groups = oidc.extract_groups(claims, groups_claim)

    # Determine role — first matching group mapping wins (ordered by sort_order)
    role_id = None
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT azure_group_id, role_id FROM oidc_group_mappings ORDER BY sort_order"
        )
        rows = await cursor.fetchall()
    for row in rows:
        if row["azure_group_id"] in user_groups:
            role_id = row["role_id"]
            break

    if not role_id:
        role_id = cfg.get("default_role_id") or None

    if not role_id:
        return RedirectResponse("/login?sso=1&error=no_role", status_code=302)

    # Verify the role still exists
    async with get_db() as db:
        cursor = await db.execute("SELECT id FROM roles WHERE id=?", [role_id])
        if not await cursor.fetchone():
            return RedirectResponse("/login?sso=1&error=invalid_role", status_code=302)

    # JIT provision or update user
    now = _now()
    ip  = request.client.host if request.client else ""
    async with get_db() as db:
        cursor = await db.execute("SELECT id, auth_source FROM users WHERE email=?", [email])
        existing = await cursor.fetchone()

        if existing:
            # Prevent SSO from silently taking over a pre-existing local account.
            # An admin must explicitly link the account first (by setting auth_source
            # to 'sso' or deleting and re-provisioning via SSO).
            if existing["auth_source"] == "local":
                return RedirectResponse(
                    f"/login?sso=1&error=account_conflict",
                    status_code=302,
                )
            user_id = existing["id"]
            await db.execute(
                "UPDATE users SET role_id=?, auth_source='sso', updated_at=?, last_login_at=? WHERE id=?",
                [role_id, now, now, user_id],
            )
        else:
            import secrets
            from app.auth import hash_password
            user_id  = str(uuid.uuid4())
            dummy_pw = hash_password(secrets.token_urlsafe(32))
            await db.execute(
                """INSERT INTO users (id, email, password_hash, role_id, auth_source, is_active, created_at, updated_at, last_login_at)
                   VALUES (?,?,?,?,'sso',1,?,?,?)""",
                [user_id, email, dummy_pw, role_id, now, now, now],
            )

        await db.execute(
            """INSERT INTO audit_log (user_id, user_email, action, target_type, target_id, details, ip_address, occurred_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            [user_id, email, "auth.sso_login", "portal_user", user_id,
             json.dumps({"provider": cfg["issuer_url"], "role_id": role_id,
                         "groups_in_token": len(user_groups)}),
             ip, now],
        )

    # Issue portal JWT tokens
    token_id, expires_at = create_refresh_token()
    access_token = create_access_token(user_id, token_id)

    async with get_db() as db:
        await db.execute(
            "INSERT INTO refresh_tokens (id, user_id, issued_at, expires_at, ip_address) VALUES (?,?,?,?,?)",
            [token_id, user_id, now, expires_at.isoformat(), ip],
        )

    # Use a short-lived one-time exchange code instead of passing tokens in the
    # URL — tokens in URLs appear in browser history and server access logs.
    exchange_code = str(uuid.uuid4())
    async with get_db() as db:
        await db.execute(
            "INSERT INTO oidc_exchange_codes (code, access_token, refresh_token, user_id, created_at) VALUES (?,?,?,?,?)",
            [exchange_code, access_token, token_id, user_id, now],
        )

    return RedirectResponse(f"/login?sso=1&code={exchange_code}", status_code=302)


# ── Public: exchange one-time code for tokens ─────────────────────────────────

_EXCHANGE_TTL_SECONDS = 60

@router.post("/exchange")
@limiter.limit("20/minute")
async def oidc_exchange(request: Request, code: str = Body(..., embed=True)):
    """Swap the short-lived SSO exchange code for access + refresh tokens.
    Codes expire after 60 seconds and are deleted on first use.
    """
    async with get_db() as db:
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=_EXCHANGE_TTL_SECONDS)).isoformat()
        cursor = await db.execute(
            "SELECT access_token, refresh_token, user_id FROM oidc_exchange_codes WHERE code=? AND created_at > ?",
            [code, cutoff],
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(400, "Invalid or expired SSO exchange code.")
        await db.execute("DELETE FROM oidc_exchange_codes WHERE code=?", [code])
        # Clean up expired codes
        await db.execute("DELETE FROM oidc_exchange_codes WHERE created_at <= ?", [cutoff])

    resp = JSONResponse({"access_token": row["access_token"], "refresh_token": row["refresh_token"]})
    resp.set_cookie(
        "session", make_session_cookie(row["user_id"]),
        httponly=True, samesite="lax",
        max_age=settings.refresh_token_expire_days * 86400,
        secure=True,
    )
    return resp


# ── OIDC Configuration ────────────────────────────────────────────────────────

@router.get("/config", response_model=OidcConfigResponse)
async def get_oidc_config(_: CurrentUser = require_permission(SETTINGS_READ)):
    cfg = await _load_config()
    return OidcConfigResponse(
        enabled=cfg.get("enabled", False),
        issuer_url=cfg.get("issuer_url", ""),
        client_id=cfg.get("client_id", ""),
        client_secret_set=bool(cfg.get("client_secret")),
        redirect_uri=cfg.get("redirect_uri", ""),
        groups_claim=cfg.get("groups_claim") or "groups",
        button_label=cfg.get("button_label") or "Sign in with SSO",
        default_role_id=cfg.get("default_role_id"),
    )


@router.put("/config")
async def save_oidc_config(
    body: OidcConfig,
    _: CurrentUser = require_permission(SETTINGS_WRITE),
):
    existing = await _load_config()
    secret   = body.client_secret if body.client_secret else existing.get("client_secret", "")
    issuer_url = body.issuer_url.strip().rstrip("/")
    # Strip if user accidentally pasted the full discovery URL
    if issuer_url.endswith("/.well-known/openid-configuration"):
        issuer_url = issuer_url[: -len("/.well-known/openid-configuration")]
    if issuer_url:
        try:
            oidc.validate_issuer_url(issuer_url)
        except RuntimeError as e:
            raise HTTPException(400, str(e))
    await set_config("oidc_config", {
        "enabled":         body.enabled,
        "issuer_url":      issuer_url,
        "client_id":       body.client_id.strip(),
        "client_secret":   secret,
        "redirect_uri":    body.redirect_uri.strip(),
        "groups_claim":    body.groups_claim.strip() or "groups",
        "button_label":    body.button_label.strip() or "Sign in with SSO",
        "default_role_id": body.default_role_id or None,
    })
    # Bust discovery cache so new issuer takes effect immediately
    oidc._discovery_cache.pop(issuer_url, None)
    return {"ok": True}


# ── Group → Role Mappings ──────────────────────────────────────────────────────

@router.get("/mappings", response_model=list[OidcGroupMapping])
async def list_mappings(_: CurrentUser = require_permission(SETTINGS_READ)):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT id, azure_group_id AS group_id, role_id, label, sort_order "
            "FROM oidc_group_mappings ORDER BY sort_order"
        )
        rows = await cursor.fetchall()
    return [OidcGroupMapping(**dict(r)) for r in rows]


@router.post("/mappings", response_model=OidcGroupMapping, status_code=201)
async def create_mapping(
    body: OidcGroupMappingCreate,
    _: CurrentUser = require_permission(SETTINGS_WRITE),
):
    async with get_db() as db:
        cursor = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM oidc_group_mappings")
        next_order = (await cursor.fetchone())[0]
        mapping_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO oidc_group_mappings (id, azure_group_id, role_id, label, sort_order) VALUES (?,?,?,?,?)",
            [mapping_id, body.group_id.strip(), body.role_id, body.label.strip(), next_order],
        )
    return OidcGroupMapping(
        id=mapping_id, group_id=body.group_id.strip(),
        role_id=body.role_id, label=body.label.strip(), sort_order=next_order,
    )


@router.put("/mappings/{mapping_id}", response_model=OidcGroupMapping)
async def update_mapping(
    mapping_id: str,
    body: OidcGroupMappingUpdate,
    _: CurrentUser = require_permission(SETTINGS_WRITE),
):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT id, azure_group_id AS group_id, role_id, label, sort_order "
            "FROM oidc_group_mappings WHERE id=?",
            [mapping_id],
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "Mapping not found")
        updated = dict(row)
        if body.group_id  is not None: updated["group_id"] = body.group_id.strip()
        if body.role_id   is not None: updated["role_id"]  = body.role_id
        if body.label     is not None: updated["label"]    = body.label.strip()
        await db.execute(
            "UPDATE oidc_group_mappings SET azure_group_id=?, role_id=?, label=? WHERE id=?",
            [updated["group_id"], updated["role_id"], updated["label"], mapping_id],
        )
    return OidcGroupMapping(**updated)


@router.delete("/mappings/{mapping_id}", status_code=204)
async def delete_mapping(
    mapping_id: str,
    _: CurrentUser = require_permission(SETTINGS_WRITE),
):
    async with get_db() as db:
        await db.execute("DELETE FROM oidc_group_mappings WHERE id=?", [mapping_id])


@router.post("/mappings/reorder", status_code=204)
async def reorder_mappings(
    body: OidcMappingsReorder,
    _: CurrentUser = require_permission(SETTINGS_WRITE),
):
    async with get_db() as db:
        for i, mid in enumerate(body.ordered_ids):
            await db.execute(
                "UPDATE oidc_group_mappings SET sort_order=? WHERE id=?", [i, mid],
            )
