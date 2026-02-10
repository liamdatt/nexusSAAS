from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    tenants: Mapped[list["Tenant"]] = relationship(back_populates="owner")


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, unique=True, index=True)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="provisioning")
    worker_id: Mapped[str] = mapped_column(String(128), nullable=False, default="worker-1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    owner: Mapped[User] = relationship(back_populates="tenants")


class TenantRuntime(Base):
    __tablename__ = "tenant_runtime"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), nullable=False, unique=True, index=True)
    desired_state: Mapped[str] = mapped_column(String(64), nullable=False, default="stopped")
    actual_state: Mapped[str] = mapped_column(String(64), nullable=False, default="provisioning")
    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class TenantSecret(Base):
    __tablename__ = "tenant_secrets"

    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    encrypted_blob: Mapped[dict] = mapped_column(JSON, nullable=False)
    key_version: Mapped[str] = mapped_column(String(64), nullable=False, default="v1")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ConfigRevision(Base):
    __tablename__ = "config_revisions"
    __table_args__ = (UniqueConstraint("tenant_id", "revision", name="uq_config_tenant_revision"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), nullable=False, index=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    env_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class PromptRevision(Base):
    __tablename__ = "prompt_revisions"
    __table_args__ = (UniqueConstraint("tenant_id", "name", "revision", name="uq_prompt_tenant_name_revision"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class SkillRevision(Base):
    __tablename__ = "skill_revisions"
    __table_args__ = (UniqueConstraint("tenant_id", "skill_id", "revision", name="uq_skill_tenant_skill_revision"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), nullable=False, index=True)
    skill_id: Mapped[str] = mapped_column(String(128), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class RuntimeEvent(Base):
    __tablename__ = "runtime_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(128), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AdminAction(Base):
    __tablename__ = "admin_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    tenant_id: Mapped[str | None] = mapped_column(ForeignKey("tenants.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(128), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
