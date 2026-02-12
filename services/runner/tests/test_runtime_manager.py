from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock, patch

from app.config import get_settings
from app.runtime_manager import RuntimeErrorManager, RuntimeManager


def _proc(returncode: int = 0, stdout: str = "", stderr: str = "") -> Mock:
    proc = Mock()
    proc.returncode = returncode
    proc.stdout = stdout
    proc.stderr = stderr
    return proc


def test_runtime_files_render(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()

    manager.write_compose("abc123", "ghcr.io/test/image:1")
    manager.write_runtime_env("abc123", {"BRIDGE_SHARED_SECRET": "secret"})
    manager.write_config_files("abc123", env={"A": "B"}, prompts=[{"name": "system", "content": "x"}], skills=[])

    assert manager.compose_file("abc123").exists()
    assert manager.runtime_env_file("abc123").exists()
    assert (manager.config_dir("abc123") / "env.json").exists()
    assert (manager.prompts_dir("abc123") / "system.md").exists()

    manager.write_config_files(
        "abc123",
        prompts=[{"name": "system", "content": "updated"}],
        skills=[{"skill_id": "alpha", "content": "content"}],
    )
    assert (manager.prompts_dir("abc123") / "system.md").exists()
    assert list(manager.prompts_dir("abc123").glob("*.md")) == [manager.prompts_dir("abc123") / "system.md"]
    assert list(manager.skills_dir("abc123").glob("*.md")) == [manager.skills_dir("abc123") / "alpha.md"]


def test_invalid_prompt_or_skill_identifier_rejected(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()

    try:
        manager.write_config_files("abc123", prompts=[{"name": "../escape", "content": "x"}])
        assert False, "expected RuntimeErrorManager for invalid prompt identifier"
    except RuntimeErrorManager as exc:
        assert exc.code == "invalid_config_item"

    try:
        manager.write_config_files("abc123", skills=[{"skill_id": "bad/name", "content": "x"}])
        assert False, "expected RuntimeErrorManager for invalid skill identifier"
    except RuntimeErrorManager as exc:
        assert exc.code == "invalid_config_item"


def test_compose_start_uses_up_detached(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()
    manager.write_compose("abc123", "ghcr.io/test/image:1")
    manager.write_runtime_env("abc123", {"BRIDGE_SHARED_SECRET": "secret"})

    with patch("app.runtime_manager.subprocess.run") as run_mock:
        run_mock.return_value.stdout = ""
        run_mock.return_value.stderr = ""
        manager.compose_start("abc123")

    args = run_mock.call_args.args[0]
    assert args[:4] == ["docker", "compose", "-f", str(manager.compose_file("abc123"))]
    assert args[4:] == ["up", "-d"]


def test_compose_start_migrates_legacy_config_mount_to_rw(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()
    manager.ensure_layout("abc123")
    manager.compose_file("abc123").write_text(
        "services:\n"
        "  runtime:\n"
        "    volumes:\n"
        "      - /opt/nexus/tenants/abc123/config:/data/config:ro\n",
        encoding="utf-8",
    )

    with patch("app.runtime_manager.subprocess.run") as run_mock:
        run_mock.return_value.stdout = ""
        run_mock.return_value.stderr = ""
        manager.compose_start("abc123")

    rendered = manager.compose_file("abc123").read_text(encoding="utf-8")
    assert ":/data/config:ro" not in rendered
    assert ":/data/config\n" in rendered
    args = run_mock.call_args.args[0]
    assert args[:4] == ["docker", "compose", "-f", str(manager.compose_file("abc123"))]
    assert args[4:] == ["up", "-d"]


def test_compose_start_migrates_compose_image_when_provided(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()
    manager.ensure_layout("abc123")
    manager.compose_file("abc123").write_text(
        "services:\n"
        "  runtime:\n"
        "    image: ghcr.io/test/old:1\n",
        encoding="utf-8",
    )

    with patch("app.runtime_manager.subprocess.run") as run_mock:
        run_mock.side_effect = [_proc(returncode=0), _proc(returncode=0)]
        manager.compose_start("abc123", nexus_image="ghcr.io/test/new:2")

    rendered = manager.compose_file("abc123").read_text(encoding="utf-8")
    assert "image: ghcr.io/test/new:2" in rendered
    assert "image: ghcr.io/test/old:1" not in rendered
    first_call = run_mock.call_args_list[0].args[0]
    second_call = run_mock.call_args_list[1].args[0]
    assert first_call == ["docker", "image", "inspect", "ghcr.io/test/new:2"]
    assert second_call[:4] == ["docker", "compose", "-f", str(manager.compose_file("abc123"))]
    assert second_call[4:] == ["up", "-d"]


def test_compose_restart_with_image_uses_up_detached(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()
    manager.ensure_layout("abc123")
    manager.compose_file("abc123").write_text(
        "services:\n"
        "  runtime:\n"
        "    image: ghcr.io/test/old:1\n",
        encoding="utf-8",
    )

    with patch("app.runtime_manager.subprocess.run") as run_mock:
        run_mock.side_effect = [_proc(returncode=0), _proc(returncode=0)]
        manager.compose_restart("abc123", nexus_image="ghcr.io/test/new:2")

    second_call = run_mock.call_args_list[1].args[0]
    assert second_call[:4] == ["docker", "compose", "-f", str(manager.compose_file("abc123"))]
    assert second_call[4:] == ["up", "-d"]


def test_compose_start_rejects_placeholder_nexus_image(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()
    manager.write_compose("abc123", "ghcr.io/test/image:1")

    try:
        manager.compose_start("abc123", nexus_image="ghcr.io/your-org/nexus-runtime:sha-REPLACE_WITH_COMMIT")
        assert False, "expected nexus_image_invalid for placeholder image"
    except RuntimeErrorManager as exc:
        assert exc.code == "nexus_image_invalid"


def test_compose_start_maps_manifest_missing_to_nexus_image_invalid(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()
    manager.write_compose("abc123", "ghcr.io/test/image:1")

    with patch("app.runtime_manager.subprocess.run") as run_mock:
        run_mock.side_effect = [
            _proc(returncode=1, stderr="Error: No such image"),
            _proc(returncode=1, stderr="Error response from daemon: manifest unknown"),
        ]
        try:
            manager.compose_start("abc123", nexus_image="ghcr.io/test/new:2")
            assert False, "expected nexus_image_invalid when manifest is missing"
        except RuntimeErrorManager as exc:
            assert exc.code == "nexus_image_invalid"


def test_compose_start_requires_existing_compose(tmp_path: Path, monkeypatch) -> None:
    compose_template = tmp_path / "compose.tmpl"
    env_template = tmp_path / "env.tmpl"
    compose_template.write_text("service tenant ${TENANT_ID} image ${NEXUS_IMAGE}\n", encoding="utf-8")
    env_template.write_text("unused\n", encoding="utf-8")

    monkeypatch.setenv("TENANT_ROOT", str(tmp_path / "tenants"))
    monkeypatch.setenv("TEMPLATE_COMPOSE_PATH", str(compose_template))
    monkeypatch.setenv("TEMPLATE_ENV_PATH", str(env_template))

    get_settings.cache_clear()
    manager = RuntimeManager()
    manager.ensure_layout("abc123")

    try:
        manager.compose_start("abc123")
        assert False, "expected compose_missing when compose file is absent"
    except RuntimeErrorManager as exc:
        assert exc.code == "compose_missing"


def test_repo_template_uses_rw_config_mount() -> None:
    template_path = Path(__file__).resolve().parents[3] / "runtime" / "templates" / "tenant-compose.yml.tmpl"
    template = template_path.read_text(encoding="utf-8")

    assert ":/data/config:ro" not in template
    assert ":/data/config" in template
