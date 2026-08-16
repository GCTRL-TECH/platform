#!/usr/bin/env python3
"""Guard: the installer must never hand a container an address it cannot resolve.

Background — the bug this exists to prevent
-------------------------------------------
Whenever the installer finds Neo4j / Qdrant / Ollama already running on the HOST,
it points the corresponding env var at ``host.docker.internal``. On Docker Desktop
that name resolves by itself; on plain Linux Docker it does NOT unless the service
declares::

    extra_hosts:
      - "host.docker.internal:host-gateway"

The shipped compose files declared it for ``gctrl-api`` only. So on a Linux box with
a native Ollama, KEX could not resolve the name: embeddings returned nothing,
relation extraction was skipped, the isolated entities were pruned — and the job
still reported ``completed``. An install that looked healthy produced edgeless
graphs.

What is checked
---------------
1. Every service in a shipped compose file whose ``environment`` mentions one of
   HOST_SUBSTITUTABLE_VARS must declare the host-gateway mapping.
2. Every env var an installer assigns a ``host.docker.internal`` URL to must be in
   HOST_SUBSTITUTABLE_VARS — so adding a newly host-detectable service to an
   installer without teaching the compose files about it fails here.

Run: ``python3 scripts/check-compose-hosts.py`` (exit 1 on violation). Needs PyYAML.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

# Compose files handed to customers. The portal one is what `curl gctrl.tech/install`
# and `pip install gctrl` actually download (https://gctrl.tech/compose.yml); the
# deploy template is the in-repo source of truth. They must not drift apart.
COMPOSE_FILES = [
    Path("services/portal/public/compose.yml"),
    Path("deploy/compose-template.yml"),
]

# Scripts that may rewrite those env vars to a host address.
INSTALLERS = [
    Path("services/portal/public/install"),
    Path("pip/src/gctrl/installer.py"),
]

# Env vars the installers may point at the host.
HOST_SUBSTITUTABLE_VARS = {
    "NEO4J_URI",
    "QDRANT_URL",
    "OLLAMA_BASE",
    "EMBEDDING_BASE_URL",
}

REQUIRED_MAPPING = "host.docker.internal:host-gateway"

# `NEO4J_URI="bolt://host.docker.internal:7687"` (sh) and
# `self.neo4j_uri = "bolt://host.docker.internal:11434"` (py) alike: capture the
# assignment target, then normalise it to an env var name.
ASSIGNMENT = re.compile(
    r"""(?:self\.)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["'][^"']*host\.docker\.internal""",
)


def check_compose(path: Path) -> list[str]:
    doc = yaml.safe_load((ROOT / path).read_text(encoding="utf-8")) or {}
    problems: list[str] = []
    for name, svc in (doc.get("services") or {}).items():
        env = svc.get("environment") or []
        # Compose accepts both the list form (`- KEY=value`) and the mapping form.
        keys = (
            {e.split("=", 1)[0].strip() for e in env if isinstance(e, str)}
            if isinstance(env, list)
            else set(env.keys())
        )
        needs = keys & HOST_SUBSTITUTABLE_VARS
        if not needs:
            continue
        hosts = svc.get("extra_hosts") or []
        if REQUIRED_MAPPING not in [str(h).strip() for h in hosts]:
            problems.append(
                f"{path}: service '{name}' can receive a host.docker.internal URL "
                f"({', '.join(sorted(needs))}) but declares no "
                f'extra_hosts "{REQUIRED_MAPPING}" - on Linux that name will not resolve.'
            )
    return problems


def check_installer(path: Path) -> list[str]:
    text = (ROOT / path).read_text(encoding="utf-8")
    problems: list[str] = []
    for match in ASSIGNMENT.finditer(text):
        var = match.group(1).upper()
        if var not in HOST_SUBSTITUTABLE_VARS:
            problems.append(
                f"{path}: assigns a host.docker.internal URL to '{match.group(1)}', "
                f"which is not in HOST_SUBSTITUTABLE_VARS. Add it here AND give every "
                f"compose service that receives it the extra_hosts mapping."
            )
    return problems


def main() -> int:
    problems: list[str] = []
    for f in COMPOSE_FILES:
        problems += check_compose(f)
    for f in INSTALLERS:
        problems += check_installer(f)

    if problems:
        print("compose/installer host mapping check FAILED:\n")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(
        f"compose/installer host mapping OK "
        f"({len(COMPOSE_FILES)} compose files, {len(INSTALLERS)} installers)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
