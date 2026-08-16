-- Extraktions-Jobs, die in KEINER Wissensbasis stehen, in die Standard-Basis ihres
-- Besitzers einsortieren.
--
-- Warum jetzt: bis heute galt "Compilation ohne source_job_ids = der komplette Graph des
-- Besitzers". Diese Ersatzregel hat zwei Dinge gleichzeitig getan — sie hat unabgelegte
-- Jobs sichtbar gehalten UND jede noch leere Wissensbasis zum Fenster auf den ganzen
-- Account gemacht (auf der geteilten VPS-Installation sah die frische persoenliche KB
-- eines Kollegen alle 14 Knoten der Testdaten des Account-Inhabers). Die Leseregel ist
-- jetzt streng: eine Wissensbasis IST ihre Quell-Jobs, leer heisst leer.
--
-- Damit dabei nichts unsichtbar wird, muss die erste Haelfte der alten Regel durch echte
-- Ablage ersetzt werden statt durch eine Wildcard beim Lesen. Genau das macht diese
-- Migration, einmalig und additiv:
--
--   * Nur `kex_*`-Jobs. Sie sind die einzigen, deren Knoten die Job-Id tragen
--     (`_source_jobs`) — ein `fuse_merge` wuerde nichts sichtbar machen, und ein
--     `distill_wiki` gehoert in seine WIKI-Compilation, nie in die RAW-Standardbasis.
--   * Nur abgeschlossene Jobs: alles andere hat keine Knoten im Graphen.
--   * Nur Jobs, die NIRGENDWO referenziert sind. Ein Job, der schon in irgendeiner
--     Compilation steht, war nie unsichtbar und wird nicht zusaetzlich einsortiert.
--   * Ziel ist die Standard-Wissensbasis des jeweiligen Besitzers, definiert wie in
--     routes::kex::resolve_default_compilation: die aelteste, die weder System- noch
--     WIKI-Compilation ist. Es wird ausschliesslich in die EIGENE Basis des Job-Besitzers
--     geschrieben — ueber Account-Grenzen bewegt sich nichts.
--
-- Idempotent (DISTINCT ueber die Vereinigung) und ohne Loeschung: laeuft sie zweimal,
-- passiert beim zweiten Mal nichts.

WITH default_comp AS (
    SELECT DISTINCT ON (user_id) user_id, id
    FROM compilations
    WHERE COALESCE(is_system, false) = false
      AND type::text <> 'WIKI'
    ORDER BY user_id, created_at
),
filed AS (
    SELECT DISTINCT unnest(source_job_ids) AS job_id
    FROM compilations
),
orphans AS (
    SELECT j.user_id, array_agg(j.id) AS job_ids
    FROM jobs j
    WHERE j.status = 'completed'
      AND j.type LIKE 'kex\_%'
      AND NOT EXISTS (SELECT 1 FROM filed f WHERE f.job_id = j.id)
    GROUP BY j.user_id
)
UPDATE compilations c
SET source_job_ids = ARRAY(
        SELECT DISTINCT x FROM unnest(c.source_job_ids || o.job_ids) x
    ),
    updated_at = NOW()
FROM default_comp d
JOIN orphans o ON o.user_id = d.user_id
WHERE c.id = d.id;
