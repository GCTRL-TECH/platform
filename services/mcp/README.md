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

## Setup for Claude Code

Add to your Claude Code MCP settings (`.claude/settings.json` or via `/mcp add`):

```json
{
  "mcpServers": {
    "gctrl": {
      "command": "node",
      "args": ["/path/to/gctrl/services/mcp/dist/index.js"],
      "env": {
        "GCTRL_API_URL": "http://localhost:4000/api",
        "GCTRL_API_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

## Get a Token

```bash
curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@gctrl.tech","password":"GCTRL2026"}' | jq -r '.token'
```

## Build

```bash
cd borghive/services/mcp
npm install
npm run build
```
