# Quick Start

Get from zero to a working, queryable knowledge graph — and an AI agent that can read and write it — in about ten minutes. Each step links to a deeper page if you want the detail.

> **Optional prerequisite — native Ollama (recommended for speed).** The bundled Ollama runs inside Docker and is **CPU-only**. For GPU acceleration (Apple Metal, or NVIDIA on Windows/Linux), install [Ollama](https://ollama.com/download) **natively** on the host first. If you want Ollama's hosted cloud models too, run `ollama login`. You can also do this later — see step 2.

## 1. Install GCTRL

One command brings up the whole stack:

```bash
curl -fsSL https://gctrl.tech/install | bash
```

The installer detects what you already run (Neo4j / Qdrant / Ollama), deploys only what's missing, lets you pick a model, and starts everything. When it finishes, the dashboard is at **`http://localhost:3001`**.

→ Detail: [Installation](installation.md) · on Windows use [Docker Desktop + WSL 2](windows.md).

## 2. Set up your LLM (local, or native Ollama for GPU)

On first run the installer pulls a local model so you can start immediately. For real performance, run **Ollama natively** (GPU) and point GCTRL at it in **Settings → Infrastructure** — this is the single biggest speed lever. Choose or switch models any time in **Settings → AI Models**, where you can also one-click-install the recommended embedding/extraction models.

→ Detail: [LLM Providers](llm-providers.md) · [Infrastructure & Ollama](infrastructure.md).

## 3. Register, get a license key, and activate

1. **Register at [gctrl.tech](https://gctrl.tech)** to get your license key.
2. Open the dashboard at **`http://localhost:3001`** and **create your admin account** — the first account on a fresh install becomes the administrator.
3. Go to **Settings → License**, paste your key, and click **Activate**.

Activation is hardware-bound and unlocks the tuned entity-resolution profile for your deployment. Without a key the platform still runs on safe generic defaults. Your data never leaves the machine.

→ Detail: [Activation & Setup](activation.md).

## 4. Create a full-access token for your agent

To let an AI agent operate GCTRL:

1. Go to **Settings → Agent** and click **Generate full-access token**. Copy it — it's shown only once.
2. **Remote agents:** the MCP-over-HTTP gateway is **off by default**. Enable it for your deployment, and make sure the **API port (`:4000`) is reachable** from where your agent runs (forward/expose the port, or run the agent on the same host).

You can scope tokens per knowledge base or clearance level later in **Access Control**.

→ Detail: [Access Control](access-control.md) · [Agents & MCP](agents-mcp.md).

## 5. Connect your agent (MCP)

Drop the GCTRL MCP server into **Claude Code, Codex, Cursor, Claude Desktop** — anywhere that speaks MCP — using your token. For the HTTP gateway:

```jsonc
{
  "mcpServers": {
    "gctrl": {
      "type": "http",
      "url": "http://localhost:4000/api/agent/mcp",
      "headers": { "Authorization": "ApiKey YOUR_TOKEN" }
    }
  }
}
```

(A local stdio variant for desktop/IDE agents is in [Agents & MCP](agents-mcp.md).) Your agent now has durable, access-controlled, audited memory — GCTRL becomes a memory node in your agent team.

## 6. Test ingestion and check the knowledge graph

Prove the loop end to end. Pick whichever path you like:

- **In the UI:** use **Upload / Import** to drop a **PDF** (or paste text). KEX extracts entities and relations; open the **Visual Explorer** or **Wiki** to see the graph, then ask questions in **Talk-to-Graph**.
- **From your agent:** *"Ingest this PDF and show me the knowledge graph."* — the agent runs the same tools and reports back.
- **From the API:**

```bash
curl -X POST http://localhost:4000/kex/extract \
  -H "Content-Type: application/json" \
  -d '{ "text": "Ada Lovelace worked with Charles Babbage on the Analytical Engine in 1843." }'
```

You'll see entities (Ada Lovelace, Charles Babbage, Analytical Engine) and their relations land in the graph — grounded, traceable, and local.

## You're operational

From here: merge multiple sources with **FUSE**, browse the auto-distilled **Wiki**, and ask grounded questions in **Talk-to-Graph** — all over the same graph, all on your machine.

→ Next: [The Four Modules](modules.md) · [Memory Layers](memory-layers.md) · [Performance Guide](performance.md)
