from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import SessionLocal, init_db
from app.events import EventManager
from app.rate_limit import RedisRateLimiter
from app.routers import auth, events_ws, tenants


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.control_auto_create_schema:
        # Test/local fallback only. Production/staging should run Alembic migrations.
        init_db()
    app.state.settings = settings
    app.state.signup_rate_limiter = RedisRateLimiter(
        redis_url=settings.redis_url,
        limit_per_minute=settings.ratelimit_signup_per_minute,
    )
    await app.state.signup_rate_limiter.start()
    app.state.events = EventManager(SessionLocal)
    await app.state.events.start()
    try:
        yield
    finally:
        await app.state.signup_rate_limiter.stop()
        await app.state.events.stop()


app = FastAPI(title="Nexus Control Plane", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


app.include_router(auth.router)
app.include_router(tenants.router)
app.include_router(events_ws.router)
