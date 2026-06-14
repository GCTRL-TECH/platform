import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  XCircle,
  Loader2,
  ExternalLink,
  GitBranch,
  Hash,
  AlertCircle,
  ThumbsUp,
  ThumbsDown,
  Shield,
} from 'lucide-react'
import { format } from 'date-fns'
import { useApiQuery } from '@/hooks/useApi'
import { usePublicConfig } from '@/hooks/usePublicConfig'
import { cn } from '@/lib/utils'

interface Entity {
  text: string
  label: string
  type: string
  score?: number
}

interface Relation {
  head: string
  type: string
  tail: string
}

interface JobData {
  id: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  updatedAt?: string
  completedAt?: string
  input?: Record<string, unknown>
  error?: string
}

interface JobResultData {
  jobId: string
  status: string
  completedAt?: string
  result?: {
    entities?: Entity[]
    relations?: Relation[]
    graphStats?: {
      nodes?: number
      edges?: number
    }
    raw?: {
      graph_stats?: {
        entities_created?: number
        relations_created?: number
        nodes_total?: number
      }
    }
    pii_findings?: {
      has_pii: boolean
      total_count: number
      findings: { type: string; count: number }[]
    }
  }
}

type TimelineStep = {
  key: string
  label: string
  description: string
}

const TIMELINE_STEPS: TimelineStep[] = [
  { key: 'created', label: 'Created', description: 'Job queued for processing' },
  { key: 'processing', label: 'Processing', description: 'Extracting entities and relations' },
  { key: 'completed', label: 'Completed', description: 'Knowledge graph updated' },
]

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

const STATUS_BADGE: Record<string, { className: string; label: string }> = {
  pending: { className: 'badge-yellow', label: 'Pending' },
  processing: { className: 'badge-blue', label: 'Processing' },
  completed: { className: 'badge-green', label: 'Completed' },
  failed: { className: 'badge-red', label: 'Failed' },
}

export function KexJobDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [feedback, setFeedback] = useState<Record<number, 'up' | 'down'>>({})
  const { neo4jBrowser } = usePublicConfig()

  // Fetch job status
  const { data: jobResponse, isLoading, error } = useApiQuery<{ job: JobData }>(
    ['kex', 'jobs', id],
    `/kex/jobs/${id}`,
    {
      enabled: !!id,
      refetchInterval: (query) => {
        const data = query.state.data as { job: JobData } | undefined
        if (data?.job?.status === 'pending' || data?.job?.status === 'processing') return 3000
        return false
      },
    }
  )

  // Fetch results when completed
  const job = jobResponse?.job
  const { data: resultData } = useApiQuery<JobResultData>(
    ['kex', 'jobs', id, 'result'],
    `/kex/jobs/${id}/result`,
    {
      enabled: !!id && job?.status === 'completed',
    }
  )

  const statusInfo = job ? (STATUS_BADGE[job.status] ?? { className: 'badge-slate', label: job.status }) : null

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
          <p className="mt-1 text-sm text-slate-500">This extraction job doesn't exist or was deleted.</p>
        </div>
        <button onClick={() => navigate('/kex')} className="btn-secondary">
          Back to KEX
        </button>
      </div>
    )
  }

  const entities = resultData?.result?.entities ?? []
  const relations = resultData?.result?.relations ?? []
  const graphStats = resultData?.result?.raw?.graph_stats

  const inputText = (job.input?.['text'] as string) ?? ''

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Back + header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => navigate('/kex')}
          className="btn-ghost mt-0.5 text-slate-500 hover:text-slate-300"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-slate-100">Extraction Job</h2>
            {statusInfo && <span className={statusInfo.className}>{statusInfo.label}</span>}
          </div>
          <p className="mt-1 font-mono text-xs text-slate-600">{job.id}</p>
        </div>
        <a
          href={neo4jBrowser}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary"
        >
          <ExternalLink size={14} />
          View in Neo4j
        </a>
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
                    <p className="mt-0.5 text-xs text-slate-600 font-mono">
                      {format(new Date(job.createdAt), 'MMM d, yyyy HH:mm:ss')}
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
      {job.status === 'completed' && graphStats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="card flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
              <Hash size={18} className="text-violet-400" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Entities</p>
              <p className="text-xl font-bold text-slate-100">{entities.length}</p>
            </div>
          </div>
          <div className="card flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10">
              <GitBranch size={18} className="text-cyan-400" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Relations</p>
              <p className="text-xl font-bold text-slate-100">{relations.length}</p>
            </div>
          </div>
        </div>
      )}

      {/* PII Shield */}
      {job.status === 'completed' && resultData?.result?.pii_findings && (
        <div className={cn(
          "card flex items-start gap-4 border",
          resultData.result.pii_findings.has_pii
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-emerald-500/30 bg-emerald-500/5"
        )}>
          <div className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            resultData.result.pii_findings.has_pii ? "bg-amber-500/10" : "bg-emerald-500/10"
          )}>
            <Shield size={18} className={resultData.result.pii_findings.has_pii ? "text-amber-400" : "text-emerald-400"} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-200">
              {resultData.result.pii_findings.has_pii
                ? `PII Detected — ${resultData.result.pii_findings.total_count} instance${resultData.result.pii_findings.total_count !== 1 ? 's' : ''}`
                : "No PII Detected"}
            </p>
            {resultData.result.pii_findings.has_pii && (
              <div className="mt-2 flex flex-wrap gap-2">
                {resultData.result.pii_findings.findings.map((f) => (
                  <span key={f.type} className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20">
                    {f.type.replace(/_/g, ' ')}: {f.count}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Entities table */}
      {entities.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">
              Entities <span className="text-slate-600">({entities.length})</span>
            </h3>
            <div className="flex items-center gap-3 text-xs">
              {Object.values(feedback).filter((v) => v === 'up').length > 0 && (
                <span className="flex items-center gap-1 text-emerald-400">
                  <ThumbsUp size={12} />
                  {Object.values(feedback).filter((v) => v === 'up').length} correct
                </span>
              )}
              {Object.values(feedback).filter((v) => v === 'down').length > 0 && (
                <span className="flex items-center gap-1 text-red-400">
                  <ThumbsDown size={12} />
                  {Object.values(feedback).filter((v) => v === 'down').length} incorrect
                </span>
              )}
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 border-b border-slate-800 bg-slate-900/90 backdrop-blur-sm">
                <tr>
                  <th className="table-header">Text</th>
                  <th className="table-header">Label</th>
                  <th className="table-header">Confidence</th>
                  <th className="table-header text-right">Feedback</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {entities.map((entity, i) => (
                  <tr key={i} className="hover:bg-slate-800/30 transition-colors">
                    <td className="table-cell font-medium text-slate-200">{entity.text}</td>
                    <td className="table-cell">
                      <span className="badge badge-slate">{entity.label}</span>
                    </td>
                    <td className="table-cell">
                      {entity.score !== undefined ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 rounded-full bg-slate-800 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${entity.score * 100}%` }}
                            />
                          </div>
                          <span className="text-xs text-slate-500">
                            {(entity.score * 100).toFixed(0)}%
                          </span>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="table-cell text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() =>
                            setFeedback((prev) => {
                              const next = { ...prev }
                              if (next[i] === 'up') { delete next[i] } else { next[i] = 'up' }
                              return next
                            })
                          }
                          title="Correct entity type"
                          className={cn(
                            'rounded p-1 transition-colors',
                            feedback[i] === 'up'
                              ? 'text-emerald-400 bg-emerald-500/10'
                              : 'text-slate-600 hover:text-emerald-400 hover:bg-emerald-500/10'
                          )}
                        >
                          <ThumbsUp size={13} />
                        </button>
                        <button
                          onClick={() =>
                            setFeedback((prev) => {
                              const next = { ...prev }
                              if (next[i] === 'down') { delete next[i] } else { next[i] = 'down' }
                              return next
                            })
                          }
                          title="Wrong entity type"
                          className={cn(
                            'rounded p-1 transition-colors',
                            feedback[i] === 'down'
                              ? 'text-red-400 bg-red-500/10'
                              : 'text-slate-600 hover:text-red-400 hover:bg-red-500/10'
                          )}
                        >
                          <ThumbsDown size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Relations table */}
      {relations.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="border-b border-slate-800 px-6 py-4">
            <h3 className="text-sm font-semibold text-slate-200">
              Relations <span className="text-slate-600">({relations.length})</span>
            </h3>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 border-b border-slate-800 bg-slate-900/90 backdrop-blur-sm">
                <tr>
                  <th className="table-header">Head</th>
                  <th className="table-header">Relation</th>
                  <th className="table-header">Tail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {relations.map((rel, i) => (
                  <tr key={i} className="hover:bg-slate-800/30 transition-colors">
                    <td className="table-cell font-medium text-slate-300">{rel.head}</td>
                    <td className="table-cell">
                      <span className="font-mono text-xs text-blue-400">{rel.type}</span>
                    </td>
                    <td className="table-cell text-slate-300">{rel.tail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Input preview */}
      {inputText && (
        <div className="card">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Source Input</h3>
          <pre className="overflow-x-auto rounded-lg bg-slate-800/50 p-4 font-mono text-xs text-slate-400 whitespace-pre-wrap break-all">
            {inputText.slice(0, 500)}{inputText.length > 500 ? '...' : ''}
          </pre>
        </div>
      )}
    </div>
  )
}
