from __future__ import annotations

import os

os.environ["DATABASE_URL"] = "sqlite:///./test_control_plane.db"
os.environ["CONTROL_AUTO_CREATE_SCHEMA"] = "true"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"
if os.path.exists("./test_control_plane.db"):
    os.remove("./test_control_plane.db")

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_signup_and_one_tenant_limit() -> None:
    signup_resp = client.post(
        "/v1/auth/signup",
        json={"email": "user@example.com", "password": "supersecure123"},
    )
    assert signup_resp.status_code == 200
    access = signup_resp.json()["tokens"]["access_token"]

    setup_1 = client.post("/v1/tenants/setup", headers={"Authorization": f"Bearer {access}"}, json={})
    # Runner is absent in unit tests so setup can return 200 with status=error after failed provision.
    assert setup_1.status_code == 200

    setup_2 = client.post("/v1/tenants/setup", headers={"Authorization": f"Bearer {access}"}, json={})
    assert setup_2.status_code == 409
