from __future__ import annotations

import asyncio
import contextlib
import json
import logging

import websockets

from app.publisher import EventPublisher
from app.runtime_manager import RuntimeManager

logger = logging.getLogger(__name__)


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
                logger.warning("bridge monitor error tenant_id=%s ws_url=%s err=%s", tenant_id, ws_url, exc)
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

        event = self._normalized_event(envelope)
        payload = envelope.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        if not payload and "data" in envelope and isinstance(envelope.get("data"), dict):
            payload = envelope["data"]

        if event == "bridge.qr":
            qr_payload = payload or self._extract_qr_payload(envelope)
            await self.publisher.publish(tenant_id, "whatsapp.qr", qr_payload)
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
            if event and "qr" in event:
                qr_payload = payload or self._extract_qr_payload(envelope)
                if qr_payload:
                    await self.publisher.publish(tenant_id, "whatsapp.qr", qr_payload)
                    return
            await self.publisher.publish(
                tenant_id,
                "runtime.log",
                {"bridge_event": event, "payload": payload, "raw_envelope": envelope},
            )

    def _normalized_event(self, envelope: dict) -> str | None:
        raw_event = envelope.get("event") or envelope.get("type") or envelope.get("name")
        if not isinstance(raw_event, str):
            return None
        token = raw_event.strip().lower().replace(":", ".").replace("_", ".")
        aliases = {
            "whatsapp.qr": "bridge.qr",
            "bridge.qrcode": "bridge.qr",
            "bridge.qr.code": "bridge.qr",
            "bridge.ready.state": "bridge.ready",
            "bridge.inbound.message": "bridge.inbound_message",
            "bridge.delivery.receipt": "bridge.delivery_receipt",
        }
        return aliases.get(token, token)

    def _extract_qr_payload(self, envelope: dict) -> dict:
        for key in ("qr", "qr_code", "qrcode", "code"):
            value = envelope.get(key)
            if isinstance(value, str) and value:
                return {"qr": value}
        return {}
