# Securing Your Deployment

GCTRL runs entirely on your own infrastructure — your data, graphs, and license never leave the machine. The defaults assume a **trusted, local** network. Before you expose anything beyond `localhost`, review this page.

## Don't expose the data-layer ports

The bundled databases are reachable only from the GCTRL containers by default. **Never forward or publish these ports to the internet:**

| Service | Port(s) | Risk if exposed |
|---------|---------|-----------------|
| Neo4j | 7474, 7687 | Full graph read/write |
| Postgres | 5432 | All app data, users, license |
| Qdrant | 6333 | All vector chunks |
| Ollama | 11434 | Unauthenticated model access |

Keep them bound to `localhost` / the Docker network (the default). If you need remote access to a database, tunnel over **SSH or a VPN** — don't open the port.

## Database passwords are unique per install

Each deployment generates its **own random Neo4j and Postgres passwords** into `~/gctrl/.env` (written `chmod 600`). Keep `.env` secret and backed up — losing it means losing access to the databases.

> Installs from before this change used shared default passwords. If you ever exposed Neo4j/Postgres on those installs, rotate the credentials (and never expose those ports again).

## Exposing the API (`:4000`) for a remote agent

The [Quick Start](quickstart.md) mentions forwarding `:4000` so a remote agent can reach the MCP gateway. If you do:

- Put it behind **TLS + a reverse proxy** — never serve the API over plain HTTP on the internet.
- Restrict access by **firewall / IP allowlist** where you can.
- Treat the **full-access token like a password** — it grants full control. Prefer **scoped tokens** (per knowledge base / clearance) from [Access Control](access-control.md), and revoke unused ones.
- The **MCP-over-HTTP gateway is OFF by default** — only enable it when you actually need remote agents.

## Rotating secrets

- The DB passwords and `JWT_SECRET` live in `~/gctrl/.env`. Changing the `JWT_SECRET` invalidates existing sessions (everyone re-logs in). Changing a **database** password after first init requires updating the database itself, not just `.env`.
- Revoke and reissue agent tokens any time in [Access Control](access-control.md).

## Everything stays local

License validation concerns the license only — your ingested content, graphs, and memory **never leave the machine**. See [Compliance & Sovereignty](compliance.md).

## Reporting a vulnerability

Found a security issue? Please report it **privately** to **fabio@5monti.com** — do **not** open a public issue. We'll acknowledge and work a fix with you before any disclosure.
