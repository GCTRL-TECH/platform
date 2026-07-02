# GCTRL Agent Skill

Teach an external coding agent (Claude Code, Cursor, Codex, or any MCP-capable CLI) to use a GCTRL knowledge base as its long-term memory: when to retrieve, how to descend the tool ladder without flooding its context, and how to write conclusions back so memory compounds.

Three variants of the same behavior, one per agent:

| File | Target |
|---|---|
| `gctrl/SKILL.md` | Claude Code skill |
| `cursor/gctrl.mdc` | Cursor rules file |
| `codex/AGENTS-snippet.md` | AGENTS.md section for Codex and other CLIs |

The skill teaches behavior, not the API. The full tool reference lives in the GCTRL docs under "Agents & MCP".

## Prerequisite: a scoped access token

Create a token in the GCTRL portal: **Settings → Access Control → New Token**. Pick a clearance ceiling, grant the knowledge base(s) the agent may use (read + write), and toggle **KB-scoped** mode so the token sees nothing else. The token looks like `gctrl_…` and is sent as `Authorization: ApiKey gctrl_…`.

## 1. Connect the MCP server

Two transports; pick one.

### a) stdio (local — agent and GCTRL on the same machine or LAN)

Build once: `cd services/mcp && npm install && npm run build`. Then in the project's `.mcp.json` (Claude Code) or the equivalent MCP config (Cursor: `.cursor/mcp.json`; Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gctrl": {
      "command": "node",
      "args": ["/path/to/borghive/services/mcp/dist/index.js"],
      "env": {
        "GCTRL_API_URL": "http://localhost:4000/api",
        "GCTRL_API_TOKEN": "gctrl_your_scoped_token"
      }
    }
  }
}
```

Tools appear as `gctrl_*` (e.g. `gctrl_search_entities`). To reach a networked GCTRL through the same stdio server, set `GCTRL_GATEWAY_URL` (e.g. `http://<gctrl-host>:3001/api/agent/mcp`) instead of `GCTRL_API_URL` — the server then proxies the remote gateway's tools (unprefixed names).

### b) HTTP gateway (remote — direct MCP-over-HTTP, no local Node needed)

```json
{
  "mcpServers": {
    "gctrl": {
      "type": "http",
      "url": "http://<gctrl-host>:3001/api/agent/mcp",
      "headers": { "Authorization": "ApiKey gctrl_your_scoped_token" }
    }
  }
}
```

The gateway is off by default: set `GCTRL_AGENT_GATEWAY_ENABLED=true` in the API server environment (or enable it in Settings → Agent) and restart. Port 3001 is the bundled web server, which proxies `/api/*`; the API service itself answers on 4000 with the same path. Gateway tools use unprefixed names (`search_entities`, `get_dossier`, …).

## 2. Install the skill

### Claude Code

Copy the skill directory into the project (or user-level for all projects):

```bash
mkdir -p .claude/skills/gctrl
cp sdk/claude-skill/gctrl/SKILL.md .claude/skills/gctrl/SKILL.md
# user-level alternative: ~/.claude/skills/gctrl/SKILL.md
```

Claude Code loads the skill's trigger description automatically; the body is pulled in when it fires.

### Cursor

```bash
mkdir -p .cursor/rules
cp sdk/claude-skill/cursor/gctrl.mdc .cursor/rules/gctrl.mdc
```

The rule is description-triggered (`alwaysApply: false`); Cursor's agent attaches it when a request matches the description.

### Codex / other CLIs

Append the section from `codex/AGENTS-snippet.md` to the project's `AGENTS.md`. Configure the MCP server per that CLI's mechanism (Codex: `~/.codex/config.toml` `mcp_servers` block pointing at the same stdio command/env as above).

## 3. Smoke test (5 questions)

Start a fresh agent session in a project with the skill installed and a token scoped to a populated knowledge base. Ask, in order:

1. "What knowledge bases can you see right now?" — must call `list_graphs` and name them, not guess.
2. "Who is <a person in the KB> and what do they own?" — must probe/dossier, then answer with facts and provenance, without hedging.
3. "What do we know about <a project in the KB>?" — must retrieve before answering; the answer cites facts that only exist in the KB.
4. "Where does the fact that <known fact> come from?" — must return an origin file/source, not "I don't have access".
5. "We just decided <invent a small decision>. Make sure we don't lose that." — must `store` into an explicit compilationId and confirm which KB it wrote to.

Pass: all five answered with tool calls (visible in the transcript), no hallucinated entities, and question 5 produces a write. If the agent answers 2–4 from general knowledge without touching GCTRL, the skill is not loading — check the install path and that the MCP server is listed by the client.

## Honest limits

Retrieval is only as good as what was ingested: if the KB is thin, answers will be thin. The skill makes the agent say "not on record" instead of inventing — it cannot conjure facts that were never extracted. Scoped tokens also hide out-of-scope KBs entirely; a "missing" entity may simply be out of scope.

## Evaluation

`VERIFY.md` in this directory contains a 10-question dogfood protocol with scoring for measuring retrieval triggering and context discipline on a cold-start agent.
