-- text_chunks: dual-storage companion to Qdrant. KEX writes the chunk
-- text + metadata here; the qdrant_point_id ties each row to its vector.
CREATE TABLE IF NOT EXISTS text_chunks (
  id               UUID         PRIMARY KEY,
  job_id           UUID,
  compilation_id   UUID,
  user_id          UUID,
  content          TEXT         NOT NULL,
  start_char       INTEGER,
  end_char         INTEGER,
  chunk_sequence   INTEGER,
  qdrant_point_id  TEXT,
  entity_mentions  JSONB        DEFAULT '[]',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_text_chunks_job_id         ON text_chunks(job_id);
CREATE INDEX IF NOT EXISTS idx_text_chunks_compilation_id ON text_chunks(compilation_id);
CREATE INDEX IF NOT EXISTS idx_text_chunks_user_id        ON text_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_text_chunks_qdrant_point   ON text_chunks(qdrant_point_id);
