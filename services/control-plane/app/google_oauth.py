from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import HTTPException, Request, status

from app.config import Settings


GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_OAUTH_SCOPES = (
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
)


def _normalize_origin(raw: str | None) -> str:
    candidate = (raw or "").strip()
    if not candidate:
        return ""
    parsed = urlparse(candidate)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def parse_allowed_origins(raw: str) -> set[str]:
    out: set[str] = set()
    for chunk in (raw or "").split(","):
        normalized = _normalize_origin(chunk)
        if normalized:
            out.add(normalized)
    return out


def request_origin(request: Request) -> str:
    origin = _normalize_origin(request.headers.get("origin"))
    if origin:
        return origin

    referer = request.headers.get("referer")
    if referer:
        parsed = urlparse(referer)
        normalized = _normalize_origin(f"{parsed.scheme}://{parsed.netloc}")
        if normalized:
            return normalized

    return _normalize_origin(str(request.base_url))


def ensure_google_oauth_configured(settings: Settings) -> None:
    missing: list[str] = []
    if not settings.google_oauth_client_id.strip():
        missing.append("GOOGLE_OAUTH_CLIENT_ID")
    if not settings.google_oauth_client_secret.strip():
        missing.append("GOOGLE_OAUTH_CLIENT_SECRET")
    if not settings.google_oauth_redirect_uri.strip():
        missing.append("GOOGLE_OAUTH_REDIRECT_URI")
    if not settings.google_oauth_allowed_origins.strip():
        missing.append("GOOGLE_OAUTH_ALLOWED_ORIGINS")
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "google_oauth_not_configured",
                "message": f"Missing Google OAuth config: {', '.join(missing)}",
            },
        )


def ensure_origin_allowed(*, origin: str, allowed_origins: set[str]) -> None:
    if not origin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "google_oauth_origin_missing", "message": "Could not resolve request origin"},
        )
    if origin not in allowed_origins:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "google_oauth_origin_forbidden", "message": f"Origin not allowed: {origin}"},
        )


def build_google_consent_url(*, client_id: str, redirect_uri: str, state: str) -> str:
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(GOOGLE_OAUTH_SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
        }
    )
    return f"{GOOGLE_AUTH_URL}?{query}"


async def exchange_code_for_tokens(
    *,
    code: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
) -> dict:
    payload = {
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(GOOGLE_TOKEN_URL, data=payload)
    if resp.status_code >= 400:
        message = resp.text
        try:
            parsed = resp.json()
            if isinstance(parsed, dict):
                err = str(parsed.get("error", "")).strip()
                desc = str(parsed.get("error_description", "")).strip()
                message = f"{err}: {desc}".strip(": ").strip() or message
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "google_token_exchange_failed", "message": message},
        )
    return resp.json()


def token_scopes(token_payload: dict) -> list[str]:
    scopes = token_payload.get("scope")
    if isinstance(scopes, str):
        return [chunk for chunk in scopes.split() if chunk]
    return list(GOOGLE_OAUTH_SCOPES)


def token_expiry_iso(token_payload: dict) -> str | None:
    expires_in = token_payload.get("expires_in")
    if not isinstance(expires_in, int):
        return None
    expiry = datetime.now(UTC) + timedelta(seconds=max(0, expires_in))
    return expiry.isoformat()
