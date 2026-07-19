# FAQ / Troubleshooting

Common setup, runtime, and operational questions for running GCTRL on-prem. Use the section anchors to jump straight to your issue.

---

## Docker is not running / "cannot connect to Docker"

GCTRL runs its services in Docker, so **Docker Desktop must be open and running** before you start GCTRL.

- **Symptom:** services fail to start, or you see `cannot connect to the Docker daemon`.
- **Fix:** open Docker Desktop and wait until it reports *running* (green whale icon), then start GCTRL again.
- On Windows and Mac, Docker Desktop must stay open in the background - closing it stops every GCTRL container.

---

## Model out of memory

A model that is too large for available RAM/VRAM will fail to load or crash mid-inference.

- **Pick a smaller model** - a smaller model needs less memory and still works for most extraction and chat tasks.
- **Or add RAM** (or free up memory by closing other apps).
- As a rule of thumb, the model must fit in available memory with headroom for the rest of the stack. If a large model OOMs, step down a size and retry.

---

## Switch from bundled to native Ollama

GCTRL ships with a bundled Ollama for zero-config startup, but you can point it at a **native Ollama** install (useful for GPU acceleration and shared model libraries).

- Configure this in **Settings → Infrastructure**, then point GCTRL at your native Ollama endpoint.
- On **Mac**, native Ollama is the recommended path because it uses **Metal** GPU acceleration (see [GPU support](#gpu-support)).
- For full self-hosting and endpoint details, see the **Infrastructure** page.

---

## Ports already in use

GCTRL binds several local ports. If one is taken, the matching service will not start.

| Service | Port |
|---------|-----:|
| Dashboard | **3001** |
| API | **4000** |
| KEX (extraction) | **4010** |
| FUSE (fusion) | **4020** |
| Agent | **7070** |

- **Fix:** stop whatever already holds the port, or reconfigure GCTRL to use a free one.
- To find the offending process: `lsof -i :4000` (Mac/Linux) or `netstat -ano | findstr :4000` (Windows).

---

## Where does my data live?

**On-prem, on your machine.** GCTRL stores everything in **local volumes**:

- **Postgres** - application and metadata storage
- **Neo4j** - the knowledge graph
- **Qdrant** - vector embeddings

These are local Docker volumes under your control. Nothing is stored off-machine. See **Compliance & Data Sovereignty** for the full data-sovereignty posture.

---

## Is anything sent to the cloud?

**No - not with local Ollama.** When inference runs on local Ollama, prompts, documents, graph content, and answers all stay inside your network. There is no external API in the data path and zero token cost. See **Compliance & Data Sovereignty**.

---

## Use my own Neo4j / Qdrant

You can point GCTRL at your own database instances instead of the bundled ones.

- Configure connection details in **Settings → Infrastructure** for both Neo4j and Qdrant.
- This is the same place you swap the vector store - see the **Benchmarks** page on why Qdrant is swappable for lower query latency.

---

## Connect Claude Code / Cursor

GCTRL exposes an **MCP** server so agents like **Claude Code** and **Cursor** can use it as memory and knowledge.

1. Create a **scoped token** in **Settings → Access Control** (set its clearance ceiling and KB grants - see **Access Control & Multi-Tenancy**).
2. Configure the agent's **MCP** connection using that token.
3. Full connection steps and copy-paste config are on the **Agents** page.

Using a scoped token here means the agent can only see and write the knowledge bases you granted it - ideal for keeping an external coding agent inside one project's knowledge.

---

## License / activation issues

- Confirm the activation key is entered correctly and your instance can reach the activation check.
- If activation fails behind a corporate proxy or air-gapped network, check that outbound access for the activation step is permitted (this is separate from the inference data path, which stays local).
- If the problem persists, capture the activation error message and contact support.

---

## How do I update GCTRL?

- Pull the latest GCTRL release and restart the stack so the updated containers come up.
- Local data volumes (Postgres / Neo4j / Qdrant) persist across updates - your knowledge graphs are not touched by an update.
- Take a snapshot/backup of your volumes before a major update if you want a guaranteed rollback point.

---

## GPU support

- **NVIDIA** GPUs are **auto-detected** and used for inference when present.
- On **Mac**, use **native Ollama**, which uses **Metal** for GPU acceleration (the bundled containerized path does not expose Metal). See [Switch from bundled to native Ollama](#switch-from-bundled-to-native-ollama).

---

## See also

- **Access Control & Multi-Tenancy** - creating scoped tokens for agents.
- **Compliance & Data Sovereignty** - where data lives and what stays local.
- **Benchmarks** - swapping the vector store for lower latency.
