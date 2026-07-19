# Ground Control (GCTRL) MCP Server

Exposes Ground Control's knowledge management as MCP tools for Claude and other AI agents.

## Tools Available

| Tool | Description |
|------|-------------|
| `gctrl_extract` | Extract knowledge from text → Neo4j entities + Qdrant vectors |
| `gctrl_query` | Ask questions about knowledge graphs (hybrid RAG) |
| `gctrl_search_entities` | Search for specific entities by name/type |
| `gctrl_list_graphs` | List all knowledge graph compilations |
| `gctrl_fuse` | Merge extraction jobs into unified graphs |
| `gctrl_list_ontologies` | List available ontologies |
| `gctrl_list_extractions` | List recent extraction jobs |
| `gctrl_store` | Store knowledge (like Obsidian notes, but with KG extraction) |
| `gctrl_schema` | Get the knowledge graph schema |

### Deprecated names (alias, removal in v2)

Every tool above is also exposed under its legacy name for backwards
compatibility with existing `.mcp.json` configs. The aliases log a
deprecation warning to stderr on every invocation and **will be removed
in v2.0** — please migrate.

| Deprecated alias | Use instead |
|---|---|
| `borghive_extract` | `gctrl_extract` |
| `borghive_query` | `gctrl_query` |
| `borghive_store` | `gctrl_store` |
| `borghive_fuse` | `gctrl_fuse` |
| `borghive_search_entities` | `gctrl_search_entities` |
| `borghive_list_graphs` | `gctrl_list_graphs` |
| `borghive_list_ontologies` | `gctrl_list_ontologies` |
| `borghive_list_extractions` | `gctrl_list_extractions` |
| `borghive_schema` | `gctrl_schema` |

## Quickstart (npm)

Published on npm as [`gctrl-mcp`](https://www.npmjs.com/package/gctrl-mcp) and in the
official MCP Registry as `io.github.GCTRL-TECH/gctrl`. Add to your MCP client config
(Claude Code, Claude Desktop, Cursor, Codex, …):

```json
{
  "mcpServers": {
    "gctrl": {
      "command": "npx",
      "args": ["-y", "gctrl-mcp"],
      "env": {
        "GCTRL_GATEWAY_URL": "http://localhost:4000/api/agent/mcp",
        "GCTRL_API_TOKEN": "gctrl_..."
      }
    }
  }
}
```

Requires a running GCTRL harness ([get started](https://gctrl.tech)).

### Configuration

| Env var | Purpose |
|---|---|
| `GCTRL_GATEWAY_URL` | Recommended: URL of your harness's MCP gateway (`http://<host>:4000/api/agent/mcp`). The stdio server acts as a thin authenticated proxy. |
| `GCTRL_API_URL` | Alternative direct mode: GCTRL API base URL (`http://<host>:4000/api`); tools run locally against the API. |
| `GCTRL_API_TOKEN` | Scoped GCTRL Access Token (`gctrl_…`), created in **Settings → Access Control** with a clearance level + per-graph grants. Least privilege — the agent sees exactly what the token is cleared for. |

Dev-only fallback: `GCTRL_EMAIL` + `GCTRL_PASSWORD` (full-clearance JWT). Avoid in production.

## Build from source

```bash
cd borghive/services/mcp
npm install
npm run build
```
