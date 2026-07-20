-- Fix DELETE /api/kex/jobs/:id returning 500 for every job that recorded usage.
--
-- token_usage.job_id and connector_sync_jobs.kex_job_id reference jobs(id) with
-- NO ON DELETE action (unlike pii_findings CASCADE / file_assets SET NULL), so a
-- bare `DELETE FROM jobs` hits token_usage_job_id_fkey on any normal extract or
-- upload. SET NULL on both: usage rows are billing history and must survive the
-- job; connector_sync_jobs rows are sync history (their live status is derived
-- by joining onto the kex job — a NULL join simply reports no live status).

ALTER TABLE token_usage
  DROP CONSTRAINT IF EXISTS token_usage_job_id_fkey,
  ADD CONSTRAINT token_usage_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE connector_sync_jobs
  DROP CONSTRAINT IF EXISTS connector_sync_jobs_kex_job_id_fkey,
  ADD CONSTRAINT connector_sync_jobs_kex_job_id_fkey
    FOREIGN KEY (kex_job_id) REFERENCES jobs(id) ON DELETE SET NULL;
