# Infrastructure

**Settings → Infrastructure** is where you repoint GCTRL at external storage and, most importantly, at **GPU-accelerated inference**. This is the single highest-impact configuration page for performance.

## Pointing at external services

GCTRL ships with bundled Neo4j, Qdrant, Postgres, and Ollama, but you can point it at your own. Every endpoint is **env-overridable** and configurable from **Settings → Infrastructure**:

| Service | Type | When changes apply |
|---------|------|--------------------|
| **Qdrant** | HTTP | **Immediately** |
| **Ollama** | HTTP | **Immediately** |
| **Neo4j** | Pooled DB | After a **restart** |
| **Postgres** | Pooled DB | After a **restart** |

HTTP services (Qdrant, Ollama) re-target on the fly. Pooled database connections (Neo4j, Postgres) hold a connection pool, so changes take effect after a restart.

## The big one: switch to native Ollama for GPU acceleration

The bundled Ollama runs **inside Docker**. On **macOS / Apple Silicon, Docker cannot access the Apple GPU (Metal)** — so the containerized Ollama runs **CPU-only**, leaving the machine's GPU and unified memory completely unused. On a capable Mac this is the difference between sluggish and fast.

**The fix: run Ollama natively on the host and point GCTRL at it.** One setting repoints **both** the RAG/agent path **and** KEX extraction/embeddings to the GPU-accelerated native Ollama.

### macOS / Apple Silicon

1. **Install Ollama natively:**

   ```bash
   brew install ollama
   ```

   (or install the app from [ollama.com](https://ollama.com)).

2. **Pull a model:**

   ```bash
   ollama pull qwen2.5:7b
   ```

3. **Repoint GCTRL.** In **Settings → Infrastructure**, set the Ollama base URL to:

   ```
   http://host.docker.internal:11434
   ```

   `host.docker.internal` lets the containers reach the host's native Ollama. The change applies immediately (Ollama is an HTTP service).

That **one switch** routes **both**:

- the **RAG / agent path** (Talk-to-Graph generation), **and**
- **KEX extraction and embeddings**

to the native, GPU-accelerated Ollama — recovering the Apple GPU and unified memory the Docker path could never touch.

### Linux

The same idea applies on Linux: run a **host-native Ollama with a GPU** (e.g. an NVIDIA card) instead of the bundled container, then set the Ollama base URL in **Settings → Infrastructure** to your host-native Ollama endpoint. As on macOS, the one switch repoints both the RAG/agent path and KEX extraction/embeddings.

## See also

- [Performance](performance.md) — the full best-performance guide, where native Ollama is the biggest lever
- [LLM Providers](llm-providers.md) — model and provider selection
