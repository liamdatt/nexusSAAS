from __future__ import annotations

import json
import logging
from time import monotonic
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit

import redis.asyncio as redis

from app.config import get_settings

logger = logging.getLogger(__name__)


class EventPublisher:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._redis: redis.Redis | None = None
        self._next_connect_attempt_at = 0.0
        self._connect_backoff_seconds = 2.0
        self._redis_url_validated = False

    async def start(self) -> None:
        self._validate_redis_url_once()
        await self._ensure_redis(force=True)

    async def stop(self) -> None:
        await self._disconnect()

    async def is_healthy(self) -> bool:
        if not await self._ensure_redis():
            return False
        try:
            assert self._redis is not None
            await self._redis.ping()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("runner publisher redis health check failed err_type=%s err=%s", type(exc).__name__, exc)
            await self._disconnect()
            return False

    async def publish(self, tenant_id: str, event_type: str, payload: dict) -> None:
        event = {
            "tenant_id": tenant_id,
            "type": event_type,
            "payload": payload,
            "created_at": datetime.now(UTC).isoformat(),
        }
        if not await self._ensure_redis(force=True):
            logger.warning("runner publisher redis unavailable tenant_id=%s event_type=%s", tenant_id, event_type)
            return
        channel = f"tenant:{tenant_id}:events"
        body = json.dumps(event)
        try:
            assert self._redis is not None
            await self._redis.publish(channel, body)
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "runner publisher publish failed tenant_id=%s event_type=%s err_type=%s err=%s",
                tenant_id,
                event_type,
                type(exc).__name__,
                exc,
            )
            await self._disconnect()

        if not await self._ensure_redis(force=True):
            logger.warning(
                "runner publisher reconnect failed tenant_id=%s event_type=%s",
                tenant_id,
                event_type,
            )
            return

        try:
            assert self._redis is not None
            await self._redis.publish(channel, body)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "runner publisher retry failed tenant_id=%s event_type=%s err_type=%s err=%s",
                tenant_id,
                event_type,
                type(exc).__name__,
                exc,
            )
            await self._disconnect()
            return

    async def _ensure_redis(self, *, force: bool = False) -> bool:
        if self._redis is not None:
            return True
        now = monotonic()
        if not force and now < self._next_connect_attempt_at:
            return False
        if await self._connect():
            self._next_connect_attempt_at = 0.0
            return True
        self._next_connect_attempt_at = monotonic() + self._connect_backoff_seconds
        return False

    async def _connect(self) -> bool:
        self._validate_redis_url_once()
        client = redis.from_url(self.settings.redis_url, decode_responses=True)
        try:
            await client.ping()
        except Exception as exc:  # noqa: BLE001
            logger.warning("runner publisher redis connect failed err_type=%s err=%s", type(exc).__name__, exc)
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
            return False
        self._redis = client
        logger.info("runner publisher connected to redis")
        return True

    async def _disconnect(self) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.close()
        except Exception:  # noqa: BLE001
            pass
        self._redis = None

    def _validate_redis_url_once(self) -> None:
        if self._redis_url_validated:
            return
        self._redis_url_validated = True

        raw = (self.settings.redis_url or "").strip()
        redacted = self._redact_redis_url(raw)
        if not raw:
            logger.warning("runner publisher REDIS_URL is empty; redis event publish will be unavailable")
            return

        if not raw.startswith(("redis://", "rediss://")):
            logger.warning(
                "runner publisher REDIS_URL missing redis:// or rediss:// scheme; value=%s",
                redacted,
            )
            return

        try:
            parsed = urlsplit(raw)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "runner publisher REDIS_URL could not be parsed value=%s err_type=%s err=%s",
                redacted,
                type(exc).__name__,
                exc,
            )
            return

        if not parsed.hostname:
            logger.warning("runner publisher REDIS_URL has no host value=%s", redacted)
        if not parsed.password:
            logger.warning(
                "runner publisher REDIS_URL has no password value=%s; auth-required redis will reject connections",
                redacted,
            )
        if parsed.password and parsed.username is None:
            logger.warning(
                "runner publisher REDIS_URL has password but no username value=%s; ACL redis typically requires default user",
                redacted,
            )

    def _redact_redis_url(self, raw: str) -> str:
        if not raw:
            return "<empty>"
        try:
            parsed = urlsplit(raw)
            host = parsed.hostname or ""
            port = f":{parsed.port}" if parsed.port else ""
            auth = ""
            if parsed.username is not None:
                auth = f"{parsed.username}:***@"
            elif parsed.password:
                auth = ":***@"
            netloc = f"{auth}{host}{port}"
            return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))
        except Exception:  # noqa: BLE001
            return "<invalid>"
