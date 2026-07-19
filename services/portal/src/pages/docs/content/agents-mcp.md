# Agents & MCP

GCTRL exposes its knowledge graph and memory layers to AI agents over the **Model Context Protocol (MCP)**. Connect an agent once and it gains durable, organised, access-controlled memory - GCTRL becomes a **memory node** in your agent team.

## What an agent gets

GCTRL exposes roughly **30 MCP tools**, split into read and write operations. Every call is **clearance-filtered** (an agent only sees the knowledge bases and classifications it is granted) and **audited** (every call is logged).

**Read tools (examples)**

| Tool | Returns |
|------|---------|
| `list_graphs` | Available compilations / knowledge bases |
| `search_entities` | Entities matching a query |
| `get_entity` | A single entity and its attributes |
| `get_neighbors` | Adjacent entities in the graph |
| `shortest_path` | Path between two entities |
| `get_dossier` | HOT authoritative dossier for an entity |
| `search_chunks` | WARM evidence passages (vector + lexical) |
| `wiki_page` | Curated WIKI prose for an entity/topic |
| `memory_health` | Tier coverage, sizes, heat/trust snapshot |

**Write tools (examples)**

| Tool | Effect |
|------|--------|
| `extract` | Run KEX over new source |
| `fuse` | Merge extraction jobs into the graph |
| `store` | Write a fact / entity |
| `correct` | Correct a wrong fact (never re-extracted) |
| `add_relationships` | Link entities |
| `pin_dossier` | Pin a HOT dossier so it is never evicted |
| `run_maintenance` | Trigger the memory governance cycle |

## Two transports

GCTRL offers two ways to connect, depending on where the agent runs.

### 1. Local stdio MCP server

A local MCP server (`services/mcp`) for desktop / IDE agents - **Claude Code, Claude Desktop, Cursor**. It speaks MCP over stdio and authenticates with a **scoped token** (`GCTRL_API_TOKEN`).

```json
{
  "mcpServers": {
    "gctrl": {
      "command": "node",
      "args": ["services/mcp/index.js"],
      "env": {
        "GCTRL_API_TOKEN": "gctrl_scoped_token_here"
      }
    }
  }
}
```

### 2. MCP-over-HTTP gateway

An HTTP gateway (`POST /api/agent/mcp`) for **remote / multi-agent orchestrators** - e.g. Hermes, Codex. It is **off by default** and enabled per deployment.

```bash
# Environment for a remote agent
export GCTRL_API_TOKEN="gctrl_scoped_token_here"
export GCTRL_GATEWAY_URL="https://your-gctrl-host/api/agent/mcp"
```

```jsonc
// Orchestrator-side MCP config (illustrative)
{
  "mcpServers": {
    "gctrl": {
      "type": "http",
      "url": "https://your-gctrl-host/api/agent/mcp",
      "headers": { "Authorization": "ApiKey ${GCTRL_API_TOKEN}" }
    }
  }
}
```

| | stdio MCP server | HTTP gateway |
|---|---|---|
| For | Claude Code / Desktop / Cursor | Remote / multi-agent orchestrators |
| Location | `services/mcp` (local) | `POST /api/agent/mcp` |
| Default | On | **Off** (enable per deployment) |
| Auth | `GCTRL_API_TOKEN` | `GCTRL_API_TOKEN` + `GCTRL_GATEWAY_URL` |

## Install the skill

The skill teaches the agent _when_ to retrieve, how to descend the tool ladder without flooding context, and how to write conclusions back so memory compounds. Without it the tools are available but the agent has no discipline about using them. **Do this right after wiring up the MCP config above.**

The canonical, always-current copy is served at `GET /api/agent/skill.md` on your own instance, and publicly mirrored at **[gctrl.tech/skill.md](https://gctrl.tech/skill.md)**. Full per-client install commands (Claude Code, Cursor, Codex/AGENTS.md, or paste-as-system-prompt) live on the **[Install the GCTRL Skill](memory-skill.md)** page - this section just covers the token you'll need first.

### Create a scoped access token

In the GCTRL portal: **Settings → Access Control → New Token**. Pick a clearance ceiling, grant the knowledge bases the agent may use, and toggle **KB-scoped** mode. The token is sent as:

```
Authorization: ApiKey gctrl_your_scoped_token
```

> **Settings shortcut** - the **Settings → Agent** Harness tab and the onboarding wizard's "Connect Agent" step both have a one-click **Copy skill.md** button alongside the MCP config, with your instance URL pre-filled.

## GCTRL as a memory node

Once connected, GCTRL slots into your existing agent team as the **shared memory node**. Your agents gain:

- **Durable memory** - knowledge survives across sessions in the backing stores.
- **Organised memory** - read the right tier (dossier / chunks / graph / wiki) per question.
- **Access-controlled memory** - scoped tokens mean each agent only touches its granted KBs, and every access is audited.

GCTRL also runs **its own internal agent** - the agentic deep-RAG mode in Talk-to-Graph - which performs multi-hop reasoning over the graph on the platform's behalf.

## See also

[Modules](modules.md) · [Memory Layers](memory-layers.md) · [GCTRL Memory Skill](memory-skill.md) · [Architecture](architecture.md)
