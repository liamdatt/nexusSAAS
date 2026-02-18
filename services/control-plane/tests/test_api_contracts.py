from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import parse_qs, urlparse

os.environ["DATABASE_URL"] = "sqlite:///./test_control_plane_contracts.db"
os.environ["CONTROL_AUTO_CREATE_SCHEMA"] = "true"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"
os.environ["NEXUS_IMAGE"] = "ghcr.io/test/nexus-runtime:test"
os.environ["GOOGLE_OAUTH_CLIENT_ID"] = "google-client-id-test"
os.environ["GOOGLE_OAUTH_CLIENT_SECRET"] = "google-client-secret-test"
os.environ["GOOGLE_OAUTH_REDIRECT_URI"] = "http://testserver/v1/oauth/google/callback"
os.environ["GOOGLE_OAUTH_ALLOWED_ORIGINS"] = "http://testserver"

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import tenants
from app.runner_client import RunnerError
from app.security import create_google_oauth_state


DB_PATH = Path("./test_control_plane_contracts.db")
if DB_PATH.exists():
    DB_PATH.unlink()


class DummyRunner:
    def __init__(self) -> None:
        self.fail_apply_config = False
        self.provision_payloads: list[dict] = []
        self.apply_config_payloads: list[dict] = []
        self.start_payloads: list[dict | None] = []
        self.restart_payloads: list[dict | None] = []
        self.pair_start_payloads: list[dict | None] = []
        self.google_connect_payloads: list[dict] = []
        self.google_disconnect_calls: list[str] = []

    async def provision(self, tenant_id: str, payload: dict) -> dict:
        self.provision_payloads.append(payload)
        return {"tenant_id": tenant_id, "ok": True}

    async def start(self, tenant_id: str, payload: dict | None = None) -> dict:
        self.start_payloads.append(payload)
        return {"tenant_id": tenant_id, "ok": True}

    async def stop(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def restart(self, tenant_id: str, payload: dict | None = None) -> dict:
        self.restart_payloads.append(payload)
        return {"tenant_id": tenant_id, "ok": True}

    async def pair_start(self, tenant_id: str, payload: dict | None = None) -> dict:
        self.pair_start_payloads.append(payload)
        return {"tenant_id": tenant_id, "ok": True}

    async def disconnect(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "ok": True}

    async def apply_config(self, tenant_id: str, payload: dict) -> dict:
        if self.fail_apply_config:
            raise RunnerError("apply failed", status_code=502, code="runner_apply_failed")
        self.apply_config_payloads.append(payload)
        return {"tenant_id": tenant_id, "ok": True}

    async def google_connect(self, tenant_id: str, payload: dict) -> dict:
        self.google_connect_payloads.append(payload)
        return {"tenant_id": tenant_id, "ok": True}

    async def google_disconnect(self, tenant_id: str) -> dict:
        self.google_disconnect_calls.append(tenant_id)
        return {"tenant_id": tenant_id, "ok": True}

    async def health(self, tenant_id: str) -> dict:
        return {"tenant_id": tenant_id, "container_running": True}


tenants.runner = DummyRunner()


@pytest.fixture
def client() -> Iterator[TestClient]:
    tenants.runner = DummyRunner()
    tenants.runner.fail_apply_config = False
    tenants.runner.provision_payloads.clear()
    tenants.runner.apply_config_payloads.clear()
    tenants.runner.start_payloads.clear()
    tenants.runner.restart_payloads.clear()
    tenants.runner.pair_start_payloads.clear()
    tenants.runner.google_connect_payloads.clear()
    tenants.runner.google_disconnect_calls.clear()
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
    assert tenants.runner.start_payloads[-1] == {"nexus_image": os.environ["NEXUS_IMAGE"]}
    assert tenants.runner.restart_payloads[-1] == {"nexus_image": os.environ["NEXUS_IMAGE"]}
    assert tenants.runner.pair_start_payloads[-1] == {"nexus_image": os.environ["NEXUS_IMAGE"]}

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


def test_setup_seeds_prompt_and_skill_defaults(client: TestClient) -> None:
    user = _signup(client, "contracts-defaults@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    prompts_resp = client.get(f"/v1/tenants/{tenant_id}/prompts", headers={"Authorization": f"Bearer {token}"})
    assert prompts_resp.status_code == 200
    prompts = prompts_resp.json()
    prompt_names = {item["name"] for item in prompts}
    assert {"system", "SOUL", "IDENTITY", "AGENTS"}.issubset(prompt_names)
    identity = next(item for item in prompts if item["name"] == "IDENTITY")
    assert "FloPro Limited" in identity["content"]

    skills_resp = client.get(f"/v1/tenants/{tenant_id}/skills", headers={"Authorization": f"Bearer {token}"})
    assert skills_resp.status_code == 200
    skills = skills_resp.json()
    seeded_skill_ids = {item["skill_id"] for item in skills}
    assert {"google_workspace", "xlsx_professional", "pdf_professional", "images_openrouter"}.issubset(
        seeded_skill_ids
    )

    provision_payload = tenants.runner.provision_payloads[-1]
    assert any(item["name"] == "SOUL" for item in provision_payload["prompts"])
    assert any(item["skill_id"] == "google_workspace" for item in provision_payload["skills"])


def test_assistant_bootstrap_idempotent_when_defaults_present(client: TestClient) -> None:
    user = _signup(client, "contracts-bootstrap-idempotent@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    resp = client.post(
        f"/v1/tenants/{tenant_id}/assistant/bootstrap",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["tenant_id"] == tenant_id
    assert body["applied"] is False
    assert body["restarted_runtime"] is False
    assert body["reason"] == "already_bootstrapped"


def test_assistant_bootstrap_replaces_scaffold_prompt_and_skill(client: TestClient) -> None:
    user = _signup(client, "contracts-bootstrap-apply@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    soul_scaffold = client.put(
        f"/v1/tenants/{tenant_id}/prompts/SOUL",
        headers={"Authorization": f"Bearer {token}"},
        json={"content": "# Soul\n"},
    )
    assert soul_scaffold.status_code == 200
    skill_scaffold = client.put(
        f"/v1/tenants/{tenant_id}/skills/google_workspace",
        headers={"Authorization": f"Bearer {token}"},
        json={"content": "# Skill\nDescribe behavior."},
    )
    assert skill_scaffold.status_code == 200

    tenants.runner.apply_config_payloads.clear()
    resp = client.post(
        f"/v1/tenants/{tenant_id}/assistant/bootstrap",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["applied"] is True
    assert body["restarted_runtime"] is True
    assert body["reason"] == "applied_defaults"

    prompts_resp = client.get(f"/v1/tenants/{tenant_id}/prompts", headers={"Authorization": f"Bearer {token}"})
    assert prompts_resp.status_code == 200
    soul = next(item for item in prompts_resp.json() if item["name"] == "SOUL")
    assert "personal assistant" in soul["content"].lower()

    skills_resp = client.get(f"/v1/tenants/{tenant_id}/skills", headers={"Authorization": f"Bearer {token}"})
    assert skills_resp.status_code == 200
    google_skill = next(item for item in skills_resp.json() if item["skill_id"] == "google_workspace")
    assert "google workspace skill" in google_skill["content"].lower()
    assert len(tenants.runner.apply_config_payloads) == 1


def test_assistant_bootstrap_overwrites_managed_skills_on_version_bump(client: TestClient, monkeypatch) -> None:
    user = _signup(client, "contracts-bootstrap-versioned-managed@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    custom = client.put(
        f"/v1/tenants/{tenant_id}/skills/google_workspace",
        headers={"Authorization": f"Bearer {token}"},
        json={"content": "# Google Workspace Skill\\nCustom tenant override"},
    )
    assert custom.status_code == 200

    tenants.runner.apply_config_payloads.clear()
    monkeypatch.setattr(tenants, "ASSISTANT_DEFAULTS_VERSION", "2099-01-01-managed-refresh")

    resp = client.post(
        f"/v1/tenants/{tenant_id}/assistant/bootstrap",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["applied"] is True
    assert body["reason"] == "applied_defaults"

    skills_resp = client.get(f"/v1/tenants/{tenant_id}/skills", headers={"Authorization": f"Bearer {token}"})
    assert skills_resp.status_code == 200
    google_skill = next(item for item in skills_resp.json() if item["skill_id"] == "google_workspace")
    assert "custom tenant override" not in google_skill["content"].lower()
    assert "google workspace skill" in google_skill["content"].lower()
    assert len(tenants.runner.apply_config_payloads) == 1


def test_cross_tenant_isolation(client: TestClient) -> None:
    user_a = _signup(client, "isolation-a@example.com")
    token_a = user_a["tokens"]["access_token"]
    tenant_a = _setup_tenant(client, token_a)

    user_b = _signup(client, "isolation-b@example.com")
    token_b = user_b["tokens"]["access_token"]

    denied = client.get(f"/v1/tenants/{tenant_a}/status", headers={"Authorization": f"Bearer {token_b}"})
    assert denied.status_code == 404


def test_disconnect_immediately_projects_pending_pairing_status(client: TestClient) -> None:
    user = _signup(client, "contracts-disconnect-status@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    start = client.post(f"/v1/tenants/{tenant_id}/runtime/start", headers={"Authorization": f"Bearer {token}"})
    assert start.status_code == 200

    disconnect = client.post(
        f"/v1/tenants/{tenant_id}/whatsapp/disconnect",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert disconnect.status_code == 200

    status_resp = client.get(f"/v1/tenants/{tenant_id}/status", headers={"Authorization": f"Bearer {token}"})
    assert status_resp.status_code == 200
    assert status_resp.json()["actual_state"] == "pending_pairing"


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


def test_setup_rejects_invalid_nexus_image_config(client: TestClient) -> None:
    original_image = app.state.settings.nexus_image
    app.state.settings.nexus_image = "ghcr.io/your-org/nexus-runtime:sha-REPLACE_WITH_COMMIT"
    try:
        user = _signup(client, "contracts-invalid-image-setup@example.com")
        token = user["tokens"]["access_token"]
        setup = client.post(
            "/v1/tenants/setup",
            headers={"Authorization": f"Bearer {token}"},
            json={"initial_config": {"NEXUS_OPENROUTER_API_KEY": "sk-contract-test"}},
        )
        assert setup.status_code == 400
        assert setup.json()["detail"]["error"] == "nexus_image_invalid"
    finally:
        app.state.settings.nexus_image = original_image


def test_runtime_start_rejects_invalid_nexus_image_config(client: TestClient) -> None:
    user = _signup(client, "contracts-invalid-image-start@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    original_image = app.state.settings.nexus_image
    app.state.settings.nexus_image = "ghcr.io/your-org/nexus-runtime:sha-REPLACE_WITH_COMMIT"
    try:
        start_resp = client.post(
            f"/v1/tenants/{tenant_id}/runtime/start",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert start_resp.status_code == 400
        assert start_resp.json()["detail"]["error"] == "nexus_image_invalid"
    finally:
        app.state.settings.nexus_image = original_image


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


def test_recent_events_endpoint_filters_and_scopes(client: TestClient) -> None:
    user_a = _signup(client, "contracts-events-a@example.com")
    token_a = user_a["tokens"]["access_token"]
    tenant_a = _setup_tenant(client, token_a)

    user_b = _signup(client, "contracts-events-b@example.com")
    token_b = user_b["tokens"]["access_token"]
    tenant_b = _setup_tenant(client, token_b)

    asyncio.run(app.state.events.emit(tenant_a, "runtime.status", {"state": "pending_pairing"}))
    asyncio.run(app.state.events.emit(tenant_a, "whatsapp.qr", {"qr": "qr-a"}))
    asyncio.run(app.state.events.emit(tenant_b, "whatsapp.qr", {"qr": "qr-b"}))

    recent = client.get(
        f"/v1/tenants/{tenant_a}/events/recent?limit=10&types=whatsapp.qr",
        headers={"Authorization": f"Bearer {token_a}"},
    )
    assert recent.status_code == 200
    rows = recent.json()
    assert len(rows) >= 1
    assert all(row["tenant_id"] == tenant_a for row in rows)
    assert all(row["type"] == "whatsapp.qr" for row in rows)
    latest_event_id = rows[0]["event_id"]

    after = client.get(
        f"/v1/tenants/{tenant_a}/events/recent?after_event_id={latest_event_id}&types=whatsapp.qr",
        headers={"Authorization": f"Bearer {token_a}"},
    )
    assert after.status_code == 200
    assert after.json() == []

    denied = client.get(
        f"/v1/tenants/{tenant_a}/events/recent",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert denied.status_code == 404


def test_google_connect_start_returns_auth_url(client: TestClient) -> None:
    user = _signup(client, "contracts-google-start@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)

    resp = client.post(
        f"/v1/tenants/{tenant_id}/google/connect/start",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["tenant_id"] == tenant_id
    assert body["expires_in_seconds"] > 0
    assert "https://accounts.google.com/o/oauth2/v2/auth" in body["auth_url"]
    assert "state=" in body["auth_url"]
    scope = parse_qs(urlparse(body["auth_url"]).query).get("scope", [""])[0].split()
    assert "https://www.googleapis.com/auth/documents" in scope
    assert "https://www.googleapis.com/auth/drive.file" in scope
    assert "https://www.googleapis.com/auth/documents.readonly" not in scope


def test_google_callback_persists_token_and_syncs_runner(client: TestClient, monkeypatch) -> None:
    user = _signup(client, "contracts-google-callback@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)
    user_id = int(user["user"]["id"])
    state_token, _ttl = create_google_oauth_state(user_id=user_id, tenant_id=tenant_id, origin="http://testserver")

    async def _fake_exchange(**kwargs) -> dict:
        assert kwargs["code"] == "auth-code"
        return {
            "access_token": "ya29.test-access",
            "refresh_token": "1//test-refresh",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events",
        }

    monkeypatch.setattr(tenants, "exchange_code_for_tokens", _fake_exchange)

    callback = client.get("/v1/oauth/google/callback", params={"code": "auth-code", "state": state_token})
    assert callback.status_code == 200
    assert "google.oauth.result" in callback.text

    status_resp = client.get(f"/v1/tenants/{tenant_id}/google/status", headers={"Authorization": f"Bearer {token}"})
    assert status_resp.status_code == 200
    status_body = status_resp.json()
    assert status_body["connected"] is True
    assert "https://www.googleapis.com/auth/gmail.modify" in status_body["scopes"]

    assert len(tenants.runner.google_connect_payloads) >= 1
    token_json = tenants.runner.google_connect_payloads[-1]["token_json"]
    assert token_json["token"] == "ya29.test-access"
    assert token_json["refresh_token"] == "1//test-refresh"


def test_google_disconnect_clears_status_and_calls_runner(client: TestClient, monkeypatch) -> None:
    user = _signup(client, "contracts-google-disconnect@example.com")
    token = user["tokens"]["access_token"]
    tenant_id = _setup_tenant(client, token)
    user_id = int(user["user"]["id"])
    state_token, _ttl = create_google_oauth_state(user_id=user_id, tenant_id=tenant_id, origin="http://testserver")

    async def _fake_exchange(**kwargs) -> dict:
        del kwargs
        return {
            "access_token": "ya29.test-access",
            "refresh_token": "1//test-refresh",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events",
        }

    monkeypatch.setattr(tenants, "exchange_code_for_tokens", _fake_exchange)
    callback = client.get("/v1/oauth/google/callback", params={"code": "auth-code", "state": state_token})
    assert callback.status_code == 200

    resp = client.post(f"/v1/tenants/{tenant_id}/google/disconnect", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["operation"] == "google_disconnect"
    assert tenant_id in tenants.runner.google_disconnect_calls

    status_resp = client.get(f"/v1/tenants/{tenant_id}/google/status", headers={"Authorization": f"Bearer {token}"})
    assert status_resp.status_code == 200
    assert status_resp.json()["connected"] is False


def test_google_endpoints_enforce_tenant_ownership(client: TestClient) -> None:
    user_a = _signup(client, "contracts-google-owner-a@example.com")
    token_a = user_a["tokens"]["access_token"]
    tenant_a = _setup_tenant(client, token_a)

    user_b = _signup(client, "contracts-google-owner-b@example.com")
    token_b = user_b["tokens"]["access_token"]

    denied_status = client.get(f"/v1/tenants/{tenant_a}/google/status", headers={"Authorization": f"Bearer {token_b}"})
    denied_connect = client.post(
        f"/v1/tenants/{tenant_a}/google/connect/start",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    denied_disconnect = client.post(
        f"/v1/tenants/{tenant_a}/google/disconnect",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert denied_status.status_code == 404
    assert denied_connect.status_code == 404
    assert denied_disconnect.status_code == 404
