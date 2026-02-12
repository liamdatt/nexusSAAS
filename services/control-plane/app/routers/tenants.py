from __future__ import annotations

import secrets
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.crypto import SecretCipher
from app.db import get_db
from app.deps import get_current_user
from app.models import ConfigRevision, PromptRevision, SkillRevision, Tenant, TenantRuntime, TenantSecret, User
from app.runner_client import RunnerClient, RunnerError
from app.schemas import (
    ConfigOut,
    ConfigPatchRequest,
    OperationAccepted,
    PromptOut,
    PromptPutRequest,
    SkillOut,
    SkillPutRequest,
    TenantOut,
    TenantSetupRequest,
    TenantStatusOut,
)


router = APIRouter(prefix="/v1/tenants", tags=["tenants"])
runner = RunnerClient()
cipher = SecretCipher()
logger = logging.getLogger(__name__)
OPENROUTER_API_KEY = "NEXUS_OPENROUTER_API_KEY"


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
        secret_blob = cipher.encrypt({"bridge_shared_secret": bridge_secret})
        tenant_secret = TenantSecret(
            tenant_id=tenant_id,
            encrypted_blob=secret_blob,
            key_version=cipher.key_version,
        )
        config_rev = ConfigRevision(tenant_id=tenant_id, revision=1, env_json=initial_env, is_active=True)

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

        db.add_all([runtime, tenant_secret, config_rev])
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
        "nexus_image": request.app.state.settings.nexus_image,
        "runtime_env": initial_env,
        "bridge_shared_secret": bridge_secret,
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
    await _runner_call(request, tenant_id, "start", lambda: runner.start(tenant_id))
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
    await _runner_call(request, tenant_id, "restart", lambda: runner.restart(tenant_id))
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
    await _runner_call(request, tenant_id, "pair_start", lambda: runner.pair_start(tenant_id))
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
    await _emit(request, tenant_id, "whatsapp.disconnected", {"reason": "requested"})
    return OperationAccepted(tenant_id=tenant_id, operation="whatsapp_disconnect")


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
