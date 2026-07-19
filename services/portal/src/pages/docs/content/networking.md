# Networking & Ports

GCTRL's Docker stack is built around one rule: **expose exactly one port.** Everything the app needs - the UI, the REST API, the MCP-over-HTTP gateway, agent tool calls, graph embeds - rides through it. This page maps every port in the stack and shows the supported ways to reach that one port remotely.

## The one-port model

| Service | Container | Port | Scope | Purpose |
|---|---|---|---|---|
| Web (nginx) | `gctrl-web` | **3001** | **Published to the host** | The only externally reachable port. Serves the UI and reverse-proxies `/api/*` to the API. |
| API | `gctrl-api` | 4000 | Loopback (`127.0.0.1`) | REST API, MCP-over-HTTP gateway, agent tools. Reached only via the web container's `/api/` proxy or directly on `localhost` on the host itself. |
| KEX (extraction) | `gctrl-kex` | 4010 | Loopback (`127.0.0.1`) | Extraction worker. Never called directly by a browser or remote agent. |
| FUSE (fusion) | `gctrl-fuse` | 4020 | Loopback (`127.0.0.1`) | Entity resolution / fusion worker. Same rule. |
| License agent | `gctrl-agent` | 7070 | Loopback (`127.0.0.1`) | Talks to `api.gctrl.tech` for license heartbeats; local status only. |
| Ollama (bundled) | `gctrl-ollama` | 11434 | Loopback (`127.0.0.1`) | Local model inference. |
| Postgres / Redis / Neo4j / Qdrant / resolver | `gctrl-postgres`, `gctrl-redis`, `gctrl-neo4j`, `gctrl-qdrant`, `gctrl-resolver` | - | Docker-network-internal only | No host port published at all - reachable only from other containers on the `gctrl` network. |

Everything marked "loopback" is bound to `127.0.0.1:<port>` in the shipped compose file - reachable from processes on the host, but not from the network or the internet, even if you don't touch the firewall.

```
        internet / LAN                    host (127.0.0.1)              gctrl network
             │                                    │                            │
             ▼                                    │                            │
   ┌───────────────────┐   :3001    ┌──────────────────────┐                   │
   │ browser / agent /  │──────────▶│  gctrl-web (nginx)    │                  │
   │ reverse proxy      │            │  UI + /api/* proxy    │──────┐          │
   └───────────────────┘            └──────────────────────┘       │          │
                                                                    ▼          │
                                     ┌──────────────────────┐  gctrl-api :4000 │
                                     │ loopback-only, no LAN │◀─────────────────┘
                                     │ or internet exposure  │  kex/fuse/agent/ollama,
                                     └──────────────────────┘  postgres/redis/neo4j/qdrant
```

Because nginx proxies all of `/api/*` - the app UI, the REST API, the MCP-over-HTTP gateway (`/api/agent/mcp`), direct agent tool calls (`/api/agent/tools/*`), and graph embeds (`/embed/graph/...`, `/api/public/embed/...`) - a remote agent or browser needs nothing but this one origin plus an access token. There is no second port to open for "the API" or "the agent."

## Remote access options

Ranked by what most installs should reach for first.

### 1. Reverse proxy with TLS (recommended for public installs)

Put a TLS-terminating reverse proxy in front of port 3001 and forward only 443/80. A minimal Caddy example:

```
your-domain.com {
    reverse_proxy localhost:3001
}
```

nginx or Traefik work the same way - proxy `443 → 127.0.0.1:3001`. Websockets and streaming responses need `Upgrade`/`Connection` headers forwarded; `services/web/nginx.conf` already sets these on its own `/api/` proxy, so as long as your outer proxy forwards them too (standard for nginx/Caddy/Traefik), MCP-over-HTTP and long-running extraction requests work unmodified.

### 2. Tailscale / VPN (recommended for private installs)

No public port at all - the install stays off the internet entirely, reachable only to devices on your tailnet. This is the best default for a VPS you don't want publicly listed. See [Private access with Tailscale](tailscale.md) for exact commands.

### 3. Plain LAN on port 3001

For a trusted local network only (e.g. a home lab or an isolated office VLAN), you can just open 3001 on the LAN and skip TLS. Fine for trusted networks; not appropriate once the install is reachable from the internet.

## What NOT to expose

Never forward or publish 4000 (API), 4010 (KEX), 4020 (FUSE), 7070 (agent), 11434 (Ollama), or any database port (Postgres 5432, Neo4j 7474/7687, Qdrant 6333) - to the LAN or the internet.

Two independent reasons:

- **They're loopback-by-design.** The compose file binds them to `127.0.0.1`, not `0.0.0.0` - this is a deliberate trust boundary, not an oversight. Forwarding them (e.g. rebinding the compose or port-forwarding a router) removes that boundary.
- **Internal trust, not user auth.** Calls between the API, KEX, and FUSE containers are gated by a shared `INTERNAL_API_SECRET`, not by the per-user access tokens that protect `/api/*` at the nginx layer. Exposing 4010/4020 directly bypasses that layer's authentication entirely.

If you need direct database access remotely (a Neo4j Browser session, a Postgres client), tunnel over SSH or Tailscale - never open the port. See [Securing Your Deployment](security.md).

## Outbound requirements

GCTRL only needs a handful of outbound connections - no inbound port beyond 3001 (or your TLS/tailnet front door) is ever required for the platform to function:

| Destination | Purpose |
|---|---|
| `ghcr.io` | Pulling update images (digests + layers) |
| `gctrl.tech` | Version channel (`/version.json`) for update checks |
| `api.gctrl.tech` | License heartbeat |
| Your chosen cloud LLM provider (optional) | Only if you configure a cloud model instead of local Ollama |

**Air-gapped note:** with no cloud LLM provider configured, the only outbound traffic GCTRL generates is updates and the license heartbeat - everything else (extraction, fusion, RAG, graph storage) runs fully offline against the bundled or self-hosted models and databases.

## Firewall quick reference

Inbound: allow only 443 (reverse proxy) or 3001 (plain LAN), deny everything else.

```bash
# ufw
sudo ufw default deny incoming
sudo ufw allow 443/tcp     # or 3001/tcp for plain LAN, not both
sudo ufw allow OpenSSH
sudo ufw enable
```

Hetzner Cloud Firewall / Hostinger VPS firewall: create one inbound rule for TCP 443 (or 3001), source `0.0.0.0/0` (or your LAN CIDR for the plain-LAN option), and leave every other port on default-deny. Both providers apply the firewall at the hypervisor level, so it protects the host even if `ufw` is misconfigured inside the VM.

## See also

[Private access with Tailscale](tailscale.md) · [Securing Your Deployment](security.md) · [Installation](installation.md)
