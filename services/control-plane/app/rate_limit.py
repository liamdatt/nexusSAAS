from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Protocol

import redis.asyncio as redis
from fastapi import HTTPException, status


class InMemoryRateLimiter:
    def __init__(self, limit_per_minute: int) -> None:
        self.limit_per_minute = limit_per_minute
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.time()
        window_start = now - 60
        q = self._hits[key]
        while q and q[0] < window_start:
            q.popleft()
        if len(q) >= self.limit_per_minute:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Rate limit exceeded")
        q.append(now)


class _RateLimiter(Protocol):
    async def check(self, key: str) -> None:
        ...


class RedisRateLimiter:
    def __init__(self, redis_url: str, limit_per_minute: int, *, prefix: str = "ratelimit:signup") -> None:
        self.redis_url = redis_url
        self.limit_per_minute = limit_per_minute
        self.prefix = prefix
        self._redis: redis.Redis | None = None
        self._fallback = InMemoryRateLimiter(limit_per_minute=limit_per_minute)

    async def start(self) -> None:
        self._redis = redis.from_url(self.redis_url, decode_responses=True)
        try:
            await self._redis.ping()
        except Exception:  # noqa: BLE001
            await self.stop()

    async def stop(self) -> None:
        if self._redis is not None:
            await self._redis.close()
        self._redis = None

    async def check(self, key: str) -> None:
        if self._redis is None:
            self._fallback.check(key)
            return

        bucket = int(time.time() // 60)
        redis_key = f"{self.prefix}:{bucket}:{key}"
        try:
            count = await self._redis.incr(redis_key)
            if count == 1:
                await self._redis.expire(redis_key, 130)
            if count > self.limit_per_minute:
                raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Rate limit exceeded")
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001
            self._fallback.check(key)
