import { useState } from 'react'
import { FolderOpen, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { JobRow, type KexJob } from './JobRow'

export interface JobBatch {
  id: string
  name: string
  source: string | null
  sourceMetadata?: Record<string, unknown> | null
  totalJobs: number
  completedJobs: number
  failedJobs: number
  status: string
  createdAt: string
  updatedAt: string
}

interface BatchRowProps {
  batch: JobBatch
  onCancelJob?: (jobId: string) => void
  onDeleteJob?: (jobId: string, name: string) => void
}

export function BatchRow({ batch, onCancelJob, onDeleteJob }: BatchRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [childJobs, setChildJobs] = useState<KexJob[]>([])
  const [loading, setLoading] = useState(false)

  const doneJobs = batch.completedJobs + batch.failedJobs
  const progress = batch.totalJobs > 0 ? Math.round((doneJobs / batch.totalJobs) * 100) : 0
  const isRunning = batch.status === 'processing' || batch.status === 'pending'
  const pendingJobs = batch.totalJobs - doneJobs

  async function toggleExpand() {
    if (!expanded && childJobs.length === 0) {
      setLoading(true)
      try {
        const { data } = await api.get(`/kex/batches/${batch.id}/jobs`)
        setChildJobs(data.jobs || [])
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    setExpanded(!expanded)
  }

  return (
    <div className="border-b border-slate-800/50">
      {/* Batch header row */}
      <button
        onClick={() => void toggleExpand()}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-800/30 transition-colors"
      >
        {/* Expand icon + Folder icon + Name (flex-1 to match JobRow name col) */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {expanded ? <ChevronDown size={10} className="shrink-0 text-slate-500" /> : <ChevronRight size={10} className="shrink-0 text-slate-500" />}
          <FolderOpen size={13} className="shrink-0 text-amber-400" />
          <span className="truncate text-xs font-medium text-slate-200">
            {batch.name}
            {batch.sourceMetadata && (batch.sourceMetadata as { compilationName?: string }).compilationName && (
              <span className="text-slate-500 font-normal">{' → '}<span className="text-indigo-400">{String((batch.sourceMetadata as { compilationName: string }).compilationName)}</span></span>
            )}
          </span>
        </div>

        {/* Progress bar — aligned to status badge column (w-16) */}
        <div className="shrink-0 w-16">
          <div className="flex items-center gap-1">
            <div className="h-1.5 flex-1 rounded-full bg-slate-800">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  batch.status === 'completed' ? 'bg-emerald-500' :
                  batch.failedJobs > 0 ? 'bg-amber-500' : 'bg-indigo-500',
                  isRunning && 'animate-pulse'
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[9px] text-slate-500 w-6 text-right">{progress}%</span>
          </div>
        </div>

        {/* Entities col (w-12) — show total */}
        <span className="shrink-0 text-[10px] text-slate-500 w-12 text-right">{batch.totalJobs} files</span>

        {/* Duration col (w-12) — show counts */}
        <span className="shrink-0 text-[10px] w-12 text-right">
          {batch.failedJobs > 0 ? <span className="text-red-400">{batch.failedJobs} err</span> : <span className="text-emerald-400">{batch.completedJobs} done</span>}
        </span>

        {/* Time col (w-16) — pending count */}
        <span className="shrink-0 text-[10px] text-slate-600 w-16 text-right">
          {pendingJobs > 0 ? `${pendingJobs} pending` : ''}
        </span>

        {/* Actions col (w-6) — spinner when running */}
        <div className="shrink-0 w-6 flex justify-end">
          {isRunning && <Loader2 size={12} className="animate-spin text-indigo-400" />}
        </div>
      </button>

      {/* Expanded child jobs */}
      {expanded && (
        <div className="bg-slate-950/30">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={14} className="animate-spin text-slate-500" />
            </div>
          ) : childJobs.length === 0 ? (
            <p className="px-8 py-3 text-[10px] text-slate-600">No jobs in this batch</p>
          ) : (
            childJobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                compact
                onCancel={onCancelJob}
                onDelete={onDeleteJob}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
