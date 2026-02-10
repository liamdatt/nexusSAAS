from __future__ import annotations

import asyncio
import contextlib
import json

import websockets

from app.publisher import EventPublisher
from app.runtime_manager import RuntimeManager


class TenantMonitor:
    def __init__(self, publisher: EventPublisher, runtime_manager: RuntimeManager) -> None:
        self.publisher = publisher
        self.runtime_manager = runtime_manager
        self._tasks: dict[str, asyncio.Task] = {}

    def active_count(self) -> int:
        return len([t for t in self._tasks.values() if not t.done()])

    async def start(self, tenant_id: str) -> None:
        if tenant_id in self._tasks and not self._tasks[tenant_id].done():
            return
        self._tasks[tenant_id] = asyncio.create_task(self._run(tenant_id))

    async def stop(self, tenant_id: str) -> None:
        task = self._tasks.get(tenant_id)
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        self._tasks.pop(tenant_id, None)

    async def shutdown(self) -> None:
        for tenant_id in list(self._tasks.keys()):
            await self.stop(tenant_id)

    async def _run(self, tenant_id: str) -> None:
        ws_url = self.runtime_manager.bridge_ws_url(tenant_id)
        backoff_seconds = 1.0
        while True:
            try:
                async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20) as ws:
                    backoff_seconds = 1.0
                    await self.publisher.publish(tenant_id, "runtime.status", {"state": "pending_pairing"})
                    async for raw in ws:
                        await self._handle_message(tenant_id, raw)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                await self.publisher.publish(
                    tenant_id,
                    "runtime.error",
                    {"message": f"bridge_monitor_error: {exc}", "retry_in_seconds": backoff_seconds},
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2.0, 30.0)

    async def _handle_message(self, tenant_id: str, raw: str) -> None:
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError:
            await self.publisher.publish(tenant_id, "runtime.log", {"raw": raw})
            return

        event = envelope.get("event")
        payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}

        if event == "bridge.qr":
            await self.publisher.publish(tenant_id, "whatsapp.qr", payload)
        elif event == "bridge.connected":
            await self.publisher.publish(tenant_id, "whatsapp.connected", payload)
            await self.publisher.publish(tenant_id, "runtime.status", {"state": "running"})
        elif event == "bridge.disconnected":
            await self.publisher.publish(tenant_id, "whatsapp.disconnected", payload)
            await self.publisher.publish(tenant_id, "runtime.status", {"state": "pending_pairing"})
        elif event in {"bridge.inbound_message", "bridge.delivery_receipt"}:
            # Compatibility with runtimes that don't emit bridge.connected explicitly.
            await self.publisher.publish(tenant_id, "whatsapp.connected", {"source_event": event})
            await self.publisher.publish(tenant_id, "runtime.status", {"state": "running"})
        elif event == "bridge.error":
            await self.publisher.publish(tenant_id, "runtime.error", payload)
        elif event == "bridge.ready":
            await self.publisher.publish(tenant_id, "runtime.status", {"state": "pending_pairing"})
        else:
            await self.publisher.publish(tenant_id, "runtime.log", {"bridge_event": event, "payload": payload})
