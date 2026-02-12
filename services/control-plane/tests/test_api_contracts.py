from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite:///./test_control_plane_contracts.db"
os.environ["CONTROL_AUTO_CREATE_SCHEMA"] = "true"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import tenants
from app.runner_client import RunnerError


DB_PATH = Path("./test_control_plane_contracts.db")
if DB_PATH.exists():
    DB_PATH.unlink()


class DummyRunner:
    def __init__(self) -> None:
        self.fail_apply_config = False

    async def provision(self, tenant_id: str, payload: dict) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def start(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def stop(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def restart(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def pair_start(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def disconnect(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def apply_config(self, tenant_id: str, payload: dict) -> dict:
        if self.fail_apply_config:
            raise RunnerError("apply failed", status_code=502, code="runner_apply_failed")
        return {"tenant_id": tenant_id, "ok": True}

    async def health(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "container_running": True}


tenants.runner = DummyRunner()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def _signup(client: TestClient, email: str) -> dict:
    resp = client.post("/v1/auth/signup", json={"email": email, "password": "supersecure123"})
    assert resp.status_code == 200
    return resp.json()


def test_control_plane_routes_contract_and_auth(client: TestClient) -> None:
    user = _signup(client, "contracts-a@example.com")
    token = user["tokens"]["access_token"]

    setup = client.post("/v1/tenants/setup", headers={"Authorization": f"Bearer {token}"}, json={})
    assert setup.status_code == 200
    tenant_id = setup.json()["id"]
    setup_status = client.get(f"/v1/tenants/{tenant_id}/status", headers={"Authorization": f"Bearer {token}"})
    assert setup_status.status_code == 200
    assert setup_status.json()["actual_state"] == "pending_pairing"

    assert client.get(f"/v1/tenants/{tenant_id}/status", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert client.post(f"/v1/tenants/{tenant_id}/runtime/start", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert client.post(f"/v1/tenants/{tenant_id}/runtime/stop", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert client.post(f"/v1/tenants/{tenant_id}/runtime/restart", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert (
        client.post(f"/v1/tenants/{tenant_id}/whatsapp/pair/start", headers={"Authorization": f"Bearer {token}"}).status_code
        == 200
    )
    assert (
        client.post(
            f"/v1/tenants/{tenant_id}/whatsapp/disconnect",
            headers={"Authorization": f"Bearer {token}"},
        ).status_code
        == 200
    )

    assert client.get(f"/v1/tenants/{tenant_id}/config", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert (
        client.patch(
            f"/v1/tenants/{tenant_id}/config",
            headers={"Authorization": f"Bearer {token}"},
            json={"values": {"NEXUS_CLI_ENABLED": "false"}},
        ).status_code
        == 200
    )
    assert client.get(f"/v1/tenants/{tenant_id}/prompts", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert (
        client.put(
            f"/v1/tenants/{tenant_id}/prompts/system",
            headers={"Authorization": f"Bearer {token}"},
            json={"content": "You are Nexus."},
        ).status_code
        == 200
    )
    assert client.get(f"/v1/tenants/{tenant_id}/skills", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert (
        client.put(
            f"/v1/tenants/{tenant_id}/skills/default",
            headers={"Authorization": f"Bearer {token}"},
            json={"content": "# Skill"},
        ).status_code
        == 200
    )

    # Protected route must reject missing auth.
    unauthorized = client.get(f"/v1/tenants/{tenant_id}/status")
    assert unauthorized.status_code == 401


def test_cross_tenant_isolation(client: TestClient) -> None:
    user_a = _signup(client, "isolation-a@example.com")
    token_a = user_a["tokens"]["access_token"]
    tenant_a = client.post("/v1/tenants/setup", headers={"Authorization": f"Bearer {token_a}"}, json={}).json()["id"]

    user_b = _signup(client, "isolation-b@example.com")
    token_b = user_b["tokens"]["access_token"]

    denied = client.get(f"/v1/tenants/{tenant_a}/status", headers={"Authorization": f"Bearer {token_b}"})
    assert denied.status_code == 404


def test_config_revision_activation_only_on_successful_apply(client: TestClient) -> None:
    user = _signup(client, "contracts-config@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = client.post("/v1/tenants/setup", headers={"Authorization": f"Bearer {token}"}, json={}).json()["id"]

    tenants.runner.fail_apply_config = True
    try:
        failed = client.patch(
            f"/v1/tenants/{tenant_id}/config",
            headers={"Authorization": f"Bearer {token}"},
            json={"values": {"EXTRA_FLAG": "1"}},
        )
        assert failed.status_code == 502
    finally:
        tenants.runner.fail_apply_config = False

    config = client.get(f"/v1/tenants/{tenant_id}/config", headers={"Authorization": f"Bearer {token}"})
    assert config.status_code == 200
    assert config.json()["revision"] == 1
