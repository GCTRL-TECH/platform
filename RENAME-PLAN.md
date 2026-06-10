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

## Done in THIS commit — npm rename + MCP tool rename (with deprecation)

### 1. npm package rename — `n8n-nodes-borghive` → `n8n-nodes-gctrl`

The package is now a clean Ground Control package end-to-end:

- `package.json#name` = `n8n-nodes-gctrl`, version bumped to **1.0.0**
  (major bump — this is a breaking change for anyone who already
  installed `n8n-nodes-borghive`).
- TypeScript identifiers renamed throughout `src/`: `BorgHive` →
  `Gctrl`, `borghive` → `gctrl`. Source files and folders renamed to
  match (`nodes/Gctrl/Gctrl.node.ts`, `credentials/GctrlApi.credentials.ts`,
  `shared/GctrlApiClient.ts`, etc.).
- Credential type id renamed from `GCTRLApi` (transitional) to
  `gctrlApi` (n8n camelCase convention).
- Node `displayName` values switched to "Ground Control" / "Ground
  Control Trigger" / "Ground Control Memory" / "Ground Control
  Knowledge Tool".
- `package.json#n8n.nodes` and `package.json#n8n.credentials` updated
  to point at the renamed dist paths.
- Icons renamed `borghive.svg` → `gctrl.svg`, referenced via
  `icon: 'file:gctrl.svg'`.
- README rewritten under the Ground Control brand.
- New `MIGRATION.md` documents the user-side steps for moving from
  `n8n-nodes-borghive` (uninstall old, install new, restart n8n,
  re-select nodes in existing workflows, credentials carry over).

Builds clean with `npm run build` (tsc + gulp icons).

### 2. MCP tool rename — `borghive_*` → `gctrl_*` (with deprecation aliases)

Tool names in `services/mcp/src/index.ts` rewritten through a small
`registerToolWithAlias()` helper that registers each tool under both
its new canonical `gctrl_*` name and its legacy `borghive_*` name.

- Canonical names: `gctrl_extract`, `gctrl_query`, `gctrl_store`,
  `gctrl_fuse`, `gctrl_search_entities`, `gctrl_list_graphs`,
  `gctrl_list_ontologies`, `gctrl_list_extractions`, `gctrl_schema`.
- Each legacy `borghive_*` alias forwards to the same handler, logs a
  `console.error` deprecation warning naming both the old and the new
  tool name, and carries a `[DEPRECATED — use 'gctrl_X' instead,
  alias will be removed in v2]` prefix on its description.
- Aliases marked in code with `// DEPRECATED — remove in v2`.
- Startup logs a clear notice that the deprecated names are still
  exposed.
- `services/mcp/README.md` documents the new names with a
  "Deprecated names (alias, removal in v2)" callout listing every
  alias.
- `borghive/.mcp.json` (actually `Databorg/.mcp.json` — the only
  example config in the repo) updated to the new env-var names
  (`GCTRL_*`).
- `docs/buildsummary.md` updated to the new tool names with a
  deprecation callout.
- `services/web/src/pages/settings/SettingsPage.tsx` "MCP Server"
  panel updated to display the `gctrl_*` names.

Builds clean with `npm run build` (tsc). Both old and new names are
present in `dist/index.js` (18 registrations = 9 tools × 2 names).

### Removal schedule

- **MCP server v2.0**: drop the `registerToolWithAlias()` helper and
  call `server.tool()` directly. Remove every `borghive_*` alias and
  the deprecation-warning code path.
- **n8n package**: publish a single final `n8n-nodes-borghive` release
  whose only purpose is to surface a "use `n8n-nodes-gctrl` instead"
  notice (e.g. an error-throwing stub or a `deprecated` field in
  package.json). Do not re-export — see `MIGRATION.md` for why.

---

## Still pending — needs deliberate work

### 1. `borghive/` repo folder rename — huge blast radius

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

MCP tool names and the npm package were renamed in the latest commit;
the deprecation aliases / migration guide cover the transition. See
the "Removal schedule" above for when the legacy paths disappear.
