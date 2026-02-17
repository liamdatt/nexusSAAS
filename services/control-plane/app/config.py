from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    control_host: str = "0.0.0.0"
    control_port: int = 9000

    database_url: str = "sqlite:///./control_plane.db"
    control_auto_create_schema: bool = False
    redis_url: str = "redis://127.0.0.1:6379/0"

    app_jwt_secret: str = "dev-app-jwt-secret"
    app_jwt_alg: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 30

    runner_base_url: str = "http://127.0.0.1:8000"
    runner_shared_secret: str = "dev-runner-shared-secret"
    runner_token_ttl_seconds: int = 60

    nexus_image: str = "ghcr.io/your-org/nexus-runtime:sha-REPLACE_WITH_COMMIT"

    secrets_master_key_b64: str = ""

    ratelimit_signup_per_minute: int = Field(default=10, ge=1)
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_oauth_redirect_uri: str = ""
    google_oauth_allowed_origins: str = ""
    google_oauth_state_ttl_seconds: int = Field(default=600, ge=60, le=3600)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
