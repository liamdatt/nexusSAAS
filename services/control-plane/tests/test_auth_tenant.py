from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

os.environ["DATABASE_URL"] = "sqlite:///./test_control_plane.db"
os.environ["CONTROL_AUTO_CREATE_SCHEMA"] = "true"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"
if os.path.exists("./test_control_plane.db"):
    os.remove("./test_control_plane.db")

from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def test_signup_and_setup_is_idempotent(client: TestClient) -> None:
    signup_resp = client.post(
        "/v1/auth/signup",
        json={"email": "user@example.com", "password": "supersecure123"},
    )
    assert signup_resp.status_code == 200
    access = signup_resp.json()["tokens"]["access_token"]

    setup_1 = client.post("/v1/tenants/setup", headers={"Authorization": f"Bearer {access}"}, json={})
    # Runner is absent in unit tests so setup can return 200 with status=error after failed provision.
    assert setup_1.status_code == 200
    tenant_id_1 = setup_1.json()["id"]

    setup_2 = client.post("/v1/tenants/setup", headers={"Authorization": f"Bearer {access}"}, json={})
    assert setup_2.status_code == 200
    assert setup_2.json()["id"] == tenant_id_1


def test_rapid_repeated_setup_calls_return_same_tenant(client: TestClient) -> None:
    signup_resp = client.post(
        "/v1/auth/signup",
        json={"email": "user-repeat@example.com", "password": "supersecure123"},
    )
    assert signup_resp.status_code == 200
    access = signup_resp.json()["tokens"]["access_token"]

    tenant_id: str | None = None
    for _ in range(10):
        setup_resp = client.post("/v1/tenants/setup", headers={"Authorization": f"Bearer {access}"}, json={})
        assert setup_resp.status_code == 200
        body = setup_resp.json()
        if tenant_id is None:
            tenant_id = body["id"]
        assert body["id"] == tenant_id
