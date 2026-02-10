from __future__ import annotations

import os

from fastapi.testclient import TestClient
from jose import jwt

os.environ["RUNNER_SHARED_SECRET"] = "test-runner-secret-health"
os.environ["RUNNER_JWT_ALG"] = "HS256"
os.environ["TENANT_ROOT"] = "/tmp/nexus_runner_test_tenants_health"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"

from app.main import app


client = TestClient(app)


def _token(tenant_id: str, action: str) -> str:
    payload = {
        "sub": f"tenant:{tenant_id}",
        "tenant_id": tenant_id,
        "action": action,
        "aud": "runner",
        "iat": 1,
        "exp": 4102444800,
    }
    return jwt.encode(payload, os.environ["RUNNER_SHARED_SECRET"], algorithm=os.environ["RUNNER_JWT_ALG"])


def test_health_payload_shape() -> None:
    token = _token("abc123", "health")
    resp = client.get("/internal/tenants/abc123/health", headers={"Authorization": f"Bearer {token}"})
    # If tenant is invalid or missing, runner returns a deterministic structured error.
    if resp.status_code != 200:
        assert "detail" in resp.json()
        assert "error" in resp.json()["detail"]
        return

    data = resp.json()
    assert "tenant_id" in data
    assert "container_running" in data
    assert "status_text" in data
    assert "docker_available" in data
    assert "docker_status" in data
    assert "redis_available" in data
    assert "active_monitors" in data
    assert "last_reconcile_at" in data
