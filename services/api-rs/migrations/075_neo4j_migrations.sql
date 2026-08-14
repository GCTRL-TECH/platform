-- Marker table for one-time Neo4j data migrations.
--
-- Neo4j has no migration framework here, and the graph-side backfills are full
-- scans over every node and relationship. Without a marker they would re-run on
-- every boot: harmless in effect (they are idempotent) but a needless scan of the
-- whole store each restart, on a graph that carries no indexes at all.
--
-- Postgres is the right place for the marker: it is the authoritative store, it
-- is already migrated on startup, and a restored-from-backup Neo4j paired with a
-- current Postgres is exactly the case where re-running is desirable — dropping
-- the row is then the documented way to force a re-run.
CREATE TABLE IF NOT EXISTS neo4j_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    details    JSONB
);
