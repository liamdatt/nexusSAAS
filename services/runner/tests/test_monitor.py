from __future__ import annotations

import asyncio

from app.monitor import TenantMonitor


class DummyPublisher:
    def __init__(self) -> None:
        self.items: list[tuple[str, str, dict]] = []

    async def publish(self, tenant_id: str, event_type: str, payload: dict) -> None:
        self.items.append((tenant_id, event_type, payload))


class DummyRuntimeManager:
    def bridge_ws_url(self, tenant_id: str) -> str:
        return f"ws://tenant_{tenant_id}_runtime:8765"


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
