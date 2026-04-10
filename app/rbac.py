"""Permission constants and require_permission() FastAPI dependency factory."""
from fastapi import Depends, HTTPException

from app.auth import CurrentUser, get_current_user

# ── Permission strings ────────────────────────────────────────────────────────
USERS_READ     = "users:read"
USERS_WRITE    = "users:write"
SETTINGS_READ  = "settings:read"
SETTINGS_WRITE = "settings:write"
GROUPS_READ    = "groups:read"
MEMBERS_READ   = "members:read"
MEMBERS_WRITE  = "members:write"
MEMBERS_EJECT  = "members:eject"
REPORTS_READ   = "reports:read"
ROLES_READ       = "roles:read"
ROLES_WRITE      = "roles:write"
CREDENTIALS_READ = "credentials:read"
AUDIT_READ       = "audit:read"

ALL_PERMISSIONS = [
    USERS_READ, USERS_WRITE,
    SETTINGS_READ, SETTINGS_WRITE,
    GROUPS_READ,
    MEMBERS_READ, MEMBERS_WRITE, MEMBERS_EJECT,
    REPORTS_READ,
    ROLES_READ, ROLES_WRITE,
    CREDENTIALS_READ,
    AUDIT_READ,
]


def require_permission(permission: str):
    """Returns a FastAPI Depends that enforces a single permission."""
    async def _dep(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if permission not in current_user.permissions:
            raise HTTPException(
                status_code=403,
                detail=f"Permission required: {permission}",
            )
        return current_user
    return Depends(_dep)
