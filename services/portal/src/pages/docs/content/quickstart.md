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

## 4. Test ingestion and check the knowledge graph

Prove the loop end to end before wiring up an agent. Pick whichever path you like:

- **In the UI:** use **Upload / Import** to drop a **PDF** (or paste text). KEX extracts entities and relations; open the **Visual Explorer** or **Wiki** to see the graph, then ask questions in **Talk-to-Graph**.
- **From the API:**

```bash
curl -X POST http://localhost:4000/api/kex/extract \
  -H "Authorization: ApiKey <your-access-token>" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Ada Lovelace worked with Charles Babbage on the Analytical Engine in 1843." }'
```

(Create an access token under **Access Control**, or reuse the one from the onboarding's "Connect your agent" step.)

You'll see entities (Ada Lovelace, Charles Babbage, Analytical Engine) and their relations land in the graph — grounded, traceable, and local.

## 5. Connect your agent

The last step, and the point of the whole exercise: give an AI agent durable, access-controlled memory instead of a blank context window every session.

1. Go to **Settings → Agent** and click **Generate full-access token**. Copy it — it's shown only once. Scope tighter tokens per knowledge base or clearance level in **Access Control**.
2. Pick a connection method:
   - **MCP clients** (Claude Code, Codex, Cursor, Claude Desktop, and anywhere else that speaks MCP) — drop this into the client's MCP config:

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

     (A local stdio variant for desktop/IDE agents is in [Agents & MCP](agents-mcp.md).) Remote agents need the MCP-over-HTTP gateway enabled (**Settings → Agent** — off by default). No extra port to open — the gateway rides the same origin as the app UI (`:3001`, or your TLS domain / tailnet hostname once you expose it, see [Networking & Ports](networking.md)).
   - **Any other agent framework** (LangChain, LlamaIndex, a custom harness) — drop in `GET /api/agent/skill.md` as the agent's system instructions and call tools directly at `POST /api/agent/tools/<tool>` with the same `Authorization: ApiKey` header. No MCP client required.
3. **Install the skill.** The MCP config gives the agent tools; the skill teaches it how to use them — read the right memory layer, and always write conclusions back so GCTRL compounds instead of starting cold. Click **Copy skill.md** next to the MCP config (onboarding, or Settings → Agent), or fetch it directly from **[gctrl.tech/skill.md](https://gctrl.tech/skill.md)**. Full per-client install steps: [Install the GCTRL Skill](memory-skill.md).
4. Ask your agent: *"Ingest this PDF and show me the knowledge graph."* Agents can call `ingest_file` directly, so they don't need the UI upload step at all.

Your agent now has durable, access-controlled, audited memory — GCTRL becomes a memory node in your agent team.

→ Detail: [Access Control](access-control.md) · [Agents & MCP](agents-mcp.md) · [Install the GCTRL Skill](memory-skill.md) · [Integrations](integrations.md).

## You're operational

From here: merge multiple sources with **FUSE**, browse the auto-distilled **Wiki**, and ask grounded questions in **Talk-to-Graph** — all over the same graph, all on your machine.

### Expose it (optional)

Everything above runs on `localhost`. If you want to reach your install from another machine — a remote agent, a teammate, a phone — see [Networking & Ports](networking.md) for the one port to open and the recommended way to do it (a TLS reverse proxy, or [Tailscale](tailscale.md) for a VPS you don't want on the public internet).

→ Next: [The Four Modules](modules.md) · [Memory Layers](memory-layers.md) · [Performance Guide](performance.md)
