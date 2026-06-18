# Licenses

## Ground Control (GCTRL) — own license

GCTRL is **dual-licensed**: open source under the **GNU AGPL v3** ([`/LICENSE`](../LICENSE)),
or under a **commercial license** for proprietary/closed/hosted use without AGPL
copyleft obligations. See [`/LICENSING.md`](../LICENSING.md) for the full explanation
and how to obtain a commercial license. (The `n8n-nodes-gctrl` connector is
separately MIT-licensed.)

---

# Third-Party License Notices

Ground Control bundles and runs the following third-party software, each as an
**independent component** (a separate container or a library) — unmodified and
accessed over standard network or library interfaces. Licenses are listed as
integrated; consult each project for the authoritative, version- and
edition-specific terms.

| Component | Role in GCTRL | License | Source |
|---|---|---|---|
| **Neo4j** (Community Edition) | Graph database | GPL-3.0 | https://github.com/neo4j/neo4j |
| **Qdrant** | Vector database | Apache-2.0 | https://github.com/qdrant/qdrant |
| **PostgreSQL** | Relational store | PostgreSQL License | https://www.postgresql.org |
| **Redis** | Cache & job queue | BSD-3 / RSALv2 / AGPL-3.0 (version-dependent) | https://github.com/redis/redis |
| **Ollama** | Local LLM runtime | MIT | https://github.com/ollama/ollama |
| **GLiNER** | Zero-shot entity recognition | Apache-2.0 | https://github.com/urchade/GLiNER |
| **Qwen2.5** | Relation-extraction model | Apache-2.0 / Qwen License (per model size) | https://github.com/QwenLM/Qwen2.5 |
| **nomic-embed-text** | Text embeddings | Apache-2.0 | https://huggingface.co/nomic-ai/nomic-embed-text-v1.5 |
| **LIMES** | Link discovery / entity resolution | AGPL-3.0 | https://github.com/dice-group/LIMES |
| **React** | Web UI | MIT | https://github.com/facebook/react |
| **Vite** | Web build tooling | MIT | https://github.com/vitejs/vite |
| **Axum / Tokio** | Rust API + async runtime | MIT | https://github.com/tokio-rs/axum |
| **FastAPI** | Python service framework | MIT | https://github.com/fastapi/fastapi |

> License terms above are provided for convenience and reflect each component as
> integrated. Some are version- or model-specific (e.g. Redis by version, Qwen2.5
> by model size, model weights by card) — always defer to the upstream project for
> the authoritative license.

### Copyleft components (AGPL / GPL)

Some components above carry strong copyleft terms — notably **LIMES** (AGPL-3.0)
and **Neo4j Community Edition** (GPL-3.0). Ground Control runs each as an
**unmodified, separately-running service** (its own container), communicating only
over the network. They are not incorporated into, statically linked with, or
modified by Ground Control's own codebase, so they are not derivative works of
GCTRL. Their source remains publicly available at the URLs above; if any such
component is ever modified, the modified source will be published in accordance
with its license.
