# Rename Plan: BorgHive → Ground Control (GCTRL)

This document is the canonical record of the BorgHive → Ground Control
rename. It captures the decisions, what shipped in which commit, and
what is intentionally still pending.

---

## Decisions (canonical values)

| Concern | Value |
|---|---|
| Brand name (user-facing) | **Ground Control** |
| Code / identifier prefix | **GCTRL** |
| Production customer domain | **gctrl.tech** |
| Customer app subdomain | **app.gctrl.tech** |
| Mail subdomain (Mailgun) | **mg.gctrl.tech** |
| RDF namespace for entity URIs | **`http://gctrl.tech/entity/`** |
| Test-only seed email TLD | **gctrl.test** (RFC 6761 reserved — non-routable) |
| Real seed admin email | **admin@gctrl.tech** |

These values are the source of truth. Anything in code/docs that
disagrees with this table is a bug.

---

## Done in commit `dc0fcfc` — user-facing string sweep

Brand display strings and human-readable copy were rewritten from
"BorgHive" / "Borg Hive" to **Ground Control**:

- UI strings (titles, headers, button labels, toasts)
- Marketing copy and landing-page text
- README headings and prose
- Comment headers in source files

This commit deliberately left infrastructure values, seed data, RDF
namespaces, package names, MCP tool names, env-var names, DB
identifiers, Docker container/network names, and the `borghive/` repo
folder name unchanged. That work is split out below.

---

## Done in THIS commit — production-domain sweep + RDF namespace migration

### Domain references

`.env.example` and `.env.production.example`, plus any docs that
quoted production URLs, now point at the canonical `gctrl.tech`
domain:

| File | Change |
|---|---|
| `.env.production.example` | `DOMAIN`, `FRONTEND_URL`, `BORGHIVE_BASE_URL` values → `app.gctrl.tech` |
| `.env.production.example` | `MAIL_USER` value → `postmaster@mg.gctrl.tech` |
| `.env.production.example` | `GRAFANA_URL` value → `https://app.gctrl.tech/grafana` |

Note: the env-var **name** `BORGHIVE_BASE_URL` is intentionally left
unchanged — renaming it would require coordinated changes to every
service that reads it. Only the **value** moves to `gctrl.tech`.

### Seed credentials + JWT defaults

| File | Change |
|---|---|
| `.env.example` | `JWT_SECRET` default → `GCTRL_dev_jwt_secret_change_in_production` |
| `.env.example` | `JWT_REFRESH_SECRET` default → `GCTRL_dev_refresh_secret_change_in_production` |
| `docs/buildsummary.md` | Admin seed → `admin@gctrl.tech` / `GCTRL_admin_change_me_now` |
| `docs/buildsummary.md` | Test user → `test@gctrl.test` (RFC 6761 reserved TLD) |
| `docs/buildsummary.md` | n8n package reference → `n8n-nodes-gctrl` (matches repo) |

Test-user email uses `gctrl.test` so it cannot accidentally collide
with a real production address — `.test` is reserved and non-routable
by RFC 6761.

### RDF namespace (code + migration)

- `services/fuse/src/config_builder.py`: default RDF namespace moves
  from `http://borghive.dev/entity/` to `http://gctrl.tech/entity/`.
  Made overridable via the `GCTRL_RDF_NAMESPACE` environment variable
  so historical deployments can opt out until they have run the
  migration script.
- `scripts/migrate-rdf-namespace.cypher`: idempotent Cypher script
  that rewrites legacy `borghive.dev` entity URIs to the new
  namespace.
- `scripts/migrate-rdf-namespace.sh`: thin shell wrapper that invokes
  the Cypher inside the running `neo4j` container with sensible
  defaults.

---

## Namespace Migration — operator runbook

The RDF namespace is a semantic identifier baked into every entity
URI in Neo4j. Flipping the default in code **without** rewriting the
stored URIs would silently break entity lookups, owl:sameAs links
emitted by the resolver, and any external system that holds a
reference to a `borghive.dev` URI. The migration is therefore
coordinated, not lazy.

### Why this needs a deliberate cutover

- Every `Entity.uri` currently in Neo4j is stamped with the legacy
  namespace.
- The resolver emits new URIs using the new namespace.
- If both run at once without a rewrite, the same entity will exist
  under two URIs and `owl:sameAs` will quietly drift.

### When to run

1. **Stop ingestion** (KEX + FUSE workers idle).
2. **Back up Neo4j** — `docker exec neo4j neo4j-admin database dump …`
   or your standard snapshot procedure.
3. Run the migration (commands below).
4. **Then** redeploy services with the new default namespace.
5. Resume ingestion.

Do **not** run it ahead of the deploy — the legacy default is still
expected by the running services until they are cycled.

### Commands

Preferred (shell wrapper, picks up env overrides):

```bash
cd borghive
bash scripts/migrate-rdf-namespace.sh
```

Direct (in-container, defaults baked into the Cypher file):

```bash
docker exec -i neo4j cypher-shell -u neo4j -p password \
  < scripts/migrate-rdf-namespace.cypher
```

Verify zero remaining legacy URIs:

```cypher
MATCH (n:Entity) WHERE n.uri STARTS WITH 'http://borghive.dev/entity/'
RETURN count(n);
```

### Rollback

The migration is symmetric. Re-run the wrapper with the namespaces
swapped:

```bash
OLD_NS='http://gctrl.tech/entity/' \
NEW_NS='http://borghive.dev/entity/' \
bash scripts/migrate-rdf-namespace.sh
```

If you have not yet redeployed the services, you can also unblock by
setting `GCTRL_RDF_NAMESPACE=http://borghive.dev/entity/` to keep the
old default until you are ready.

---

## Still pending — needs deliberate work

These items are intentionally out of scope for this sweep because
they have wide blast radius and break installed users / configured
clients.

### 1. npm package rename — `n8n-nodes-borghive` → `n8n-nodes-gctrl`

The on-disk folder and `package.json` name field have already been
updated to `n8n-nodes-gctrl`, but **publishing under the new npm
name is a breaking change for anyone who already installed
`n8n-nodes-borghive`** in their n8n instance.

Required follow-up:
- Decide on deprecation strategy for the old npm name (publish a
  final shim release that re-exports from the new package, or push a
  migration notice).
- Publish `n8n-nodes-gctrl` to npm and tag a clean v1.
- Update install docs and the n8n community-nodes listing.

### 2. MCP tool rename — `borghive_*` → `gctrl_*`

Tool names are part of the wire contract with any client `.mcp.json`
that already references them (Claude Desktop, Cursor, custom
agents). Renaming them requires:
- A coordinated server-side change (the tool list the server
  exposes).
- A user-side migration of every `.mcp.json` referencing
  `borghive_extract`, `borghive_query`, `borghive_store`,
  `borghive_fuse`, `borghive_search_entities`, `borghive_list_graphs`,
  `borghive_list_ontologies`, `borghive_list_extractions`,
  `borghive_schema`.
- Either a deprecation window where both names are accepted, or a
  hard cutover with comms.

### 3. `borghive/` repo folder rename — huge blast radius

Renaming the top-level `borghive/` directory affects:
- Every absolute and relative path in scripts (`scripts/run-e2e.ps1`,
  `scripts/run-smoke.ps1`, `scripts/smoke-test.sh`).
- Every IDE / editor workspace file.
- Every CI configuration that hardcodes the path.
- Any developer's local clone with WIP branches.

This is a coordinated, single-PR change that should be done on a
quiet day with all collaborators warned in advance.

---

## Intentionally NOT changed

- Environment-variable **names** (e.g. `BORGHIVE_BASE_URL`, `JWT_SECRET`).
- Database column / table names.
- Docker container names and the `borghive_*` Docker network.
- The `borghive/` repo folder.
- MCP tool names (`borghive_*`).
- npm package distribution name on the registry.

Only the **values** of env-vars, the **defaults** of secrets, and
**user-facing display strings** are in scope here.
