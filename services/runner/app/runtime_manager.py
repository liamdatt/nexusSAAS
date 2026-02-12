from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from pathlib import Path
from string import Template

from app.config import get_settings

logger = logging.getLogger(__name__)


class RuntimeErrorManager(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RuntimeManager:
    TENANT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
    CONFIG_ITEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    LEGACY_CONFIG_RO_MOUNT = ":/data/config:ro"
    CONFIG_RW_MOUNT = ":/data/config"

    def __init__(self) -> None:
        self.settings = get_settings()

    def validate_tenant_id(self, tenant_id: str) -> None:
        if not self.TENANT_ID_RE.fullmatch(tenant_id):
            raise RuntimeErrorManager("invalid_tenant_id", f"Invalid tenant_id: {tenant_id}")

    def tenant_dir(self, tenant_id: str) -> Path:
        self.validate_tenant_id(tenant_id)
        root = self.settings.tenant_root.resolve()
        tenant = (root / tenant_id).resolve()
        if tenant != root and root not in tenant.parents:
            raise RuntimeErrorManager("invalid_tenant_path", f"Tenant path escaped root: {tenant}")
        return tenant

    def env_dir(self, tenant_id: str) -> Path:
        return self.tenant_dir(tenant_id) / "env"

    def config_dir(self, tenant_id: str) -> Path:
        return self.tenant_dir(tenant_id) / "config"

    def prompts_dir(self, tenant_id: str) -> Path:
        return self.config_dir(tenant_id) / "prompts"

    def skills_dir(self, tenant_id: str) -> Path:
        return self.config_dir(tenant_id) / "skills"

    def compose_file(self, tenant_id: str) -> Path:
        return self.tenant_dir(tenant_id) / "docker-compose.yml"

    def runtime_env_file(self, tenant_id: str) -> Path:
        return self.env_dir(tenant_id) / "runtime.env"

    def validate_layout(self, tenant_id: str, *, require_existing: bool) -> None:
        tenant_path = self.tenant_dir(tenant_id)
        if require_existing and not tenant_path.exists():
            raise RuntimeErrorManager("tenant_not_found", f"Tenant directory not found: {tenant_path}")

        compose_path = self.compose_file(tenant_id)
        if require_existing and not compose_path.exists():
            raise RuntimeErrorManager("compose_missing", f"Compose file not found: {compose_path}")

    def ensure_layout(self, tenant_id: str) -> None:
        self.env_dir(tenant_id).mkdir(parents=True, exist_ok=True)
        self.prompts_dir(tenant_id).mkdir(parents=True, exist_ok=True)
        self.skills_dir(tenant_id).mkdir(parents=True, exist_ok=True)

    def _render_template(self, template_path: Path, values: dict[str, str]) -> str:
        src = template_path.read_text(encoding="utf-8")
        return Template(src).safe_substitute(values)

    def _resolve_template(self, configured: Path, filename: str) -> Path:
        if configured.exists():
            return configured
        candidates = [
            Path(__file__).resolve().parents[3] / "runtime" / "templates" / filename,
            Path("/app/runtime/templates") / filename,
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        raise RuntimeErrorManager("template_missing", f"Template not found for {filename}")

    def write_compose(self, tenant_id: str, image: str) -> Path:
        self.ensure_layout(tenant_id)
        path = self.compose_file(tenant_id)
        template_path = self._resolve_template(self.settings.template_compose_path, "tenant-compose.yml.tmpl")
        rendered = self._render_template(
            template_path,
            {
                "TENANT_ID": tenant_id,
                "NEXUS_IMAGE": image,
                "BRIDGE_PORT": str(self.settings.bridge_port),
                "TENANT_NETWORK": self.settings.tenant_network,
            },
        )
        path.write_text(rendered, encoding="utf-8")
        return path

    def write_runtime_env(self, tenant_id: str, values: dict[str, str]) -> Path:
        self.ensure_layout(tenant_id)
        defaults = self._default_runtime_env(values)
        defaults.update(values)

        path = self.runtime_env_file(tenant_id)
        lines: list[str] = []
        for k, v in sorted(defaults.items()):
            rendered = str(v).replace("\n", "\\n")
            lines.append(f"{k}={rendered}")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def _default_runtime_env(self, values: dict[str, str]) -> dict[str, str]:
        defaults = {
            "NEXUS_CLI_ENABLED": "false",
            "NEXUS_CONFIG_DIR": "/data/config",
            "NEXUS_DATA_DIR": "/data/state",
            "NEXUS_PROMPTS_DIR": "/data/config/prompts",
            "NEXUS_SKILLS_DIR": "/data/config/skills",
            "NEXUS_BRIDGE_WS_URL": "ws://0.0.0.0:8765",
            "NEXUS_BRIDGE_BIND_HOST": "0.0.0.0",
            "BRIDGE_HOST": "0.0.0.0",
            "BRIDGE_PORT": str(self.settings.bridge_port),
            "BRIDGE_QR_MODE": "terminal",
            "BRIDGE_EXIT_ON_CONNECT": "0",
            "BRIDGE_SESSION_DIR": "/data/session",
        }
        template_env = self._resolve_template(self.settings.template_env_path, "runtime.env.tmpl")
        rendered = self._render_template(
            template_env,
            {
                "BRIDGE_SHARED_SECRET": values.get("BRIDGE_SHARED_SECRET", ""),
            },
        )
        for raw in rendered.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            defaults[key.strip()] = value.strip()
        return defaults

    def write_config_files(
        self,
        tenant_id: str,
        env: dict[str, str] | None = None,
        prompts: list[dict] | None = None,
        skills: list[dict] | None = None,
    ) -> None:
        self.ensure_layout(tenant_id)
        if env is not None:
            (self.config_dir(tenant_id) / "env.json").write_text(json.dumps(env, indent=2), encoding="utf-8")

        if prompts is not None:
            expected_paths: set[Path] = set()
            for item in prompts:
                name = self._safe_config_item_name(str(item.get("name", "")), field="prompt")
                target = self.prompts_dir(tenant_id) / f"{name}.md"
                target.write_text(str(item.get("content", "")), encoding="utf-8")
                expected_paths.add(target.resolve())
            for existing in self.prompts_dir(tenant_id).glob("*.md"):
                if existing.resolve() not in expected_paths:
                    existing.unlink(missing_ok=True)

        if skills is not None:
            expected_paths = set()
            for item in skills:
                skill_id = self._safe_config_item_name(str(item.get("skill_id", "")), field="skill")
                target = self.skills_dir(tenant_id) / f"{skill_id}.md"
                target.write_text(str(item.get("content", "")), encoding="utf-8")
                expected_paths.add(target.resolve())
            for existing in self.skills_dir(tenant_id).glob("*.md"):
                if existing.resolve() not in expected_paths:
                    existing.unlink(missing_ok=True)

    def _safe_config_item_name(self, value: str, *, field: str) -> str:
        name = value.strip()
        if not self.CONFIG_ITEM_RE.fullmatch(name):
            raise RuntimeErrorManager("invalid_config_item", f"Invalid {field} identifier: {value!r}")
        return name

    def bridge_ws_url(self, tenant_id: str) -> str:
        self.validate_tenant_id(tenant_id)
        return f"ws://tenant_{tenant_id}_runtime:{self.settings.bridge_port}"

    def _run(self, args: list[str], *, check: bool = True) -> str:
        try:
            proc = subprocess.run(args, check=check, capture_output=True, text=True)
            return ((proc.stdout or "") + (proc.stderr or "")).strip()
        except subprocess.CalledProcessError as exc:
            msg = ((exc.stdout or "") + "\n" + (exc.stderr or "")).strip()
            raise RuntimeErrorManager("docker_command_failed", f"command_failed args={args} output={msg}") from exc
        except OSError as exc:
            raise RuntimeErrorManager("docker_unavailable", f"command_exec_error args={args} error={exc}") from exc

    def docker_available(self) -> tuple[bool, str]:
        try:
            out = self._run(["docker", "info", "--format", "{{.ServerVersion}}"])
            return True, out or "ok"
        except RuntimeErrorManager as exc:
            return False, f"{exc.code}: {exc.message}"

    def list_running_tenant_ids(self) -> list[str]:
        out = self._run(["docker", "ps", "--format", "{{.Names}}"], check=False)
        tenant_ids: list[str] = []
        for raw in out.splitlines():
            name = raw.strip()
            match = re.match(r"^tenant_([a-z0-9_-]+)_runtime$", name)
            if not match:
                continue
            tenant_id = match.group(1)
            if self.TENANT_ID_RE.fullmatch(tenant_id):
                tenant_ids.append(tenant_id)
        return sorted(set(tenant_ids))

    def compose_up(self, tenant_id: str) -> None:
        self.validate_layout(tenant_id, require_existing=False)
        self._run(["docker", "compose", "-f", str(self.compose_file(tenant_id)), "up", "-d"])

    def compose_start(self, tenant_id: str) -> None:
        self.validate_layout(tenant_id, require_existing=True)
        if self._migrate_legacy_config_mount(tenant_id):
            logger.info("Updated legacy compose config mount to read-write for tenant_id=%s", tenant_id)
        self._run(["docker", "compose", "-f", str(self.compose_file(tenant_id)), "up", "-d"])

    def compose_stop(self, tenant_id: str) -> None:
        self.validate_layout(tenant_id, require_existing=True)
        self._run(["docker", "compose", "-f", str(self.compose_file(tenant_id)), "stop"])

    def compose_restart(self, tenant_id: str) -> None:
        self.validate_layout(tenant_id, require_existing=True)
        self._run(["docker", "compose", "-f", str(self.compose_file(tenant_id)), "restart"])

    def compose_down(self, tenant_id: str, remove_volumes: bool = False) -> None:
        self.validate_layout(tenant_id, require_existing=True)
        args = ["docker", "compose", "-f", str(self.compose_file(tenant_id)), "down"]
        if remove_volumes:
            args.append("-v")
        self._run(args)

    def clear_session_volume(self, tenant_id: str) -> None:
        self.validate_layout(tenant_id, require_existing=True)
        volume = f"tenant_{tenant_id}_session"
        self._run(["docker", "run", "--rm", "-v", f"{volume}:/session", "busybox", "sh", "-c", "rm -rf /session/*"])

    def is_running(self, tenant_id: str) -> tuple[bool, str]:
        self.validate_tenant_id(tenant_id)
        name = f"tenant_{tenant_id}_runtime"
        out = self._run(["docker", "ps", "--filter", f"name={name}", "--format", "{{.Status}}"], check=False)
        if out:
            return True, out
        return False, "not running"

    def delete_tenant_files(self, tenant_id: str) -> None:
        tenant_dir = self.tenant_dir(tenant_id)
        if not tenant_dir.exists():
            return
        if str(tenant_dir).strip() in {"", "/"}:
            raise RuntimeErrorManager("unsafe_path", "Refusing to delete unsafe path")
        shutil.rmtree(tenant_dir)

    def _migrate_legacy_config_mount(self, tenant_id: str) -> bool:
        compose_path = self.compose_file(tenant_id)
        original = compose_path.read_text(encoding="utf-8")
        if self.LEGACY_CONFIG_RO_MOUNT not in original:
            return False

        updated = original.replace(self.LEGACY_CONFIG_RO_MOUNT, self.CONFIG_RW_MOUNT)
        if updated == original:
            return False

        compose_path.write_text(updated, encoding="utf-8")
        return True
