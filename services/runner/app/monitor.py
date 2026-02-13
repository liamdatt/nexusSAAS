from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from time import monotonic

import websockets

from app.publisher import EventPublisher
from app.runtime_manager import RuntimeManager

logger = logging.getLogger(__name__)


class TenantMonitor:
    STARTUP_GRACE_SECONDS = 15.0
    RECONNECT_GRACE_SECONDS = 20.0
    RUNTIME_ERROR_COOLDOWN_SECONDS = 10.0
    MAX_BACKOFF_SECONDS = 30.0

    def __init__(self, publisher: EventPublisher, runtime_manager: RuntimeManager) -> None:
        self.publisher = publisher
        self.runtime_manager = runtime_manager
        self._tasks: dict[str, asyncio.Task] = {}

    def active_count(self) -> int:
        self._prune_done_tasks()
        return len(self._tasks)

    def monitored_tenant_ids(self) -> set[str]:
        self._prune_done_tasks()
        return set(self._tasks.keys())

    async def start(self, tenant_id: str) -> None:
        self._prune_done_tasks()
        if tenant_id in self._tasks:
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

    def _prune_done_tasks(self) -> None:
        for tenant_id, task in list(self._tasks.items()):
            if task.done():
                self._tasks.pop(tenant_id, None)

    def _container_running(self, tenant_id: str) -> bool | None:
        try:
            running, _ = self.runtime_manager.is_running(tenant_id)
            return running
        except Exception:  # noqa: BLE001
            return None

    async def _run(self, tenant_id: str) -> None:
        ws_url = self.runtime_manager.bridge_ws_url(tenant_id)
        backoff_seconds = 1.0
        connected_once = False
        last_connected_at: float | None = None
        startup_grace_until = monotonic() + self.STARTUP_GRACE_SECONDS
        next_runtime_error_at = 0.0
        while True:
            try:
                headers = self.runtime_manager.bridge_ws_headers(tenant_id)
                async with websockets.connect(
                    ws_url,
                    ping_interval=20,
                    ping_timeout=20,
                    additional_headers=headers,
                ) as ws:
                    logger.info(
                        "bridge monitor connected tenant_id=%s ws_url=%s auth=%s",
                        tenant_id,
                        ws_url,
                        "secret_header" if headers else "none",
                    )
                    connected_once = True
                    last_connected_at = monotonic()
                    backoff_seconds = 1.0
                    await self.publisher.publish(tenant_id, "runtime.status", {"state": "pending_pairing"})
                    async for raw in ws:
                        await self._handle_message(tenant_id, raw)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                now = monotonic()
                err_type = type(exc).__name__
                transient_error = self._is_transient_monitor_error(exc)
                container_running = self._container_running(tenant_id) if transient_error else None

                suppress_for_startup = transient_error and not connected_once and now < startup_grace_until
                suppress_for_reconnect = (
                    transient_error
                    and connected_once
                    and last_connected_at is not None
                    and now < (last_connected_at + self.RECONNECT_GRACE_SECONDS)
                )
                if transient_error and container_running is False and not (suppress_for_startup or suppress_for_reconnect):
                    logger.info(
                        "bridge monitor transient error tenant_id=%s ws_url=%s err_type=%s err=%s "
                        "container_running=%s monitor_action=suppress_not_running",
                        tenant_id,
                        ws_url,
                        err_type,
                        exc,
                        container_running,
                    )
                    return

                if suppress_for_startup:
                    logger.info(
                        "bridge monitor transient error tenant_id=%s ws_url=%s err_type=%s err=%s "
                        "container_running=%s monitor_action=suppress_grace grace_scope=startup retry_in_seconds=%s",
                        tenant_id,
                        ws_url,
                        err_type,
                        exc,
                        container_running,
                        backoff_seconds,
                    )
                elif suppress_for_reconnect:
                    logger.info(
                        "bridge monitor transient error tenant_id=%s ws_url=%s err_type=%s err=%s "
                        "container_running=%s monitor_action=suppress_grace grace_scope=reconnect retry_in_seconds=%s",
                        tenant_id,
                        ws_url,
                        err_type,
                        exc,
                        container_running,
                        backoff_seconds,
                    )
                elif now >= next_runtime_error_at:
                    logger.warning(
                        "bridge monitor error tenant_id=%s ws_url=%s err_type=%s err=%s "
                        "container_running=%s monitor_action=emit_runtime_error retry_in_seconds=%s",
                        tenant_id,
                        ws_url,
                        err_type,
                        exc,
                        container_running,
                        backoff_seconds,
                    )
                    await self.publisher.publish(
                        tenant_id,
                        "runtime.error",
                        {"message": f"bridge_monitor_error: {exc}", "retry_in_seconds": backoff_seconds},
                    )
                    next_runtime_error_at = now + self.RUNTIME_ERROR_COOLDOWN_SECONDS
                else:
                    logger.debug(
                        "bridge monitor transient error tenant_id=%s ws_url=%s err_type=%s err=%s "
                        "container_running=%s monitor_action=retry next_emit_in=%.2f",
                        tenant_id,
                        ws_url,
                        err_type,
                        exc,
                        container_running,
                        max(next_runtime_error_at - now, 0.0),
                    )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2.0, self.MAX_BACKOFF_SECONDS)

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
            qr = qr_payload.get("qr") if isinstance(qr_payload, dict) else None
            logger.info(
                "bridge qr event tenant_id=%s has_qr=%s qr_length=%s",
                tenant_id,
                isinstance(qr, str) and bool(qr),
                len(qr) if isinstance(qr, str) else 0,
            )
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

    def _is_transient_monitor_error(self, exc: Exception) -> bool:
        if isinstance(exc, OSError):
            return True
        return type(exc).__name__ in {"ConnectionClosed", "ConnectionClosedError", "InvalidStatus", "InvalidStatusCode"}
