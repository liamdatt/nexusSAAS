"""initial schema

Revision ID: 20260210_000001
Revises:
Create Date: 2026-02-10 12:30:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260210_000001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("password_hash", sa.String(length=512), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "tenants",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("worker_id", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_tenants_owner_user_id", "tenants", ["owner_user_id"], unique=True)

    op.create_table(
        "tenant_runtime",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.String(length=64), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("desired_state", sa.String(length=64), nullable=False),
        sa.Column("actual_state", sa.String(length=64), nullable=False),
        sa.Column("last_heartbeat", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
    )
    op.create_index("ix_tenant_runtime_tenant_id", "tenant_runtime", ["tenant_id"], unique=True)

    op.create_table(
        "tenant_secrets",
        sa.Column("tenant_id", sa.String(length=64), sa.ForeignKey("tenants.id"), primary_key=True),
        sa.Column("encrypted_blob", sa.JSON(), nullable=False),
        sa.Column("key_version", sa.String(length=64), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "config_revisions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.String(length=64), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("env_json", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "revision", name="uq_config_tenant_revision"),
    )
    op.create_index("ix_config_revisions_tenant_id", "config_revisions", ["tenant_id"])

    op.create_table(
        "prompt_revisions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.String(length=64), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", "revision", name="uq_prompt_tenant_name_revision"),
    )
    op.create_index("ix_prompt_revisions_tenant_id", "prompt_revisions", ["tenant_id"])

    op.create_table(
        "skill_revisions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.String(length=64), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("skill_id", sa.String(length=128), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "skill_id", "revision", name="uq_skill_tenant_skill_revision"),
    )
    op.create_index("ix_skill_revisions_tenant_id", "skill_revisions", ["tenant_id"])

    op.create_table(
        "runtime_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.String(length=64), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("type", sa.String(length=128), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_runtime_events_tenant_id", "runtime_events", ["tenant_id"])

    op.create_table(
        "admin_actions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("actor_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("tenant_id", sa.String(length=64), sa.ForeignKey("tenants.id"), nullable=True),
        sa.Column("action", sa.String(length=128), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("admin_actions")
    op.drop_index("ix_runtime_events_tenant_id", table_name="runtime_events")
    op.drop_table("runtime_events")
    op.drop_index("ix_skill_revisions_tenant_id", table_name="skill_revisions")
    op.drop_table("skill_revisions")
    op.drop_index("ix_prompt_revisions_tenant_id", table_name="prompt_revisions")
    op.drop_table("prompt_revisions")
    op.drop_index("ix_config_revisions_tenant_id", table_name="config_revisions")
    op.drop_table("config_revisions")
    op.drop_table("tenant_secrets")
    op.drop_index("ix_tenant_runtime_tenant_id", table_name="tenant_runtime")
    op.drop_table("tenant_runtime")
    op.drop_index("ix_tenants_owner_user_id", table_name="tenants")
    op.drop_table("tenants")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
