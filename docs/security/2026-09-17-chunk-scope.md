# 2026-09-17 - Chunk retrieval ignored the scope of KB-scoped access tokens

Severity: high (cross-knowledge-base read inside one account). Measured on a
production instance running GCTRL v0.9.11.

## What leaked

Source-text passages (chunks). A freshly minted access token with `kbScoped: true`
and exactly ONE grant, on an EMPTY compilation, called the agent tool
`search_chunks` - with and without `compilationId` - and received passages that
belong to a different compilation of the same account owner. `list_graphs` and
`search_entities` were correctly scoped for the same token.

Affected read paths:

| Path | Effect |
|------|--------|
| Agent tool `search_chunks` (`POST /api/agent/tools/search_chunks`, MCP `tools/call`) | Foreign passages returned verbatim. |
| `groundingChunks` of `get_entity` / `get_dossier` (agent tools + REST entity/dossier reads) | Found while fixing, not part of the measurement: up to 3 verbatim snippets selected by entity uri + owner only. An entity present in several knowledge bases shares one uri, so a scoped key could read the other knowledge bases' text about it. |
| `POST /api/rag/query` (agent tool `query`, Talk-to-Graph chat, deep mode) | The blended ANSWER was grounded on foreign chunks and cited them, including the parent-document expansion (whole source session, up to 4k chars each). Ordering/broad questions additionally injected an event log / session timeline over the WHOLE account. |

Not affected: other accounts. Owner (`user_id`) and clearance (`min_rank`) were
always enforced - the hole is the missing knowledge-base boundary WITHIN an account.

## Root cause

- `services/api-rs/src/routes/agent.rs` (`search_chunks`) and
  `services/api-rs/src/routes/rag.rs` (`/rag/query`) sent
  `{query, limit, compilation_id, user_id, max_rank}` to the KEX worker `/search`.
  Scope = account owner + clearance rank. Neither used
  `routes::kg::api_key_scoped_jobs`, which every graph tool already goes through.
- `services/kex/src/main.py` `/search` treats `compilation_id` as a SOFT preference
  (`compilation_id = X OR compilation_id IS NULL`, because `text_chunks.compilation_id`
  is NULL on many chunks), drops it when the scoped pass is empty, and finally falls
  back to a lexical search over the whole owner corpus. `hebb.rerank_with_memory`
  could additionally pull in a co-activated neighbour chunk; co-activation pairs are
  per owner, not per knowledge base.
- An out-of-scope `compilationId` resolved to rank `i32::MIN`, but the KEX clearance
  filter is null-tolerant (`min_rank IS NULL` counts as public), so unclassified
  chunks still came back.

## Who is affected

Every KB-scoped key (`api_keys.kb_scoped = true`): per-user / colleague keys,
project and room member keys, scoped agent keys (Hermes, Anvil personal keys).
Anything such a key could not see in `list_graphs` was still readable as text, as
long as the key's clearance rank covered the chunk. Unscoped full-owner keys and
JWT sessions were never restricted here and are not "affected" - but see the
behaviour changes below.

## Since when

- `search_chunks`, `api_key_scope` (`kb_scoped`) and the whole-corpus fallback in KEX
  all arrived together in `abf2b5f` (2026-06-14, "multi-tenant memory platform").
  Chunk retrieval has been owner + clearance scoped only since that commit, i.e.
  for as long as KB-scoped tokens exist.
- `4b66161` (2026-07-04, "close dossier + KB-scope leaks") introduced
  `api_key_scoped_jobs` and put the graph tools behind it. The chunk paths were
  missed in that pass.

## What the fix does

1. `routes::kg::chunk_job_scope(db, claims, compilation_id)` - ONE helper for both
   call sites. `None` = unrestricted, `Some(empty)` = nothing visible.
   - `compilationId` given: the `source_job_ids` of that compilation, only if the
     caller owns it, a KB-scoped key holds a grant on it, and (Codebase access off)
     it is not a CODE graph. Otherwise an EMPTY result - not an error that would
     confirm the compilation exists. A WIKI compilation resolves to the jobs of its
     RAW sources (for a scoped key: only sources it is granted too).
   - no `compilationId`: `api_key_scoped_jobs(claims)`; JWT sessions and
     unrestricted keys stay `None`.
2. api-rs sends the scope to KEX as `job_ids` and, independent of the KEX image
   version, over-fetches (x10, max 60), drops every chunk whose `job_id` is not
   allowed (a chunk without `job_id` fails closed), then cuts to the requested limit.
   This runs before the rerank/prompt in `rag.rs` and before the Hebbian
   reinforcement in `agent.rs`, so a caller can neither read, cite, reinforce nor
   co-activate a chunk it may not see. An empty scope never reaches KEX.
3. KEX `/search` enforces `job_ids` as a HARD filter in every channel: Qdrant
   must-filter on the `job_id` payload, `job_id = ANY(...)` in both lexical queries,
   carried through the whole-corpus fallback and the Hebbian neighbour lookup, and
   re-checked on the final list. `job_ids: []` returns `{"chunks": []}` at once.
4. The whole-account event log / session timeline of `/rag/query` is confined to
   the same job scope.
5. `kg::fetch_grounding_chunks` takes the caller's claims and applies
   `api_key_scoped_jobs` (`job_id = ANY(...)`, empty scope = no snippets).
6. Guard tests: `kg::chunk_scope_tests::every_kex_search_call_site_is_job_scoped`
   walks every api-rs source file - whoever posts to the worker `/search` must use
   the helper, forward `job_ids` and filter the answer.
   `services/kex/tests/test_search_scope.py` pins the KEX wiring the same way.

The api-rs filter alone closes the leak, so an updated api-rs with an OLD KEX image
is already safe (only recall suffers when foreign hits crowd the over-fetch). An
updated KEX with an old api-rs is NOT - api-rs is the side that knows the scope.

## Behaviour changes for integrators

- `compilationId` is now a HARD filter for `search_chunks` and `/rag/query`, for
  every caller including JWT sessions. Previously an empty or non-matching
  compilation silently fell back to the whole account.
- `search_chunks` honours `limit` (integer, default 5, clamped 1..50).
- KEX `SearchReq` has a new optional field `job_ids: string[] | null`.

## Verify on a live instance

1. Pick a compilation A with content, and create an EMPTY compilation B (no source
   jobs). Note a query string that clearly matches a passage in A.
2. Mint a scoped read-only probe key with one grant on B:

   ```bash
   curl -s -X POST "$BASE/api/users/api-keys" -H "Authorization: Bearer $JWT" \
     -H 'Content-Type: application/json' \
     -d '{"name":"probe-chunk-scope","kbScoped":true,"readOnly":true,
          "grants":[{"compilationId":"<B>","readOnly":true}]}'
   ```

3. Call the tool with the probe key - without, with B, and with A as `compilationId`:

   ```bash
   for body in '{"query":"<text from A>"}' \
               '{"query":"<text from A>","compilationId":"<B>"}' \
               '{"query":"<text from A>","compilationId":"<A>"}'; do
     curl -s -X POST "$BASE/api/agent/tools/search_chunks" \
       -H "Authorization: ApiKey $PROBE" -H 'Content-Type: application/json' -d "$body"
   done
   ```

   Expected: `{"chunks":[]}` three times. Before the fix the first two returned A's
   text (measured); the third is the same hole by code reading (rank `i32::MIN` does
   not exclude chunks whose `min_rank` is NULL).
4. Same key, `POST /api/agent/tools/query` with `{"message":"<question about A>"}`:
   the answer must not contain A's content and `sources` must be empty.
   (B is empty, so there is no chunk whose entity mentions could pull graph facts in -
   see "Not covered" below.)
5. Control: the same `search_chunks` call with the owner JWT still returns A's passage.
6. Delete the probe key: `DELETE $BASE/api/users/api-keys/<id>`.

## Not covered by this fix

- `/rag/query` graph context: the Neo4j lookup that expands the retrieved chunks'
  entity mentions into triples is scoped by owner + clearance, not by
  `neo4j::job_scope`. With the chunk fix the entity NAMES now come only from
  in-scope chunks, but for a name that also exists in another knowledge base the
  triples of that other knowledge base can still enter the prompt. Separate change.
- `fetch_grounding_chunks` and the entity-read chunk COUNT apply no `min_rank`
  clearance filter (only owner, and now job scope).
- The unauthenticated `/rag/query` path sends `user_id: null` to KEX (PUBLIC-rank
  chunks of all owners). Unchanged here on purpose; worth its own review.
