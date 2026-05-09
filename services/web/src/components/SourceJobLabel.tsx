/**
 * SourceJobLabel — renders a friendly label for a KEX source job.
 *
 * Given a `jobId` and the full `jobs` list (typically from `useApiQuery(['kex','jobs'], '/kex/jobs')`),
 * resolves a descriptive label:
 *   1. The original file name (from `input.fileName` or `input.originalFilename`)
 *   2. The first 60 chars of `input.text` if no file name exists
 *   3. `(deleted extraction)` if the job is missing from the list
 *
 * Renders a short UUID prefix as a monospace subtitle for power users.
 */

export interface SourceJobInfo {
  id: string
  input?: Record<string, unknown>
}

interface SourceJobLabelProps {
  jobId: string
  jobs: SourceJobInfo[] | undefined
  /** Show only the label without the UUID subtitle. */
  hideUuid?: boolean
}

export function resolveSourceJobLabel(
  jobId: string,
  jobs: SourceJobInfo[] | undefined
): { label: string; missing: boolean } {
  const job = jobs?.find((j) => j.id === jobId)
  if (!job) {
    return { label: '(deleted extraction)', missing: true }
  }
  const input = job.input
  if (input) {
    const fileName =
      (input['fileName'] as string | undefined) ||
      (input['originalFilename'] as string | undefined)
    if (fileName && fileName.trim()) {
      return { label: fileName, missing: false }
    }
    const text = input['text'] as string | undefined
    if (text && text.trim()) {
      const trimmed = text.trim()
      return {
        label: trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed,
        missing: false,
      }
    }
  }
  return { label: jobId.slice(0, 12) + '…', missing: false }
}

export function SourceJobLabel({ jobId, jobs, hideUuid = false }: SourceJobLabelProps) {
  const { label, missing } = resolveSourceJobLabel(jobId, jobs)
  return (
    <div className="min-w-0">
      <p
        className={
          'truncate text-xs font-medium ' +
          (missing ? 'text-slate-600 italic' : 'text-slate-300')
        }
      >
        {label}
      </p>
      {!hideUuid && (
        <span className="font-mono text-[10px] text-slate-600">
          {jobId.slice(0, 12)}…
        </span>
      )}
    </div>
  )
}
