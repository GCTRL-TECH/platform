"""Smoke tests that need neither Docker nor network — they exercise the pure
logic (CLI wiring, .env generation, arch/profile handling)."""

import sys
from pathlib import Path

# Make src/ importable without an install step.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import gctrl  # noqa: E402
from gctrl import cli, installer  # noqa: E402


def test_version_matches_package():
    assert gctrl.__version__ == "0.1.0"


def test_cli_parses_all_commands():
    parser = cli._build_parser()
    for cmd in ("install", "update", "up", "down", "status", "logs"):
        ns = parser.parse_args([cmd])
        assert ns.command == cmd


def test_cli_no_command_defaults_ok():
    ns = cli._build_parser().parse_args([])
    assert ns.command is None  # main() maps this to `install`


def test_arch_normalisation():
    assert installer._arch.__module__  # importable
    # normalisation table covers the common machine strings
    import platform
    assert installer._arch() in {"arm64", "x86_64", platform.machine().lower(), "unknown"}


def test_env_generation_has_all_keys(tmp_path, monkeypatch):
    # Point INSTALL_DIR at a temp dir and stub the network downloads so we can
    # assert the .env contract (keys the compose stack reads) without touching
    # gctrl.tech or Docker.
    monkeypatch.setattr(installer, "INSTALL_DIR", tmp_path)
    monkeypatch.setattr(installer, "CONFIG_DIR", tmp_path / "config")
    monkeypatch.setattr(installer, "download", lambda url, dest: dest.parent.mkdir(parents=True, exist_ok=True) or dest.write_text("stub"))

    inst = installer.Installer()
    inst.neo4j_uri = "bolt://gctrl-neo4j:7687"
    inst.qdrant_url = "http://gctrl-qdrant:6333"
    inst.ollama_base = "http://gctrl-ollama:11434"
    inst.generate_config()

    env = (tmp_path / ".env").read_text()
    for key in (
        "GCTRL_API_URL", "GCTRL_DATA_DIR", "JWT_SECRET", "INTERNAL_API_SECRET",
        "NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "QDRANT_URL", "OLLAMA_BASE",
        "RELEX_MODEL", "AUTO_CLASSIFY_MODEL", "POSTGRES_PASSWORD", "VLLM_MODEL",
    ):
        assert f"{key}=" in env, f"missing {key} in generated .env"

    # Secrets are non-empty and preserved on a second run.
    jwt1 = installer._read_prev_env("JWT_SECRET")
    assert len(jwt1) >= 32
    inst.generate_config()
    assert installer._read_prev_env("JWT_SECRET") == jwt1  # not rotated


# -- Superseded-image cleanup --------------------------------------------------
# The attribution half is pure, so the safety property that matters - never
# touch an image that isn't GCTRL's - is provable without Docker.

def test_owns_gctrl_images_by_tag_and_by_digest():
    assert installer._is_owned("ghcr.io/gctrl-tech/api:latest")
    assert installer._is_owned("ghcr.io/gctrl-tech/kex:latest-cuda")
    # The superseded case: the tag already moved, only the digest is left.
    assert installer._is_owned("ghcr.io/gctrl-tech/api@sha256:old")


def test_does_not_own_foreign_or_lookalike_repos():
    for ref in (
        "postgres:16-alpine",
        "ollama/ollama:latest",
        "vllm/vllm-openai:latest",
        "ghcr.io/ggml-org/llama.cpp:server",
        "ghcr.io/gctrl-tech/api-experimental:latest",  # must respect the repo boundary
        "",
    ):
        assert not installer._is_owned(ref), ref


def test_cleanup_is_a_no_op_when_disabled(monkeypatch):
    monkeypatch.setenv("GCTRL_KEEP_OLD_IMAGES", "1")
    # Any docker call would blow up here, proving the opt-out short-circuits.
    monkeypatch.setattr(installer, "_capture", lambda args: 1 / 0)
    installer.cleanup_superseded_images()


def test_batched_covers_every_item_exactly_once():
    items = [str(i) for i in range(450)]
    batches = list(installer._batched(items, installer._INSPECT_BATCH))
    assert [x for b in batches for x in b] == items
    assert all(len(b) <= installer._INSPECT_BATCH for b in batches)
