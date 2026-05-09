-- Backfill: mark jobs as completed when text_chunks exist for them.
--
-- Context: KEX/FUSE workers historically only published results via Redis
-- pubsub (fire-and-forget). If the api-rs subscriber missed the message,
-- the job stayed 'pending' until recover_stale_jobs flipped it to 'failed'
-- after one hour. Workers now write directly to jobs.status, but jobs that
-- ran before the fix can still be stuck in 'pending'.
--
-- This statement recovers them: any 'pending' job that already produced
-- text_chunks rows clearly finished successfully, so flip it to 'completed'.
-- Run once after deploying the fix.

UPDATE jobs
SET status='completed',
    completed_at = COALESCE(completed_at, NOW()),
    updated_at = NOW(),
    result = COALESCE(result, '{"recovered": true}'::jsonb)
WHERE status='pending'
  AND id IN (SELECT DISTINCT job_id FROM text_chunks WHERE job_id IS NOT NULL);
