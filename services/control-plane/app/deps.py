from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.security import decode_app_token, is_token_error


bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    db: Session = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    try:
        claims = decode_app_token(credentials.credentials)
    except Exception as exc:  # noqa: BLE001
        if is_token_error(exc):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
        raise
    if claims.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Access token required")

    user_id = int(claims["sub"])
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user
