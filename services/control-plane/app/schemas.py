from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)


class RefreshRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    id: int
    email: EmailStr
    created_at: datetime


class AuthTokens(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in_seconds: int


class AuthResponse(BaseModel):
    user: UserOut
    tokens: AuthTokens


class TenantSetupRequest(BaseModel):
    initial_config: dict[str, str] | None = None


class TenantOut(BaseModel):
    id: str
    owner_user_id: int
    status: str
    worker_id: str
    created_at: datetime
    updated_at: datetime


class TenantStatusOut(BaseModel):
    tenant_id: str
    desired_state: str
    actual_state: str
    last_heartbeat: datetime | None
    last_error: str | None


class OperationAccepted(BaseModel):
    tenant_id: str
    operation: str
    accepted: bool = True


class ConfigOut(BaseModel):
    tenant_id: str
    revision: int
    env_json: dict


class ConfigPatchRequest(BaseModel):
    values: dict[str, str]


class PromptPutRequest(BaseModel):
    content: str


class SkillPutRequest(BaseModel):
    content: str


class PromptOut(BaseModel):
    name: str
    revision: int
    content: str


class SkillOut(BaseModel):
    skill_id: str
    revision: int
    content: str


class RuntimeEventOut(BaseModel):
    tenant_id: str
    type: str
    payload: dict
    created_at: datetime
