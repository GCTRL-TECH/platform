/**
 * Job status vocabulary shared by the KEX/FUSE views.
 *
 * `completed_degraded` is a TERMINAL SUCCESS: the job finished, but one of its
 * phases was skipped (relation extraction or embedding — typically because the
 * LLM/embedding endpoint was unreachable), so the graph it produced is
 * incomplete. The API derives it from the job result and ships the human-readable
 * cause in `degradedReason`; the stored status column stays `completed`
 * (services/api-rs/src/routes/kex.rs → `presented_status`).
 *
 * Anything that used to test `status === 'completed'` must use `isCompleted()`,
 * otherwise a degraded job silently disappears from lists, counts and result
 * fetches — which is exactly the invisibility this state exists to end.
 */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'completed_degraded' | 'failed'

/** Finished successfully — with or without a degraded phase. */
export function isCompleted(status?: string): boolean {
  return status === 'completed' || status === 'completed_degraded'
}

/** Finished, but the resulting graph is incomplete. */
export function isDegraded(status?: string): boolean {
  return status === 'completed_degraded'
}
