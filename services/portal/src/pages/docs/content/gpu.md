# Use Your GPU (native Ollama)

GCTRL ships with a **bundled Ollama** so it works out of the box — but that one
runs inside Docker, which is **CPU-only** (Docker can't reach your GPU: Apple
Metal, or NVIDIA/AMD on Windows/Linux). For GPU speed, run **Ollama natively** on
the host and point GCTRL at it.

It's two short steps.

## 1. Expose native Ollama to GCTRL

Native Ollama listens on `127.0.0.1` (localhost) by default — only the host can
reach it, **not** the GCTRL containers. Tell Ollama to listen on all interfaces by
setting `OLLAMA_HOST=0.0.0.0:11434`, then restart it. This is Ollama's own setting
— one environment variable, no GCTRL-specific change.

### Linux (systemd)

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' | \
  sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

### macOS

```bash
launchctl setenv OLLAMA_HOST "0.0.0.0:11434"
# then quit and reopen the Ollama app (menu bar)
```

### Windows

```powershell
setx OLLAMA_HOST "0.0.0.0:11434"
# then quit Ollama from the system tray and reopen it
```

> **Security note:** `0.0.0.0` makes Ollama reachable from your network, not just
> localhost. On a trusted/private machine that's fine; on an exposed host, firewall
> port `11434` to the Docker bridge only.

## 2. Point GCTRL at it

In the dashboard, go to **Settings → AI Models** (or **Infrastructure**) and set the
Ollama base URL to:

```
http://localhost:11434
```

GCTRL automatically routes `localhost` to your host (`host.docker.internal`) from
inside the containers — so the natural value just works. Click **Test connection**;
once it's reachable, your installed models (and GPU) appear.

## What GCTRL does for you

- **Auto-routing:** you can paste `localhost:11434` — GCTRL rewrites it to reach
  your host, so you don't need to know `host.docker.internal`.
- **Safe fallback:** if the installer finds a native Ollama that's localhost-only,
  it keeps the **bundled CPU Ollama** running so the platform still works out of the
  box — you switch to native (GPU) whenever you're ready, with no downtime.
- **Guided UI:** when Ollama isn't reachable, **Settings → AI Models** shows these
  exact commands for your OS with a one-click **Test again**.

## Models and VRAM

The GPU only helps for models that **fit in VRAM**. As a rough guide: embeddings
(`nomic-embed-text`) and small models (`llama3.2:3b`, `qwen2.5:3b`) fit in ~3–4 GB;
`qwen2.5:7b` needs ~6 GB; larger models need proportionally more. A model that
doesn't fit falls back to CPU (slow) or fails to load — pick a model sized for your
GPU, or use a cloud model for the big ones.

→ Related: [LLM Providers](llm-providers.md) · [Infrastructure & Ollama](infrastructure.md) · [Installation](installation.md)
