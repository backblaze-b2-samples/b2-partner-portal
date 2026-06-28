"""Pydantic request/response models."""
from __future__ import annotations
import re
from typing import Any, Optional
from pydantic import BaseModel, EmailStr, Field, field_validator


# ── API call inspector (self-documenting) ────────────────────────────────────

class B2ApiCall(BaseModel):
    """Represents one HTTP call made to the Backblaze API — shown in the UI."""
    method: str
    url: str
    request_headers: dict[str, str]   # auth token masked
    request_body: Optional[dict] = None
    response_status: int
    response_body: Any
    duration_ms: float


# ── Auth ─────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class MeResponse(BaseModel):
    id: str
    email: str
    role_id: str
    permissions: list[str]
    api_inspector_enabled: bool = False


# ── Users ─────────────────────────────────────────────────────────────────────

_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")
_ROLE_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")


class UserCreate(BaseModel):
    email: str
    password: str = Field(min_length=12, description="Minimum 12 characters")
    role_id: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Invalid email address")
        return v


class UserUpdate(BaseModel):
    email: Optional[str] = None
    role_id: Optional[str] = None
    is_active: Optional[bool] = None


class UserResponse(BaseModel):
    id: str
    email: str
    role_id: str
    role_name: str
    is_active: bool
    created_at: str
    last_login_at: Optional[str]
    auth_source: str = "local"


class BulkImportResult(BaseModel):
    created: int
    skipped: int
    errors: list[dict]


# ── Roles ─────────────────────────────────────────────────────────────────────

class RoleCreate(BaseModel):
    id: str = Field(description="Role slug — lowercase alphanumeric, hyphens, underscores, max 64 chars")
    name: str
    description: str = ""
    permissions: list[str]

    @field_validator("id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        if not _ROLE_ID_RE.match(v):
            raise ValueError("Role ID must be lowercase alphanumeric with hyphens/underscores only (max 64 chars)")
        return v


class RoleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    permissions: Optional[list[str]] = None


class RoleResponse(BaseModel):
    id: str
    name: str
    description: str
    permissions: list[str]
    created_at: str


# ── Settings ──────────────────────────────────────────────────────────────────

class SettingsUpdate(BaseModel):
    account_id: str
    application_key_id: str
    application_key: str
    report_bucket: Optional[str] = None
    report_prefix: Optional[str] = "daily-reports/"


class SettingsResponse(BaseModel):
    account_id: Optional[str]
    application_key_id: Optional[str]
    application_key_masked: Optional[str]   # last 4 chars only
    report_bucket: Optional[str]
    report_prefix: Optional[str]
    configured: bool


class ConnectionTestResponse(BaseModel):
    success: bool
    message: str
    b2_api_call: Optional[B2ApiCall] = None


class DiskUsageEntry(BaseModel):
    label: str
    bytes: int
    file_count: int
    description: str


class DiskUsageResponse(BaseModel):
    entries: list[DiskUsageEntry]
    total_bytes: int
    data_dir: str


# ── Groups ────────────────────────────────────────────────────────────────────

class GroupResponse(BaseModel):
    group_id: str
    group_name: str
    raw: dict
    cached_at: str


class GroupsListResponse(BaseModel):
    groups: list[GroupResponse]
    total: int
    cached_at: Optional[str]
    b2_api_call: Optional[B2ApiCall] = None


# ── Members ───────────────────────────────────────────────────────────────────

class MemberCreate(BaseModel):
    email: str
    region: str = "us-west"


class MemberResponse(BaseModel):
    account_id: str
    email: str
    region: str
    s3_endpoint: Optional[str]
    raw: dict


class MembersListResponse(BaseModel):
    group_id: str
    group_name: Optional[str]
    members: list[MemberResponse]
    next_cursor: Optional[str]
    b2_api_call: Optional[B2ApiCall] = None


class MemberCreateResponse(BaseModel):
    member: MemberResponse
    credentials: dict          # application_key_id + application_key (only shown once)
    b2_api_call: Optional[B2ApiCall] = None


class MemberEject(BaseModel):
    email: Optional[str] = None  # if provided, changes member's email on ejection


class MemberEjectResponse(BaseModel):
    success: bool
    message: str
    b2_api_call: Optional[B2ApiCall] = None


class BulkMemberResult(BaseModel):
    email: str
    region: str
    success: bool
    account_id: Optional[str] = None
    s3_endpoint: Optional[str] = None
    application_key_id: Optional[str] = None
    application_key: Optional[str] = None
    error: Optional[str] = None
    b2_api_call: Optional[B2ApiCall] = None


class BulkMemberImportResponse(BaseModel):
    created: int
    failed: int
    results: list[BulkMemberResult]


class VaultedCredentialResponse(BaseModel):
    member_account_id: str
    account_email: str
    group_id: str
    region: str = ""
    s3_endpoint: str = ""
    application_key_id: str
    application_key: str
    created_at: str


# ── OIDC SSO ──────────────────────────────────────────────────────────────────

class OidcConfig(BaseModel):
    enabled: bool = False
    issuer_url: str = ""
    client_id: str = ""
    client_secret: str = ""   # empty string means "don't change existing"
    redirect_uri: str = ""
    groups_claim: str = "groups"
    button_label: str = "Sign in with SSO"
    default_role_id: Optional[str] = None


class OidcConfigResponse(BaseModel):
    enabled: bool
    issuer_url: str
    client_id: str
    client_secret_set: bool   # true if a secret is stored; never returned in plaintext
    redirect_uri: str
    groups_claim: str
    button_label: str
    default_role_id: Optional[str]


class OidcGroupMapping(BaseModel):
    id: str
    group_id: str
    role_id: str
    label: str
    sort_order: int


class OidcGroupMappingCreate(BaseModel):
    group_id: str
    role_id: str
    label: str = ""


class OidcGroupMappingUpdate(BaseModel):
    group_id: Optional[str] = None
    role_id: Optional[str] = None
    label: Optional[str] = None


class OidcMappingsReorder(BaseModel):
    ordered_ids: list[str]


# ── Reports ───────────────────────────────────────────────────────────────────

class ReportFileInfo(BaseModel):
    report_date: str
    file_type: str
    group_id: Optional[str]
    location: Optional[str]
    file_size: int
    row_count: Optional[int]
    downloaded_at: str


class ReportDataResponse(BaseModel):
    report_date: str
    file_type: str
    headers: list[str]
    rows: list[list[str]]
    row_count: int
    b2_api_call: Optional[B2ApiCall] = None
