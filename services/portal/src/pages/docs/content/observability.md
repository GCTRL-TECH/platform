# Observability & Tracing (Phoenix)

GCTRL can trace every extraction, retrieval and LLM call end to end, so you can
see **where the time actually goes** instead of guessing. It uses
[Arize Phoenix](https://github.com/Arize-ai/phoenix), an open-source LLM
observability tool that you run **yourself**.

It is **off by default**. Nothing is collected, and no exporter is even wired up,
until you point GCTRL at a Phoenix instance.

## Why it matters

"The extraction feels slow" is not actionable. A trace is. With tracing on you
can answer, in seconds:

- Is the time going into entity recognition, relation extraction, embedding, or
  the graph write?
- Which model call is the long pole - and how long did it actually take?
- Did a step fail and get retried, or silently degrade?
- Is retrieval slow because of the vector search, or the graph query?

This is how we found, for example, that a single retrieval helper's timeout was
dominating end-to-end recall latency - invisible in logs, obvious in a trace.

## Privacy: self-hosted only, on purpose

**Traces contain your prompts and knowledge content.** That is what makes them
useful, and it is also why GCTRL only ever ships them to a Phoenix instance
**you** run - never to a hosted collector, and never to us.

This is the same stance as the rest of the platform: your knowledge does not
leave your infrastructure. If you enable tracing, keep Phoenix inside your own
network and treat it with the same access controls as the graph itself. Span
payloads (documents, prompts) are truncated before export to keep traces
lightweight, but you should still assume a trace is sensitive.

## Turning it on

### 1. Run Phoenix

```bash
docker run -d --name phoenix -p 6006:6006 -p 4317:4317 \
  arizephoenix/phoenix:latest
```

- `6006` - the web UI **and** the OTLP/HTTP endpoint (`/v1/traces`)
- `4317` - OTLP/gRPC, if you prefer it

### 2. Point GCTRL at it

Set `PHOENIX_OTLP_URL` in your `.env` and restart the stack:

```bash
# Phoenix running on the Docker host:
PHOENIX_OTLP_URL=http://host.docker.internal:6006/v1/traces
```

```bash
docker compose up -d
```

On Linux, if `host.docker.internal` isn't available, use the host's LAN/bridge
address (e.g. `http://172.17.0.1:6006/v1/traces`) or put Phoenix on the same
Docker network and use `http://phoenix:6006/v1/traces`.

### 3. Open the UI

Go to `http://localhost:6006` and select the **gctrl** project. Run an
extraction or ask a question in Talk to Graph, and traces appear.

## What gets traced

Three services report into the same project, each under its own service name, so
you can see a whole job across process boundaries:

| Service | Name | What it reports |
|---|---|---|
| API | `gctrl-api` | Request-level spans for retrieval, chat and tool calls |
| KEX | `gctrl-kex` | The extraction pipeline, phase by phase |
| FUSE | `gctrl-fuse` | Merge and distillation work, one span per LLM generation |

An extraction job produces one parent span with its phases nested underneath:

| Span | Kind | What it covers |
|---|---|---|
| `kex.chunk` | CHAIN | Splitting the document into chunks |
| `kex.ner` | CHAIN | Entity recognition (carries the input size) |
| `kex.relex` | LLM | Relation extraction (carries model + provider) |
| `kex.embed` | CHAIN | Embedding the chunks (carries the embedding model) |
| `kex.vector_store` | TOOL | Writing vectors to the store |
| `kex.kg_write` | TOOL | Writing entities + relations to the graph |

Spans use **OpenInference** conventions, so Phoenix renders them as proper
LLM/CHAIN/TOOL nodes with prompts, model names and token-level detail where
available - not just opaque timers.

## Reading a trace

A few things worth looking for:

- **A fat `kex.relex` span** - relation extraction is the LLM-heavy phase. If it
  dominates, that's a model/hardware question: see
  [Cookbook: Model Tuning](/docs/cookbook) and [Use Your GPU](/docs/gpu).
- **A fat `kex.embed` span** - usually the embedding model or a CPU-only runtime.
- **A slow `kex.kg_write` or `kex.vector_store`** - that's storage, not inference.
- **Error spans** - failures are recorded on the span, so a degraded step shows
  up as a red node rather than disappearing into a log line.

## Turning it off

Unset `PHOENIX_OTLP_URL` (or set it empty) and restart. The exporter is not
wired at all when the variable is absent - services fall back to plain stdout
logging, exactly as they behave on a default install.

Tracing is also **fail-safe**: if the Phoenix endpoint is unreachable or the
exporter can't be built, GCTRL logs the problem and carries on with normal
logging. Telemetry never takes the platform down.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PHOENIX_OTLP_URL` | *(unset - tracing off)* | Full OTLP traces endpoint, e.g. `http://host.docker.internal:6006/v1/traces` |
| `PHOENIX_SERVICE_NAME` | `gctrl-api` / `gctrl-kex` / `gctrl-fuse` | Service name a container reports under (set per service in the compose file) |
| `PHOENIX_PROJECT_NAME` | `gctrl` | Phoenix project the spans land in - change it to separate environments (e.g. `gctrl-staging`) |

These are already declared for the `api`, `kex` and `fuse` services in the
shipped compose files; in a normal install you only ever set
`PHOENIX_OTLP_URL`.
