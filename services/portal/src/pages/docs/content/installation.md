# Installation

GCTRL installs with a single command. The installer detects what you already run, deploys only what is missing, and brings up the full stack.

## One-line install

```bash
curl -fsSL https://gctrl.tech/install | bash
```

The script is interactive on first run: it detects your environment, lets you pick a model, and brings the platform up.

> **For full performance, run Ollama natively.** The bundled Ollama runs inside Docker, which is **CPU-only** — Docker cannot reach your GPU (Apple Metal, or NVIDIA on Windows/Linux). Install Ollama natively on the host and point GCTRL at it in **Settings → Infrastructure**. It is the single biggest performance lever — see [Infrastructure & Ollama](infrastructure.md).

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Docker** + **docker compose** plugin | The stack runs as containers; the compose plugin (`docker compose`, not legacy `docker-compose`) is required |
| **curl** | Fetches the installer |
| **openssl** | Generates local secrets and keys |
| **16 GB+ RAM** | Minimum. Larger models need more — budget accordingly |

### Supported platforms

- **macOS (Apple Silicon)** — images run **native arm64**.
- **Linux (x86_64)** — an **NVIDIA GPU is auto-detected**; when present the installer selects **CUDA** images.
- **Windows** — run it via **Docker Desktop + WSL 2**. Follow the dedicated [Windows Install](windows.md) guide.

## What the installer does

1. **Detects existing services.** If **Neo4j**, **Qdrant**, or **Ollama** are already running on their standard ports, GCTRL **reuses them**. Otherwise it deploys the **bundled containers**.
2. **Detects GPU.** On Linux, an NVIDIA GPU triggers CUDA image selection automatically.
3. **Interactive model picker.** Choose the local model to pull and run for extraction and RAG.
4. **Brings up the stack.** Starts all platform services via docker compose.
5. **Deploys the FUSE resolution engine automatically.**

## Ports

| Service | URL / Port |
|---------|-----------|
| Dashboard | `http://localhost:3001` |
| API | `:4000` |
| KEX (extraction) | `:4010` |
| FUSE (fusion / entity resolution) | `:4020` |
| License agent | `:7070` |

> **Keep the data-layer ports private.** The bundled Neo4j, Postgres, Qdrant and Ollama are for local/Docker access only — never expose them to the internet. Database passwords are generated uniquely per install into `~/gctrl/.env`. Before exposing anything beyond `localhost`, read [Securing Your Deployment](security.md).

## Non-interactive install

To skip the model picker, set `GCTRL_MODEL` and the installer runs unattended:

```bash
GCTRL_MODEL=qwen2.5:7b curl -fsSL https://gctrl.tech/install | bash
```

This is the recommended form for scripted or repeatable deployments.

## Uninstall

GCTRL ships a dedicated uninstaller with two modes:

| Mode | Command | What happens |
|------|---------|--------------|
| **Safe** (default) | `curl -fsSL https://gctrl.tech/uninstall \| bash` | Stops GCTRL and removes its containers and images. **Your data is preserved** — the Postgres/Neo4j/Qdrant volumes and `~/gctrl/data` stay on disk, so a later reinstall picks up where you left off. |
| **Purge** | `curl -fsSL https://gctrl.tech/uninstall \| bash -s -- --purge` | **Complete removal.** Every container, image, named volume (all knowledge-graph data — unrecoverable), the docker network, and the entire `~/gctrl` directory. The host ends up as if GCTRL was never installed. |

The uninstaller asks for a typed confirmation before touching anything: `uninstall` in safe mode, `purge` in purge mode. It also deactivates your license key on the server (best-effort), so the key is free to use on a fresh install.

What it cleans up beyond the compose project: stray `gctrl-*` containers are removed even if the compose state is broken or partial, and in purge mode any `gctrl`-prefixed volumes and networks are swept as well.

### Non-interactive uninstall

For scripted use (CI, test boxes), skip the confirmation prompt with `--yes` or `GCTRL_YES=1`:

```bash
# Complete wipe, no prompt — for clean-reinstall testing
GCTRL_YES=1 curl -fsSL https://gctrl.tech/uninstall | bash -s -- --purge
```

If GCTRL was installed to a custom location, point the uninstaller at it with `GCTRL_INSTALL_DIR=/path/to/gctrl`.

### Reinstall afterwards

```bash
curl -fsSL https://gctrl.tech/install | bash
```

After a **safe** uninstall the installer reuses your preserved volumes — graphs, users and settings are back. After a **purge** you start from zero.

## Next steps

Once the stack is up, continue to [Activation](activation.md) to create your admin account and enter your license key.
