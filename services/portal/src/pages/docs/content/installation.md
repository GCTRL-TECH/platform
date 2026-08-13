# Installation

GCTRL installs with a single command. The installer detects what you already run, deploys only what is missing, and brings up the full stack. There are two ways to run it - both deploy the identical stack, and **Docker is the only hard requirement**.

## Install with curl (macOS / Linux, recommended)

```bash
curl -fsSL https://gctrl.tech/install | bash
```

On first run it is interactive: it detects your environment, lets you pick a model, and brings the platform up. This is the path we recommend on any Mac or Linux box, because it has no Python packaging in the way.

## Install with pip (Windows, or any Python environment you control)

```bash
pip install gctrl && gctrl install
```

`pip install gctrl` gives you the `gctrl` command; `gctrl install` detects your environment, lets you pick a model, and brings the platform up - identical stack, identical images. It needs **Python 3.8+** and **Docker**, and nothing else: no curl, openssl or bash, which is why it is the **native Windows** path (see the [Windows Install](windows.md) guide).

On macOS and Linux, use **pipx** rather than plain pip:

```bash
pipx install gctrl && gctrl install
```

Most current Linux distributions and Homebrew refuse a plain `pip install` into their system Python - see [Externally managed environments](#externally-managed-environments-pep-668) directly below.

> **For full performance, run Ollama natively.** The bundled Ollama runs inside Docker, which is **CPU-only** - Docker cannot reach your GPU (Apple Metal, or NVIDIA on Windows/Linux). Install Ollama natively on the host and point GCTRL at it in **Settings → Infrastructure**. It is the single biggest performance lever - see [Infrastructure & Ollama](infrastructure.md).

## Externally managed environments (PEP 668)

If `pip install gctrl` answers with

```text
error: externally-managed-environment
× This environment is externally managed
```

then nothing is wrong with your machine or with GCTRL. Arch, Debian 12+, Ubuntu 23.04+, Fedora 38+ and Homebrew mark their Python as distro-managed, and pip declines to write into it. Pick whichever line fits your setup:

| Your setup | Command |
|------------|---------|
| **Any Unix (recommended)** - isolated CLI, no system Python touched | `pipx install gctrl && gctrl install` |
| You already use **uv** | `uv tool install gctrl && gctrl install` |
| You want it in the system Python anyway | `pip install --break-system-packages gctrl` |
| Plain virtualenv | `python3 -m venv ~/.gctrl-cli && ~/.gctrl-cli/bin/pip install gctrl` |

Install pipx first if you do not have it: `sudo pacman -S python-pipx` (Arch), `sudo apt install pipx` (Debian/Ubuntu), `sudo dnf install pipx` (Fedora), `brew install pipx` (macOS).

> **If the next command says `gctrl: command not found`,** the CLI installed fine but its directory is not on your `PATH`. With `--break-system-packages` or `--user` the `gctrl` script lands in `~/.local/bin`; run `pipx ensurepath` (or add that directory to `PATH`) and open a new shell. With a venv, call it by full path: `~/.gctrl-cli/bin/gctrl install`.

Or simply use the curl one-liner above - it is unaffected by any of this.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Docker** + **docker compose** plugin | The stack runs as containers; the compose plugin (`docker compose`, not legacy `docker-compose`) is required. This is the only hard requirement for either install path |
| **Python 3.8+** | For the pip path only - natively on Windows, or via `pipx`/a venv on macOS and Linux. Nothing else: the CLI is stdlib-only and generates secrets itself |
| **curl** + **openssl** | For the curl path only (fetches the installer, generates local secrets). The pip path needs neither |
| **16 GB+ RAM** | Minimum. Larger models need more - budget accordingly |

### Supported platforms

- **macOS (Apple Silicon)** - images run **native arm64**. Use curl, or `pipx install gctrl` (Homebrew's Python rejects plain pip).
- **Linux (x86_64)** - an **NVIDIA GPU is auto-detected**; when present the installer selects **CUDA** images. Use curl, or `pipx install gctrl`.
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

The pip/pipx path installs a `gctrl` command that manages the whole lifecycle:

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
# curl
GCTRL_MODEL=qwen2.5:7b curl -fsSL https://gctrl.tech/install | bash

# pip
GCTRL_MODEL=qwen2.5:7b gctrl install
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
