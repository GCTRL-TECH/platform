-- 099: project lessons — conventions, recipes, pitfalls and decisions a team
-- learned while working, stored as chunks so they take part in the Hebbian
-- hot/cold layer (routes/lessons.rs).
--
-- `kind` marks special chunks ('lesson'); ordinary document chunks keep NULL.
-- `meta` carries the lesson's fields (lessonType, title, text, evidence,
-- origin, sourceRef, compilationId, promotedFrom).

ALTER TABLE text_chunks ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE text_chunks ADD COLUMN IF NOT EXISTS meta JSONB;

-- The playbook query: a knowledge base's lessons, hottest first.
CREATE INDEX IF NOT EXISTS idx_text_chunks_lessons
    ON text_chunks (user_id, heat DESC)
    WHERE kind = 'lesson' AND NOT archived;

-- Lesson jobs (`kex_lesson`, KEX note pipeline: embed + store, no extraction).
-- Postgres has no "extend CHECK", so the list is re-declared (mirrors 077 + kex_lesson).
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (
  type IN (
    'kex_extract',
    'kex_upload',
    'fuse_merge',
    'kex_connector',
    'kex_url',
    'kex_sharepoint',
    'kex_obsidian',
    'distill_wiki',
    'kex_code',
    'kex_lesson'
  )
);
