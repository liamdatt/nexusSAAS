from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime

from fastapi import FastAPI, Header, HTTPException, status

from app.auth import AuthError, verify_internal_token
from app.config import get_settings
from app.monitor import TenantMonitor
from app.publisher import EventPublisher
from app.runtime_manager import RuntimeErrorManager, RuntimeManager
from app.schemas import ApplyConfigRequest, GenericResponse, HealthResponse, ProvisionRequest


settings = get_settings()
publisher = EventPublisher()
runtime_manager = RuntimeManager()
monitor = TenantMonitor(publisher, runtime_manager)
reconcile_task: asyncio.Task | None = None
last_reconcile_at: datetime | None = None


def _runtime_http_error(exc: RuntimeErrorManager) -> HTTPException:
    status_map = {
        "invalid_tenant_id": status.HTTP_400_BAD_REQUEST,
        "invalid_tenant_path": status.HTTP_400_BAD_REQUEST,
        "invalid_config_item": status.HTTP_400_BAD_REQUEST,
        "unsafe_path": status.HTTP_400_BAD_REQUEST,
        "tenant_not_found": status.HTTP_404_NOT_FOUND,
        "compose_missing": status.HTTP_404_NOT_FOUND,
        "template_missing": status.HTTP_500_INTERNAL_SERVER_ERROR,
        "docker_unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
        "docker_command_failed": status.HTTP_502_BAD_GATEWAY,
    }
    return HTTPException(
        status_code=status_map.get(exc.code, status.HTTP_500_INTERNAL_SERVER_ERROR),
        detail={"error": exc.code, "message": exc.message},
    )


async def _reconcile_loop() -> None:
    global last_reconcile_at
    while True:
        try:
            tenant_ids = {d.name for d in settings.tenant_root.iterdir() if d.is_dir()}
        except Exception:  # noqa: BLE001
            tenant_ids = set()

        try:
            tenant_ids.update(runtime_manager.list_running_tenant_ids())
        except RuntimeErrorManager:
            pass

        for tenant_id in sorted(tenant_ids):
            try:
                running, status_text = runtime_manager.is_running(tenant_id)
            except RuntimeErrorManager:
                continue
            if running:
                await monitor.start(tenant_id)
                await publisher.publish(tenant_id, "runtime.status", {"state": "running", "status": status_text})
            else:
                await publisher.publish(tenant_id, "runtime.status", {"state": "paused", "status": status_text})

        last_reconcile_at = datetime.now(UTC)
        await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global reconcile_task
    await publisher.start()
    reconcile_task = asyncio.create_task(_reconcile_loop())
    try:
        yield
    finally:
        if reconcile_task is not None:
            reconcile_task.cancel()
            with suppress(asyncio.CancelledError):
                await reconcile_task
        await monitor.shutdown()
        await publisher.stop()


app = FastAPI(title="Nexus Runner", version="0.1.0", lifespan=lifespan)


def require_internal_auth(
    tenant_id: str,
    action: str,
    authorization: str | None,
) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "missing_bearer_token", "message": "Missing bearer token"},
        )
    token = authorization.split(" ", 1)[1]
    try:
        verify_internal_token(token, tenant_id=tenant_id, action=action)
    except AuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": exc.code, "message": exc.message},
        ) from exc


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.post("/internal/tenants/{tenant_id}/provision", response_model=GenericResponse)
async def provision_tenant(
    tenant_id: str,
    body: ProvisionRequest,
    authorization: str | None = Header(default=None),
) -> GenericResponse:
    require_internal_auth(tenant_id, "provision", authorization)
    if body.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "tenant_id_mismatch", "message": "tenant_id mismatch"},
        )

    try:
        runtime_manager.validate_tenant_id(tenant_id)
        image = body.nexus_image or settings.nexus_image
        runtime_manager.write_compose(tenant_id=tenant_id, image=image)
        runtime_env = dict(body.runtime_env)
        runtime_env["BRIDGE_SHARED_SECRET"] = body.bridge_shared_secret
        runtime_manager.write_runtime_env(tenant_id=tenant_id, values=runtime_env)
        runtime_manager.write_config_files(tenant_id=tenant_id, env=runtime_env, prompts=[], skills=[])
        runtime_manager.compose_up(tenant_id)
        await monitor.start(tenant_id)
        await publisher.publish(tenant_id, "runtime.status", {"state": "pending_pairing"})
    except RuntimeErrorManager as exc:
        await publisher.publish(tenant_id, "runtime.error", {"error": exc.code, "message": exc.message})
        raise _runtime_http_error(exc) from exc
    return GenericResponse(tenant_id=tenant_id, detail="provisioned")


@app.post("/internal/tenants/{tenant_id}/start", response_model=GenericResponse)
async def start_tenant(tenant_id: str, authorization: str | None = Header(default=None)) -> GenericResponse:
    require_internal_auth(tenant_id, "start", authorization)
    try:
        runtime_manager.compose_start(tenant_id)
        await monitor.start(tenant_id)
        await publisher.publish(tenant_id, "runtime.status", {"state": "running"})
    except RuntimeErrorManager as exc:
        await publisher.publish(tenant_id, "runtime.error", {"error": exc.code, "message": exc.message})
        raise _runtime_http_error(exc) from exc
    return GenericResponse(tenant_id=tenant_id, detail="started")


@app.post("/internal/tenants/{tenant_id}/stop", response_model=GenericResponse)
async def stop_tenant(tenant_id: str, authorization: str | None = Header(default=None)) -> GenericResponse:
    require_internal_auth(tenant_id, "stop", authorization)
    try:
        runtime_manager.compose_stop(tenant_id)
        await publisher.publish(tenant_id, "runtime.status", {"state": "paused"})
    except RuntimeErrorManager as exc:
        await publisher.publish(tenant_id, "runtime.error", {"error": exc.code, "message": exc.message})
        raise _runtime_http_error(exc) from exc
    return GenericResponse(tenant_id=tenant_id, detail="stopped")


@app.post("/internal/tenants/{tenant_id}/restart", response_model=GenericResponse)
async def restart_tenant(tenant_id: str, authorization: str | None = Header(default=None)) -> GenericResponse:
    require_internal_auth(tenant_id, "restart", authorization)
    try:
        runtime_manager.compose_restart(tenant_id)
        await monitor.start(tenant_id)
        await publisher.publish(tenant_id, "runtime.status", {"state": "running"})
    except RuntimeErrorManager as exc:
        await publisher.publish(tenant_id, "runtime.error", {"error": exc.code, "message": exc.message})
        raise _runtime_http_error(exc) from exc
    return GenericResponse(tenant_id=tenant_id, detail="restarted")


@app.post("/internal/tenants/{tenant_id}/pair/start", response_model=GenericResponse)
async def pair_start(tenant_id: str, authorization: str | None = Header(default=None)) -> GenericResponse:
    require_internal_auth(tenant_id, "pair_start", authorization)
    try:
        runtime_manager.compose_start(tenant_id)
        await monitor.start(tenant_id)
        await publisher.publish(tenant_id, "runtime.status", {"state": "pending_pairing"})
    except RuntimeErrorManager as exc:
        await publisher.publish(tenant_id, "runtime.error", {"error": exc.code, "message": exc.message})
        raise _runtime_http_error(exc) from exc
    return GenericResponse(tenant_id=tenant_id, detail="pairing_started")


@app.post("/internal/tenants/{tenant_id}/apply-config", response_model=GenericResponse)
async def apply_config(
    tenant_id: str,
    body: ApplyConfigRequest,
    authorization: str | None = Header(default=None),
) -> GenericResponse:
    require_internal_auth(tenant_id, "apply_config", authorization)
    try:
        runtime_manager.write_runtime_env(tenant_id, body.env)
        runtime_manager.write_config_files(
            tenant_id,
            env=body.env,
            prompts=[item.model_dump() for item in body.prompts],
            skills=[item.model_dump() for item in body.skills],
        )
        runtime_manager.compose_restart(tenant_id)
        await monitor.start(tenant_id)
        await publisher.publish(
            tenant_id,
            "config.applied",
            {"config_revision": body.config_revision},
        )
    except RuntimeErrorManager as exc:
        await publisher.publish(tenant_id, "runtime.error", {"error": exc.code, "message": exc.message})
        raise _runtime_http_error(exc) from exc
    return GenericResponse(tenant_id=tenant_id, detail="config_applied")


@app.post("/internal/tenants/{tenant_id}/whatsapp/disconnect", response_model=GenericResponse)
async def whatsapp_disconnect(tenant_id: str, authorization: str | None = Header(default=None)) -> GenericResponse:
    require_internal_auth(tenant_id, "whatsapp_disconnect", authorization)
    try:
        runtime_manager.clear_session_volume(tenant_id)
        runtime_manager.compose_restart(tenant_id)
        await monitor.start(tenant_id)
        await publisher.publish(tenant_id, "whatsapp.disconnected", {"reason": "disconnect_requested"})
    except RuntimeErrorManager as exc:
        await publisher.publish(tenant_id, "runtime.error", {"error": exc.code, "message": exc.message})
        raise _runtime_http_error(exc) from exc
    return GenericResponse(tenant_id=tenant_id, detail="whatsapp_disconnected")


@app.get("/internal/tenants/{tenant_id}/health", response_model=HealthResponse)
async def tenant_health(tenant_id: str, authorization: str | None = Header(default=None)) -> HealthResponse:
    require_internal_auth(tenant_id, "health", authorization)
    try:
        running, status_text = runtime_manager.is_running(tenant_id)
    except RuntimeErrorManager as exc:
        raise _runtime_http_error(exc) from exc

    docker_ok, docker_status = runtime_manager.docker_available()
    redis_ok = await publisher.is_healthy()
    return HealthResponse(
        tenant_id=tenant_id,
        container_running=running,
        status_text=status_text,
        docker_available=docker_ok,
        docker_status=docker_status,
        redis_available=redis_ok,
        active_monitors=monitor.active_count(),
        last_reconcile_at=last_reconcile_at,
    )


@app.delete("/internal/tenants/{tenant_id}", response_model=GenericResponse)
async def delete_tenant(tenant_id: str, authorization: str | None = Header(default=None)) -> GenericResponse:
    require_internal_auth(tenant_id, "delete", authorization)
    try:
        await monitor.stop(tenant_id)
        runtime_manager.compose_down(tenant_id, remove_volumes=True)
        runtime_manager.delete_tenant_files(tenant_id)
    except RuntimeErrorManager as exc:
        await publisher.publish(tenant_id, "runtime.error", {"error": exc.code, "message": exc.message})
        raise _runtime_http_error(exc) from exc
    return GenericResponse(tenant_id=tenant_id, detail="deleted")
