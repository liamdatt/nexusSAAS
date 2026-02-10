from __future__ import annotations

from jose import JWTError, jwt

from app.config import get_settings


class AuthError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def verify_internal_token(token: str, tenant_id: str, action: str) -> dict:
    settings = get_settings()
    try:
        claims = jwt.decode(
            token,
            settings.runner_shared_secret,
            algorithms=[settings.runner_jwt_alg],
            audience="runner",
        )
    except JWTError as exc:
        raise AuthError("invalid_token", "Invalid internal JWT") from exc

    if claims.get("tenant_id") != tenant_id:
        raise AuthError("tenant_scope_mismatch", "tenant_id mismatch")
    if claims.get("action") != action:
        raise AuthError("action_scope_mismatch", "action mismatch")
    return claims
