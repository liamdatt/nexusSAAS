from __future__ import annotations

import httpx

from app.config import get_settings
from app.security import create_runner_token


class RunnerError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502, code: str = "runner_error") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class RunnerClient:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def _request(self, method: str, path: str, tenant_id: str, action: str, json_body: dict | None = None) -> dict:
        token = create_runner_token(tenant_id=tenant_id, action=action)
        url = f"{self.settings.runner_base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.request(
                    method,
                    url,
                    json=json_body,
                    headers={"Authorization": f"Bearer {token}"},
                )
        except httpx.HTTPError as exc:
            raise RunnerError(f"runner_http_error: {exc}", status_code=502, code="runner_http_error") from exc
        if resp.status_code >= 400:
            code = "runner_error"
            message = resp.text
            try:
                parsed = resp.json()
                if isinstance(parsed, dict):
                    detail = parsed.get("detail")
                    if isinstance(detail, dict):
                        code = str(detail.get("error", code))
                        message = str(detail.get("message", message))
                    elif isinstance(detail, str):
                        message = detail
            except Exception:  # noqa: BLE001
                pass
            raise RunnerError(message, status_code=resp.status_code, code=code)
        if resp.content:
            return resp.json()
        return {}

    async def provision(self, tenant_id: str, payload: dict) -> dict:
        return await self._request("POST", f"/internal/tenants/{tenant_id}/provision", tenant_id, "provision", payload)

    async def start(self, tenant_id: str, payload: dict | None = None) -> dict:
        return await self._request("POST", f"/internal/tenants/{tenant_id}/start", tenant_id, "start", payload)

    async def stop(self, tenant_id: str) -> dict:
        return await self._request("POST", f"/internal/tenants/{tenant_id}/stop", tenant_id, "stop")

    async def restart(self, tenant_id: str, payload: dict | None = None) -> dict:
        return await self._request("POST", f"/internal/tenants/{tenant_id}/restart", tenant_id, "restart", payload)

    async def pair_start(self, tenant_id: str, payload: dict | None = None) -> dict:
        return await self._request("POST", f"/internal/tenants/{tenant_id}/pair/start", tenant_id, "pair_start", payload)

    async def disconnect(self, tenant_id: str) -> dict:
        return await self._request(
            "POST", f"/internal/tenants/{tenant_id}/whatsapp/disconnect", tenant_id, "whatsapp_disconnect"
        )

    async def apply_config(self, tenant_id: str, payload: dict) -> dict:
        return await self._request(
            "POST", f"/internal/tenants/{tenant_id}/apply-config", tenant_id, "apply_config", payload
        )

    async def health(self, tenant_id: str) -> dict:
        return await self._request("GET", f"/internal/tenants/{tenant_id}/health", tenant_id, "health")
