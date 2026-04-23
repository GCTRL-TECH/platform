import { useNavigate } from 'react-router-dom'
import { XCircle, Trash2 } from 'lucide-react'
import type { MouseEvent } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'

export interface KexJob {
  id: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  completedAt?: string | null
  input?: Record<string, unknown>
  result?: {
    entities?: unknown[]
    graph_stats?: { entities_created?: number }
  }
  error?: string
  batchId?: string | null
}

const STATUS_BADGE: Record<string, { className: string; label: string; dot: string }> = {
  pending: { className: 'badge-yellow', label: 'Pending', dot: 'bg-amber-400' },
  processing: { className: 'badge-blue', label: 'Processing', dot: 'bg-blue-400' },
  completed: { className: 'badge-green', label: 'Completed', dot: 'bg-emerald-400' },
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

function getJobEntities(job: KexJob): number | null {
  return job.result?.entities?.length ?? job.result?.graph_stats?.entities_created ?? null
}

function getJobDuration(job: KexJob): string | null {
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
}

export function JobRow({ job, compact, onCancel, onDelete }: JobRowProps) {
  const navigate = useNavigate()
  const badge = STATUS_BADGE[job.status] || STATUS_BADGE.pending
  const isRunning = job.status === 'pending' || job.status === 'processing'
  const entities = getJobEntities(job)
  const duration = getJobDuration(job)
  const name = getJobName(job)

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
        <span className="truncate text-xs text-slate-300 font-medium">{name}</span>
      </div>

      {/* Status badge — fixed width */}
      <span className={cn(badge.className, 'shrink-0 text-[9px] w-16 text-center')}>{badge.label}</span>

      {/* Entities — always rendered, fixed width */}
      <span className="shrink-0 text-[10px] text-slate-500 w-12 text-right">{entities !== null ? `${entities} ent` : '—'}</span>

      {/* Duration — always rendered, fixed width */}
      <span className="shrink-0 text-[10px] text-slate-600 w-12 text-right">{duration ?? (isRunning ? '...' : '—')}</span>

      {/* Time — fixed width */}
      <span className="shrink-0 text-[10px] text-slate-600 w-16 text-right">
        {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true }).replace('about ', '')}
      </span>

      {/* Actions — fixed width */}
      <div className="shrink-0 w-6 flex justify-end">
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
