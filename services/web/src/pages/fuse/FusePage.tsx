import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  GitMerge,
  Plus,
  ArrowUpRight,
  ArrowLeft,
  Clock,
  XCircle,
  Trash2,
  Coins,
  Search,
  CheckSquare,
  Square,
  Database,
  Network,
  AlertCircle,
  Info,
  ChevronDown,
  Hash,
  GitBranch,
  ChevronRight,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useApiQuery, useApiMutation } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal'
import { useAuth } from '@/hooks/useAuth'

// ─── Types ────────────────────────────────────────────────────────────────────

interface KexJob {
  id: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  completedAt?: string | null
  input?: Record<string, unknown>
  result?: {
    entities?: unknown[]
    relations?: unknown[]
    graph_stats?: {
      entities_created?: number
      nodes_total?: number
    }
  }
}

interface KexJobsResponse {
  jobs: KexJob[]
}

type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'

interface Compilation {
  id: string
  name: string
  description: string | null
  nodeCount: number
  edgeCount: number
  classification: Classification
  sourceJobIds: string[]
  version: number
  createdAt: string
}

interface CompilationsResponse {
  compilations: Compilation[]
}

interface FuseJob {
  id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  completedAt?: string | null
  input?: Record<string, unknown>
  result?: {
    nodes_total?: number
    entities_merged?: number
    duplicates_found?: number
    relations_merged?: number
  }
  error?: string | null
}

interface FuseJobsResponse {
  jobs: FuseJob[]
}

interface MergeResponse {
  compilationId: string
  jobId: string
  status: string
}

interface OntologyOption {
  id: string
  name: string
  scope: 'private' | 'shared' | 'public'
  entityTypeCount: number
  entityTypes?: { name: string; qid: string }[]
}

interface OntologiesResponse {
  ontologies: OntologyOption[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { className: string; label: string; dot: string }> = {
  pending: { className: 'badge-yellow', label: 'Pending', dot: 'bg-amber-400' },
  processing: { className: 'badge-blue', label: 'Processing', dot: 'bg-blue-400' },
  completed: { className: 'badge-green', label: 'Completed', dot: 'bg-emerald-400' },
  failed: { className: 'badge-red', label: 'Failed', dot: 'bg-red-400' },
}

const CLASSIFICATION_BADGE: Record<Classification, string> = {
  PUBLIC: 'badge-green',
  INTERNAL: 'badge-blue',
  CONFIDENTIAL: 'badge-yellow',
  RESTRICTED: 'badge-red',
}

type Mode = 'mode_select' | 'create_new' | 'enrich_existing'

// ─── SourcePicker ─────────────────────────────────────────────────────────────

function SourcePicker({
  selectedIds,
  onToggle,
  onSelectAll,
  onDeselectAll,
}: {
  selectedIds: string[]
  onToggle: (id: string) => void
  onSelectAll: (allIds: string[]) => void
  onDeselectAll: () => void
}) {
  const [search, setSearch] = useState('')

  const { data: kexData, isLoading } = useApiQuery<KexJobsResponse>(
    ['kex', 'jobs'],
    '/kex/jobs'
  )

  const completedJobs = (kexData?.jobs ?? []).filter((j) => j.status === 'completed')

  const filtered = search.trim()
    ? completedJobs.filter((j) => {
        const text = (j.input?.['text'] as string) || (j.input?.['originalFilename'] as string) || ''
        return (
          text.toLowerCase().includes(search.toLowerCase()) ||
          j.id.toLowerCase().includes(search.toLowerCase())
        )
      })
    : completedJobs

  function getJobPreview(job: KexJob): string {
    if (!job.input) return job.id.slice(0, 12)
    // File uploads store the original filename under `fileName` (api-rs) or
    // `originalFilename` (KEX worker). Text extractions store the input under `text`.
    const t =
      (job.input['fileName'] as string) ||
      (job.input['originalFilename'] as string) ||
      (job.input['text'] as string) ||
      ''
    return t.length > 48 ? t.slice(0, 48) + '...' : t || job.id.slice(0, 12)
  }

  function getEntityCount(job: KexJob): number | null {
    return (
      job.result?.entities?.length ??
      job.result?.graph_stats?.entities_created ??
      null
    )
  }

  function getJobType(job: KexJob): string {
    return job.type.replace('kex_', '')
  }

  return (
    <div className="space-y-2">
      {/* Search + select all */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-field pl-8 py-1.5 text-xs"
            placeholder="Search extractions..."
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onSelectAll(completedJobs.map((j) => j.id))}
            className="text-xs text-slate-500 hover:text-blue-400 transition-colors"
          >
            Select All
          </button>
          <span className="text-slate-700">·</span>
          <button
            type="button"
            onClick={onDeselectAll}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Deselect All
          </button>
          {selectedIds.length > 0 && (
            <span className="ml-1 rounded-md bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400">
              {selectedIds.length} selected
            </span>
          )}
        </div>
      </div>

      {/* Job list */}
      {isLoading ? (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-6 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
          Loading extractions...
        </div>
      ) : completedJobs.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-800/20 px-4 py-5">
          <Info size={15} className="shrink-0 text-slate-600" />
          <p className="text-sm text-slate-500">
            No completed extractions found. Run at least one extraction in KEX first.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-800/20 px-4 py-4">
          <Search size={13} className="text-slate-600" />
          <p className="text-sm text-slate-500">No extractions match your search.</p>
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-700 divide-y divide-slate-800">
          {filtered.map((job) => {
            const selected = selectedIds.includes(job.id)
            const entities = getEntityCount(job)
            const typeLabel = getJobType(job)
            return (
              <button
                key={job.id}
                type="button"
                onClick={() => onToggle(job.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                  selected
                    ? 'bg-blue-500/10 hover:bg-blue-500/15'
                    : 'bg-slate-800/20 hover:bg-slate-800/50'
                )}
              >
                {selected ? (
                  <CheckSquare size={15} className="shrink-0 text-blue-400" />
                ) : (
                  <Square size={15} className="shrink-0 text-slate-600" />
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'truncate text-xs font-medium',
                      selected ? 'text-blue-300' : 'text-slate-300'
                    )}
                  >
                    {getJobPreview(job)}
                  </p>
                  <p className="font-mono text-[10px] text-slate-600">{job.id.slice(0, 12)}...</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {entities !== null && (
                    <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
                      {entities} ent.
                    </span>
                  )}
                  <span className="badge-slate text-[10px] uppercase">{typeLabel}</span>
                  <div className="flex items-center gap-1 text-[10px] text-slate-600">
                    <Clock size={10} />
                    {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Active Jobs Table ─────────────────────────────────────────────────────────

function ActiveJobs({
  jobs,
  onCancel,
  onDelete,
}: {
  jobs: FuseJob[]
  onCancel: (jobId: string, e: React.MouseEvent) => void
  onDelete: (jobId: string, jobName: string) => void
}) {
  const navigate = useNavigate()

  const visible = jobs
    .filter((j) => j.status === 'pending' || j.status === 'processing' || j.status === 'completed' || j.status === 'failed')
    .slice(0, 5)

  const active = visible.filter((j) => j.status === 'pending' || j.status === 'processing')
  const recent = visible.filter((j) => j.status === 'completed' || j.status === 'failed')
  const displayJobs = [...active, ...recent].slice(0, 5)

  if (displayJobs.length === 0) return null

  return (
    <div className="card p-0 overflow-hidden">
      <div className="border-b border-slate-800 px-6 py-4">
        <h3 className="text-sm font-semibold text-slate-200">Active Fusion Jobs</h3>
      </div>
      <table className="w-full">
        <thead className="border-b border-slate-800 bg-slate-900/50">
          <tr>
            <th className="table-header">Name</th>
            <th className="table-header">Status</th>
            <th className="table-header">Entities</th>
            <th className="table-header">Relations</th>
            <th className="table-header">Duplicates</th>
            <th className="table-header">Duration</th>
            <th className="table-header text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {displayJobs.map((job) => {
            const statusInfo = STATUS_BADGE[job.status] ?? { className: 'badge-slate', label: job.status, dot: 'bg-slate-400' }
            const isRunning = job.status === 'processing' || job.status === 'pending'
            const jobName = (job.input as Record<string, unknown>)?.['name'] as string | undefined
            const duration = job.completedAt
              ? `${((new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()) / 1000).toFixed(1)}s`
              : isRunning ? '...' : '—'
            return (
              <tr
                key={job.id}
                className="hover:bg-slate-800/30 transition-colors group cursor-pointer"
                onClick={() => navigate(`/fuse/${job.id}`)}
              >
                <td className="table-cell">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-800">
                      <GitMerge size={12} className="text-violet-400" />
                    </div>
                    <div className="min-w-0">
                      <span className="block text-xs font-medium text-slate-300 truncate">
                        {jobName ?? job.id.slice(0, 12)}
                      </span>
                      <span className="font-mono text-[10px] text-slate-600">{job.id.slice(0, 8)}</span>
                    </div>
                  </div>
                </td>
                <td className="table-cell">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full', statusInfo.dot, isRunning && 'animate-pulse')}
                    />
                    <span className={statusInfo.className}>{statusInfo.label}</span>
                  </div>
                </td>
                <td className="table-cell">
                  <span className="text-xs text-slate-400 font-mono">
                    {job.result?.entities_merged?.toLocaleString() ?? '—'}
                  </span>
                </td>
                <td className="table-cell">
                  <span className="text-xs text-slate-400 font-mono">
                    {job.result?.relations_merged?.toLocaleString() ?? '—'}
                  </span>
                </td>
                <td className="table-cell">
                  <span className="text-xs text-slate-400 font-mono">
                    {job.result?.duplicates_found?.toLocaleString() ?? '—'}
                  </span>
                </td>
                <td className="table-cell">
                  <span className="text-xs text-slate-400 font-mono">{duration}</span>
                </td>
                <td className="table-cell text-right">
                  <div className="flex items-center justify-end gap-2">
                    {isRunning && (
                      <button
                        onClick={(e) => onCancel(job.id, e)}
                        className="flex items-center gap-1 text-xs text-slate-600 hover:text-red-400 transition-colors"
                        title="Cancel merge"
                      >
                        <XCircle size={12} />
                        Cancel
                      </button>
                    )}
                    {!isRunning && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(job.id, jobName ?? job.id.slice(0, 8)) }}
                        className="text-xs text-slate-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate(`/fuse/${job.id}`) }}
                      className="text-xs text-slate-600 hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      View
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Knowledge Graphs Section ──────────────────────────────────────────────────

function KnowledgeGraphsSection({
  compilations,
  isLoading,
}: {
  compilations: Compilation[]
  isLoading: boolean
}) {
  const navigate = useNavigate()

  return (
    <div className="card p-0 overflow-hidden">
      <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Knowledge Graphs</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            All compilations you own. Click to open.
          </p>
        </div>
        {compilations.length > 0 && (
          <button
            onClick={() => navigate('/graphs')}
            className="text-xs text-slate-500 hover:text-blue-400 transition-colors flex items-center gap-1"
          >
            View all <ChevronRight size={12} />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 px-6 py-6 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
          Loading knowledge graphs...
        </div>
      ) : compilations.length === 0 ? (
        <div className="flex items-center gap-2.5 px-6 py-6">
          <Info size={14} className="shrink-0 text-slate-600" />
          <p className="text-sm text-slate-500">
            No knowledge graphs yet — merge extractions above to create one.
          </p>
        </div>
      ) : (
        <table className="w-full">
          <thead className="border-b border-slate-800 bg-slate-900/50">
            <tr>
              <th className="table-header">Name</th>
              <th className="table-header">Classification</th>
              <th className="table-header">Sources</th>
              <th className="table-header">Nodes</th>
              <th className="table-header">Edges</th>
              <th className="table-header">Created</th>
              <th className="table-header text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {compilations.map((c) => (
              <tr
                key={c.id}
                className="hover:bg-slate-800/30 transition-colors group cursor-pointer"
                onClick={() => navigate(`/graphs/${c.id}`)}
              >
                <td className="table-cell">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-800">
                      <Network size={12} className="text-violet-400" />
                    </div>
                    <span className="block text-xs font-medium text-slate-300 truncate">
                      {c.name}
                    </span>
                  </div>
                </td>
                <td className="table-cell">
                  <span className={CLASSIFICATION_BADGE[c.classification]}>
                    {c.classification}
                  </span>
                </td>
                <td className="table-cell">
                  <span className="text-xs text-slate-400 font-mono">
                    {(c.sourceJobIds?.length ?? 0).toLocaleString()}
                  </span>
                </td>
                <td className="table-cell">
                  <span className="flex items-center gap-1 text-xs text-slate-400 font-mono">
                    <Hash size={10} className="text-slate-600" />
                    {(c.nodeCount ?? 0).toLocaleString()}
                  </span>
                </td>
                <td className="table-cell">
                  <span className="flex items-center gap-1 text-xs text-slate-400 font-mono">
                    <GitBranch size={10} className="text-slate-600" />
                    {(c.edgeCount ?? 0).toLocaleString()}
                  </span>
                </td>
                <td className="table-cell">
                  <span className="text-xs text-slate-500">
                    {c.createdAt
                      ? formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })
                      : '—'}
                  </span>
                </td>
                <td className="table-cell text-right">
                  <ChevronRight
                    size={14}
                    className="ml-auto text-slate-700 opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export function FusePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const [mode, setMode] = useState<Mode>('mode_select')
  const [name, setName] = useState('')
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([])
  const [targetCompilationId, setTargetCompilationId] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [selectedOntologyId, setSelectedOntologyId] = useState<string | null>(null)

  // Fetch compilations for "enrich existing"
  const { data: compilationsData, isLoading: compilationsLoading } =
    useApiQuery<CompilationsResponse>(['kg', 'compilations'], '/kg/compilations')
  const compilations = compilationsData?.compilations ?? []

  // Fetch fuse jobs for active jobs section
  const { data: fuseData } = useApiQuery<FuseJobsResponse>(
    ['fuse', 'jobs'],
    '/fuse/jobs',
    { refetchInterval: 5000 }
  )
  const fuseJobs = fuseData?.jobs ?? []

  // Fetch ontologies for optional ontology selection
  const { data: ontologiesData } = useApiQuery<OntologiesResponse>(
    ['ontologies'],
    '/ontologies'
  )
  const ontologies = ontologiesData?.ontologies ?? []

  useEffect(() => {
    if (user?.defaultOntologyId && !selectedOntologyId) {
      setSelectedOntologyId(user.defaultOntologyId)
    }
  }, [user?.defaultOntologyId])

  const mergeMutation = useApiMutation<MergeResponse>('/fuse/merge', 'POST', {
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['fuse', 'jobs'] })
      queryClient.invalidateQueries({ queryKey: ['kg', 'compilations'] })
      queryClient.invalidateQueries({ queryKey: ['billing', 'balance'] })
      setName('')
      setSelectedJobIds([])
      setTargetCompilationId('')
      setSubmitError(null)
      navigate(`/fuse/${data.jobId}`)
    },
    onError: (err) => {
      setSubmitError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Merge failed'
      )
    },
  })

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  async function handleCancel(jobId: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      const { apiPost } = await import('@/lib/api')
      await apiPost(`/fuse/jobs/${jobId}/cancel`)
      queryClient.invalidateQueries({ queryKey: ['fuse', 'jobs'] })
    } catch {}
  }

  function handleDeleteRequest(jobId: string, jobName: string) {
    setDeleteTarget({ id: jobId, name: jobName })
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      const { apiDelete } = await import('@/lib/api')
      await apiDelete(`/fuse/jobs/${deleteTarget.id}`)
      queryClient.invalidateQueries({ queryKey: ['fuse', 'jobs'] })
      setDeleteTarget(null)
    } catch {} finally {
      setIsDeleting(false)
    }
  }

  function toggleJob(id: string) {
    setSelectedJobIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  function handleSubmitCreate() {
    setSubmitError(null)
    mergeMutation.mutate({
      data: {
        name: name.trim(),
        sourceJobIds: selectedJobIds,
        ontologyId: selectedOntologyId || undefined,
      },
    })
  }

  function handleSubmitEnrich() {
    setSubmitError(null)
    const target = compilations.find((c) => c.id === targetCompilationId)
    mergeMutation.mutate({
      data: {
        name: target?.name ?? name.trim(),
        sourceJobIds: selectedJobIds,
        targetCompilationId,
        ontologyId: selectedOntologyId || undefined,
      },
    })
  }

  function handleBack() {
    setMode('mode_select')
    setName('')
    setSelectedJobIds([])
    setTargetCompilationId('')
    setSubmitError(null)
    setSelectedOntologyId(null)
  }

  const canCreate = name.trim().length > 0 && selectedJobIds.length >= 1 && !mergeMutation.isPending
  const canEnrich =
    targetCompilationId.length > 0 && selectedJobIds.length >= 1 && !mergeMutation.isPending

  // ── Mode Select ──────────────────────────────────────────────────────────────

  if (mode === 'mode_select') {
    return (
      <div className="space-y-6 animate-slide-up">
        {/* Mode cards */}
        <div>
          <div className="mb-5">
            <h2 className="text-base font-semibold text-slate-100">Knowledge Fusion</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Merge extraction jobs into unified knowledge graphs.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Create New */}
            <button
              type="button"
              onClick={() => setMode('create_new')}
              className={cn(
                'group flex flex-col items-start gap-4 rounded-xl border border-slate-700 bg-slate-800/30 p-6 text-left',
                'hover:border-blue-500/50 hover:bg-slate-800/60 transition-all duration-200'
              )}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 group-hover:bg-blue-500/20 transition-colors">
                <Plus size={22} className="text-blue-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-100 group-hover:text-white transition-colors">
                  Create New Graph
                </h3>
                <p className="mt-1 text-xs text-slate-500 leading-relaxed">
                  Build a new knowledge graph from extraction jobs. Entities are linked and unified
                  into a fresh compilation.
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
                <span>Get started</span>
                <ArrowUpRight size={13} />
              </div>
            </button>

            {/* Enrich Existing */}
            <button
              type="button"
              onClick={() => setMode('enrich_existing')}
              className={cn(
                'group flex flex-col items-start gap-4 rounded-xl border border-slate-700 bg-slate-800/30 p-6 text-left',
                'hover:border-violet-500/50 hover:bg-slate-800/60 transition-all duration-200'
              )}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-500/10 group-hover:bg-violet-500/20 transition-colors">
                <ArrowUpRight size={22} className="text-violet-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-100 group-hover:text-white transition-colors">
                  Enrich Existing Graph
                </h3>
                <p className="mt-1 text-xs text-slate-500 leading-relaxed">
                  Add new extractions to an existing knowledge graph. Merges into an established
                  compilation.
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-violet-400 opacity-0 group-hover:opacity-100 transition-opacity">
                <span>Select graph</span>
                <ArrowUpRight size={13} />
              </div>
            </button>
          </div>
        </div>

        {/* Active jobs */}
        <ActiveJobs jobs={fuseJobs} onCancel={handleCancel} onDelete={handleDeleteRequest} />

        {/* Knowledge Graphs (all compilations the user owns) */}
        <KnowledgeGraphsSection
          compilations={compilations}
          isLoading={compilationsLoading}
        />
      </div>
    )
  }

  // ── Create New ───────────────────────────────────────────────────────────────

  if (mode === 'create_new') {
    return (
      <div className="space-y-6 animate-slide-up">
        <div className="card">
          {/* Header */}
          <div className="mb-5 flex items-start justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleBack}
                className="btn-ghost text-slate-500 hover:text-slate-300"
              >
                <ArrowLeft size={15} />
              </button>
              <div>
                <h2 className="text-base font-semibold text-slate-100">Create New Graph</h2>
                <p className="mt-0.5 text-sm text-slate-500">
                  Build a unified knowledge graph from selected extractions.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-400">
              <Coins size={13} />
              <span>10 tokens</span>
            </div>
          </div>

          <div className="space-y-5">
            {/* Name */}
            <div>
              <label htmlFor="create-name" className="label">
                Graph Name <span className="text-red-400">*</span>
              </label>
              <input
                id="create-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-field"
                placeholder="e.g. Q1 Reports Knowledge Graph"
                autoFocus
              />
            </div>

            {/* Source picker */}
            <div>
              <label className="label">
                Source Extractions <span className="text-red-400">*</span>
                <span className="ml-2 text-xs font-normal text-slate-600">(select at least 1)</span>
              </label>
              <SourcePicker
                selectedIds={selectedJobIds}
                onToggle={toggleJob}
                onSelectAll={(allIds) => setSelectedJobIds(allIds)}
                onDeselectAll={() => setSelectedJobIds([])}
              />
            </div>

            {/* Ontology selector */}
            <div>
              <label htmlFor="create-ontology" className="label">
                Ontology{' '}
                <span className="ml-1 font-normal text-slate-600">(optional)</span>
              </label>
              <p className="mb-1.5 text-xs text-slate-600">
                Match rules from this ontology will guide the fusion
              </p>
              <div className="relative">
                <select
                  id="create-ontology"
                  value={selectedOntologyId || ''}
                  onChange={(e) => setSelectedOntologyId(e.target.value || null)}
                  className="input-field appearance-none pr-8"
                >
                  <option value="">None (use defaults)</option>
                  {ontologies.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} — {o.entityTypeCount} type{o.entityTypeCount !== 1 ? 's' : ''}{' '}
                      [{o.scope}]
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
              </div>

              {selectedOntologyId && (() => {
                const ont = ontologies.find((o) => o.id === selectedOntologyId)
                if (!ont) return null
                const scopeBadge =
                  ont.scope === 'private'
                    ? 'badge-slate'
                    : ont.scope === 'shared'
                    ? 'badge-blue'
                    : 'badge-green'
                return (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className={cn(scopeBadge, 'text-[10px] uppercase tracking-wide')}>
                      {ont.scope}
                    </span>
                    {(ont.entityTypes ?? []).map((et) => (
                      <span
                        key={et.qid}
                        className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400"
                        title={et.qid}
                      >
                        {et.name}
                      </span>
                    ))}
                  </div>
                )
              })()}
            </div>
          </div>

          {/* Error */}
          {submitError && (
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          {/* Footer */}
          <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-5">
            <button type="button" onClick={handleBack} className="btn-ghost text-slate-500">
              Cancel
            </button>
            <button
              onClick={handleSubmitCreate}
              disabled={!canCreate}
              className="btn-primary"
            >
              {mergeMutation.isPending ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Creating...
                </>
              ) : (
                <>
                  <GitMerge size={15} />
                  Create Graph
                </>
              )}
            </button>
          </div>
        </div>

        {/* Active jobs */}
        <ActiveJobs jobs={fuseJobs} onCancel={handleCancel} onDelete={handleDeleteRequest} />
      </div>
    )
  }

  // ── Enrich Existing ──────────────────────────────────────────────────────────

  const selectedCompilation = compilations.find((c) => c.id === targetCompilationId)

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="card">
        {/* Header */}
        <div className="mb-5 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleBack}
              className="btn-ghost text-slate-500 hover:text-slate-300"
            >
              <ArrowLeft size={15} />
            </button>
            <div>
              <h2 className="text-base font-semibold text-slate-100">Enrich Existing Graph</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Add new extractions to an existing knowledge graph.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-400">
            <Coins size={13} />
            <span>10 tokens</span>
          </div>
        </div>

        <div className="space-y-5">
          {/* Compilation selector */}
          <div>
            <label className="label">
              Target Knowledge Graph <span className="text-red-400">*</span>
            </label>
            {compilationsLoading ? (
              <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-4 text-sm text-slate-500">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
                Loading compilations...
              </div>
            ) : compilations.length === 0 ? (
              <div className="flex items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-800/20 px-4 py-4">
                <Info size={14} className="shrink-0 text-slate-600" />
                <p className="text-sm text-slate-500">
                  No knowledge graphs found. Create one first using "Create New Graph".
                </p>
              </div>
            ) : (
              <div className="relative">
                <select
                  value={targetCompilationId}
                  onChange={(e) => setTargetCompilationId(e.target.value)}
                  className="input-field appearance-none pr-8"
                >
                  <option value="">Select a knowledge graph...</option>
                  {compilations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.nodeCount.toLocaleString()} nodes, {c.edgeCount.toLocaleString()} edges
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
              </div>
            )}

            {/* Selected compilation preview */}
            {selectedCompilation && (
              <div className="mt-2 flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/30 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
                  <Network size={14} className="text-violet-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-200">{selectedCompilation.name}</span>
                    <span className={CLASSIFICATION_BADGE[selectedCompilation.classification]}>
                      {selectedCompilation.classification}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <Database size={10} />
                      {selectedCompilation.nodeCount.toLocaleString()} nodes
                    </span>
                    <span>{selectedCompilation.edgeCount.toLocaleString()} edges</span>
                    <span>{selectedCompilation.sourceJobIds.length} sources</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Source picker */}
          <div>
            <label className="label">
              New Extractions to Add <span className="text-red-400">*</span>
              <span className="ml-2 text-xs font-normal text-slate-600">(select at least 1)</span>
            </label>
            <SourcePicker
              selectedIds={selectedJobIds}
              onToggle={toggleJob}
              onSelectAll={(allIds) => setSelectedJobIds(allIds)}
              onDeselectAll={() => setSelectedJobIds([])}
            />
          </div>

          {/* Ontology selector */}
          <div>
            <label htmlFor="enrich-ontology" className="label">
              Ontology{' '}
              <span className="ml-1 font-normal text-slate-600">(optional)</span>
            </label>
            <p className="mb-1.5 text-xs text-slate-600">
              Match rules from this ontology will guide the fusion
            </p>
            <div className="relative">
              <select
                id="enrich-ontology"
                value={selectedOntologyId || ''}
                onChange={(e) => setSelectedOntologyId(e.target.value || null)}
                className="input-field appearance-none pr-8"
              >
                <option value="">None (use defaults)</option>
                {ontologies.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} — {o.entityTypeCount} type{o.entityTypeCount !== 1 ? 's' : ''}{' '}
                    [{o.scope}]
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
            </div>

            {selectedOntologyId && (() => {
              const ont = ontologies.find((o) => o.id === selectedOntologyId)
              if (!ont) return null
              const scopeBadge =
                ont.scope === 'private'
                  ? 'badge-slate'
                  : ont.scope === 'shared'
                  ? 'badge-blue'
                  : 'badge-green'
              return (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={cn(scopeBadge, 'text-[10px] uppercase tracking-wide')}>
                    {ont.scope}
                  </span>
                  {(ont.entityTypes ?? []).map((et) => (
                    <span
                      key={et.qid}
                      className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400"
                      title={et.qid}
                    >
                      {et.name}
                    </span>
                  ))}
                </div>
              )
            })()}
          </div>
        </div>

        {/* Error */}
        {submitError && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        {/* Footer */}
        <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-5">
          <button type="button" onClick={handleBack} className="btn-ghost text-slate-500">
            Cancel
          </button>
          <button
            onClick={handleSubmitEnrich}
            disabled={!canEnrich}
            className="btn-primary"
          >
            {mergeMutation.isPending ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Enriching...
              </>
            ) : (
              <>
                <ArrowUpRight size={15} />
                Enrich Graph
              </>
            )}
          </button>
        </div>
      </div>

      {/* Active jobs */}
      <ActiveJobs jobs={fuseJobs} onCancel={handleCancel} onDelete={handleDeleteRequest} />

      <ConfirmDeleteModal
        open={!!deleteTarget}
        title="Delete Fusion Job"
        description={`This will permanently delete the fusion job "${deleteTarget?.name ?? ''}". This cannot be undone.`}
        confirmPhrase="delete"
        confirmText="Delete Fusion"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        isDeleting={isDeleting}
      />
    </div>
  )
}
