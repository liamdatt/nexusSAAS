from __future__ import annotations

from datetime import UTC, datetime, timedelta

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import get_settings


pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def _encode_token(payload: dict, secret: str, alg: str) -> str:
    return jwt.encode(payload, secret, algorithm=alg)


def _decode_token(token: str, secret: str, alg: str, audience: str | None = None) -> dict:
    options = {"verify_aud": audience is not None}
    return jwt.decode(token, secret, algorithms=[alg], audience=audience, options=options)


def create_access_token(user_id: int, email: str) -> tuple[str, int]:
    settings = get_settings()
    now = datetime.now(UTC)
    exp = now + timedelta(minutes=settings.access_token_minutes)
    payload = {
        "sub": str(user_id),
        "email": email,
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return _encode_token(payload, settings.app_jwt_secret, settings.app_jwt_alg), int(
        timedelta(minutes=settings.access_token_minutes).total_seconds()
    )


def create_refresh_token(user_id: int) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    exp = now + timedelta(days=settings.refresh_token_days)
    payload = {
        "sub": str(user_id),
        "type": "refresh",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return _encode_token(payload, settings.app_jwt_secret, settings.app_jwt_alg)


def decode_app_token(token: str) -> dict:
    settings = get_settings()
    return _decode_token(token, settings.app_jwt_secret, settings.app_jwt_alg)


def create_runner_token(tenant_id: str, action: str) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    exp = now + timedelta(seconds=settings.runner_token_ttl_seconds)
    payload = {
        "sub": f"tenant:{tenant_id}",
        "tenant_id": tenant_id,
        "action": action,
        "aud": "runner",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return _encode_token(payload, settings.runner_shared_secret, settings.app_jwt_alg)


def decode_runner_token(token: str) -> dict:
    settings = get_settings()
    return _decode_token(token, settings.runner_shared_secret, settings.app_jwt_alg, audience="runner")


def is_token_error(exc: Exception) -> bool:
    return isinstance(exc, JWTError)
