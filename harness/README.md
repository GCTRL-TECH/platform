# GCTRL Knowledge Agent (Pi) — Harness

Pi is GCTRL's built-in knowledge agent, packaged so it can run **inside the
app** (the floating Pi Console) **or as a member of an external agent team**
(Hermes, OpenClaw, Paperclip, …). Think of it as the "data engineer" you add to
any team: it ingests data, searches and reads access-controlled knowledge
graphs and the source text behind them, merges graphs, and reports
classification conflicts — and it can only ever surface data the team is
allowed to see.

## Why it's safe to hand to an agent

Every tool result is filtered **server-side** by the calling token's clearance
level and per-graph grants (the Phase-1 access core). A `PUBLIC` token cannot
retrieve `INTERNAL`+ content through any tool — not by convention, but because
the API physically won't return it. Each call is written to the audit trail
(which token accessed what). This is "access-control at the speed of trust":
you give an agent a token, and it inherits exactly that token's reach.

## Connecting (3 steps)

1. **Create a scoped Access Token** in GCTRL → **Access Control → Access
   Tokens**. Choose a base clearance and, optionally, grant access to specific
   graphs. Copy the `gctrl_…` token once.
2. **Point the agent at GCTRL:**
   ```bash
   export GCTRL_API_URL=http://localhost:4000/api      # or your deployment
   export GCTRL_API_TOKEN=gctrl_xxxxxxxxxxxxxxxx
   ```
3. **Call tools** — either directly (no LLM) or conversationally.

### Direct tool call (for agent frameworks)

```bash
curl -s -X POST "$GCTRL_API_URL/agent/tools/search_chunks" \
  -H "Authorization: ApiKey $GCTRL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"who leads project Zephyr?"}'
# → { "chunks": [ { "text": "…", "score": 0.82, "source": "…" } ] }   (clearance-filtered)
```

Register each entry in [`manifest.json`](./manifest.json) as a tool in your
orchestrator; the mapping is always
`POST {GCTRL_API_URL}/agent/tools/{name}` with the args as the JSON body and
`Authorization: ApiKey {GCTRL_API_TOKEN}`.

### Conversational (SSE)

```
POST {GCTRL_API_URL}/agent/chat
{ "message": "Ingest this brief as Confidential, then tell me what a Public reader would see." }
```
Streams `token` / `tool_call` / `tool_result` / `done` events. The same tools,
driven by the model. Also available in-app as the floating Pi Console.

## Tools

| Tool | Purpose |
|------|---------|
| `list_graphs` | Graphs this token can access |
| `search_entities` | Find entities by name (clearance-filtered) |
| `get_entity` | One entity + its connections |
| `search_chunks` | Retrieve grounding source text (RAG) — cite these |
| `list_conflicts` | Open classification conflicts |
| `list_sources` | Connected data sources |
| `check_balance` | Token balance |
| `create_extraction` | Ingest text at a classification |
| `fuse_graphs` | Merge graphs by source jobs (labels preserved) |

## Team pattern

Add the GCTRL agent to a team as the data layer. When a teammate needs facts,
it asks the GCTRL agent, which retrieves **only** what the shared token is
cleared for and returns grounded passages with sources. Different teams get
different tokens → different reach, all enforced and audited centrally.
