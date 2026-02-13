from __future__ import annotations

import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from jose import jwt

os.environ["RUNNER_SHARED_SECRET"] = "test-runner-secret"
os.environ["RUNNER_JWT_ALG"] = "HS256"
os.environ["TENANT_ROOT"] = "/tmp/nexus_runner_test_tenants_lifecycle"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"

from app import main


class DummyPublisher:
    def __init__(self) -> None:
        self.items: list[tuple[str, str, dict]] = []

    async def publish(self, tenant_id: str, event_type: str, payload: dict) -> None:
        self.items.append((tenant_id, event_type, payload))


class DummyRuntimeManager:
    def list_running_tenant_ids(self) -> list[str]:
        return ["running1"]

    def is_running(self, tenant_id: str) -> tuple[bool, str]:
        if tenant_id == "running1":
            return True, "Up 1m"
        return False, "Exited"


class DummyMonitor:
    def __init__(self) -> None:
        self.started: list[str] = []
        self.stopped: list[str] = []
        self._monitored: set[str] = {"running1", "stale1"}

    async def start(self, tenant_id: str) -> None:
        self.started.append(tenant_id)
        self._monitored.add(tenant_id)

    async def stop(self, tenant_id: str) -> None:
        self.stopped.append(tenant_id)
        self._monitored.discard(tenant_id)

    def monitored_tenant_ids(self) -> set[str]:
        return set(self._monitored)


def _token(tenant_id: str, action: str) -> str:
    payload = {
        "sub": f"tenant:{tenant_id}",
        "tenant_id": tenant_id,
        "action": action,
        "aud": "runner",
        "iat": 1,
        "exp": 4102444800,
    }
    return jwt.encode(payload, main.settings.runner_shared_secret, algorithm=main.settings.runner_jwt_alg)


def test_reconcile_stops_stale_monitors(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "running1").mkdir(parents=True, exist_ok=True)
    (tmp_path / "paused1").mkdir(parents=True, exist_ok=True)

    monitor = DummyMonitor()
    publisher = DummyPublisher()
    runtime_manager = DummyRuntimeManager()

    monkeypatch.setattr(main, "monitor", monitor)
    monkeypatch.setattr(main, "publisher", publisher)
    monkeypatch.setattr(main, "runtime_manager", runtime_manager)
    monkeypatch.setattr(main.settings, "tenant_root", tmp_path)

    async def _fake_sleep(seconds: float) -> None:
        del seconds
        raise asyncio.CancelledError()

    monkeypatch.setattr(main.asyncio, "sleep", _fake_sleep)

    try:
        asyncio.run(main._reconcile_loop())
        assert False, "expected loop cancellation after first reconcile cycle"
    except asyncio.CancelledError:
        pass

    assert monitor.started == ["running1"]
    assert monitor.stopped == ["stale1"]
    assert ("running1", "runtime.status", {"state": "running", "status": "Up 1m"}) in publisher.items
    assert ("paused1", "runtime.status", {"state": "paused", "status": "Exited"}) in publisher.items


def test_stop_endpoint_stops_monitor_before_publishing_status(monkeypatch) -> None:
    monitor_stop = AsyncMock()
    compose_stop = Mock()
    publish = AsyncMock()

    monkeypatch.setattr(main.monitor, "stop", monitor_stop)
    monkeypatch.setattr(main.runtime_manager, "compose_stop", compose_stop)
    monkeypatch.setattr(main.publisher, "publish", publish)

    token = _token("abc123", "stop")
    result = asyncio.run(main.stop_tenant("abc123", authorization=f"Bearer {token}"))

    assert result.detail == "stopped"
    monitor_stop.assert_awaited_once_with("abc123")
    compose_stop.assert_called_once_with("abc123")
    publish.assert_awaited_once_with("abc123", "runtime.status", {"state": "paused"})
