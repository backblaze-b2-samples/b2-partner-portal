"""
Backblaze Partner API + B2 Native API async client.

Every method returns (result_dict, B2ApiCall) so callers can include the
raw API call details in their response — making this a self-documenting
sample application.
"""
from __future__ import annotations
import asyncio
import base64
import time
from datetime import datetime, timezone
from typing import Any

import aiohttp

from app.config import settings
from app.database import get_db, get_config, set_config
from app.schemas import B2ApiCall

_AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v3/b2_authorize_account"

# HTTP status codes that warrant a retry with exponential backoff (per API docs)
_RETRYABLE_STATUSES = {408, 429, 503}
_MAX_RETRIES = 3


def _mask_auth(headers: dict) -> dict:
    """Return headers with Authorization value partially masked."""
    out = dict(headers)
    if "Authorization" in out:
        val = out["Authorization"]
        if len(val) > 12:
            out["Authorization"] = val[:8] + "••••••••" + val[-4:]
        else:
            out["Authorization"] = "••••••••"
    return out


# Keys whose values should be masked in B2 API response bodies shown in the inspector.
_SENSITIVE_RESPONSE_KEYS = {
    "authorizationToken", "applicationKey", "masterApplicationKey",
    "masterApplicationKeyId",
}


def _mask_response_body(body: dict | None) -> dict | None:
    """Recursively mask known sensitive fields in a response body."""
    if not isinstance(body, dict):
        return body
    out = {}
    for k, v in body.items():
        if k in _SENSITIVE_RESPONSE_KEYS and isinstance(v, str):
            out[k] = v[:4] + "••••••••" + v[-4:] if len(v) > 8 else "••••••••"
        elif isinstance(v, dict):
            out[k] = _mask_response_body(v)
        elif isinstance(v, list):
            out[k] = [_mask_response_body(i) if isinstance(i, dict) else i for i in v]
        else:
            out[k] = v
    return out


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _raise_for_status(status: int, body: dict | None, default_msg: str) -> None:
    """Raise RuntimeError with '[code] message' for non-200 responses."""
    if body is None:
        raise RuntimeError(f"HTTP {status}: {default_msg}")
    code = body.get("code", "")
    message = body.get("message", default_msg)
    raise RuntimeError(f"[{code}] {message}" if code else message)


class BackblazeClient:
    """
    Thin async wrapper around the Backblaze Partner API.
    Uses a shared aiohttp.ClientSession passed in at construction time.
    """

    def __init__(self, session: aiohttp.ClientSession):
        self._session = session

    # ── Low-level HTTP helper ─────────────────────────────────────────────────

    async def _request(self, method: str, url: str, *,
                       headers: dict,
                       json_body: dict | None = None) -> tuple[dict | None, int, float]:
        """
        Make an HTTP request, retrying on 408 / 429 / 503 with exponential backoff.
        Returns (parsed_json_or_None, http_status, duration_ms).
        A 204 No Content response returns body=None.
        """
        delay = 1.0
        body: dict | None = None
        status = 0
        duration = 0.0

        for attempt in range(_MAX_RETRIES):
            t0 = time.monotonic()
            request_fn = getattr(self._session, method.lower())
            kwargs: dict[str, Any] = {"headers": headers}
            if json_body is not None:
                kwargs["json"] = json_body

            async with request_fn(url, **kwargs) as resp:
                duration = (time.monotonic() - t0) * 1000
                status = resp.status
                retry_after = resp.headers.get("Retry-After") if status == 429 else None
                body = None if status == 204 else await resp.json(content_type=None)

            if status in _RETRYABLE_STATUSES and attempt < _MAX_RETRIES - 1:
                wait = float(retry_after) if retry_after else delay
                await asyncio.sleep(wait)
                delay *= 2
                continue
            break

        return body, status, duration

    # ── Token cache ───────────────────────────────────────────────────────────

    async def _get_cached_token(self) -> dict | None:
        async with get_db() as db:
            cursor = await db.execute("SELECT * FROM api_token_cache WHERE id=1")
            row = await cursor.fetchone()
            if not row:
                return None
            expires_at = datetime.fromisoformat(row["expires_at"])
            if datetime.now(timezone.utc) >= expires_at:
                return None
            return dict(row)

    async def _cache_token(self, data: dict, groups_api_url: str):
        from datetime import timedelta
        expires_at = datetime.now(timezone.utc) + timedelta(hours=23)  # 24h lifetime, refresh at 23h
        async with get_db() as db:
            await db.execute(
                """INSERT INTO api_token_cache
                   (id, auth_token, api_url, download_url, account_id, groups_api_url, issued_at, expires_at)
                   VALUES (1,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                   auth_token=excluded.auth_token, api_url=excluded.api_url,
                   download_url=excluded.download_url, account_id=excluded.account_id,
                   groups_api_url=excluded.groups_api_url,
                   issued_at=excluded.issued_at, expires_at=excluded.expires_at""",
                [data["authorizationToken"],
                 data["apiInfo"]["storageApi"]["apiUrl"],
                 data["apiInfo"]["storageApi"]["downloadUrl"],
                 data["accountId"],
                 data["apiInfo"].get("groupsApi", {}).get("groupsApiUrl", ""),
                 _now_iso(), expires_at.isoformat()],
            )

    async def invalidate_token_cache(self):
        async with get_db() as db:
            await db.execute("DELETE FROM api_token_cache WHERE id=1")

    # ── b2_authorize_account ──────────────────────────────────────────────────

    async def authorize_account(self, account_id: str, application_key_id: str,
                                 application_key: str) -> tuple[dict, B2ApiCall]:
        """
        GET b2_authorize_account

        Partner API endpoint: https://api.backblazeb2.com/b2api/v3/b2_authorize_account
        Auth: HTTP Basic — applicationKeyId:applicationKey (base64 encoded)
        Errors: unauthorized (bad key), unsupported (key requires later API version),
                408/429/503 (retried automatically).
        """
        credentials = base64.b64encode(
            f"{application_key_id}:{application_key}".encode()
        ).decode()
        headers = {
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/json",
        }

        body, status, duration = await self._request("get", _AUTHORIZE_URL, headers=headers)

        api_call = B2ApiCall(
            method="GET",
            url=_AUTHORIZE_URL,
            request_headers=_mask_auth(headers),
            request_body=None,
            response_status=status,
            response_body=_mask_response_body(body),
            duration_ms=round(duration, 1),
        )

        if status != 200:
            code = (body or {}).get("code", "")
            message = (body or {}).get("message", "Authorization failed")
            if code == "unsupported":
                raise RuntimeError("The Application Key is only valid for a later API version. "
                                   "Please generate a new Master Application Key.")
            raise RuntimeError(f"[{code}] {message}" if code else message)

        return body, api_call

    async def _get_auth(self, force_refresh: bool = False) -> dict:
        """Return cached token or re-authorize using stored credentials."""
        if not force_refresh:
            cached = await self._get_cached_token()
            if cached:
                return cached

        creds = await get_config("partner_credentials")
        if not creds:
            raise RuntimeError("Partner API credentials not configured. Go to Settings.")

        result, _ = await self.authorize_account(
            creds["account_id"], creds["application_key_id"], creds["application_key"]
        )
        groups_api_url = result.get("apiInfo", {}).get("groupsApi", {}).get("groupsApiUrl", "")
        await self._cache_token(result, groups_api_url)
        cached = await self._get_cached_token()
        return cached

    # ── b2_list_groups ────────────────────────────────────────────────────────

    async def list_groups(self, cursor: str | None = None,
                          max_count: int = 100) -> tuple[dict, B2ApiCall]:
        """
        POST b2_list_groups

        Partner API endpoint: {groupsApiUrl}/b2api/v3/b2_list_groups
        Lists active Groups for the authorized Group admin.
        Paginate using startGroupId / nextGroupId. Max 100 per page, max 500 groups total.
        408/429/503 retried automatically.
        """
        auth = await self._get_auth()
        groups_api_url = auth["groups_api_url"] or auth["api_url"]
        url = f"{groups_api_url}/b2api/v3/b2_list_groups"

        headers = {
            "Authorization": auth["auth_token"],
            "Content-Type": "application/json",
        }
        req_body: dict[str, Any] = {
            "adminAccountId": auth["account_id"],
            "maxGroupCount": max_count,
        }
        if cursor:
            req_body["startGroupId"] = cursor

        result, status, duration = await self._request("post", url, headers=headers, json_body=req_body)

        api_call = B2ApiCall(
            method="POST",
            url=url,
            request_headers=_mask_auth(headers),
            request_body=req_body,
            response_status=status,
            response_body=result,
            duration_ms=round(duration, 1),
        )

        if status != 200:
            _raise_for_status(status, result, "list_groups failed")

        return result, api_call

    async def list_all_groups(self) -> tuple[list[dict], list[B2ApiCall]]:
        """Paginate through all groups, returning merged list + all API calls."""
        all_groups: list[dict] = []
        all_calls: list[B2ApiCall] = []
        cursor = None
        while True:
            result, call = await self.list_groups(cursor=cursor)
            all_calls.append(call)
            all_groups.extend(result.get("groups", []))
            cursor = result.get("nextGroupId")
            if not cursor:
                break
        return all_groups, all_calls

    async def list_all_groups_with_retry(self) -> tuple[list[dict], list[B2ApiCall]]:
        """Call list_all_groups, retrying once on expired_auth_token."""
        try:
            return await self.list_all_groups()
        except RuntimeError as e:
            if "[expired_auth_token]" in str(e):
                await self.invalidate_token_cache()
                return await self.list_all_groups()
            raise

    # ── b2_list_group_members ─────────────────────────────────────────────────

    async def list_group_members(self, group_id: str, cursor: str | None = None,
                                  max_count: int = 100) -> tuple[dict, B2ApiCall]:
        """
        POST b2_list_group_members

        Partner API endpoint: {groupsApiUrl}/b2api/v3/b2_list_group_members
        Lists active members of a Group. Paginate using startEmail / nextEmail.
        Max 1000 per page. 408/429/503 retried automatically.
        """
        auth = await self._get_auth()
        groups_api_url = auth["groups_api_url"] or auth["api_url"]
        url = f"{groups_api_url}/b2api/v3/b2_list_group_members"

        headers = {
            "Authorization": auth["auth_token"],
            "Content-Type": "application/json",
        }
        req_body: dict[str, Any] = {
            "adminAccountId": auth["account_id"],
            "groupId": group_id,
            "maxMemberCount": min(max_count, 1000),
        }
        if cursor:
            req_body["startEmail"] = cursor

        result, status, duration = await self._request("post", url, headers=headers, json_body=req_body)

        api_call = B2ApiCall(
            method="POST",
            url=url,
            request_headers=_mask_auth(headers),
            request_body=req_body,
            response_status=status,
            response_body=result,
            duration_ms=round(duration, 1),
        )

        if status != 200:
            _raise_for_status(status, result, "list_group_members failed")

        return result, api_call

    async def list_group_members_with_retry(self, group_id: str, cursor: str | None = None,
                                             max_count: int = 100) -> tuple[dict, B2ApiCall]:
        """Call list_group_members, retrying once on expired_auth_token."""
        try:
            return await self.list_group_members(group_id, cursor=cursor, max_count=max_count)
        except RuntimeError as e:
            if "[expired_auth_token]" in str(e):
                await self.invalidate_token_cache()
                return await self.list_group_members(group_id, cursor=cursor, max_count=max_count)
            raise

    # ── b2_create_group_member ────────────────────────────────────────────────

    async def create_group_member(self, group_id: str, email: str,
                                   region: str = "us-west") -> tuple[dict, B2ApiCall]:
        """
        POST b2_create_group_member

        Partner API endpoint: {groupsApiUrl}/b2api/v3/b2_create_group_member
        Creates a new Backblaze account and adds it to the specified Group.
        Returns applicationKeyId + applicationKey for the new account (shown once).
        Region options: us-east, us-west, eu-central, ca-east.
        408/429/503 retried automatically.
        """
        auth = await self._get_auth()
        groups_api_url = auth["groups_api_url"] or auth["api_url"]
        url = f"{groups_api_url}/b2api/v3/b2_create_group_member"

        headers = {
            "Authorization": auth["auth_token"],
            "Content-Type": "application/json",
        }
        req_body = {
            "adminAccountId": auth["account_id"],
            "groupId": group_id,
            "memberEmail": email,
            "region": region,
        }

        result, status, duration = await self._request("post", url, headers=headers, json_body=req_body)

        api_call = B2ApiCall(
            method="POST",
            url=url,
            request_headers=_mask_auth(headers),
            request_body=req_body,
            response_status=status,
            response_body=result,
            duration_ms=round(duration, 1),
        )

        if status != 200:
            _raise_for_status(status, result, "create_group_member failed")

        return result, api_call

    async def create_group_member_with_retry(self, group_id: str, email: str,
                                              region: str = "us-west") -> tuple[dict, B2ApiCall]:
        """Call create_group_member, retrying once on expired_auth_token."""
        try:
            return await self.create_group_member(group_id, email, region)
        except RuntimeError as e:
            if "[expired_auth_token]" in str(e):
                await self.invalidate_token_cache()
                return await self.create_group_member(group_id, email, region)
            raise

    # ── b2_eject_group_member ─────────────────────────────────────────────────

    async def eject_group_member(self, group_id: str,
                                  member_account_id: str,
                                  email: str | None = None) -> tuple[dict, B2ApiCall]:
        """
        POST b2_eject_group_member

        Partner API endpoint: {groupsApiUrl}/b2api/v3/b2_eject_group_member
        Removes a member from a Group. The member's account is NOT deleted —
        they simply lose Group membership. Note: ejected members cannot be
        re-added via the Partner API (only via the Backblaze web UI).
        408/429/503 retried automatically.
        """
        auth = await self._get_auth()
        groups_api_url = auth["groups_api_url"] or auth["api_url"]
        url = f"{groups_api_url}/b2api/v3/b2_eject_group_member"

        headers = {
            "Authorization": auth["auth_token"],
            "Content-Type": "application/json",
        }
        req_body: dict[str, Any] = {
            "adminAccountId": auth["account_id"],
            "groupId": group_id,
            "memberAccountId": member_account_id,
        }
        if email:
            req_body["email"] = email

        result, status, duration = await self._request("post", url, headers=headers, json_body=req_body)

        api_call = B2ApiCall(
            method="POST",
            url=url,
            request_headers=_mask_auth(headers),
            request_body=req_body,
            response_status=status,
            response_body=result,
            duration_ms=round(duration, 1),
        )

        if status != 200:
            _raise_for_status(status, result, "eject_group_member failed")

        return result, api_call

    # ── B2 Native: download report file ──────────────────────────────────────

    async def download_file_by_name(self, bucket: str, file_name: str) -> tuple[bytes, B2ApiCall]:
        """
        GET {downloadUrl}/file/{bucket}/{fileName}

        B2 Native API — download a file by bucket + name.
        Used to retrieve daily usage report CSVs.
        408/429/503 retried automatically.
        """
        auth = await self._get_auth()
        url = f"{auth['download_url']}/file/{bucket}/{file_name}"
        headers = {"Authorization": auth["auth_token"]}

        delay = 1.0
        data = b""
        status = 0
        duration = 0.0
        content_type = ""

        for attempt in range(_MAX_RETRIES):
            t0 = time.monotonic()
            async with self._session.get(url, headers=headers) as resp:
                duration = (time.monotonic() - t0) * 1000
                status = resp.status
                retry_after = resp.headers.get("Retry-After") if status == 429 else None
                content_type = str(resp.content_type)
                data = await resp.read()

            if status in _RETRYABLE_STATUSES and attempt < _MAX_RETRIES - 1:
                wait = float(retry_after) if retry_after else delay
                await asyncio.sleep(wait)
                delay *= 2
                continue
            break

        api_call = B2ApiCall(
            method="GET",
            url=url,
            request_headers=_mask_auth(headers),
            request_body=None,
            response_status=status,
            response_body={"content_length": len(data), "content_type": content_type},
            duration_ms=round(duration, 1),
        )

        if status == 404:
            raise FileNotFoundError(f"No report file found at: {file_name}")
        if status != 200:
            raise RuntimeError(f"Download failed: HTTP {status}")

        return data, api_call
