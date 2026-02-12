from __future__ import annotations

import os

from fastapi.testclient import TestClient
from jose import jwt

os.environ["RUNNER_SHARED_SECRET"] = "test-runner-secret"
os.environ["RUNNER_JWT_ALG"] = "HS256"
os.environ["TENANT_ROOT"] = "/tmp/nexus_runner_test_tenants"
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


def test_runner_auth_rejects_scope_mismatch() -> None:
    wrong_tenant = _token("other123", "start")
    resp_tenant = client.post(
        "/internal/tenants/abc123/start",
        headers={"Authorization": f"Bearer {wrong_tenant}"},
    )
    assert resp_tenant.status_code == 403
    assert resp_tenant.json()["detail"]["error"] == "tenant_scope_mismatch"

    wrong_action = _token("abc123", "stop")
    resp_action = client.post(
        "/internal/tenants/abc123/start",
        headers={"Authorization": f"Bearer {wrong_action}"},
    )
    assert resp_action.status_code == 403
    assert resp_action.json()["detail"]["error"] == "action_scope_mismatch"


def test_runner_requires_bearer_token() -> None:
    resp = client.post("/internal/tenants/abc123/start")
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "missing_bearer_token"


def test_runner_requires_bearer_token_with_optional_body() -> None:
    resp = client.post(
        "/internal/tenants/abc123/start",
        json={"nexus_image": "ghcr.io/test/nexus-runtime:test"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "missing_bearer_token"
