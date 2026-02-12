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


def _setup_tenant(client: TestClient, token: str) -> str:
    resp = client.post(
        "/v1/tenants/setup",
        headers={"Authorization": f"Bearer {token}"},
        json={"initial_config": {"NEXUS_OPENROUTER_API_KEY": "sk-contract-test"}},
    )
    assert resp.status_code == 200
    return resp.json()["id"]


def test_control_plane_routes_contract_and_auth(client: TestClient) -> None:
    user = _signup(client, "contracts-a@example.com")
    token = user["tokens"]["access_token"]

    tenant_id = _setup_tenant(client, token)
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
    tenant_a = _setup_tenant(client, token_a)

    user_b = _signup(client, "isolation-b@example.com")
    token_b = user_b["tokens"]["access_token"]

    denied = client.get(f"/v1/tenants/{tenant_a}/status", headers={"Authorization": f"Bearer {token_b}"})
    assert denied.status_code == 404


def test_config_revision_activation_only_on_successful_apply(client: TestClient) -> None:
    user = _signup(client, "contracts-config@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

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


def test_start_restart_pair_require_openrouter_api_key(client: TestClient) -> None:
    user = _signup(client, "contracts-openrouter@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    remove_key = client.patch(
        f"/v1/tenants/{tenant_id}/config",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"NEXUS_OPENROUTER_API_KEY": ""}},
    )
    assert remove_key.status_code == 200

    start_resp = client.post(f"/v1/tenants/{tenant_id}/runtime/start", headers={"Authorization": f"Bearer {token}"})
    restart_resp = client.post(
        f"/v1/tenants/{tenant_id}/runtime/restart",
        headers={"Authorization": f"Bearer {token}"},
    )
    pair_resp = client.post(
        f"/v1/tenants/{tenant_id}/whatsapp/pair/start",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert start_resp.status_code == 400
    assert restart_resp.status_code == 400
    assert pair_resp.status_code == 400
    assert start_resp.json()["detail"]["error"] == "openrouter_api_key_required"
    assert restart_resp.json()["detail"]["error"] == "openrouter_api_key_required"
    assert pair_resp.json()["detail"]["error"] == "openrouter_api_key_required"


def test_config_patch_values_persist(client: TestClient) -> None:
    user = _signup(client, "contracts-values@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    update_resp = client.patch(
        f"/v1/tenants/{tenant_id}/config",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"EXTRA_FLAG": "enabled"}},
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["revision"] == 2
    assert update_resp.json()["env_json"]["EXTRA_FLAG"] == "enabled"

    config = client.get(f"/v1/tenants/{tenant_id}/config", headers={"Authorization": f"Bearer {token}"})
    assert config.status_code == 200
    assert config.json()["revision"] == 2
    assert config.json()["env_json"]["EXTRA_FLAG"] == "enabled"


def test_config_patch_remove_keys_deletes_values(client: TestClient) -> None:
    user = _signup(client, "contracts-remove@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    add_resp = client.patch(
        f"/v1/tenants/{tenant_id}/config",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"TEMP_DELETE": "1"}},
    )
    assert add_resp.status_code == 200
    assert add_resp.json()["env_json"]["TEMP_DELETE"] == "1"

    remove_resp = client.patch(
        f"/v1/tenants/{tenant_id}/config",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {}, "remove_keys": ["TEMP_DELETE"]},
    )
    assert remove_resp.status_code == 200
    assert "TEMP_DELETE" not in remove_resp.json()["env_json"]

    config = client.get(f"/v1/tenants/{tenant_id}/config", headers={"Authorization": f"Bearer {token}"})
    assert config.status_code == 200
    assert "TEMP_DELETE" not in config.json()["env_json"]


def test_config_patch_noop_keeps_revision(client: TestClient) -> None:
    user = _signup(client, "contracts-noop@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    before = client.get(f"/v1/tenants/{tenant_id}/config", headers={"Authorization": f"Bearer {token}"})
    assert before.status_code == 200
    before_revision = before.json()["revision"]

    noop = client.patch(
        f"/v1/tenants/{tenant_id}/config",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {}, "remove_keys": []},
    )
    assert noop.status_code == 200
    assert noop.json()["revision"] == before_revision

    after = client.get(f"/v1/tenants/{tenant_id}/config", headers={"Authorization": f"Bearer {token}"})
    assert after.status_code == 200
    assert after.json()["revision"] == before_revision
