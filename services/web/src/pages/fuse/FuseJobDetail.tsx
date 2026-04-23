import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  XCircle,
  Loader2,
  ExternalLink,
  GitMerge,
  GitBranch,
  Hash,
  AlertCircle,
  Database,
  Layers,
  XCircle as CancelIcon,
} from 'lucide-react'
import { format } from 'date-fns'
import { useApiQuery } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'

interface FuseJobData {
  id: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  updatedAt?: string
  completedAt?: string | null
  error?: string | null
  input?: {
    name?: string
    sourceJobIds?: string[]
    compilationId?: string
  }
  result?: {
    compilation_id?: string
    status?: string
    entities_merged?: number
    duplicates_found?: number
    relations_merged?: number
    nodes_total?: number
    stage1_apoc?: number
    stage2_limes?: number
    stage3_conex?: number
    total_links?: number
  }
}

interface FuseJobResponse {
  job: FuseJobData
}

type StepStatus = 'done' | 'active' | 'pending' | 'failed'

function getStepStatus(stepKey: string, jobStatus: string): StepStatus {
  if (jobStatus === 'failed' && stepKey === 'completed') return 'failed'
  if (stepKey === 'created') return 'done'
  if (stepKey === 'processing') {
    if (jobStatus === 'pending') return 'pending'
    if (jobStatus === 'processing') return 'active'
    return 'done'
  }
  if (stepKey === 'completed') {
    if (jobStatus === 'completed') return 'done'
    return 'pending'
  }
  return 'pending'
}

function TimelineStepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') return <CheckCircle2 size={18} className="text-emerald-400" />
  if (status === 'active') return <Loader2 size={18} className="text-blue-400 animate-spin" />
  if (status === 'failed') return <XCircle size={18} className="text-red-400" />
  return <Circle size={18} className="text-slate-700" />
}

const TIMELINE_STEPS = [
  { key: 'created', label: 'Created', description: 'Fusion job queued' },
  { key: 'processing', label: 'Processing', description: 'Running identity matching, similarity analysis, and structural inference' },
  { key: 'completed', label: 'Completed', description: 'Unified knowledge graph created' },
]

const STATUS_BADGE: Record<string, { className: string; label: string }> = {
  pending: { className: 'badge-yellow', label: 'Pending' },
  processing: { className: 'badge-blue', label: 'Processing' },
  completed: { className: 'badge-green', label: 'Completed' },
  failed: { className: 'badge-red', label: 'Failed' },
}

export function FuseJobDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: jobResponse, isLoading, error } = useApiQuery<FuseJobResponse>(
    ['fuse', 'jobs', id],
    `/fuse/jobs/${id}`,
    {
      enabled: !!id,
      refetchInterval: (query) => {
        const data = query.state.data as FuseJobResponse | undefined
        const status = data?.job?.status
        if (status === 'pending' || status === 'processing') return 3000
        return false
      },
    }
  )

  const job = jobResponse?.job
  const statusInfo = job
    ? STATUS_BADGE[job.status] ?? { className: 'badge-slate', label: job.status }
    : null
  const r = job?.result
  const compilationId = r?.compilation_id || job?.input?.compilationId
  const jobName = job?.input?.name || 'Fusion Job'
  const isRunning = job?.status === 'pending' || job?.status === 'processing'

  const duration = job?.completedAt && job?.createdAt
    ? `${((new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()) / 1000).toFixed(1)}s`
    : null

  async function handleCancel() {
    try {
      const { apiPost } = await import('@/lib/api')
      await apiPost(`/fuse/jobs/${id}/cancel`)
      queryClient.invalidateQueries({ queryKey: ['fuse', 'jobs'] })
    } catch { /* may already be done */ }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <AlertCircle size={32} className="text-red-400" />
        <div>
          <p className="text-lg font-semibold text-slate-200">Job not found</p>
          <p className="mt-1 text-sm text-slate-500">This fusion job doesn't exist or was deleted.</p>
        </div>
        <button onClick={() => navigate('/fuse')} className="btn-secondary">Back to FUSE</button>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div className="flex items-start gap-4">
        <button onClick={() => navigate('/fuse')} className="btn-ghost mt-0.5 text-slate-500 hover:text-slate-300">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-slate-100">{jobName}</h2>
            {statusInfo && <span className={statusInfo.className}>{statusInfo.label}</span>}
            {duration && <span className="text-xs text-slate-500 font-mono">{duration}</span>}
          </div>
          <p className="mt-1 font-mono text-xs text-slate-600">{job.id}</p>
        </div>
        <div className="flex gap-2">
          {isRunning && (
            <button onClick={handleCancel} className="btn-secondary text-red-400 hover:text-red-300">
              <CancelIcon size={14} />
              Cancel
            </button>
          )}
          {compilationId && (
            <button onClick={() => navigate(`/graphs/${compilationId}`)} className="btn-secondary">
              <Database size={14} />
              View Compilation
            </button>
          )}
          <a href="http://localhost:7474" target="_blank" rel="noopener noreferrer" className="btn-secondary">
            <ExternalLink size={14} />
            Neo4j
          </a>
        </div>
      </div>

      {/* Timeline */}
      <div className="card">
        <h3 className="mb-5 text-sm font-semibold text-slate-200">Processing Timeline</h3>
        <div className="relative">
          {TIMELINE_STEPS.map((step, idx) => {
            const stepStatus = getStepStatus(step.key, job.status)
            const isLast = idx === TIMELINE_STEPS.length - 1
            return (
              <div key={step.key} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <TimelineStepIcon status={stepStatus} />
                  {!isLast && (
                    <div className={cn('mt-1 h-10 w-px', stepStatus === 'done' ? 'bg-emerald-500/30' : 'bg-slate-800')} />
                  )}
                </div>
                <div className={cn('pb-6', isLast && 'pb-0')}>
                  <p className={cn('text-sm font-medium', stepStatus === 'pending' ? 'text-slate-600' : 'text-slate-200')}>
                    {step.label}
                  </p>
                  <p className="text-xs text-slate-500">{step.description}</p>
                  {step.key === 'created' && job.createdAt && (
                    <p className="mt-0.5 font-mono text-xs text-slate-600">
                      {format(new Date(job.createdAt), 'MMM d, yyyy HH:mm:ss')}
                    </p>
                  )}
                  {step.key === 'completed' && job.completedAt && (
                    <p className="mt-0.5 font-mono text-xs text-slate-600">
                      {format(new Date(job.completedAt), 'MMM d, yyyy HH:mm:ss')}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {job.status === 'failed' && job.error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{job.error}</span>
          </div>
        )}
      </div>

      {/* Stats */}
      {job.status === 'completed' && r && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="card flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
                <Hash size={18} className="text-violet-400" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Entities</p>
                <p className="text-xl font-bold text-slate-100">{(r.entities_merged ?? 0).toLocaleString()}</p>
              </div>
            </div>
            <div className="card flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10">
                <GitBranch size={18} className="text-cyan-400" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Relations</p>
                <p className="text-xl font-bold text-slate-100">{(r.relations_merged ?? 0).toLocaleString()}</p>
              </div>
            </div>
            <div className="card flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10">
                <GitMerge size={18} className="text-emerald-400" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Duplicates</p>
                <p className="text-xl font-bold text-slate-100">{(r.duplicates_found ?? 0).toLocaleString()}</p>
              </div>
            </div>
            <div className="card flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10">
                <Layers size={18} className="text-amber-400" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Links</p>
                <p className="text-xl font-bold text-slate-100">{(r.total_links ?? 0).toLocaleString()}</p>
              </div>
            </div>
          </div>

          {/* Stage breakdown */}
          <div className="card">
            <h3 className="mb-4 text-sm font-semibold text-slate-200">Discovery Breakdown</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-sm text-slate-300">Exact Identity Match</span>
                </div>
                <span className="font-mono text-sm font-medium text-slate-200">{r.stage1_apoc ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                  <span className="text-sm text-slate-300">Similarity-Based Discovery</span>
                </div>
                <span className="font-mono text-sm font-medium text-slate-200">{r.stage2_limes ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                  <span className="text-sm text-slate-300">Structural Pattern Inference</span>
                </div>
                <span className="font-mono text-sm font-medium text-slate-200">{r.stage3_conex ?? 0}</span>
              </div>

              {/* Visual bar */}
              {(r.total_links ?? 0) > 0 && (
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-800">
                  {(r.stage1_apoc ?? 0) > 0 && (
                    <div
                      className="bg-emerald-500"
                      style={{ width: `${((r.stage1_apoc ?? 0) / (r.total_links ?? 1)) * 100}%` }}
                    />
                  )}
                  {(r.stage2_limes ?? 0) > 0 && (
                    <div
                      className="bg-blue-500"
                      style={{ width: `${((r.stage2_limes ?? 0) / (r.total_links ?? 1)) * 100}%` }}
                    />
                  )}
                  {(r.stage3_conex ?? 0) > 0 && (
                    <div
                      className="bg-amber-500"
                      style={{ width: `${((r.stage3_conex ?? 0) / (r.total_links ?? 1)) * 100}%` }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Source jobs */}
          {job.input?.sourceJobIds && job.input.sourceJobIds.length > 0 && (
            <div className="card">
              <h3 className="mb-3 text-sm font-semibold text-slate-200">Source Extractions</h3>
              <div className="space-y-2">
                {job.input.sourceJobIds.map((jobId) => (
                  <button
                    key={jobId}
                    onClick={() => navigate(`/kex/${jobId}`)}
                    className="flex w-full items-center gap-3 rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-2.5 text-left hover:bg-slate-800/60 transition-colors"
                  >
                    <Database size={14} className="text-slate-500 shrink-0" />
                    <span className="font-mono text-xs text-slate-400 truncate">{jobId}</span>
                    <span className="ml-auto text-xs text-slate-600">View →</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
