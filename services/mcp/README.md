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
| `gctrl_code_index` | Index a local repo into a Codebase KB (compilation type CODE). **Direct mode only** (it indexes THIS machine, so a gateway cannot serve it) and needs the optional `@gctrl/code-indexer` package - without it the tool returns an install hint and every other tool keeps working. |
| `gctrl_code_symbol` | Find code symbols by name/path/regex (proxied to the HTTP gateway) |
| `gctrl_code_trace` | Trace callers/callees of a symbol (proxied to the HTTP gateway) |
| `gctrl_code_impact` | Impact analysis for changed symbols/files (proxied to the HTTP gateway) |
| `gctrl_code_architecture` | Languages, hotspots, communities for a Codebase KB (proxied to the HTTP gateway) |

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
| `GCTRL_MCP_TOOLS` | Optional tool-set filter. Set to `code` to register only the local code tools (`gctrl_code_index`, `gctrl_code_symbol`, `gctrl_code_trace`, `gctrl_code_impact`, `gctrl_code_architecture`) — used for the Anvil/Hermes `gctrl-code` stdio entry, kept separate from the HTTP-gateway `gctrl`/`gctrl-projekt` entries. Direct mode only: in gateway mode the gateway's own tool list is proxied verbatim, so the filter has no effect and the server says so on startup. |

Dev-only fallback: `GCTRL_EMAIL` + `GCTRL_PASSWORD` (full-clearance JWT). Avoid in production.

## Build from source

```bash
cd borghive/services/mcp
npm install
npm run build
```

### Working on the code indexer

`@gctrl/code-indexer` is an **optional** dependency and is not on npm yet, so a plain
`npm install` here will not fetch it. To develop or test `gctrl_code_index` against the
in-repo package, link it once:

```bash
cd borghive/packages/code-indexer && npm ci && npm run build
cd ../../services/mcp && npm install ../../packages/code-indexer --no-save
# or: npm link ../../packages/code-indexer
```

The server's types for the indexer are declared locally, so `npm run build` passes with
or without the package installed - the difference is only whether `gctrl_code_index`
works at runtime or returns its install hint.

### Publish order

`gctrl-mcp` and `@gctrl/code-indexer` are two npm packages and must go out in this order:

1. Publish `@gctrl/code-indexer@0.1.0`.
2. Switch `optionalDependencies` in `services/mcp/package.json` to a real registry range
   (it already reads `^0.1.0`; confirm it resolves) and re-run `npm install`.
3. Bump `gctrl-mcp` to `1.1.0` (package.json + package-lock.json root).
4. Publish `gctrl-mcp`.

Bumping `gctrl-mcp` BEFORE the indexer is on npm would break `npx gctrl-mcp` for every
existing user - which is exactly why the version sits at `1.0.1` today.
