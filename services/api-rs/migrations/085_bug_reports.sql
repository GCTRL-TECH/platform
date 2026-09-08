-- BUG REPORTS — the in-product "report a bug" button and the admin Kanban.
--
-- Any signed-in user (session or access token) files a report (POST /api/bugs);
-- an admin triages it on a Kanban (GET/PUT /api/admin/bugs, decision endpoint)
-- and turns the admitted ones into a prioritised spec.md via the configured
-- LLM (POST /api/admin/bugs/spec). See routes/bugs.rs.
--
--   status   reported   -> admitted | declined   (decision endpoint)
--            admitted   -> in_progress -> done   (Kanban columns, PUT status)
--   reporter_user_id / reporter_email : who filed it. The email is denormalised
--            so the card still shows a reporter after the account is removed
--            (the FK nulls out on delete, the mail stays).
--   decision_by / decided_at : the admin who admitted/declined and when.
--
-- bug_specs keeps every generated spec: markdown plus the ids of the reports it
-- covers (JSONB array of uuids) so the frontend can show which reports a spec
-- was built from. Additive, idempotent.

CREATE TABLE IF NOT EXISTS bug_reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title            TEXT NOT NULL,
    description      TEXT NOT NULL,
    page_url         TEXT,
    user_agent       TEXT,
    version          TEXT,
    status           TEXT NOT NULL DEFAULT 'reported'
                       CHECK (status IN ('reported', 'admitted', 'declined', 'in_progress', 'done')),
    reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reporter_email   TEXT,
    decision_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The Kanban reads "all reports, newest first" and filters by column.
CREATE INDEX IF NOT EXISTS idx_bug_reports_status_created
    ON bug_reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS bug_specs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    markdown   TEXT NOT NULL,
    bug_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
