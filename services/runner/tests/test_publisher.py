from __future__ import annotations

import asyncio
import json
import os
from unittest.mock import patch

os.environ["TENANT_ROOT"] = "/tmp/nexus_runner_test_publisher_tenants"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6399/0"

from app.publisher import EventPublisher


class _RedisDown:
    def __init__(self) -> None:
        self.closed = False

    async def ping(self) -> None:
        raise RuntimeError("redis down")

    async def close(self) -> None:
        self.closed = True


class _RedisPublishFails:
    def __init__(self) -> None:
        self.closed = False

    async def ping(self) -> bool:
        return True

    async def publish(self, channel: str, body: str) -> int:
        del channel, body
        raise RuntimeError("publish failed")

    async def close(self) -> None:
        self.closed = True


class _RedisOK:
    def __init__(self) -> None:
        self.closed = False
        self.published: list[tuple[str, dict]] = []

    async def ping(self) -> bool:
        return True

    async def publish(self, channel: str, body: str) -> int:
        self.published.append((channel, json.loads(body)))
        return 1

    async def close(self) -> None:
        self.closed = True


def test_publish_recovers_after_initial_connect_failure() -> None:
    down = _RedisDown()
    up = _RedisOK()

    async def _exercise() -> None:
        publisher = EventPublisher()
        await publisher.start()
        await publisher.publish("abc123", "whatsapp.qr", {"qr": "sample"})
        await publisher.stop()

    with patch("app.publisher.redis.from_url", side_effect=[down, up]):
        asyncio.run(_exercise())

    assert down.closed is True
    assert len(up.published) == 1
    channel, event = up.published[0]
    assert channel == "tenant:abc123:events"
    assert event["type"] == "whatsapp.qr"
    assert event["payload"]["qr"] == "sample"


def test_publish_retries_once_after_publish_failure() -> None:
    first = _RedisPublishFails()
    second = _RedisOK()

    async def _exercise() -> None:
        publisher = EventPublisher()
        await publisher.start()
        await publisher.publish("abc123", "runtime.status", {"state": "pending_pairing"})
        await publisher.stop()

    with patch("app.publisher.redis.from_url", side_effect=[first, second]):
        asyncio.run(_exercise())

    assert first.closed is True
    assert len(second.published) == 1
    channel, event = second.published[0]
    assert channel == "tenant:abc123:events"
    assert event["type"] == "runtime.status"
    assert event["payload"]["state"] == "pending_pairing"


def test_is_healthy_attempts_reconnect_when_disconnected() -> None:
    up = _RedisOK()

    async def _exercise() -> bool:
        publisher = EventPublisher()
        healthy = await publisher.is_healthy()
        await publisher.stop()
        return healthy

    with patch("app.publisher.redis.from_url", return_value=up) as from_url:
        healthy = asyncio.run(_exercise())

    assert healthy is True
    assert from_url.call_count == 1
