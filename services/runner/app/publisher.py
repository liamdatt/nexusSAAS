from __future__ import annotations

import json
from datetime import UTC, datetime

import redis.asyncio as redis

from app.config import get_settings


class EventPublisher:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._redis: redis.Redis | None = None

    async def start(self) -> None:
        self._redis = redis.from_url(self.settings.redis_url, decode_responses=True)
        try:
            await self._redis.ping()
        except Exception:  # noqa: BLE001
            await self._redis.close()
            self._redis = None

    async def stop(self) -> None:
        if self._redis is not None:
            await self._redis.close()

    async def is_healthy(self) -> bool:
        if self._redis is None:
            return False
        try:
            await self._redis.ping()
            return True
        except Exception:  # noqa: BLE001
            return False

    async def publish(self, tenant_id: str, event_type: str, payload: dict) -> None:
        event = {
            "tenant_id": tenant_id,
            "type": event_type,
            "payload": payload,
            "created_at": datetime.now(UTC).isoformat(),
        }
        if self._redis is None:
            return
        try:
            await self._redis.publish(f"tenant:{tenant_id}:events", json.dumps(event))
        except Exception:  # noqa: BLE001
            return
