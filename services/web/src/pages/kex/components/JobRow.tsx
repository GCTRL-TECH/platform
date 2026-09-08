import { useNavigate } from 'react-router-dom'
import { XCircle, Trash2, RotateCw } from 'lucide-react'
import type { MouseEvent } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'
import { isDegraded, type JobStatus } from '@/lib/jobStatus'

export interface KexJob {
  id: string
  type: string
  status: JobStatus
  /** Why the graph is incomplete — set only for `completed_degraded`. */
  degradedReason?: string | null
  createdAt: string
  completedAt?: string | null
  input?: Record<string, unknown>
  result?: {
    entities?: unknown[]
    graph_stats?: { entities_created?: number }
    /** Actual worker processing time in ms (dequeue -> result), excludes queue wait.
     *  Absent on jobs recorded before this was tracked -> fall back to wall time. */
    duration_ms?: number
  }
  error?: string
  batchId?: string | null
  /** Provenance (migration 081): name of the access token that triggered the
   *  job. Null/absent for web-login (JWT) jobs → rendered as "Web-Login". */
  tokenName?: string | null
  /** Email of the user who owns the job. */
  userEmail?: string | null
}

const STATUS_BADGE: Record<string, { className: string; label: string; dot: string }> = {
  pending: { className: 'badge-yellow', label: 'Pending', dot: 'bg-amber-400' },
  processing: { className: 'badge-blue', label: 'Processing', dot: 'bg-blue-400' },
  completed: { className: 'badge-green', label: 'Completed', dot: 'bg-emerald-400' },
  // Finished, but a phase was skipped — amber, and the row carries the reason as
  // its tooltip so the incomplete graph is visible in the list itself.
  completed_degraded: { className: 'badge-yellow', label: 'Incomplete', dot: 'bg-amber-400' },
  failed: { className: 'badge-red', label: 'Failed', dot: 'bg-red-400' },
}

export function getJobName(job: KexJob): string {
  if (!job.input) return '—'
  const fileName = (job.input['fileName'] as string) || (job.input['originalFilename'] as string) || ''
  if (fileName) return fileName.length > 50 ? fileName.slice(0, 50) + '...' : fileName
  const source = job.input['source'] as string
  if (source) return `[${source}]`
  const t = (job.input['text'] as string) ?? ''
  return t.length > 40 ? t.slice(0, 40) + '...' : t || '—'
}

// Maps a job to a coarse German source-kind label for the provenance sub-line.
// Order matters: upload is keyed on type, agent-store/repo on input.source, and
// connectors on the job type prefix.
export function getSourceKind(job: KexJob): string {
  const type = job.type || ''
  const source = (job.input?.['source'] as string | undefined) ?? ''
  if (type === 'kex_upload') return 'Datei'
  if (source === 'agent_store') return 'Agent-Store'
  if (source === 'repo' || type.includes('repo')) return 'Repo'
  const connectorTypes = ['kex_sharepoint', 'kex_obsidian', 'kex_connector', 'gmail', 'github', 'drive']
  if (connectorTypes.some((c) => type.includes(c))) return 'Connector'
  return 'Text'
}

function getJobEntities(job: KexJob): number | null {
  return job.result?.entities?.length ?? job.result?.graph_stats?.entities_created ?? null
}

function getJobDuration(job: KexJob): string | null {
  // Prefer the worker-stamped processing time (dequeue -> result). The DB's
  // created_at -> completed_at also counts the time the job sat queued behind other
  // jobs, which massively over-reported the duration for batched ingests (e.g. 481s
  // shown for a 4.8s extraction).
  const proc = job.result?.duration_ms
  if (typeof proc === 'number' && proc >= 0) {
    if (proc < 1000) return `${Math.round(proc)}ms`
    return `${(proc / 1000).toFixed(1)}s`
  }
  // Fallback for older jobs without a stamped processing time: enqueue -> done wall
  // clock (includes queue wait, so it can over-report).
  if (!job.createdAt || !job.completedAt) return null
  const ms = new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

interface JobRowProps {
  job: KexJob
  compact?: boolean
  onCancel?: (jobId: string) => void
  onDelete?: (jobId: string, name: string) => void
  onRetry?: (jobId: string) => void
}

export function JobRow({ job, compact, onCancel, onDelete, onRetry }: JobRowProps) {
  const navigate = useNavigate()
  const badge = STATUS_BADGE[job.status] || STATUS_BADGE.pending
  const isRunning = job.status === 'pending' || job.status === 'processing'
  const entities = getJobEntities(job)
  const duration = getJobDuration(job)
  const name = getJobName(job)
  // Provenance sub-line: who triggered it (token name, else Web-Login) · source kind.
  const trigger = job.tokenName || 'Web-Login'
  const sourceKind = getSourceKind(job)

  return (
    <div
      onClick={() => navigate(`/kex/${job.id}`)}
      className={cn(
        'group flex items-center gap-3 cursor-pointer transition-colors hover:bg-slate-800/50',
        compact ? 'px-6 py-2' : 'px-4 py-2.5',
      )}
    >
      {/* Status dot */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className={cn('h-2 w-2 shrink-0 rounded-full', badge.dot, isRunning && 'animate-pulse')} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-slate-300 font-medium">{name}</span>
          <span className="truncate text-[10px] text-slate-500">{trigger} · {sourceKind}</span>
        </div>
      </div>

      {/* Status badge — fixed width */}
      <span
        className={cn(badge.className, 'shrink-0 text-[9px] w-16 text-center')}
        title={isDegraded(job.status) ? (job.degradedReason ?? undefined) : undefined}
      >
        {badge.label}
      </span>

      {/* Entities — always rendered, fixed width */}
      <span className="shrink-0 text-[10px] text-slate-500 w-12 text-right">{entities !== null ? `${entities} ent` : '—'}</span>

      {/* Duration — always rendered, fixed width */}
      <span className="shrink-0 text-[10px] text-slate-600 w-12 text-right">{duration ?? (isRunning ? '...' : '—')}</span>

      {/* Time — fixed width */}
      <span className="shrink-0 text-[10px] text-slate-600 w-16 text-right">
        {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true }).replace('about ', '')}
      </span>

      {/* Actions — fixed width */}
      <div className="shrink-0 w-12 flex justify-end gap-1.5">
        {job.status === 'failed' && onRetry && (
          <button
            onClick={(e: MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onRetry(job.id) }}
            className="text-slate-600 hover:text-indigo-400 transition-colors"
            title="Retry"
          >
            <RotateCw size={12} />
          </button>
        )}
        {isRunning && onCancel && (
          <button
            onClick={(e: MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onCancel(job.id) }}
            className="text-slate-600 hover:text-red-400 transition-colors"
            title="Cancel"
          >
            <XCircle size={12} />
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e: MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onDelete(job.id, name) }}
            className="text-slate-600 hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
