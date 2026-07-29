# Installation

GCTRL installs with a single command. The installer detects what you already run, deploys only what is missing, and brings up the full stack. There are two ways to run it - both deploy the identical stack, and **Docker is the only hard requirement**.

## Install with pip (recommended, cross-platform)

```bash
pip install gctrl && gctrl install
```

`pip install gctrl` gives you the `gctrl` command; `gctrl install` detects your environment, lets you pick a model, and brings the platform up. This path works on **macOS, Linux and native Windows** - no curl, openssl or bash needed, just **Python 3.8+** and **Docker**. Prefer an isolated CLI? Use `pipx install gctrl` instead of `pip install gctrl`.

## Install with curl (macOS / Linux)

```bash
curl -fsSL https://gctrl.tech/install | bash
```

The shell one-liner does the same thing on macOS and Linux. On first run it is interactive: it detects your environment, lets you pick a model, and brings the platform up.

> **For full performance, run Ollama natively.** The bundled Ollama runs inside Docker, which is **CPU-only** - Docker cannot reach your GPU (Apple Metal, or NVIDIA on Windows/Linux). Install Ollama natively on the host and point GCTRL at it in **Settings → Infrastructure**. It is the single biggest performance lever - see [Infrastructure & Ollama](infrastructure.md).

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Docker** + **docker compose** plugin | The stack runs as containers; the compose plugin (`docker compose`, not legacy `docker-compose`) is required. This is the only hard requirement for either install path |
| **Python 3.8+** | For the pip path only (`pip install gctrl`). Nothing else - the CLI is stdlib-only and generates secrets itself |
| **curl** + **openssl** | For the curl path only (fetches the installer, generates local secrets). The pip path needs neither |
| **16 GB+ RAM** | Minimum. Larger models need more - budget accordingly |

### Supported platforms

- **macOS (Apple Silicon)** - images run **native arm64**.
- **Linux (x86_64)** - an **NVIDIA GPU is auto-detected**; when present the installer selects **CUDA** images.
- **Windows** - `pip install gctrl` runs **natively in PowerShell**; you still need **Docker Desktop** for the container engine. See the [Windows Install](windows.md) guide.

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

> **Keep the data-layer ports private.** The bundled Neo4j, Postgres, Qdrant and Ollama are for local/Docker access only - never expose them to the internet. Database passwords are generated uniquely per install into `~/gctrl/.env`. Before exposing anything beyond `localhost`, read [Securing Your Deployment](security.md).

## Managing your install (the `gctrl` CLI)

After `pip install gctrl`, the `gctrl` command manages the whole lifecycle:

| Command | What it does |
|---------|--------------|
| `gctrl install` | Install and start: detect infra, pick a model, `docker compose up` |
| `gctrl update` | Re-pull the compose file and images, then restart - **preserves** your `.env` and generated secrets |
| `gctrl up` / `gctrl down` | Start / stop the installed stack |
| `gctrl status` | Container status |
| `gctrl logs` | Tail logs (`--no-follow` to print current logs and exit) |

The curl path installs to the same place (`~/gctrl`), so you can still manage it with plain `docker compose` from that directory if you prefer.

## Non-interactive install

To skip the model picker, set `GCTRL_MODEL` and the installer runs unattended - both paths honor the same environment variables (`GCTRL_MODEL`, `GCTRL_RUNTIME`, `GCTRL_INSTALL_DIR`):

```bash
# pip
GCTRL_MODEL=qwen2.5:7b gctrl install

# curl
GCTRL_MODEL=qwen2.5:7b curl -fsSL https://gctrl.tech/install | bash
```

This is the recommended form for scripted or repeatable deployments.

## Uninstall

GCTRL ships a dedicated uninstaller with two modes:

| Mode | Command | What happens |
|------|---------|--------------|
| **Safe** (default) | `curl -fsSL https://gctrl.tech/uninstall \| bash` | Stops GCTRL and removes its containers and images. **Your data is preserved** - the Postgres/Neo4j/Qdrant volumes and `~/gctrl/data` stay on disk, so a later reinstall picks up where you left off. |
| **Purge** | `curl -fsSL https://gctrl.tech/uninstall \| bash -s -- --purge` | **Complete removal.** Every container, image, named volume (all knowledge-graph data - unrecoverable), the docker network, and the entire `~/gctrl` directory. The host ends up as if GCTRL was never installed. |

The uninstaller asks for a typed confirmation before touching anything: `uninstall` in safe mode, `purge` in purge mode. It also deactivates your license key on the server (best-effort), so the key is free to use on a fresh install.

What it cleans up beyond the compose project: stray `gctrl-*` containers are removed even if the compose state is broken or partial, and in purge mode any `gctrl`-prefixed volumes and networks are swept as well.

### Non-interactive uninstall

For scripted use (CI, test boxes), skip the confirmation prompt with `--yes` or `GCTRL_YES=1`:

```bash
# Complete wipe, no prompt - for clean-reinstall testing
GCTRL_YES=1 curl -fsSL https://gctrl.tech/uninstall | bash -s -- --purge
```

If GCTRL was installed to a custom location, point the uninstaller at it with `GCTRL_INSTALL_DIR=/path/to/gctrl`.

### Reinstall afterwards

```bash
curl -fsSL https://gctrl.tech/install | bash
```

After a **safe** uninstall the installer reuses your preserved volumes - graphs, users and settings are back. After a **purge** you start from zero.

## Next steps

Once the stack is up, continue to [Activation](activation.md) to create your admin account and enter your license key.
