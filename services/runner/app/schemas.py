from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProvisionRequest(BaseModel):
    tenant_id: str
    nexus_image: str | None = None
    runtime_env: dict[str, str] = Field(default_factory=dict)
    bridge_shared_secret: str


class PromptPayload(BaseModel):
    name: str
    content: str


class SkillPayload(BaseModel):
    skill_id: str
    content: str


class ApplyConfigRequest(BaseModel):
    env: dict[str, str] = Field(default_factory=dict)
    prompts: list[PromptPayload] = Field(default_factory=list)
    skills: list[SkillPayload] = Field(default_factory=list)
    config_revision: int | None = None


class GenericResponse(BaseModel):
    tenant_id: str
    ok: bool = True
    detail: str | None = None


class HealthResponse(BaseModel):
    tenant_id: str
    container_running: bool
    status_text: str
    docker_available: bool
    docker_status: str
    redis_available: bool
    active_monitors: int
    last_reconcile_at: datetime | None = None
