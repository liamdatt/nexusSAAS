from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Tenant
from app.security import decode_app_token


router = APIRouter(prefix="/v1/events", tags=["events"])


@router.websocket("/ws")
async def events_ws(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=1008)
        return

    try:
        claims = decode_app_token(token)
    except JWTError:
        await websocket.close(code=1008)
        return

    if claims.get("type") != "access":
        await websocket.close(code=1008)
        return

    user_id = int(claims["sub"])
    db = SessionLocal()
    try:
        tenant = db.scalar(select(Tenant).where(Tenant.owner_user_id == user_id))
        if tenant is None:
            await websocket.close(code=1008)
            return
        tenant_id = tenant.id
    finally:
        db.close()

    manager = websocket.app.state.events
    await manager.register(tenant_id, websocket)
    await websocket.send_json({"type": "ws.ready", "tenant_id": tenant_id, "payload": {"status": "ok"}})
    replay = websocket.query_params.get("replay", "20")
    after_event_id = websocket.query_params.get("after_event_id")
    try:
        replay_limit = int(replay)
    except ValueError:
        replay_limit = 20
    try:
        after_id = int(after_event_id) if after_event_id is not None else None
    except ValueError:
        after_id = None
    await manager.replay_recent(tenant_id, websocket, limit=replay_limit, after_event_id=after_id)

    try:
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=45)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ws.keepalive", "tenant_id": tenant_id, "payload": {}})
    except WebSocketDisconnect:
        await manager.unregister(tenant_id, websocket)
