from __future__ import annotations

import json
import secrets
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from jose import JWTError
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.assistant_defaults import (
    ASSISTANT_DEFAULTS_VERSION,
    MANAGED_PROMPT_IDS,
    MANAGED_SKILL_IDS,
    PROMPT_DEFAULTS,
    SKILL_DEFAULTS,
    prompt_needs_default,
    skill_needs_default,
)
from app.crypto import SecretCipher
from app.db import get_db
from app.deps import get_current_user
from app.google_oauth import (
    build_google_consent_url,
    ensure_google_oauth_configured,
    ensure_origin_allowed,
    exchange_code_for_tokens,
    parse_allowed_origins,
    request_origin,
    token_expiry_iso,
    token_scopes,
)
from app.models import ConfigRevision, PromptRevision, RuntimeEvent, SkillRevision, Tenant, TenantRuntime, TenantSecret, User
from app.runner_client import RunnerClient, RunnerError
from app.security import create_google_oauth_state, decode_google_oauth_state
from app.schemas import (
    AssistantBootstrapOut,
    ConfigOut,
    ConfigPatchRequest,
    GoogleConnectStartOut,
    GoogleStatusOut,
    OperationAccepted,
    PromptOut,
    PromptPutRequest,
    RuntimeEventOut,
    SkillOut,
    SkillPutRequest,
    TenantOut,
    TenantSetupRequest,
    TenantStatusOut,
)


router = APIRouter(prefix="/v1/tenants", tags=["tenants"])
oauth_router = APIRouter(prefix="/v1/oauth", tags=["oauth"])
runner = RunnerClient()
cipher = SecretCipher()
logger = logging.getLogger(__name__)
OPENROUTER_API_KEY = "NEXUS_OPENROUTER_API_KEY"
NEXUS_IMAGE_PLACEHOLDERS = ("replace_with", "your-org", "<org>")


def _openrouter_key_required_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "error": "openrouter_api_key_required",
            "message": "NEXUS_OPENROUTER_API_KEY is required before runtime start",
        },
    )


def _has_openrouter_api_key(env_json: dict | None) -> bool:
    if not isinstance(env_json, dict):
        return False
    value = env_json.get(OPENROUTER_API_KEY)
    if value is None:
        return False
    return bool(str(value).strip())


def _require_openrouter_api_key(db: Session, tenant_id: str) -> None:
    active = db.scalar(
        select(ConfigRevision).where(ConfigRevision.tenant_id == tenant_id, ConfigRevision.is_active.is_(True))
    )
    if active is None or not _has_openrouter_api_key(active.env_json):
        raise _openrouter_key_required_error()


def _require_valid_nexus_image(request: Request) -> str:
    image = str(request.app.state.settings.nexus_image or "").strip()
    lowered = image.lower()
    if not image or any(marker in lowered for marker in NEXUS_IMAGE_PLACEHOLDERS):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "nexus_image_invalid",
                "message": "Control-plane NEXUS_IMAGE is not set to a valid runtime tag",
            },
        )
    return image


def _tenant_for_owner(db: Session, tenant_id: str, owner_user_id: int) -> Tenant:
    tenant = db.scalar(select(Tenant).where(Tenant.id == tenant_id, Tenant.owner_user_id == owner_user_id))
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    return tenant


async def _emit(request: Request, tenant_id: str, event_type: str, payload: dict) -> None:
    await request.app.state.events.emit(tenant_id=tenant_id, event_type=event_type, payload=payload)


def _runtime_for_tenant(db: Session, tenant_id: str) -> TenantRuntime:
    runtime = db.scalar(select(TenantRuntime).where(TenantRuntime.tenant_id == tenant_id))
    if runtime is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Runtime not found")
    return runtime


async def _runner_call(request: Request, tenant_id: str, action: str, call) -> None:
    try:
        await call()
    except RunnerError as exc:
        error_payload = {"error": exc.code, "message": str(exc), "action": action}
        await _emit(request, tenant_id, "runtime.error", error_payload)
        raise HTTPException(status_code=exc.status_code, detail=error_payload) from exc


def _tenant_secret_row(db: Session, tenant_id: str) -> TenantSecret:
    secret = db.get(TenantSecret, tenant_id)
    if secret is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant secrets not found")
    return secret


def _load_secret_payload(secret: TenantSecret) -> dict:
    decrypted = cipher.decrypt(secret.encrypted_blob)
    if isinstance(decrypted, dict):
        return dict(decrypted)
    return {}


def _save_secret_payload(secret: TenantSecret, payload: dict) -> None:
    secret.encrypted_blob = cipher.encrypt(payload)
    secret.key_version = cipher.key_version


def _is_runtime_running_state(actual_state: str | None) -> bool:
    return actual_state in {"running", "pending_pairing", "provisioning"}


def _google_status_payload(tenant_id: str, secret_payload: dict) -> GoogleStatusOut:
    google_blob = secret_payload.get("google_oauth")
    connected = isinstance(google_blob, dict) and isinstance(google_blob.get("token_json"), dict)
    connected_at_raw = google_blob.get("connected_at") if isinstance(google_blob, dict) else None
    connected_at: datetime | None = None
    if isinstance(connected_at_raw, str):
        try:
            connected_at = datetime.fromisoformat(connected_at_raw.replace("Z", "+00:00"))
        except ValueError:
            connected_at = None
    scopes = google_blob.get("scopes") if isinstance(google_blob, dict) else []
    if not isinstance(scopes, list):
        scopes = []
    scopes = [str(scope) for scope in scopes if isinstance(scope, str)]
    last_error = secret_payload.get("google_oauth_last_error")
    return GoogleStatusOut(
        tenant_id=tenant_id,
        connected=connected,
        connected_at=connected_at,
        scopes=scopes,
        last_error=str(last_error) if isinstance(last_error, str) and last_error.strip() else None,
    )


def _popup_html(origin: str, payload: dict) -> HTMLResponse:
    serialized = json.dumps(payload).replace("</", "<\\/")
    target_origin = json.dumps(origin)
    body = f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Google OAuth</title>
  </head>
  <body>
    <script>
      (function() {{
        const payload = {serialized};
        try {{
          if (window.opener) {{
            window.opener.postMessage(payload, {target_origin});
          }}
        }} catch (_err) {{}}
        window.close();
        document.body.innerText = payload.status === "ok"
          ? "Google account connected. You can close this window."
          : "Google account connection failed. You can close this window.";
      }})();
    </script>
  </body>
</html>"""
    return HTMLResponse(content=body)


@router.post("/setup", response_model=TenantOut)
async def setup_tenant(
    body: TenantSetupRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TenantOut:
    existing = db.scalar(select(Tenant).where(Tenant.owner_user_id == user.id))
    if existing is not None:
        return TenantOut.model_validate(existing, from_attributes=True)
    nexus_image = _require_valid_nexus_image(request)

    initial_env = {
        "NEXUS_CLI_ENABLED": "false",
        "NEXUS_CONFIG_DIR": "/data/config",
        "NEXUS_DATA_DIR": "/data/state",
        "NEXUS_PROMPTS_DIR": "/data/config/prompts",
        "NEXUS_SKILLS_DIR": "/data/config/skills",
    }
    if body.initial_config:
        initial_env.update(body.initial_config)
    if not _has_openrouter_api_key(initial_env):
        raise _openrouter_key_required_error()

    tenant: Tenant | None = None
    runtime: TenantRuntime | None = None
    tenant_id = ""
    bridge_secret = ""
    last_integrity_error: IntegrityError | None = None
    for _attempt in range(3):
        tenant_id = secrets.token_hex(8)
        # Keep worker identifier tenant-scoped to tolerate legacy schemas that enforce uniqueness.
        worker_id = f"worker-{tenant_id}"
        tenant = Tenant(id=tenant_id, owner_user_id=user.id, status="provisioning", worker_id=worker_id)
        runtime = TenantRuntime(tenant_id=tenant_id, desired_state="stopped", actual_state="provisioning")
        bridge_secret = secrets.token_urlsafe(24)
        secret_blob = cipher.encrypt(
            {
                "bridge_shared_secret": bridge_secret,
                "assistant_defaults_version": ASSISTANT_DEFAULTS_VERSION,
            }
        )
        tenant_secret = TenantSecret(
            tenant_id=tenant_id,
            encrypted_blob=secret_blob,
            key_version=cipher.key_version,
        )
        config_rev = ConfigRevision(tenant_id=tenant_id, revision=1, env_json=initial_env, is_active=True)
        prompt_revisions = [
            PromptRevision(
                tenant_id=tenant_id,
                name=name,
                revision=1,
                content=content,
                is_active=True,
            )
            for name, content in PROMPT_DEFAULTS.items()
        ]
        skill_revisions = [
            SkillRevision(
                tenant_id=tenant_id,
                skill_id=skill_id,
                revision=1,
                content=content,
                is_active=True,
            )
            for skill_id, content in SKILL_DEFAULTS.items()
        ]

        db.add(tenant)
        try:
            # Ensure parent tenant row exists before child rows are flushed.
            db.flush()
        except IntegrityError as exc:
            db.rollback()
            last_integrity_error = exc
            logger.warning(
                "Tenant setup integrity conflict for user_id=%s on attempt=%s stage=tenant_flush: %s",
                user.id,
                _attempt + 1,
                exc,
            )
            existing = db.scalar(select(Tenant).where(Tenant.owner_user_id == user.id))
            if existing is not None:
                return TenantOut.model_validate(existing, from_attributes=True)
            continue

        db.add_all([runtime, tenant_secret, config_rev, *prompt_revisions, *skill_revisions])
        try:
            db.commit()
            break
        except IntegrityError as exc:
            db.rollback()
            last_integrity_error = exc
            logger.warning(
                "Tenant setup integrity conflict for user_id=%s on attempt=%s stage=child_commit: %s",
                user.id,
                _attempt + 1,
                exc,
            )
            existing = db.scalar(select(Tenant).where(Tenant.owner_user_id == user.id))
            if existing is not None:
                return TenantOut.model_validate(existing, from_attributes=True)
    else:
        logger.error(
            "Tenant setup commit failed for user_id=%s after retries. last_error=%s",
            user.id,
            last_integrity_error,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "tenant_setup_conflict", "message": "Could not complete tenant setup"},
        ) from last_integrity_error

    assert tenant is not None
    assert runtime is not None
    db.refresh(tenant)

    payload = {
        "tenant_id": tenant_id,
        "nexus_image": nexus_image,
        "runtime_env": initial_env,
        "bridge_shared_secret": bridge_secret,
        "prompts": [{"name": name, "content": content} for name, content in PROMPT_DEFAULTS.items()],
        "skills": [{"skill_id": skill_id, "content": content} for skill_id, content in SKILL_DEFAULTS.items()],
    }

    try:
        await runner.provision(tenant_id=tenant_id, payload=payload)
        tenant.status = "pending_pairing"
        runtime.desired_state = "running"
        runtime.actual_state = "pending_pairing"
        runtime.last_heartbeat = datetime.now(UTC)
        db.commit()
        await _emit(request, tenant_id, "runtime.status", {"state": "pending_pairing"})
    except RunnerError as exc:
        tenant.status = "error"
        runtime.actual_state = "error"
        runtime.last_error = f"{exc.code}: {exc}"
        db.commit()
        await _emit(request, tenant_id, "runtime.error", {"error": exc.code, "message": str(exc)})

    return TenantOut.model_validate(tenant, from_attributes=True)


@router.get("/{tenant_id}/status", response_model=TenantStatusOut)
async def get_tenant_status(
    tenant_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TenantStatusOut:
    _tenant_for_owner(db, tenant_id, user.id)
    runtime = _runtime_for_tenant(db, tenant_id)
    try:
        health = await runner.health(tenant_id)
        container_running = bool(health.get("container_running"))
        if container_running:
            # Keep event-projected states (for example pending_pairing) instead of forcing running.
            if runtime.actual_state in {"provisioning", "paused"} and runtime.desired_state == "running":
                runtime.actual_state = "running"
        elif runtime.actual_state not in {"error", "deleted", "provisioning"}:
            runtime.actual_state = "paused"
        runtime.last_heartbeat = datetime.now(UTC)
        if runtime.actual_state != "error":
            runtime.last_error = None
        db.commit()
    except RunnerError:
        # Preserve last known state if worker is unavailable.
        pass
    return TenantStatusOut(
        tenant_id=tenant_id,
        desired_state=runtime.desired_state,
        actual_state=runtime.actual_state,
        last_heartbeat=runtime.last_heartbeat,
        last_error=runtime.last_error,
    )


@router.post("/{tenant_id}/runtime/start", response_model=OperationAccepted)
async def start_tenant_runtime(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OperationAccepted:
    _tenant_for_owner(db, tenant_id, user.id)
    _require_openrouter_api_key(db, tenant_id)
    nexus_image = _require_valid_nexus_image(request)
    await _runner_call(request, tenant_id, "start", lambda: runner.start(tenant_id, {"nexus_image": nexus_image}))
    runtime = _runtime_for_tenant(db, tenant_id)
    runtime.desired_state = "running"
    runtime.actual_state = "running"
    runtime.last_heartbeat = datetime.now(UTC)
    db.commit()
    await _emit(request, tenant_id, "runtime.status", {"state": "running"})
    return OperationAccepted(tenant_id=tenant_id, operation="start")


@router.post("/{tenant_id}/runtime/stop", response_model=OperationAccepted)
async def stop_tenant_runtime(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OperationAccepted:
    _tenant_for_owner(db, tenant_id, user.id)
    await _runner_call(request, tenant_id, "stop", lambda: runner.stop(tenant_id))
    runtime = _runtime_for_tenant(db, tenant_id)
    runtime.desired_state = "paused"
    runtime.actual_state = "paused"
    runtime.last_heartbeat = datetime.now(UTC)
    db.commit()
    await _emit(request, tenant_id, "runtime.status", {"state": "paused"})
    return OperationAccepted(tenant_id=tenant_id, operation="stop")


@router.post("/{tenant_id}/runtime/restart", response_model=OperationAccepted)
async def restart_tenant_runtime(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OperationAccepted:
    _tenant_for_owner(db, tenant_id, user.id)
    _require_openrouter_api_key(db, tenant_id)
    nexus_image = _require_valid_nexus_image(request)
    await _runner_call(
        request, tenant_id, "restart", lambda: runner.restart(tenant_id, {"nexus_image": nexus_image})
    )
    runtime = _runtime_for_tenant(db, tenant_id)
    runtime.desired_state = "running"
    runtime.actual_state = "running"
    runtime.last_heartbeat = datetime.now(UTC)
    db.commit()
    await _emit(request, tenant_id, "runtime.status", {"state": "running"})
    return OperationAccepted(tenant_id=tenant_id, operation="restart")


@router.post("/{tenant_id}/whatsapp/pair/start", response_model=OperationAccepted)
async def pair_start(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OperationAccepted:
    _tenant_for_owner(db, tenant_id, user.id)
    _require_openrouter_api_key(db, tenant_id)
    nexus_image = _require_valid_nexus_image(request)
    await _runner_call(
        request, tenant_id, "pair_start", lambda: runner.pair_start(tenant_id, {"nexus_image": nexus_image})
    )
    runtime = _runtime_for_tenant(db, tenant_id)
    runtime.desired_state = "pending_pairing"
    runtime.actual_state = "pending_pairing"
    runtime.last_heartbeat = datetime.now(UTC)
    db.commit()
    await _emit(request, tenant_id, "runtime.status", {"state": "pending_pairing"})
    return OperationAccepted(tenant_id=tenant_id, operation="pair_start")


@router.post("/{tenant_id}/whatsapp/disconnect", response_model=OperationAccepted)
async def whatsapp_disconnect(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OperationAccepted:
    _tenant_for_owner(db, tenant_id, user.id)
    await _runner_call(request, tenant_id, "whatsapp_disconnect", lambda: runner.disconnect(tenant_id))
    runtime = _runtime_for_tenant(db, tenant_id)
    runtime.desired_state = "pending_pairing"
    runtime.actual_state = "pending_pairing"
    runtime.last_error = None
    runtime.last_heartbeat = datetime.now(UTC)
    db.commit()
    await _emit(request, tenant_id, "whatsapp.disconnected", {"reason": "requested"})
    await _emit(request, tenant_id, "runtime.status", {"state": "pending_pairing"})
    return OperationAccepted(tenant_id=tenant_id, operation="whatsapp_disconnect")


@router.post("/{tenant_id}/google/connect/start", response_model=GoogleConnectStartOut)
async def google_connect_start(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GoogleConnectStartOut:
    _tenant_for_owner(db, tenant_id, user.id)
    settings = request.app.state.settings
    ensure_google_oauth_configured(settings)

    allowed_origins = parse_allowed_origins(settings.google_oauth_allowed_origins)
    origin = request_origin(request)
    ensure_origin_allowed(origin=origin, allowed_origins=allowed_origins)
    state_token, expires_in = create_google_oauth_state(user_id=user.id, tenant_id=tenant_id, origin=origin)
    auth_url = build_google_consent_url(
        client_id=settings.google_oauth_client_id,
        redirect_uri=settings.google_oauth_redirect_uri,
        state=state_token,
    )
    return GoogleConnectStartOut(tenant_id=tenant_id, auth_url=auth_url, expires_in_seconds=expires_in)


@router.get("/{tenant_id}/google/status", response_model=GoogleStatusOut)
async def google_status(
    tenant_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GoogleStatusOut:
    _tenant_for_owner(db, tenant_id, user.id)
    secret = _tenant_secret_row(db, tenant_id)
    payload = _load_secret_payload(secret)
    return _google_status_payload(tenant_id, payload)


@router.post("/{tenant_id}/google/disconnect", response_model=OperationAccepted)
async def google_disconnect(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OperationAccepted:
    _tenant_for_owner(db, tenant_id, user.id)
    secret = _tenant_secret_row(db, tenant_id)
    payload = _load_secret_payload(secret)
    payload.pop("google_oauth", None)
    payload.pop("google_oauth_last_error", None)
    _save_secret_payload(secret, payload)
    db.commit()

    await _runner_call(request, tenant_id, "google_disconnect", lambda: runner.google_disconnect(tenant_id))
    await _emit(request, tenant_id, "google.disconnected", {"reason": "requested"})
    return OperationAccepted(tenant_id=tenant_id, operation="google_disconnect")


@oauth_router.get("/google/callback")
async def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
    db: Session = Depends(get_db),
) -> HTMLResponse:
    if not state:
        return _popup_html(
            "*",
            {"type": "google.oauth.result", "status": "error", "error": "Missing OAuth state token"},
        )

    try:
        claims = decode_google_oauth_state(state)
    except JWTError:
        return _popup_html(
            "*",
            {"type": "google.oauth.result", "status": "error", "error": "Invalid or expired OAuth state token"},
        )

    tenant_id = str(claims.get("tenant_id") or "").strip()
    origin = str(claims.get("origin") or "").strip()
    try:
        user_id = int(claims.get("user_id"))
    except Exception:  # noqa: BLE001
        return _popup_html(
            origin or "*",
            {"type": "google.oauth.result", "status": "error", "error": "Invalid OAuth state payload"},
        )

    tenant = db.scalar(select(Tenant).where(Tenant.id == tenant_id, Tenant.owner_user_id == user_id))
    if tenant is None:
        return _popup_html(
            origin or "*",
            {"type": "google.oauth.result", "status": "error", "error": "Tenant not found for OAuth state"},
        )

    settings = request.app.state.settings
    try:
        ensure_google_oauth_configured(settings)
        allowed_origins = parse_allowed_origins(settings.google_oauth_allowed_origins)
        ensure_origin_allowed(origin=origin, allowed_origins=allowed_origins)

        if error:
            details = (error_description or error).strip() or "Google authorization was denied"
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "google_oauth_denied", "message": details},
            )
        if not code:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "google_oauth_missing_code", "message": "Missing OAuth code"},
            )

        token_payload = await exchange_code_for_tokens(
            code=code,
            client_id=settings.google_oauth_client_id,
            client_secret=settings.google_oauth_client_secret,
            redirect_uri=settings.google_oauth_redirect_uri,
        )
        refresh_token = token_payload.get("refresh_token")
        if not isinstance(refresh_token, str) or not refresh_token.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "google_oauth_refresh_token_missing",
                    "message": "Google did not return a refresh token. Disconnect and reconnect with consent.",
                },
            )

        access_token = str(token_payload.get("access_token") or "").strip()
        if not access_token:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "google_oauth_access_token_missing",
                    "message": "Google did not return an access token.",
                },
            )

        scopes = token_scopes(token_payload)
        token_json: dict[str, object] = {
            "token": access_token,
            "refresh_token": refresh_token,
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": settings.google_oauth_client_id,
            "client_secret": settings.google_oauth_client_secret,
            "scopes": scopes,
        }
        expiry = token_expiry_iso(token_payload)
        if expiry:
            token_json["expiry"] = expiry
        token_type = token_payload.get("token_type")
        if isinstance(token_type, str) and token_type.strip():
            token_json["token_type"] = token_type

        secret = _tenant_secret_row(db, tenant_id)
        secret_payload = _load_secret_payload(secret)
        secret_payload["google_oauth"] = {
            "token_json": token_json,
            "scopes": scopes,
            "connected_at": datetime.now(UTC).isoformat(),
        }
        secret_payload.pop("google_oauth_last_error", None)
        _save_secret_payload(secret, secret_payload)
        db.commit()

        await _runner_call(
            request,
            tenant_id,
            "google_connect",
            lambda: runner.google_connect(tenant_id, {"token_json": token_json}),
        )
        await _emit(request, tenant_id, "google.connected", {"scopes": scopes})
        return _popup_html(origin, {"type": "google.oauth.result", "status": "ok", "tenant_id": tenant_id})
    except HTTPException as exc:
        secret = _tenant_secret_row(db, tenant_id)
        secret_payload = _load_secret_payload(secret)
        detail = exc.detail if isinstance(exc.detail, dict) else {"error": "google_oauth_error", "message": str(exc.detail)}
        message = str(detail.get("message") or detail.get("error") or "Google OAuth error")
        secret_payload["google_oauth_last_error"] = message
        _save_secret_payload(secret, secret_payload)
        db.commit()
        await _emit(request, tenant_id, "google.error", {"message": message})
        return _popup_html(
            origin,
            {
                "type": "google.oauth.result",
                "status": "error",
                "tenant_id": tenant_id,
                "error": message,
            },
        )


@router.post("/{tenant_id}/assistant/bootstrap", response_model=AssistantBootstrapOut)
async def assistant_bootstrap(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> AssistantBootstrapOut:
    _tenant_for_owner(db, tenant_id, user.id)
    runtime = _runtime_for_tenant(db, tenant_id)

    prompt_rows = db.scalars(
        select(PromptRevision).where(PromptRevision.tenant_id == tenant_id, PromptRevision.is_active.is_(True))
    ).all()
    skill_rows = db.scalars(
        select(SkillRevision).where(SkillRevision.tenant_id == tenant_id, SkillRevision.is_active.is_(True))
    ).all()
    prompt_map = {row.name: row for row in prompt_rows}
    skill_map = {row.skill_id: row for row in skill_rows}

    secret = _tenant_secret_row(db, tenant_id)
    secret_payload = _load_secret_payload(secret)
    previous_version = str(secret_payload.get("assistant_defaults_version") or "").strip()
    defaults_version_changed = previous_version != ASSISTANT_DEFAULTS_VERSION

    prompt_updates: dict[str, str] = {}
    for name, content in PROMPT_DEFAULTS.items():
        current = prompt_map.get(name)
        if defaults_version_changed and name in MANAGED_PROMPT_IDS:
            prompt_updates[name] = content
            continue
        if prompt_needs_default(name, current.content if current else None):
            prompt_updates[name] = content

    skill_updates: dict[str, str] = {}
    for skill_id, content in SKILL_DEFAULTS.items():
        current = skill_map.get(skill_id)
        if defaults_version_changed and skill_id in MANAGED_SKILL_IDS:
            skill_updates[skill_id] = content
            continue
        if skill_needs_default(skill_id, current.content if current else None):
            skill_updates[skill_id] = content

    if not prompt_updates and not skill_updates:
        if previous_version != ASSISTANT_DEFAULTS_VERSION:
            secret_payload["assistant_defaults_version"] = ASSISTANT_DEFAULTS_VERSION
            _save_secret_payload(secret, secret_payload)
            db.commit()
        return AssistantBootstrapOut(
            tenant_id=tenant_id,
            applied=False,
            version=ASSISTANT_DEFAULTS_VERSION,
            restarted_runtime=False,
            reason="already_bootstrapped",
        )

    merged_prompts = {row.name: row.content for row in prompt_rows}
    merged_prompts.update(prompt_updates)
    merged_skills = {row.skill_id: row.content for row in skill_rows}
    merged_skills.update(skill_updates)
    config = db.scalar(select(ConfigRevision).where(ConfigRevision.tenant_id == tenant_id, ConfigRevision.is_active.is_(True)))
    env_payload = config.env_json if config else {}

    pending_prompt_revisions: list[PromptRevision] = []
    for name, content in prompt_updates.items():
        next_rev = (
            db.scalar(
                select(func.max(PromptRevision.revision)).where(
                    PromptRevision.tenant_id == tenant_id,
                    PromptRevision.name == name,
                )
            )
            or 0
        ) + 1
        revision = PromptRevision(
            tenant_id=tenant_id,
            name=name,
            revision=next_rev,
            content=content,
            is_active=False,
        )
        db.add(revision)
        pending_prompt_revisions.append(revision)

    pending_skill_revisions: list[SkillRevision] = []
    for skill_id, content in skill_updates.items():
        next_rev = (
            db.scalar(
                select(func.max(SkillRevision.revision)).where(
                    SkillRevision.tenant_id == tenant_id,
                    SkillRevision.skill_id == skill_id,
                )
            )
            or 0
        ) + 1
        revision = SkillRevision(
            tenant_id=tenant_id,
            skill_id=skill_id,
            revision=next_rev,
            content=content,
            is_active=False,
        )
        db.add(revision)
        pending_skill_revisions.append(revision)

    restarted_runtime = _is_runtime_running_state(runtime.actual_state)
    try:
        await _runner_call(
            request,
            tenant_id,
            "assistant_bootstrap_apply_config",
            lambda: runner.apply_config(
                tenant_id,
                {
                    "env": env_payload,
                    "prompts": [{"name": name, "content": content} for name, content in merged_prompts.items()],
                    "skills": [{"skill_id": skill_id, "content": content} for skill_id, content in merged_skills.items()],
                    "config_revision": config.revision if config else None,
                },
            ),
        )
    except HTTPException:
        db.rollback()
        raise

    if prompt_updates:
        db.execute(
            update(PromptRevision)
            .where(PromptRevision.tenant_id == tenant_id, PromptRevision.name.in_(list(prompt_updates)))
            .values(is_active=False)
        )
        for revision in pending_prompt_revisions:
            revision.is_active = True

    if skill_updates:
        db.execute(
            update(SkillRevision)
            .where(SkillRevision.tenant_id == tenant_id, SkillRevision.skill_id.in_(list(skill_updates)))
            .values(is_active=False)
        )
        for revision in pending_skill_revisions:
            revision.is_active = True

    secret_payload["assistant_defaults_version"] = ASSISTANT_DEFAULTS_VERSION
    _save_secret_payload(secret, secret_payload)
    db.commit()

    await _emit(
        request,
        tenant_id,
        "assistant.bootstrap.applied",
        {
            "version": ASSISTANT_DEFAULTS_VERSION,
            "restarted_runtime": restarted_runtime,
            "prompts": sorted(prompt_updates.keys()),
            "skills": sorted(skill_updates.keys()),
        },
    )
    return AssistantBootstrapOut(
        tenant_id=tenant_id,
        applied=True,
        version=ASSISTANT_DEFAULTS_VERSION,
        restarted_runtime=restarted_runtime,
        reason="applied_defaults",
    )


@router.get("/{tenant_id}/config", response_model=ConfigOut)
async def get_config(
    tenant_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConfigOut:
    _tenant_for_owner(db, tenant_id, user.id)
    active = db.scalar(select(ConfigRevision).where(ConfigRevision.tenant_id == tenant_id, ConfigRevision.is_active.is_(True)))
    if active is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Active config not found")
    return ConfigOut(tenant_id=tenant_id, revision=active.revision, env_json=active.env_json)


@router.get("/{tenant_id}/events/recent", response_model=list[RuntimeEventOut])
async def get_recent_events(
    tenant_id: str,
    limit: int = 50,
    after_event_id: int | None = None,
    types: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[RuntimeEventOut]:
    _tenant_for_owner(db, tenant_id, user.id)

    bounded_limit = max(1, min(limit, 200))
    stmt = select(RuntimeEvent).where(RuntimeEvent.tenant_id == tenant_id)
    if after_event_id is not None:
        stmt = stmt.where(RuntimeEvent.id > after_event_id)

    if types:
        selected_types = [item.strip() for item in types.split(",") if item.strip()]
        if selected_types:
            stmt = stmt.where(RuntimeEvent.type.in_(selected_types))

    rows = db.scalars(stmt.order_by(RuntimeEvent.id.desc()).limit(bounded_limit)).all()
    return [
        RuntimeEventOut(
            event_id=row.id,
            tenant_id=row.tenant_id,
            type=row.type,
            payload=row.payload_json,
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.patch("/{tenant_id}/config", response_model=ConfigOut)
async def patch_config(
    tenant_id: str,
    body: ConfigPatchRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConfigOut:
    _tenant_for_owner(db, tenant_id, user.id)
    active = db.scalar(select(ConfigRevision).where(ConfigRevision.tenant_id == tenant_id, ConfigRevision.is_active.is_(True)))
    if active is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Active config not found")

    merged = dict(active.env_json)
    merged.update(body.values)
    for key in body.remove_keys:
        merged.pop(key, None)

    if merged == active.env_json:
        return ConfigOut(tenant_id=tenant_id, revision=active.revision, env_json=active.env_json)

    next_rev = (db.scalar(select(func.max(ConfigRevision.revision)).where(ConfigRevision.tenant_id == tenant_id)) or 0) + 1
    new_rev = ConfigRevision(tenant_id=tenant_id, revision=next_rev, env_json=merged, is_active=False)
    db.add(new_rev)

    prompts = db.scalars(
        select(PromptRevision).where(PromptRevision.tenant_id == tenant_id, PromptRevision.is_active.is_(True))
    ).all()
    skills = db.scalars(
        select(SkillRevision).where(SkillRevision.tenant_id == tenant_id, SkillRevision.is_active.is_(True))
    ).all()

    await _runner_call(
        request,
        tenant_id,
        "apply_config",
        lambda: runner.apply_config(
            tenant_id,
            {
                "env": merged,
                "prompts": [{"name": p.name, "content": p.content} for p in prompts],
                "skills": [{"skill_id": s.skill_id, "content": s.content} for s in skills],
                "config_revision": next_rev,
            },
        ),
    )
    db.execute(update(ConfigRevision).where(ConfigRevision.tenant_id == tenant_id).values(is_active=False))
    new_rev.is_active = True
    db.commit()
    await _emit(request, tenant_id, "config.applied", {"revision": next_rev})
    return ConfigOut(tenant_id=tenant_id, revision=next_rev, env_json=merged)


@router.get("/{tenant_id}/prompts", response_model=list[PromptOut])
async def get_prompts(
    tenant_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[PromptOut]:
    _tenant_for_owner(db, tenant_id, user.id)
    rows = db.scalars(
        select(PromptRevision)
        .where(PromptRevision.tenant_id == tenant_id, PromptRevision.is_active.is_(True))
        .order_by(PromptRevision.name.asc())
    ).all()
    return [PromptOut(name=r.name, revision=r.revision, content=r.content) for r in rows]


@router.put("/{tenant_id}/prompts/{name}", response_model=PromptOut)
async def put_prompt(
    tenant_id: str,
    name: str,
    body: PromptPutRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PromptOut:
    _tenant_for_owner(db, tenant_id, user.id)
    next_rev = (
        db.scalar(
            select(func.max(PromptRevision.revision)).where(PromptRevision.tenant_id == tenant_id, PromptRevision.name == name)
        )
        or 0
    ) + 1
    rev = PromptRevision(tenant_id=tenant_id, name=name, revision=next_rev, content=body.content, is_active=False)
    db.add(rev)

    config = db.scalar(select(ConfigRevision).where(ConfigRevision.tenant_id == tenant_id, ConfigRevision.is_active.is_(True)))
    prompts = db.scalars(
        select(PromptRevision).where(PromptRevision.tenant_id == tenant_id, PromptRevision.is_active.is_(True))
    ).all()
    skills = db.scalars(
        select(SkillRevision).where(SkillRevision.tenant_id == tenant_id, SkillRevision.is_active.is_(True))
    ).all()
    prompts_payload = {p.name: p.content for p in prompts}
    prompts_payload[name] = body.content
    await _runner_call(
        request,
        tenant_id,
        "apply_config",
        lambda: runner.apply_config(
            tenant_id,
            {
                "env": config.env_json if config else {},
                "prompts": [{"name": p_name, "content": p_content} for p_name, p_content in prompts_payload.items()],
                "skills": [{"skill_id": s.skill_id, "content": s.content} for s in skills],
            },
        ),
    )
    db.execute(
        update(PromptRevision)
        .where(PromptRevision.tenant_id == tenant_id, PromptRevision.name == name)
        .values(is_active=False)
    )
    rev.is_active = True
    db.commit()
    await _emit(request, tenant_id, "config.applied", {"prompt": name, "revision": next_rev})
    return PromptOut(name=name, revision=next_rev, content=body.content)


@router.get("/{tenant_id}/skills", response_model=list[SkillOut])
async def get_skills(
    tenant_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SkillOut]:
    _tenant_for_owner(db, tenant_id, user.id)
    rows = db.scalars(
        select(SkillRevision)
        .where(SkillRevision.tenant_id == tenant_id, SkillRevision.is_active.is_(True))
        .order_by(SkillRevision.skill_id.asc())
    ).all()
    return [SkillOut(skill_id=r.skill_id, revision=r.revision, content=r.content) for r in rows]


@router.put("/{tenant_id}/skills/{skill_id}", response_model=SkillOut)
async def put_skill(
    tenant_id: str,
    skill_id: str,
    body: SkillPutRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SkillOut:
    _tenant_for_owner(db, tenant_id, user.id)
    next_rev = (
        db.scalar(
            select(func.max(SkillRevision.revision)).where(
                SkillRevision.tenant_id == tenant_id, SkillRevision.skill_id == skill_id
            )
        )
        or 0
    ) + 1
    rev = SkillRevision(tenant_id=tenant_id, skill_id=skill_id, revision=next_rev, content=body.content, is_active=False)
    db.add(rev)

    config = db.scalar(select(ConfigRevision).where(ConfigRevision.tenant_id == tenant_id, ConfigRevision.is_active.is_(True)))
    prompts = db.scalars(
        select(PromptRevision).where(PromptRevision.tenant_id == tenant_id, PromptRevision.is_active.is_(True))
    ).all()
    skills = db.scalars(
        select(SkillRevision).where(SkillRevision.tenant_id == tenant_id, SkillRevision.is_active.is_(True))
    ).all()
    skills_payload = {s.skill_id: s.content for s in skills}
    skills_payload[skill_id] = body.content
    await _runner_call(
        request,
        tenant_id,
        "apply_config",
        lambda: runner.apply_config(
            tenant_id,
            {
                "env": config.env_json if config else {},
                "prompts": [{"name": p.name, "content": p.content} for p in prompts],
                "skills": [{"skill_id": s_id, "content": s_content} for s_id, s_content in skills_payload.items()],
            },
        ),
    )
    db.execute(
        update(SkillRevision)
        .where(SkillRevision.tenant_id == tenant_id, SkillRevision.skill_id == skill_id)
        .values(is_active=False)
    )
    rev.is_active = True
    db.commit()
    await _emit(request, tenant_id, "config.applied", {"skill_id": skill_id, "revision": next_rev})
    return SkillOut(skill_id=skill_id, revision=next_rev, content=body.content)
