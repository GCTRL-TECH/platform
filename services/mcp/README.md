# GCTRL MCP Server

Exposes GCTRL's knowledge management as MCP tools for Claude and other AI agents.

## Tools Available

| Tool | Description |
|------|-------------|
| `GCTRL_extract` | Extract knowledge from text → Neo4j entities + Qdrant vectors |
| `GCTRL_query` | Ask questions about knowledge graphs (hybrid RAG) |
| `GCTRL_search_entities` | Search for specific entities by name/type |
| `GCTRL_list_graphs` | List all knowledge graph compilations |
| `GCTRL_fuse` | Merge extraction jobs into unified graphs |
| `GCTRL_list_ontologies` | List available ontologies |
| `GCTRL_list_extractions` | List recent extraction jobs |
| `GCTRL_store` | Store knowledge (like Obsidian notes, but with KG extraction) |
| `GCTRL_schema` | Get the knowledge graph schema |

## Setup for Claude Code

Add to your Claude Code MCP settings (`.claude/settings.json` or via `/mcp add`):

```json
{
  "mcpServers": {
    "GCTRL": {
      "command": "node",
      "args": ["d:/N8N/Projekte/Databorg/GCTRL/services/mcp/dist/index.js"],
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
  -d '{"email":"admin@GCTRL.dev","password":"GCTRL2026"}' | jq -r '.token'
```

## Build

```bash
cd GCTRL/services/mcp
npm install
npm run build
```

