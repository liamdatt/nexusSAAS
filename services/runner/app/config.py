from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    runner_host: str = "0.0.0.0"
    runner_port: int = 8000

    runner_shared_secret: str = "dev-runner-shared-secret"
    runner_jwt_alg: str = "HS256"

    redis_url: str = "redis://127.0.0.1:6379/0"

    tenant_root: Path = Path("/opt/nexus/tenants")
    tenant_network: str = "runner_internal"
    nexus_image: str = "ghcr.io/your-org/nexus-runtime:sha-REPLACE_WITH_COMMIT"
    bridge_port: int = 8765

    template_compose_path: Path = Path("runtime/templates/tenant-compose.yml.tmpl")
    template_env_path: Path = Path("runtime/templates/runtime.env.tmpl")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.tenant_root.mkdir(parents=True, exist_ok=True)
    return settings
