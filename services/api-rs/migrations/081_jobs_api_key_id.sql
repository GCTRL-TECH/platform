-- Migration 081 — attribute each job to the API token that triggered it.
--
-- Powers the KEX overview provenance: instead of a bare "agent_store" label, the
-- overview can show WHICH user/token triggered the extraction, then the source
-- type (agent store vs uploaded file) and file name. NULL = triggered via a
-- logged-in web/JWT session (no API token), rendered as "Web-Login" in the UI.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_api_key_id ON jobs(api_key_id);
