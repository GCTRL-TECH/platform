# Integrations

GCTRL connects to any MCP client, agent framework, or system that can make an HTTP call. There is no proprietary protocol to adopt — pick the transport that matches where your agent runs. Remote agents only need one thing: the web origin (port `3001`, your TLS domain, or a tailnet hostname) — see [Networking & Ports](networking.md). Full marketplace view: [gctrl.tech/integrations](/integrations).

## Connection methods

### MCP over HTTP (remote agents)

```jsonc
{
  "mcpServers": {
    "gctrl": {
      "type": "http",
      "url": "https://<your-install>/api/agent/mcp",
      "headers": { "Authorization": "ApiKey <token>" }
    }
  }
}
```

Off by default — enable the gateway in **Settings → Agent**. No separate port to open: the gateway is reachable at `/api/agent/mcp` on the same origin as the app UI.

### MCP over stdio (local agents)

```jsonc
{
  "mcpServers": {
    "gctrl": {
      "command": "node",
      "args": ["services/mcp/dist/index.js"],
      "env": { "GCTRL_API_TOKEN": "gctrl_your_scoped_token" }
    }
  }
}
```

Build once with `cd services/mcp && npm install && npm run build`.

### Direct HTTP (any framework, zero MCP)

```bash
curl -X POST https://<your-install>/api/agent/tools/search_entities \
  -H "Authorization: ApiKey <token>" \
  -H "Content-Type: application/json" \
  -d '{ "query": "Ada Lovelace" }'
```

Every tool GCTRL exposes over MCP is also callable directly at `POST /api/agent/tools/<tool>` — useful for frameworks with their own tool-calling convention. `GET /api/agent/skill.md` returns the canonical GCTRL memory skill as markdown, for frameworks that take a drop-in system-prompt file instead of an MCP config.

Every integration sees exactly the clearance and knowledge-base scope carried by its token — create tokens in [Access Control](access-control.md).

### After connecting: install the skill

Whichever transport you pick, the MCP config only gives the agent the *tools*. Right after connecting, [install the GCTRL skill](memory-skill.md) too — it teaches the agent when to read which memory layer and to always write conclusions back, which is what makes GCTRL's memory compound across sessions instead of sitting there unused. Canonical copy: [gctrl.tech/skill.md](https://gctrl.tech/skill.md).

## Coding agents

| Agent | Method |
|---|---|
| Claude Code | MCP http config in `.mcp.json` |
| Codex | MCP config (`~/.codex/config.toml`) |
| Kimi | MCP |
| Cline | MCP |
| OpenClaw | MCP or direct HTTP tools |

## IDEs

| IDE | Method |
|---|---|
| Cursor | MCP (`.cursor/mcp.json`) |
| Windsurf | MCP |
| Zed | MCP |
| VS Code + GitHub Copilot | MCP support / agent mode |

## Copilots

| Copilot | Method |
|---|---|
| Microsoft Copilot Studio | Custom connector → GCTRL REST API, `Authorization: ApiKey` header |
| GitHub Copilot | MCP in agent mode |

## Agent frameworks

| Framework | Method |
|---|---|
| Pi (built-in GCTRL agent) | Zero setup — enable in **Settings → Agent** |
| Paperclip | Drop-in: copy `skill.md` (`GET /api/agent/skill.md`), call `POST /api/agent/tools/<tool>` |
| Hermes | Same drop-in harness pattern as Paperclip |
| LangChain | HTTP tools (`POST /api/agent/tools/<tool>`) or the MCP adapter |
| LlamaIndex | Same — HTTP tools or MCP adapter |

## Automation

| Tool | Method |
|---|---|
| n8n | Native GCTRL nodes — see **Settings → n8n** |
| Webhooks | **Settings → Webhooks** |

## Knowledge sources

| Source | Method |
|---|---|
| Google Drive | Connector |
| Obsidian | Connector |
| SharePoint | Connector |
| Website crawler | Connector |
| PDF / DOCX upload | Upload in the UI, or `ingest_file` from any connected agent |

## See also

[Agents & MCP](agents-mcp.md) · [Install the GCTRL Skill](memory-skill.md) · [Access Control](access-control.md) · [Quick Start](quickstart.md)
