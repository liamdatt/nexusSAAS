from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import select

os.environ["DATABASE_URL"] = "sqlite:///./test_control_plane_events_manager.db"
os.environ["CONTROL_AUTO_CREATE_SCHEMA"] = "true"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"
os.environ["NEXUS_IMAGE"] = "ghcr.io/test/nexus-runtime:test"

DB_PATH = Path("./test_control_plane_events_manager.db")
if DB_PATH.exists():
    DB_PATH.unlink()

from app.db import SessionLocal, init_db
from app.events import EventManager
from app.models import RuntimeEvent, Tenant, TenantRuntime, User


class _RedisDown:
    def __init__(self) -> None:
        self.closed = False

    async def ping(self) -> None:
        raise RuntimeError("redis unavailable")

    async def close(self) -> None:
        self.closed = True


class _PubSub:
    def __init__(self, messages: list[dict]) -> None:
        self._messages = list(messages)
        self.closed = False
        self.subscribed = False

    async def psubscribe(self, pattern: str) -> None:
        assert pattern == "tenant:*:events"
        self.subscribed = True

    async def get_message(self, ignore_subscribe_messages: bool = True, timeout: float = 1.0):
        del ignore_subscribe_messages, timeout
        if self._messages:
            return self._messages.pop(0)
        await asyncio.sleep(0.01)
        return None

    async def close(self) -> None:
        self.closed = True


class _RedisUp:
    def __init__(self, messages: list[dict]) -> None:
        self.closed = False
        self._pubsub = _PubSub(messages)

    async def ping(self) -> bool:
        return True

    def pubsub(self) -> _PubSub:
        return self._pubsub

    async def publish(self, channel: str, body: str) -> int:
        del channel
        self._pubsub._messages.append({"data": body})
        return 1

    async def close(self) -> None:
        self.closed = True


def test_event_manager_recovers_when_redis_is_unavailable_on_startup() -> None:
    init_db()
    db = SessionLocal()
    try:
        user = User(email="events-manager@example.com", password_hash="x")
        db.add(user)
        db.flush()
        db.add(Tenant(id="abc123", owner_user_id=user.id, status="pending_pairing", worker_id="worker-abc123"))
        db.commit()
    finally:
        db.close()

    down = _RedisDown()
    up = _RedisUp(
        [
            {
                "data": json.dumps(
                    {
                        "tenant_id": "abc123",
                        "type": "whatsapp.qr",
                        "payload": {"qr": "qr-test"},
                    }
                )
            }
        ]
    )

    async def _fast_sleep(delay: float) -> None:
        await asyncio.sleep(delay)

    async def _exercise() -> None:
        manager = EventManager(SessionLocal)
        from_url_calls = {"count": 0}

        def _from_url(*args, **kwargs):
            del args, kwargs
            from_url_calls["count"] += 1
            if from_url_calls["count"] == 1:
                return down
            return up

        with patch("app.events.redis.from_url", side_effect=_from_url):
            await manager.start()
            try:
                for _ in range(400):
                    db = SessionLocal()
                    try:
                        row = db.scalar(
                            select(RuntimeEvent).where(
                                RuntimeEvent.tenant_id == "abc123",
                                RuntimeEvent.type == "whatsapp.qr",
                            )
                        )
                    finally:
                        db.close()
                    if row is not None:
                        break
                    await _fast_sleep(0.02)
                else:
                    assert False, "expected whatsapp.qr event to be consumed after redis reconnect"
            finally:
                await manager.stop()

    asyncio.run(_exercise())

    assert down.closed is True
    assert up.closed is True


def test_runtime_projection_ignores_reconcile_running_state() -> None:
    init_db()
    db = SessionLocal()
    try:
        user = User(email="events-projection@example.com", password_hash="x")
        db.add(user)
        db.flush()
        db.add(Tenant(id="proj123", owner_user_id=user.id, status="pending_pairing", worker_id="worker-proj123"))
        db.add(TenantRuntime(tenant_id="proj123", desired_state="running", actual_state="pending_pairing"))
        db.commit()
    finally:
        db.close()

    manager = EventManager(SessionLocal)

    db = SessionLocal()
    try:
        manager._project_runtime_state(
            db,
            tenant_id="proj123",
            event_type="runtime.status",
            payload={"state": "running", "source": "reconcile"},
        )
        db.commit()
    finally:
        db.close()

    db = SessionLocal()
    try:
        runtime = db.scalar(select(TenantRuntime).where(TenantRuntime.tenant_id == "proj123"))
        assert runtime is not None
        assert runtime.actual_state == "pending_pairing"
    finally:
        db.close()

    db = SessionLocal()
    try:
        manager._project_runtime_state(
            db,
            tenant_id="proj123",
            event_type="runtime.status",
            payload={"state": "running"},
        )
        db.commit()
    finally:
        db.close()

    db = SessionLocal()
    try:
        runtime = db.scalar(select(TenantRuntime).where(TenantRuntime.tenant_id == "proj123"))
        assert runtime is not None
        assert runtime.actual_state == "running"
    finally:
        db.close()
