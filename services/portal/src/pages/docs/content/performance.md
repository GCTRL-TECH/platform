# Performance

This is the best-performance guide for GCTRL. The levers are listed roughly in order of impact. Apply the first one and you will feel it immediately.

## 1. Run native Ollama on the GPU (biggest lever)

The single largest speedup is switching from the **bundled, CPU-only Ollama container** to a **host-native, GPU-accelerated Ollama**. On Apple Silicon the Docker path cannot reach the GPU (Metal) at all; on Linux a host-native Ollama uses your NVIDIA GPU directly.

One setting repoints **both** the RAG/agent path **and** KEX extraction/embeddings to the native GPU.

→ Full instructions in [Infrastructure](infrastructure.md).

## 2. Pick the right model

Match the model to the hardware and to whether you are on the CPU or GPU path:

| Model | Best for |
|-------|----------|
| **llama3.2:3b** | Small / fast - the **bundled CPU path**, where a lightweight model keeps latency usable |
| **qwen2.5:7b** | **Strong extraction quality** for KEX once you have GPU acceleration |
| **14b / 32b** | **Big-RAM machines** with a capable GPU - highest quality |
| **nomic-embed-text** | Embeddings (default, local) |

Rule of thumb: small model on the CPU path, larger model once native GPU Ollama is in place.

## 3. Choose a faster vector store

**Qdrant is bundled** and, in the retrieval pipeline, is the **slowest retrieval step**:

| Step | p50 latency |
|------|-------------|
| Vector search (Qdrant) | ~44 ms |
| Graph search | ~7 ms |

Qdrant is **swappable**. If query latency matters, point GCTRL at a **faster vector store** to cut the dominant cost in retrieval. (Configure the endpoint in **Settings → Infrastructure**; HTTP services apply immediately.)

## 4. Scale ingest throughput at the graph layer

Ingest throughput is bound by **graph (Neo4j) write speed**, **not** the matching engine. The entity-matching engine sustains **~2,750 entities/s** - the bottleneck on large ingests is how fast Neo4j can absorb writes.

For very large ingests:

- Use an **external / tuned Neo4j**, or
- Use a **bulk loader** to land data faster than transactional writes allow.

## 5. Reuse existing infrastructure in production

In production, prefer pointing GCTRL at your **own managed Neo4j and Qdrant** (and Postgres) rather than running the **bundled containers**. Managed, properly-resourced infrastructure outperforms the convenience containers and gives you the operational controls (backups, scaling, monitoring) you want at scale.

## Quick reference

| Lever | Action | Impact |
|-------|--------|--------|
| Native Ollama on GPU | Repoint Ollama base URL to host-native | **Highest** |
| Model choice | 3b on CPU, 7b+ on GPU | High |
| Vector store | Swap Qdrant for a faster store | Cuts query latency |
| Graph writes | External/tuned Neo4j or bulk loader | Faster large ingests |
| Reuse infra | Managed Neo4j/Qdrant in prod | Operational + speed |

## See also

- [Infrastructure](infrastructure.md) - how to make the changes above
- [LLM Providers](llm-providers.md) - provider and model selection
