"""Generic OIDC client — discovery document, token exchange, ID token validation.

Works with any compliant provider: Azure Entra ID, Google Workspace, Okta,
Auth0, Keycloak, AWS Cognito, etc.
"""
from __future__ import annotations
import time
from typing import Any
from urllib.parse import urlencode, urlparse

import aiohttp
import jwt as _jwt
from jwt import PyJWKClient

# Cache: keyed by URL, value is (data, fetched_at_epoch)
_discovery_cache: dict[str, tuple[dict, float]] = {}
_jwks_clients:    dict[str, PyJWKClient] = {}
_DISCOVERY_TTL = 3600   # re-fetch discovery doc at most once per hour


def _require_same_origin(issuer_url: str, endpoint_url: str, label: str) -> None:
    """Ensure a discovered endpoint shares the same HTTPS host as the issuer.

    Prevents a compromised or malicious discovery document from redirecting
    token requests to an attacker-controlled host (SSRF / open-redirect).
    """
    issuer  = urlparse(issuer_url)
    endpoint = urlparse(endpoint_url)
    if endpoint.scheme != "https" or endpoint.netloc != issuer.netloc:
        raise RuntimeError(
            f"OIDC {label} '{endpoint_url}' does not share the issuer host "
            f"'{issuer.netloc}'. Discovery document may be misconfigured."
        )


async def _fetch_json(url: str) -> dict:
    async with aiohttp.ClientSession() as s:
        async with s.get(url, timeout=aiohttp.ClientTimeout(total=10)) as r:
            r.raise_for_status()
            return await r.json()


async def get_discovery(issuer_url: str) -> dict:
    """Fetch and cache the OIDC discovery document for the given issuer."""
    issuer_url = issuer_url.rstrip("/")
    cached = _discovery_cache.get(issuer_url)
    if cached and time.time() - cached[1] < _DISCOVERY_TTL:
        return cached[0]
    doc = await _fetch_json(f"{issuer_url}/.well-known/openid-configuration")
    _discovery_cache[issuer_url] = (doc, time.time())
    return doc


def _get_jwks_client(jwks_uri: str) -> PyJWKClient:
    """Return a cached PyJWKClient for the given JWKS URI."""
    if jwks_uri not in _jwks_clients:
        # cache_keys=True keeps fetched keys in memory; lifespan matches process
        _jwks_clients[jwks_uri] = PyJWKClient(jwks_uri, cache_keys=True)
    return _jwks_clients[jwks_uri]


async def build_auth_url(issuer_url: str, client_id: str, redirect_uri: str, state: str) -> str:
    doc = await get_discovery(issuer_url)
    _require_same_origin(issuer_url, doc["authorization_endpoint"], "authorization_endpoint")
    params = {
        "client_id":     client_id,
        "response_type": "code",
        "redirect_uri":  redirect_uri,
        "response_mode": "query",
        "scope":         "openid email profile",
        "state":         state,
    }
    return f"{doc['authorization_endpoint']}?{urlencode(params)}"


async def exchange_code(
    issuer_url: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    code: str,
) -> dict[str, Any]:
    doc = await get_discovery(issuer_url)
    _require_same_origin(issuer_url, doc["token_endpoint"], "token_endpoint")
    async with aiohttp.ClientSession() as s:
        async with s.post(
            doc["token_endpoint"],
            data={
                "client_id":     client_id,
                "client_secret": client_secret,
                "code":          code,
                "redirect_uri":  redirect_uri,
                "grant_type":    "authorization_code",
            },
            timeout=aiohttp.ClientTimeout(total=15),
        ) as r:
            result = await r.json()
            if r.status != 200:
                raise RuntimeError(result.get("error_description") or "Token exchange failed")
            return result


async def decode_id_token(id_token: str, issuer_url: str, client_id: str) -> dict[str, Any]:
    """Validate signature, issuer, audience, and expiry; return claims."""
    doc             = await get_discovery(issuer_url)
    jwks_uri        = doc["jwks_uri"]
    expected_issuer = doc.get("issuer", issuer_url)

    try:
        jwks_client  = _get_jwks_client(jwks_uri)
        signing_key  = jwks_client.get_signing_key_from_jwt(id_token)
        claims = _jwt.decode(
            id_token,
            signing_key,
            algorithms=["RS256", "ES256"],
            audience=client_id,
            issuer=expected_issuer,
        )
    except _jwt.PyJWTError as e:
        raise RuntimeError(f"ID token validation failed: {e}")

    return claims


def extract_email(claims: dict) -> str | None:
    """Return the verified email from the ID token, or None if unverifiable.

    Rejects tokens where email_verified is explicitly False. Tokens that omit
    email_verified entirely (e.g. Azure, which pre-verifies at the directory
    level) are accepted — the claim is only present and False on providers that
    allow unverified addresses (e.g. some Okta or Cognito configurations).
    """
    # email_verified absent → treat as verified (Azure, Google omit it when verified)
    # email_verified present and False → reject
    email_verified = claims.get("email_verified")
    if email_verified is False:
        return None

    return (claims.get("email") or claims.get("preferred_username") or "").lower().strip() or None


def extract_groups(claims: dict, groups_claim: str = "groups") -> list[str]:
    """Return group identifiers from the configured claim (GUIDs, names, etc.)."""
    return [str(g) for g in (claims.get(groups_claim) or [])]
