-- A1 HYBRID RETRIEVAL — lexical / BM25-style full-text index over chunk content.
--
-- Why: dense vector search (Qdrant / nomic-embed-text) reliably misses EXACT
-- keywords, filenames, IDs, and code tokens — an embedding smears "GCTRL-XR-7741"
-- into a fuzzy neighbourhood instead of matching it literally. A Postgres
-- full-text index gives us the lexical channel of a hybrid retriever (dense ∪
-- lexical, fused by reciprocal-rank fusion in KEX /search).
--
-- Config choice: 'simple' (NOT 'english'). The 'english' configuration stems and
-- strips stopwords, which is great for prose but DESTRUCTIVE for the exact tokens
-- this index exists to catch: it would lowercase+stem "Running" -> "run" and drop
-- short/number-heavy tokens. 'simple' only lowercases and splits on
-- non-alphanumerics — it preserves IDs, filenames, mixed-language terms, and is
-- the safest base for a corpus that mixes German + English + code tokens. Exact
-- substrings that 'simple' still splits on punctuation (e.g. "GCTRL-XR-7741" ->
-- gctrl/xr/7741) are additionally recoverable via a raw ILIKE fallback in the app.
--
-- Generated column: content_tsv is STORED and GENERATED ALWAYS, so it
-- auto-populates for every EXISTING row at migration time and for every future
-- INSERT/UPDATE with zero application changes (no backfill job, no trigger).
-- The GIN index makes `content_tsv @@ query` fast.

ALTER TABLE text_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_text_chunks_content_tsv
  ON text_chunks USING GIN (content_tsv);

-- Trigram index on raw content powers the exact-substring ILIKE fallback for
-- punctuated tokens that tsquery splits (filenames, hyphenated IDs). Best-effort:
-- pg_trgm may not be installed in every environment, so guard the whole block and
-- never fail the migration if the extension can't be created.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_text_chunks_content_trgm
      ON text_chunks USING GIN (content gin_trgm_ops);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (% ) — ILIKE fallback will seq-scan; non-fatal', SQLERRM;
  END;
END $$;
