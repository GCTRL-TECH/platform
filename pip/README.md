# GCTRL - pip installer

Self-host **Ground Control (GCTRL)**, the sovereign knowledge-graph memory layer
for AI, with one command. This is the `pip` sibling of the `curl | bash` installer:
same stack, same images, but cross-platform (macOS, Linux, **and Windows**) with
**Docker as the only prerequisite** (no curl / openssl / bash needed).

```bash
pipx install gctrl      # macOS / Linux - isolated CLI, always works
pip install gctrl       # Windows (PowerShell), or any venv you control

gctrl install           # fetches compose.yml + images, brings the stack up
```

Then open <http://localhost:3001> to activate your license and finish setup.

## "error: externally-managed-environment"

If plain `pip install gctrl` answers with that, nothing is wrong with your
machine or with this package. Arch, Debian 12+, Ubuntu 23.04+, Fedora 38+ and
Homebrew mark their Python as distro-managed, and pip declines to write into it
([PEP 668](https://peps.python.org/pep-0668/)). It refuses before it ever looks
at the package name, so it is not something a package can opt out of. Use one of:

| Your setup | Command |
|---|---|
| **Any Unix (recommended)** | `pipx install gctrl` |
| You already use **uv** | `uv tool install gctrl` |
| System Python anyway | `pip install --break-system-packages gctrl` |
| Plain virtualenv | `python3 -m venv ~/.gctrl-cli && ~/.gctrl-cli/bin/pip install gctrl` |

No pipx yet? `sudo pacman -S python-pipx` (Arch), `sudo apt install pipx`
(Debian/Ubuntu), `sudo dnf install pipx` (Fedora), `brew install pipx` (macOS).

**If the next command says `gctrl: command not found`,** the CLI installed but
its directory is not on your `PATH`. With `--break-system-packages` or `--user`
the script lands in `~/.local/bin`: run `pipx ensurepath` (or add that directory
to `PATH`) and open a new shell. With a venv, call it by full path
(`~/.gctrl-cli/bin/gctrl install`).

On macOS and Linux you can also skip Python entirely and use the shell
installer: `curl -fsSL https://gctrl.tech/install | bash`.

## Commands

| Command | What it does |
|---|---|
| `gctrl install` | Detect infra (Neo4j/Qdrant/Ollama/GPU), write `~/gctrl/.env`, `docker compose up -d`, wait for the UI |
| `gctrl update` | Re-pull `compose.yml` + images and restart, **preserving** your `.env` and generated secrets |
| `gctrl up` / `gctrl down` | Start / stop the installed stack |
| `gctrl status` | `docker compose ps` |
| `gctrl logs` | Tail logs (`--no-follow` to print and exit) |

## Non-interactive install

Honors the same environment variables as the shell installer:

```bash
GCTRL_MODEL=qwen2.5:7b GCTRL_RUNTIME=vllm gctrl install
```

- `GCTRL_MODEL` - local generation model (default `llama3.2:3b`)
- `GCTRL_RUNTIME=vllm` - enable vLLM (only on NVIDIA hosts with 8 GB+ VRAM)
- `GCTRL_INSTALL_DIR` - install location (default `~/gctrl`)

## How it relates to the curl installer

`curl -fsSL https://gctrl.tech/install | bash` still works and is unchanged. This
package installs the **same** stack by reusing the same server-side artifacts
(`https://gctrl.tech/compose.yml`, the license public key, the pinned image tags).
Picking pip vs curl changes nothing about GCTRL itself, only how you bootstrap it.

Not to be confused with the `@gctrl/cli` npm package, which *talks to* a running
instance's API. This package *installs and runs* the stack.

Docs: <https://gctrl.tech/docs> · License: AGPL-3.0-or-later
