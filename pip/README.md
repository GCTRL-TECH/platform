# GCTRL — pip installer

Self-host **Ground Control (GCTRL)**, the sovereign knowledge-graph memory layer
for AI, with one command. This is the `pip` sibling of the `curl | bash` installer
— same stack, same images, but cross-platform (macOS, Linux, **and Windows**) with
**Docker as the only prerequisite** (no curl / openssl / bash needed).

```bash
pipx install gctrl      # recommended (isolated CLI)
# or:  pip install gctrl

gctrl install           # fetches compose.yml + images, brings the stack up
```

Then open <http://localhost:3001> to activate your license and finish setup.

## Commands

| Command | What it does |
|---|---|
| `gctrl install` | Detect infra (Neo4j/Qdrant/Ollama/GPU), write `~/gctrl/.env`, `docker compose up -d`, wait for the UI |
| `gctrl update` | Re-pull `compose.yml` + images and restart — **preserves** your `.env` and generated secrets |
| `gctrl up` / `gctrl down` | Start / stop the installed stack |
| `gctrl status` | `docker compose ps` |
| `gctrl logs` | Tail logs (`--no-follow` to print and exit) |

## Non-interactive install

Honors the same environment variables as the shell installer:

```bash
GCTRL_MODEL=qwen2.5:7b GCTRL_RUNTIME=vllm gctrl install
```

- `GCTRL_MODEL` — local generation model (default `llama3.2:3b`)
- `GCTRL_RUNTIME=vllm` — enable vLLM (only on NVIDIA hosts with ≥8 GB VRAM)
- `GCTRL_INSTALL_DIR` — install location (default `~/gctrl`)

## How it relates to the curl installer

`curl -fsSL https://gctrl.tech/install | bash` still works and is unchanged. This
package installs the **same** stack by reusing the same server-side artifacts
(`https://gctrl.tech/compose.yml`, the license public key, the pinned image tags).
Picking pip vs curl changes nothing about GCTRL itself — only how you bootstrap it.

Not to be confused with the `@gctrl/cli` npm package, which *talks to* a running
instance's API. This package *installs and runs* the stack.

Docs: <https://gctrl.tech/docs> · License: AGPL-3.0-or-later
