from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite:///./test_control_plane_ws.db"
os.environ["CONTROL_AUTO_CREATE_SCHEMA"] = "true"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"
os.environ["NEXUS_IMAGE"] = "ghcr.io/test/nexus-runtime:test"

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import tenants


DB_PATH = Path("./test_control_plane_ws.db")
if DB_PATH.exists():
    DB_PATH.unlink()


class DummyRunner:
    async def provision(self, tenant_id: str, payload: dict) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def start(self, tenant_id: str, payload: dict | None = None) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def stop(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def restart(self, tenant_id: str, payload: dict | None = None) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def pair_start(self, tenant_id: str, payload: dict | None = None) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def disconnect(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def apply_config(self, tenant_id: str, payload: dict) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def health(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "container_running": True}


tenants.runner = DummyRunner()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def _signup_and_setup(client: TestClient) -> tuple[str, str]:
    auth = client.post("/v1/auth/signup", json={"email": "ws@example.com", "password": "supersecure123"}).json()
    token = auth["tokens"]["access_token"]
    setup = client.post(
        "/v1/tenants/setup",
        headers={"Authorization": f"Bearer {token}"},
        json={"initial_config": {"NEXUS_OPENROUTER_API_KEY": "sk-ws-test"}},
    ).json()
    return token, setup["id"]


def test_ws_fanout_and_replay(client: TestClient) -> None:
    token, tenant_id = _signup_and_setup(client)

    asyncio.run(app.state.events.emit(tenant_id, "runtime.status", {"state": "pending_pairing"}))

    with client.websocket_connect(f"/v1/events/ws?token={token}&replay=10") as ws:
        ready = ws.receive_json()
        assert ready["type"] == "ws.ready"

        replayed = ws.receive_json()
        assert replayed["type"] == "runtime.status"
        assert replayed["tenant_id"] == tenant_id
        assert replayed["payload"]["state"] == "pending_pairing"

        asyncio.run(app.state.events.emit(tenant_id, "config.applied", {"revision": 2}))
        live = ws.receive_json()
        if live["type"] == "runtime.status":
            live = ws.receive_json()
        assert live["type"] == "config.applied"
        assert live["payload"]["revision"] == 2
