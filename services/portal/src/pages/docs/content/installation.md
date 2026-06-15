# Installation

GCTRL installs with a single command. The installer detects what you already run, deploys only what is missing, and brings up the full stack.

## One-line install

```bash
curl -fsSL https://gctrl.tech/install | bash
```

The script is interactive on first run: it detects your environment, lets you pick a model, and brings the platform up.

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

> On Apple Silicon, Docker cannot reach the Apple GPU (Metal). For best performance run Ollama natively — see [Infrastructure](infrastructure.md).

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

## Non-interactive install

To skip the model picker, set `GCTRL_MODEL` and the installer runs unattended:

```bash
GCTRL_MODEL=qwen2.5:7b curl -fsSL https://gctrl.tech/install | bash
```

This is the recommended form for scripted or repeatable deployments.

## Next steps

Once the stack is up, continue to [Activation](activation.md) to create your admin account and enter your license key.
