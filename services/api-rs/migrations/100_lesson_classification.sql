-- 100: Lehren tragen die Freigabestufe ihrer Herkunft (routes/lessons.rs).
--
-- Bis v0.9.22 schickte der Lehren-Job keine Einstufung an KEX; jede Lehre landete
-- deshalb mit min_rank 0 (PUBLIC) in text_chunks, egal wie streng ihre Wissensbasis
-- eingestuft war. Ab jetzt setzt der Job die Einstufung (Vorgabe = Wissensbasis). Diese
-- Migration hebt die BESTEHENDEN Lehren nach: nie herab, nur hoch.
--
-- Qdrant traegt min_rank als Payload und wird hier nicht angefasst; KEX /search prueft
-- deshalb jede Trefferliste zum Schluss gegen text_chunks.min_rank
-- (services/kex/src/clearance_guard.py). Postgres ist die Wahrheit ueber die Einstufung.

-- 1) Boden: die Einstufung der Wissensbasis (expliziter Level, sonst die Alt-Spalte;
--    unbekanntes Label = hoechste Stufe, wie kg::classification_rank_of). Liegt eine
--    Lehre in mehreren Wissensbasen, gilt die strengste.
WITH kb AS (
    SELECT c.id AS chunk_id,
           MAX(COALESCE(cl.rank,
               CASE k.classification::text
                    WHEN 'PUBLIC' THEN 0
                    WHEN 'INTERNAL' THEN 100
                    WHEN 'CONFIDENTIAL' THEN 200
                    ELSE 300 END)) AS rank
      FROM text_chunks c
      JOIN compilations k ON c.job_id = ANY(k.source_job_ids)
      LEFT JOIN classification_levels cl ON cl.id = k.classification_level_id
     WHERE c.kind = 'lesson'
     GROUP BY c.id
)
UPDATE text_chunks t
   SET min_rank = kb.rank,
       classification_level_id = COALESCE(
           (SELECT id FROM classification_levels WHERE user_id IS NULL AND rank = kb.rank LIMIT 1),
           t.classification_level_id),
       meta = COALESCE(t.meta, '{}'::jsonb) || jsonb_build_object('classificationRank', kb.rank)
  FROM kb
 WHERE t.id = kb.chunk_id AND kb.rank > COALESCE(t.min_rank, 0);

-- 1b) Stufen-Marke: Anvil schreibt ab VERTRAULICH `stufe:<STUFE>` in evidence (damit die
--     Einstufung auch ein GCTRL ueberlebt, das sie noch nicht kennt). Nur anheben.
UPDATE text_chunks t
   SET min_rank = m.rank,
       classification_level_id = COALESCE(
           (SELECT id FROM classification_levels WHERE user_id IS NULL AND rank = m.rank LIMIT 1),
           t.classification_level_id),
       meta = COALESCE(t.meta, '{}'::jsonb) || jsonb_build_object('classificationRank', m.rank)
  FROM (
    SELECT id, CASE WHEN meta->>'evidence' LIKE '%stufe:STRENG_VERTRAULICH%' THEN 300 ELSE 200 END AS rank
      FROM text_chunks
     WHERE kind = 'lesson' AND meta->>'evidence' ~ 'stufe:(STRENG_VERTRAULICH|VERTRAULICH)'
  ) m
 WHERE t.id = m.id AND m.rank > COALESCE(t.min_rank, 0);

-- 2) Befoerderte Team-Lehren: die strengste ihrer Quellen (nach Schritt 1).
WITH src AS (
    SELECT t.id AS chunk_id, MAX(COALESCE(s.min_rank, 0)) AS rank
      FROM text_chunks t
      JOIN LATERAL jsonb_array_elements_text(t.meta->'promotedFrom') AS p(src_id) ON true
      JOIN text_chunks s ON s.id::text = p.src_id AND s.user_id = t.user_id
     WHERE t.kind = 'lesson' AND jsonb_typeof(t.meta->'promotedFrom') = 'array'
     GROUP BY t.id
)
UPDATE text_chunks t
   SET min_rank = src.rank,
       classification_level_id = COALESCE(
           (SELECT id FROM classification_levels WHERE user_id IS NULL AND rank = src.rank LIMIT 1),
           t.classification_level_id),
       meta = COALESCE(t.meta, '{}'::jsonb) || jsonb_build_object('classificationRank', src.rank)
  FROM src
 WHERE t.id = src.chunk_id AND src.rank > COALESCE(t.min_rank, 0);
