from __future__ import annotations

import asyncio
import contextlib
from unittest.mock import patch

from app.monitor import TenantMonitor


class DummyPublisher:
    def __init__(self) -> None:
        self.items: list[tuple[str, str, dict]] = []

    async def publish(self, tenant_id: str, event_type: str, payload: dict) -> None:
        self.items.append((tenant_id, event_type, payload))


class DummyRuntimeManager:
    def bridge_ws_url(self, tenant_id: str) -> str:
        return f"ws://tenant_{tenant_id}_runtime:8765"

    def bridge_ws_headers(self, tenant_id: str) -> dict[str, str] | None:
        del tenant_id
        return None


def _events(publisher: DummyPublisher) -> list[str]:
    return [item[1] for item in publisher.items]


def test_monitor_maps_bridge_qr_event() -> None:
    publisher = DummyPublisher()
    monitor = TenantMonitor(publisher, DummyRuntimeManager())

    asyncio.run(monitor._handle_message("abc123", '{"event":"bridge.qr","payload":{"qr":"x"}}'))
    assert _events(publisher) == ["whatsapp.qr"]
    assert publisher.items[0][2]["qr"] == "x"


def test_monitor_accepts_type_alias_for_qr() -> None:
    publisher = DummyPublisher()
    monitor = TenantMonitor(publisher, DummyRuntimeManager())

    asyncio.run(monitor._handle_message("abc123", '{"type":"whatsapp.qr","payload":{"qr":"y"}}'))
    assert _events(publisher) == ["whatsapp.qr"]
    assert publisher.items[0][2]["qr"] == "y"


def test_monitor_handles_qr_suffix_event_name() -> None:
    publisher = DummyPublisher()
    monitor = TenantMonitor(publisher, DummyRuntimeManager())

    asyncio.run(monitor._handle_message("abc123", '{"event":"bridge.qrcode","qr":"z"}'))
    assert _events(publisher) == ["whatsapp.qr"]
    assert publisher.items[0][2]["qr"] == "z"


def test_monitor_non_json_becomes_runtime_log() -> None:
    publisher = DummyPublisher()
    monitor = TenantMonitor(publisher, DummyRuntimeManager())

    asyncio.run(monitor._handle_message("abc123", "not-json"))
    assert _events(publisher) == ["runtime.log"]
    assert publisher.items[0][2]["raw"] == "not-json"


def test_monitor_inbound_message_marks_connected() -> None:
    publisher = DummyPublisher()
    monitor = TenantMonitor(publisher, DummyRuntimeManager())

    asyncio.run(monitor._handle_message("abc123", '{"event":"bridge.inbound_message","payload":{"id":"m1"}}'))
    assert _events(publisher) == ["whatsapp.connected", "runtime.status"]
    assert publisher.items[1][2]["state"] == "running"


def test_monitor_connects_with_bridge_secret_header() -> None:
    publisher = DummyPublisher()

    class SecretRuntimeManager(DummyRuntimeManager):
        def bridge_ws_headers(self, tenant_id: str) -> dict[str, str] | None:
            del tenant_id
            return {"x-nexus-secret": "bridge-secret"}

    monitor = TenantMonitor(publisher, SecretRuntimeManager())

    class _HangingWS:
        def __aiter__(self):
            return self

        async def __anext__(self):
            await asyncio.sleep(3600)
            raise StopAsyncIteration

    class _ConnectCtx:
        async def __aenter__(self):
            return _HangingWS()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    async def _exercise() -> dict | None:
        captured: dict | None = None

        def _fake_connect(url: str, **kwargs):
            del url
            nonlocal captured
            captured = kwargs.get("additional_headers")
            return _ConnectCtx()

        with patch("app.monitor.websockets.connect", side_effect=_fake_connect):
            task = asyncio.create_task(monitor._run("abc123"))
            await asyncio.sleep(0.05)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        return captured

    headers = asyncio.run(_exercise())
    assert headers == {"x-nexus-secret": "bridge-secret"}


def test_monitor_rate_limits_transient_startup_errors() -> None:
    publisher = DummyPublisher()
    monitor = TenantMonitor(publisher, DummyRuntimeManager())

    current_time = 0.0
    sleep_calls = 0

    def _fake_monotonic() -> float:
        nonlocal current_time
        current_time += 1.0
        return current_time

    async def _fake_sleep(seconds: float) -> None:
        nonlocal sleep_calls, current_time
        sleep_calls += 1
        current_time += seconds
        if sleep_calls >= 6:
            raise asyncio.CancelledError()

    with (
        patch("app.monitor.websockets.connect", side_effect=OSError(-2, "Name or service not known")),
        patch("app.monitor.monotonic", side_effect=_fake_monotonic),
        patch("app.monitor.asyncio.sleep", side_effect=_fake_sleep),
    ):
        try:
            asyncio.run(monitor._run("abc123"))
            assert False, "expected monitor loop cancellation"
        except asyncio.CancelledError:
            pass

    runtime_errors = [item for item in publisher.items if item[1] == "runtime.error"]
    assert 1 <= len(runtime_errors) <= 2
