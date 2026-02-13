from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections import defaultdict
from datetime import UTC, datetime

import redis.asyncio as redis
from fastapi import WebSocket
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.models import RuntimeEvent, Tenant, TenantRuntime

logger = logging.getLogger(__name__)


class EventManager:
    def __init__(self, db_session_factory: sessionmaker) -> None:
        self.settings = get_settings()
        self.db_session_factory = db_session_factory
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._redis: redis.Redis | None = None
        self._consume_task: asyncio.Task | None = None

    async def start(self) -> None:
        self._consume_task = asyncio.create_task(self._consume_supervisor())

    async def stop(self) -> None:
        if self._consume_task:
            self._consume_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._consume_task
        await self._disconnect_redis()

    async def register(self, tenant_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[tenant_id].add(websocket)

    async def unregister(self, tenant_id: str, websocket: WebSocket) -> None:
        self._connections[tenant_id].discard(websocket)

    async def replay_recent(
        self,
        tenant_id: str,
        websocket: WebSocket,
        *,
        limit: int = 20,
        after_event_id: int | None = None,
    ) -> None:
        limit = max(0, min(limit, 200))
        if limit == 0:
            return

        db = self.db_session_factory()
        try:
            stmt = select(RuntimeEvent).where(RuntimeEvent.tenant_id == tenant_id)
            if after_event_id is not None:
                stmt = stmt.where(RuntimeEvent.id > after_event_id)
            stmt = stmt.order_by(RuntimeEvent.id.desc()).limit(limit)
            rows = list(db.scalars(stmt).all())
        finally:
            db.close()

        for row in reversed(rows):
            await websocket.send_json(self._row_to_wire(row))

    async def emit(self, tenant_id: str, event_type: str, payload: dict) -> None:
        event = {
            "tenant_id": tenant_id,
            "type": event_type,
            "payload": payload,
            "created_at": datetime.now(UTC).isoformat(),
        }
        if self._redis is None:
            await self._connect_redis()
        if self._redis is not None:
            try:
                await self._redis.publish(f"tenant:{tenant_id}:events", json.dumps(event))
                return
            except Exception as exc:  # noqa: BLE001
                # Fall through to in-process persistence/broadcast if publish fails.
                logger.warning(
                    "events redis publish failed tenant_id=%s event_type=%s err_type=%s err=%s",
                    tenant_id,
                    event_type,
                    type(exc).__name__,
                    exc,
                )
                await self._disconnect_redis()
        await self._persist_and_broadcast(event)

    async def _consume_supervisor(self) -> None:
        backoff = 1.0
        while True:
            try:
                if not await self._connect_redis():
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2.0, 30.0)
                    continue
                await self._consume_once()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("events redis consume loop error err_type=%s err=%s", type(exc).__name__, exc)
                await self._disconnect_redis()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2.0, 30.0)

    async def _consume_once(self) -> None:
        if self._redis is None:
            return

        pubsub = self._redis.pubsub()
        try:
            await pubsub.psubscribe("tenant:*:events")
            logger.info("events redis subscription established pattern=tenant:*:events")
            while True:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if not msg:
                    await asyncio.sleep(0.05)
                    continue
                data = msg.get("data")
                if not data:
                    continue
                try:
                    parsed = json.loads(data)
                except json.JSONDecodeError:
                    continue
                await self._persist_and_broadcast(parsed)
        finally:
            await pubsub.close()

    async def _connect_redis(self) -> bool:
        if self._redis is not None:
            try:
                await self._redis.ping()
                return True
            except Exception as exc:  # noqa: BLE001
                logger.warning("events redis ping failed err_type=%s err=%s", type(exc).__name__, exc)
                await self._disconnect_redis()

        client = redis.from_url(self.settings.redis_url, decode_responses=True)
        try:
            await client.ping()
        except Exception as exc:  # noqa: BLE001
            logger.warning("events redis connect failed err_type=%s err=%s", type(exc).__name__, exc)
            await client.close()
            return False
        self._redis = client
        logger.info("events redis connected")
        return True

    async def _disconnect_redis(self) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.close()
        except Exception:  # noqa: BLE001
            pass
        self._redis = None

    def _row_to_wire(self, row: RuntimeEvent) -> dict:
        created_at = row.created_at.isoformat() if row.created_at else datetime.now(UTC).isoformat()
        return {
            "event_id": row.id,
            "tenant_id": row.tenant_id,
            "type": row.type,
            "payload": row.payload_json,
            "created_at": created_at,
        }

    async def _persist_and_broadcast(self, event: dict) -> None:
        tenant_id = str(event.get("tenant_id", "")).strip()
        if not tenant_id:
            return
        event_type = str(event.get("type", "runtime.log"))
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}

        db = self.db_session_factory()
        try:
            row = RuntimeEvent(tenant_id=tenant_id, type=event_type, payload_json=payload)
            db.add(row)
            self._project_runtime_state(db, tenant_id=tenant_id, event_type=event_type, payload=payload)
            db.commit()
            db.refresh(row)
        finally:
            db.close()

        wire = self._row_to_wire(row)
        sockets = list(self._connections.get(tenant_id, set()))
        to_remove: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_json(wire)
            except Exception:  # noqa: BLE001
                to_remove.append(ws)

        for ws in to_remove:
            self._connections[tenant_id].discard(ws)

    def _project_runtime_state(self, db, *, tenant_id: str, event_type: str, payload: dict) -> None:
        runtime = db.scalar(select(TenantRuntime).where(TenantRuntime.tenant_id == tenant_id))
        if runtime is None:
            return

        tenant = db.scalar(select(Tenant).where(Tenant.id == tenant_id))
        now = datetime.now(UTC)

        mapped_state: str | None = None
        mapped_error: str | None = None

        if event_type == "runtime.status":
            state = payload.get("state")
            if isinstance(state, str) and state:
                mapped_state = state
                if state == "error":
                    raw = payload.get("message") or payload.get("error") or "runtime_error"
                    mapped_error = str(raw)
        elif event_type == "runtime.error":
            mapped_state = "error"
            raw = payload.get("message") or payload.get("error") or "runtime_error"
            mapped_error = str(raw)
        elif event_type == "whatsapp.connected":
            mapped_state = "running"
        elif event_type == "whatsapp.disconnected":
            mapped_state = "pending_pairing"

        if mapped_state is None:
            return

        runtime.actual_state = mapped_state
        runtime.last_heartbeat = now
        if mapped_state == "error":
            runtime.last_error = mapped_error or runtime.last_error
        else:
            runtime.last_error = None

        if tenant is not None:
            tenant.status = mapped_state
