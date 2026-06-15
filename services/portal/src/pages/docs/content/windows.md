# Windows Install

This guide walks through a complete installation of GCTRL on Windows. GCTRL runs as Docker containers; on Windows those containers run through **Docker Desktop with the WSL 2 backend**. You run the installer from inside a WSL 2 (Ubuntu) terminal and access the dashboard from your normal Windows browser.

For full performance you also install **native Ollama for Windows** (GPU-accelerated) and point GCTRL at it — see [Infrastructure](infrastructure.md) for the why behind this. The general install flow mirrors [Installation](installation.md), adapted for Windows.

## Overview

| Step | What you do |
|------|-------------|
| 1 | Install Docker Desktop for Windows (WSL 2 backend). |
| 2 | Install WSL 2 + Ubuntu, enable Docker WSL integration. |
| 3 | Install native Ollama for Windows and pull a model. |
| 4 | Run the GCTRL installer inside the Ubuntu (WSL) terminal. |
| 5 | Open the dashboard, create your admin account, enter your license. |
| 6 | Point GCTRL at native Ollama for GPU acceleration. |

## Requirements

| Requirement | Notes |
|-------------|-------|
| **Windows 10/11** | 64-bit, with virtualization enabled in BIOS/UEFI. |
| **Docker Desktop** | With the WSL 2 based engine. |
| **WSL 2** + **Ubuntu** | The installer runs from inside the Ubuntu shell. |
| **16 GB+ RAM** | Minimum. Larger models need more. |
| **NVIDIA GPU (recommended)** | Used via native Ollama for full performance. |

## Step 1 — Install Docker Desktop

1. Download Docker Desktop for Windows from https://www.docker.com/products/docker-desktop and install it.
2. Launch Docker Desktop.
3. Open **Settings → General** and confirm **Use the WSL 2 based engine** is enabled.
4. Keep Docker Desktop running. The GCTRL containers run through it.

> Docker Desktop must be running whenever you use GCTRL. If it is stopped, the platform will not start.

## Step 2 — Install WSL 2 and Ubuntu

1. Open **PowerShell as Administrator**.
2. Install WSL with the default Ubuntu distribution:

   ```powershell
   wsl --install
   ```

3. **Reboot** when prompted.
4. After reboot, finish the Ubuntu first-run setup (create your Linux username and password).
5. Back in Docker Desktop, open **Settings → Resources → WSL Integration** and **enable integration for your Ubuntu distro**. Apply and restart Docker Desktop if asked.

This lets Docker Desktop run containers inside the WSL 2 environment that your Ubuntu shell talks to.

## Step 3 — Install native Ollama for Windows

This step unlocks GPU acceleration. The Ollama bundled inside Docker is **CPU-only** — Docker cannot reach your NVIDIA GPU. Installing Ollama natively on Windows lets GCTRL use the GPU for both the RAG/agent path and KEX extraction and embeddings. See [Infrastructure](infrastructure.md) for more detail.

1. Download **Ollama for Windows** (native, NVIDIA-GPU accelerated) from https://ollama.com/download.
2. Install and run it.
3. Open **PowerShell** and pull a model:

   ```powershell
   ollama pull qwen2.5:7b
   ```

   On machines with more RAM/VRAM you can pull a larger model such as `qwen2.5:14b` or `qwen2.5:32b`.

You connect GCTRL to this native Ollama in step 6.

## Step 4 — Run the GCTRL installer

1. Open an **Ubuntu (WSL) terminal** (search "Ubuntu" in the Start menu, or run `wsl` in PowerShell).
2. Run the installer:

   ```bash
   curl -fsSL https://gctrl.tech/install | bash
   ```

   Docker Desktop runs the containers via WSL 2, so no extra Docker setup is needed inside Ubuntu.

3. The installer is interactive on first run: it detects existing services, lets you pick a model, brings up the stack, and deploys the **FUSE** resolution engine automatically.

To skip the model picker for a scripted install, set the model up front:

```bash
GCTRL_MODEL=qwen2.5:7b curl -fsSL https://gctrl.tech/install | bash
```

### Ports

| Service | Port |
|---------|------|
| Dashboard | `3001` |
| API | `4000` |
| KEX (extraction) | `4010` |
| FUSE (fusion / entity resolution) | `4020` |
| License agent | `7070` |

## Step 5 — Create your account and activate

1. Open **http://localhost:3001** in your Windows browser.
2. Create your admin account.
3. Enter your license key in the format:

   ```
   GCTRL-XXXX-XXXX-XXXX-XXXX-XXXX
   ```

For more on licensing, see [Activation](activation.md).

## Step 6 — Point GCTRL at native Ollama

This repoints **both** the RAG/agent path **and** KEX extraction and embeddings to your native, GPU-accelerated Ollama.

1. In the dashboard, go to **Settings → Infrastructure**.
2. Set the **Ollama base URL** to:

   ```
   http://host.docker.internal:11434
   ```

3. Save.

`host.docker.internal` is how containers reach a service running on your Windows host, so this points the in-container GCTRL at the native Windows Ollama from step 3.

Without this switch, GCTRL keeps using the bundled CPU-only Ollama — fine to start, slow for real work. See [Infrastructure](infrastructure.md) for details on the inference path.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `localhost:3001` does not load | Confirm **Docker Desktop is running**. Then check **Settings → Resources → WSL Integration** is enabled for your Ubuntu distro. |
| Installer can't reach Docker from Ubuntu | Re-enable WSL Integration for your distro in Docker Desktop and restart Docker Desktop. |
| Model runs out of memory | Pick a smaller model (for example `qwen2.5:7b` instead of a 14b/32b variant). Re-run with `GCTRL_MODEL=qwen2.5:7b`. |
| GPU is not being used | Confirm you installed **native Ollama for Windows** (step 3) and set the Ollama base URL to `http://host.docker.internal:11434` (step 6). The bundled Docker Ollama is CPU-only. |
| `wsl --install` fails | Ensure virtualization is enabled in BIOS/UEFI, then re-run PowerShell as Administrator. |

## Next steps

- [Activation](activation.md) — create your admin account and enter your license key.
- [Infrastructure](infrastructure.md) — native Ollama, GPU, and swappable backing stores.
- [Quickstart](quickstart.md) — your first extraction and graph.
