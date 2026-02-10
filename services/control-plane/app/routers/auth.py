from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.schemas import AuthResponse, AuthTokens, LoginRequest, RefreshRequest, SignupRequest, UserOut
from app.security import create_access_token, create_refresh_token, decode_app_token, hash_password, verify_password


router = APIRouter(prefix="/v1/auth", tags=["auth"])


@router.post("/signup", response_model=AuthResponse)
async def signup(body: SignupRequest, request: Request, db: Session = Depends(get_db)) -> AuthResponse:
    client_key = request.client.host if request.client else "unknown"
    await request.app.state.signup_rate_limiter.check(client_key)

    existing = db.scalar(select(User).where(User.email == body.email.lower()))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "email_already_registered", "message": "Email already registered"},
        )

    user = User(email=body.email.lower(), password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "email_already_registered", "message": "Email already registered"},
        ) from exc
    db.refresh(user)

    access_token, expires = create_access_token(user.id, user.email)
    refresh_token = create_refresh_token(user.id)
    return AuthResponse(
        user=UserOut.model_validate(user, from_attributes=True),
        tokens=AuthTokens(access_token=access_token, refresh_token=refresh_token, expires_in_seconds=expires),
    )


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest, db: Session = Depends(get_db)) -> AuthResponse:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    access_token, expires = create_access_token(user.id, user.email)
    refresh_token = create_refresh_token(user.id)
    return AuthResponse(
        user=UserOut.model_validate(user, from_attributes=True),
        tokens=AuthTokens(access_token=access_token, refresh_token=refresh_token, expires_in_seconds=expires),
    )


@router.post("/refresh", response_model=AuthTokens)
async def refresh(body: RefreshRequest, db: Session = Depends(get_db)) -> AuthTokens:
    try:
        claims = decode_app_token(body.refresh_token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token") from exc
    if claims.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token required")

    user = db.get(User, int(claims["sub"]))
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    access_token, expires = create_access_token(user.id, user.email)
    refresh_token = create_refresh_token(user.id)
    return AuthTokens(access_token=access_token, refresh_token=refresh_token, expires_in_seconds=expires)
