import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Network,
  GitBranch,
  RefreshCw,
  ExternalLink,
  Calendar,
  Shield,
  Clock,
  AlertCircle,
  Hash,
  Plus,
  Trash2,
  Save,
  Coins,
  UserCheck,
  ScrollText,
  GitMerge,
  ChevronDown,
  CheckCircle,
  Workflow,
  GitFork,
} from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'
import { useApiQuery, useApiMutation } from '@/hooks/useApi'
import { usePublicConfig } from '@/hooks/usePublicConfig'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { SourceJobLabel, type SourceJobInfo } from '@/components/SourceJobLabel'

interface KexJobsResponse {
  jobs: SourceJobInfo[]
}

type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'

interface Compilation {
  id: string
  name: string
  description: string | null
  userId: string
  sourceJobIds: string[]
  classification: Classification
  classificationLevelId: string | null
  version: number
  cronSchedule: string | null
  cronMode: string
  lastRefreshAt: string | null
  nodeCount: number
  edgeCount: number
  entityCount: number
  duplicateCount: number
  linkCount: number
  createdAt: string
  updatedAt: string
}

interface CompilationResponse {
  compilation: Compilation
}

interface AclEntry {
  userId: string
  permission: 'read' | 'write' | 'admin'
}

interface AclResponse {
  acl: AclEntry[]
}

interface AuditEntry {
  id?: string
  action: string
  userId: string
  timestamp: string
  details?: string
}

interface AuditResponse {
  entries: AuditEntry[]
}

interface RefreshResponse {
  jobId: string
  status: string
}

interface CompilationSummary {
  id: string
  name: string
  nodeCount: number
  edgeCount: number
  classification: Classification
  sourceJobIds: string[]
}

interface CompilationsResponse {
  compilations: CompilationSummary[]
}

interface MergeResponse {
  compilationId: string
  jobId: string
  status: string
}

type Tab = 'overview' | 'explorer' | 'schedule' | 'acl' | 'audit'

const CLASSIFICATION_STYLES: Record<
  Classification,
  { badge: string; label: string }
> = {
  PUBLIC: { badge: 'badge-green', label: 'Public' },
  INTERNAL: { badge: 'badge-blue', label: 'Internal' },
  CONFIDENTIAL: { badge: 'badge-yellow', label: 'Confidential' },
  RESTRICTED: { badge: 'badge-red', label: 'Restricted' },
}

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: Network },
  { id: 'explorer', label: 'Explorer', icon: Workflow },
  { id: 'schedule', label: 'Schedule', icon: Calendar },
  { id: 'acl', label: 'Access Control', icon: Shield },
  { id: 'audit', label: 'Audit Log', icon: ScrollText },
]

// ─── Merge Another Graph Panel ────────────────────────────────────────────────

function SourceJobsList({
  compilationId,
  sourceJobIds,
}: {
  compilationId: string
  sourceJobIds: string[]
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  // Resolve UUIDs → friendly file names. Cached against the same query key
  // used elsewhere (FusePage, FuseJobDetail) so this is essentially free.
  const { data: kexData } = useApiQuery<KexJobsResponse>(['kex', 'jobs'], '/kex/jobs')
  const kexJobs = kexData?.jobs ?? []

  async function handleRemove(jobId: string) {
    if (confirmRemove !== jobId) {
      setConfirmRemove(jobId)
      return
    }
    // Second click = confirmed
    setRemoving(jobId)
    try {
      const { apiPut } = await import('@/lib/api')
      const updated = sourceJobIds.filter((id) => id !== jobId)
      await apiPut(`/kg/compilations/${compilationId}`, { sourceJobIds: updated })
      queryClient.invalidateQueries({ queryKey: ['kg', 'compilations', compilationId] })
      setConfirmRemove(null)
    } catch {
      // silent
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="card p-0 overflow-hidden">
      <div className="border-b border-slate-800 px-5 py-4 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-200">
          Source Jobs{' '}
          <span className="text-slate-600">({sourceJobIds.length})</span>
        </h4>
        {confirmRemove && (
          <button
            onClick={() => setConfirmRemove(null)}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
      <div className="divide-y divide-slate-800">
        {sourceJobIds.map((jobId) => {
          const isConfirming = confirmRemove === jobId
          const isRemoving = removing === jobId
          return (
            <div
              key={jobId}
              className={cn(
                'flex items-center justify-between px-5 py-3 transition-colors',
                isConfirming && 'bg-red-500/5'
              )}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-800">
                  <Hash size={11} className="text-blue-400" />
                </div>
                <SourceJobLabel jobId={jobId} jobs={kexJobs} />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {sourceJobIds.length > 1 && (
                  <button
                    onClick={() => handleRemove(jobId)}
                    disabled={isRemoving}
                    className={cn(
                      'flex items-center gap-1 text-xs transition-colors',
                      isConfirming
                        ? 'text-red-400 hover:text-red-300 font-medium'
                        : 'text-slate-600 hover:text-red-400'
                    )}
                    title={isConfirming ? 'Click again to confirm removal' : 'Remove from compilation'}
                  >
                    {isRemoving ? (
                      <span className="h-3 w-3 animate-spin rounded-full border border-red-400/30 border-t-red-400" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    {isConfirming ? 'Confirm remove' : 'Remove'}
                  </button>
                )}
                <button
                  onClick={() => navigate(`/kex/${jobId}`)}
                  className="text-xs text-slate-600 hover:text-blue-400 transition-colors"
                >
                  View
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MergeAnotherPanel({ compilation }: { compilation: Compilation }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeSuccess, setMergeSuccess] = useState(false)

  const { data: compilationsData, isLoading: compilationsLoading } =
    useApiQuery<CompilationsResponse>(['kg', 'compilations'], '/kg/compilations', {
      enabled: open,
    })

  const others = (compilationsData?.compilations ?? []).filter((c) => c.id !== compilation.id)
  const selectedCompilation = others.find((c) => c.id === selectedId)

  const mergeMutation = useApiMutation<MergeResponse>('/fuse/merge', 'POST', {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kg', 'compilations', compilation.id] })
      queryClient.invalidateQueries({ queryKey: ['fuse', 'jobs'] })
      setMergeSuccess(true)
      setMergeError(null)
      setSelectedId('')
      setTimeout(() => {
        setMergeSuccess(false)
        setOpen(false)
      }, 2500)
    },
    onError: (err) => {
      setMergeError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Merge failed'
      )
    },
  })

  function handleMerge() {
    if (!selectedCompilation) return
    setMergeError(null)
    setMergeSuccess(false)
    mergeMutation.mutate({
      data: {
        name: compilation.name,
        targetCompilationId: compilation.id,
        sourceJobIds: selectedCompilation.sourceJobIds,
      },
    })
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-slate-200">Merge Another Graph</h4>
          <p className="mt-0.5 text-xs text-slate-500">
            Absorb another knowledge graph's sources into this compilation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setOpen((v) => !v); setMergeError(null); setMergeSuccess(false) }}
          className={cn('btn-ghost text-sm', open ? 'text-slate-300' : 'text-slate-500 hover:text-slate-300')}
        >
          <GitMerge size={14} />
          {open ? 'Hide' : 'Merge'}
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-slate-800 pt-4">
          {compilationsLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
              Loading graphs...
            </div>
          ) : others.length === 0 ? (
            <p className="text-sm text-slate-500">No other knowledge graphs available to merge.</p>
          ) : (
            <div>
              <label className="label">Source Graph to Merge In</label>
              <div className="relative">
                <select
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  className="input-field appearance-none pr-8"
                >
                  <option value="">Select a graph...</option>
                  {others.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.nodeCount.toLocaleString()} nodes
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={13}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
              </div>
              {selectedCompilation && (
                <p className="mt-1.5 text-xs text-slate-600">
                  This will add {selectedCompilation.sourceJobIds.length} source job(s) from{' '}
                  <span className="text-slate-400">{selectedCompilation.name}</span> into this graph.
                </p>
              )}
            </div>
          )}

          {mergeError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{mergeError}</span>
            </div>
          )}

          {mergeSuccess && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-400">
              <CheckCircle size={14} />
              Merge job dispatched successfully.
            </div>
          )}

          {!mergeSuccess && others.length > 0 && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-slate-600">
                <Coins size={11} />
                10 tokens
              </div>
              <button
                onClick={handleMerge}
                disabled={!selectedId || mergeMutation.isPending}
                className="btn-primary"
              >
                {mergeMutation.isPending ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Merging...
                  </>
                ) : (
                  <>
                    <GitMerge size={14} />
                    Merge Into This Graph
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  compilation,
  onRefresh,
  isRefreshing,
}: {
  compilation: Compilation
  onRefresh: () => void
  isRefreshing: boolean
}) {
  const cls = CLASSIFICATION_STYLES[compilation.classification]
  const { neo4jBrowser } = usePublicConfig()

  return (
    <div className="space-y-5">
      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
            <Hash size={16} className="text-violet-400" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Entities</p>
            <p className="text-lg font-bold text-slate-100">
              {(compilation.entityCount || compilation.nodeCount).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10">
            <GitBranch size={16} className="text-cyan-400" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Relations</p>
            <p className="text-lg font-bold text-slate-100">
              {compilation.edgeCount.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
            <GitMerge size={16} className="text-emerald-400" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Duplicates</p>
            <p className="text-lg font-bold text-slate-100">
              {(compilation.duplicateCount || 0).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
            <Hash size={16} className="text-amber-400" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Sources</p>
            <p className="text-lg font-bold text-slate-100">
              {compilation.sourceJobIds.length}
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
            <Shield size={16} className="text-amber-400" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Version</p>
            <p className="text-lg font-bold text-slate-100">v{compilation.version}</p>
          </div>
        </div>
      </div>

      {/* Description + classification */}
      <div className="card space-y-4">
        <div>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Description
          </h4>
          <p className="text-sm text-slate-300">
            {compilation.description ?? (
              <span className="text-slate-600 italic">No description provided.</span>
            )}
          </p>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Classification
          </h4>
          <span className={cls.badge}>{cls.label}</span>
        </div>

        {compilation.lastRefreshAt && (
          <div className="border-t border-slate-800 pt-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Last Refreshed
            </h4>
            <div className="flex items-center gap-1.5 text-sm text-slate-400">
              <Clock size={13} />
              {format(new Date(compilation.lastRefreshAt), 'MMM d, yyyy HH:mm')}
              <span className="text-slate-600">
                ({formatDistanceToNow(new Date(compilation.lastRefreshAt), { addSuffix: true })})
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Source jobs (editable) */}
      {compilation.sourceJobIds.length > 0 && (
        <SourceJobsList
          compilationId={compilation.id}
          sourceJobIds={compilation.sourceJobIds}
        />
      )}

      {/* Merge another graph */}
      <MergeAnotherPanel compilation={compilation} />

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="btn-secondary"
        >
          {isRefreshing ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300" />
              Refreshing...
            </>
          ) : (
            <>
              <RefreshCw size={14} />
              Refresh Now
            </>
          )}
        </button>
        <div className="flex items-center gap-1 text-xs text-slate-600">
          <Coins size={12} />
          3 tokens
        </div>
        <a
          href={neo4jBrowser}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost text-slate-500 hover:text-slate-300 ml-auto"
        >
          <ExternalLink size={14} />
          Open in Neo4j
        </a>
      </div>
    </div>
  )
}

// ─── Schedule Tab ─────────────────────────────────────────────────────────────

function ScheduleTab({ compilation }: { compilation: Compilation }) {
  const [cronSchedule, setCronSchedule] = useState(compilation.cronSchedule ?? '')
  const [cronMode, setCronMode] = useState<'incremental' | 'full'>(
    (compilation.cronMode as 'incremental' | 'full') || 'incremental'
  )
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const scheduleMutation = useApiMutation<CompilationResponse>(
    `/kg/compilations/${compilation.id}/schedule`,
    'PUT',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['kg', 'compilations', compilation.id] })
        setSaveSuccess(true)
        setSaveError(null)
        setTimeout(() => setSaveSuccess(false), 3000)
      },
      onError: (err) => {
        setSaveError(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            'Failed to save schedule'
        )
      },
    }
  )

  function handleSave() {
    setSaveError(null)
    setSaveSuccess(false)
    scheduleMutation.mutate({
      data: { schedule: cronSchedule.trim() || null, mode: cronMode },
    })
  }

  return (
    <div className="space-y-5">
      <div className="card space-y-5">
        <div>
          <h4 className="mb-3 text-sm font-semibold text-slate-200">Refresh Schedule</h4>
          <p className="mb-4 text-xs text-slate-500">
            Automatically refresh this knowledge graph on a cron schedule. Leave blank to disable
            scheduled refreshes.
          </p>

          <div className="space-y-4">
            <div>
              <label className="label">Cron Expression</label>
              <input
                type="text"
                value={cronSchedule}
                onChange={(e) => setCronSchedule(e.target.value)}
                className="input-field font-mono"
                placeholder="0 2 * * * (daily at 2am)"
              />
              <p className="mt-1.5 text-xs text-slate-600">
                Standard cron format: minute hour day month weekday
              </p>
            </div>

            <div>
              <label className="label">Refresh Mode</label>
              <div className="grid grid-cols-2 gap-2">
                {(['incremental', 'full'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setCronMode(mode)}
                    className={cn(
                      'flex flex-col rounded-lg border px-4 py-3 text-left transition-colors',
                      cronMode === mode
                        ? 'border-blue-500/40 bg-blue-500/10'
                        : 'border-slate-700 bg-slate-800/30 hover:border-slate-600'
                    )}
                  >
                    <span
                      className={cn(
                        'text-sm font-medium capitalize',
                        cronMode === mode ? 'text-blue-300' : 'text-slate-300'
                      )}
                    >
                      {mode}
                    </span>
                    <span className="mt-0.5 text-xs text-slate-500">
                      {mode === 'incremental'
                        ? 'Only process new data since last refresh'
                        : 'Fully regenerate the entire graph'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {saveError && (
          <div className="flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{saveError}</span>
          </div>
        )}

        {saveSuccess && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">
            <RefreshCw size={14} />
            Schedule saved successfully.
          </div>
        )}

        <div className="flex justify-end border-t border-slate-800 pt-4">
          <button
            onClick={handleSave}
            disabled={scheduleMutation.isPending}
            className="btn-primary"
          >
            {scheduleMutation.isPending ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Saving...
              </>
            ) : (
              <>
                <Save size={15} />
                Save Schedule
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Access Control Tab ────────────────────────────────────────────────────────

const PERMISSION_OPTIONS = ['read', 'write', 'admin'] as const
type Permission = (typeof PERMISSION_OPTIONS)[number]

function AclTab({ compilation }: { compilation: Compilation }) {
  const [newUserId, setNewUserId] = useState('')
  const [newPermission, setNewPermission] = useState<Permission>('read')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [levelId, setLevelId] = useState<string>(compilation.classificationLevelId ?? '')
  const { data: levelsData } = useApiQuery<{ levels: { id: string; display_name: string; rank: number }[] }>(
    ['classification', 'levels'], '/classification/levels',
  )
  const levels = (levelsData?.levels ?? []).slice().sort((a, b) => a.rank - b.rank)
  const queryClient = useQueryClient()

  const { data: aclData, isLoading: aclLoading } = useApiQuery<AclResponse>(
    ['kg', 'compilations', compilation.id, 'acl'],
    `/kg/compilations/${compilation.id}/acl`
  )
  const acl = aclData?.acl ?? []

  const aclMutation = useApiMutation<AclResponse>(
    `/kg/compilations/${compilation.id}/acl`,
    'PUT',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['kg', 'compilations', compilation.id, 'acl'] })
        setSaveError(null)
      },
      onError: (err) => {
        setSaveError(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            'Failed to update access control'
        )
      },
    }
  )

  const classificationMutation = useApiMutation<CompilationResponse>(
    `/kg/compilations/${compilation.id}`,
    'PUT',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['kg', 'compilations', compilation.id] })
      },
      onError: (err) => {
        setSaveError(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            'Failed to update classification'
        )
      },
    }
  )

  function handleAddUser() {
    if (!newUserId.trim()) return
    const newEntry: AclEntry = { userId: newUserId.trim(), permission: newPermission }
    const updated = [...acl.filter((e) => e.userId !== newEntry.userId), newEntry]
    aclMutation.mutate({ data: { entries: updated } })
    setNewUserId('')
  }

  function handleRemoveUser(userId: string) {
    const updated = acl.filter((e) => e.userId !== userId)
    aclMutation.mutate({ data: { entries: updated } })
  }

  function handleChangePermission(userId: string, permission: Permission) {
    const updated = acl.map((e) => (e.userId === userId ? { ...e, permission } : e))
    aclMutation.mutate({ data: { entries: updated } })
  }

  function handleClassificationSave() {
    classificationMutation.mutate({ data: { classificationLevelId: levelId } })
  }

  return (
    <div className="space-y-5">
      {/* Classification */}
      <div className="card space-y-4">
        <div>
          <h4 className="mb-3 text-sm font-semibold text-slate-200">Data Classification</h4>
          <p className="mb-3 text-xs text-slate-500">
            Set the sensitivity level for this knowledge graph. This affects who can access it.
          </p>
          <div className="flex items-center gap-3">
            <select
              value={levelId}
              onChange={(e) => setLevelId(e.target.value)}
              className="input-field w-auto"
            >
              <option value="">— select level —</option>
              {levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.display_name}
                </option>
              ))}
            </select>
            <button
              onClick={handleClassificationSave}
              disabled={
                classificationMutation.isPending ||
                !levelId ||
                levelId === (compilation.classificationLevelId ?? '')
              }
              className="btn-secondary"
            >
              {classificationMutation.isPending ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300" />
                  Saving...
                </>
              ) : (
                <>
                  <Save size={14} />
                  Save
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ACL table */}
      <div className="card p-0 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h4 className="text-sm font-semibold text-slate-200">User Permissions</h4>
        </div>

        {aclLoading ? (
          <div className="flex items-center justify-center py-10">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
          </div>
        ) : acl.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <UserCheck size={18} className="text-slate-700" />
            <p className="text-sm text-slate-500">No explicit access entries</p>
            <p className="text-xs text-slate-600">
              Add users below to grant specific permissions
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-800 bg-slate-900/50">
              <tr>
                <th className="table-header">User ID</th>
                <th className="table-header">Permission</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {acl.map((entry) => (
                <tr key={entry.userId} className="hover:bg-slate-800/30 transition-colors group">
                  <td className="table-cell">
                    <span className="font-mono text-xs text-slate-300">{entry.userId}</span>
                  </td>
                  <td className="table-cell">
                    <select
                      value={entry.permission}
                      onChange={(e) =>
                        handleChangePermission(entry.userId, e.target.value as Permission)
                      }
                      className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {PERMISSION_OPTIONS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="table-cell text-right">
                    <button
                      onClick={() => handleRemoveUser(entry.userId)}
                      className="text-slate-600 opacity-0 transition-all group-hover:opacity-100 hover:text-red-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Add user row */}
        <div className="border-t border-slate-800 bg-slate-900/30 px-5 py-4">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddUser()}
              className="input-field flex-1"
              placeholder="User ID"
            />
            <select
              value={newPermission}
              onChange={(e) => setNewPermission(e.target.value as Permission)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PERMISSION_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button
              onClick={handleAddUser}
              disabled={!newUserId.trim() || aclMutation.isPending}
              className="btn-primary"
            >
              <Plus size={15} />
              Add
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}
    </div>
  )
}

// ─── Audit Log Tab ─────────────────────────────────────────────────────────────

function AuditTab({ compilationId }: { compilationId: string }) {
  const { data, isLoading, error } = useApiQuery<AuditResponse>(
    ['kg', 'compilations', compilationId, 'audit'],
    `/kg/compilations/${compilationId}/audit`
  )
  const entries = data?.entries ?? []

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertCircle size={24} className="text-red-400" />
        <p className="text-sm text-slate-400">Failed to load audit log</p>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800">
          <ScrollText size={20} className="text-slate-600" />
        </div>
        <p className="text-sm text-slate-500">No audit entries yet</p>
        <p className="text-xs text-slate-600">Actions on this graph will be recorded here</p>
      </div>
    )
  }

  return (
    <div className="card p-0 overflow-hidden">
      <table className="w-full">
        <thead className="border-b border-slate-800 bg-slate-900/50">
          <tr>
            <th className="table-header">Action</th>
            <th className="table-header">User</th>
            <th className="table-header">Details</th>
            <th className="table-header">Timestamp</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {entries.map((entry, idx) => (
            <tr key={entry.id ?? idx} className="hover:bg-slate-800/30 transition-colors">
              <td className="table-cell">
                <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">
                  {entry.action}
                </span>
              </td>
              <td className="table-cell">
                <span className="font-mono text-xs text-slate-400">{entry.userId}</span>
              </td>
              <td className="table-cell max-w-xs">
                <span className="truncate block text-xs text-slate-500">
                  {entry.details ?? '—'}
                </span>
              </td>
              <td className="table-cell">
                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                  <Clock size={12} />
                  {formatDistanceToNow(new Date(entry.timestamp), { addSuffix: true })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export function KGDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const { data: compilationResponse, isLoading, error } = useApiQuery<CompilationResponse>(
    ['kg', 'compilations', id],
    `/kg/compilations/${id}`,
    { enabled: !!id }
  )
  const compilation = compilationResponse?.compilation

  const refreshMutation = useApiMutation<RefreshResponse>(
    `/kg/compilations/${id}/refresh`,
    'POST',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['kg', 'compilations', id] })
        setRefreshError(null)
      },
      onError: (err) => {
        setRefreshError(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            'Refresh failed'
        )
      },
    }
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
      </div>
    )
  }

  if (error || !compilation) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <AlertCircle size={32} className="text-red-400" />
        <div>
          <p className="text-lg font-semibold text-slate-200">Compilation not found</p>
          <p className="mt-1 text-sm text-slate-500">
            This knowledge graph doesn't exist or you don't have access.
          </p>
        </div>
        <button onClick={() => navigate('/graphs')} className="btn-secondary">
          Back to Knowledge Graphs
        </button>
      </div>
    )
  }

  const cls = CLASSIFICATION_STYLES[compilation.classification]

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => navigate('/graphs')}
          className="btn-ghost mt-0.5 text-slate-500 hover:text-slate-300"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-xl font-bold text-slate-100">{compilation.name}</h2>
            <span className={cls.badge}>{cls.label}</span>
            <span className="badge badge-slate">v{compilation.version}</span>
          </div>
          <p className="mt-1 font-mono text-xs text-slate-600">{compilation.id}</p>
        </div>
        <button
          onClick={() => navigate(`/graphs/${compilation.id}/lineage`)}
          className="btn-ghost shrink-0 text-slate-500 hover:text-slate-300"
          title="View data lineage"
        >
          <GitFork size={15} />
          Lineage
        </button>
        <button
          onClick={() => navigate(`/graphs/${compilation.id}/workspace`)}
          className="btn-primary shrink-0"
          title="Open the multi-viewport graph workspace"
        >
          <Workflow size={15} />
          Explore
        </button>
      </div>

      {/* Refresh error */}
      {refreshError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{refreshError}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-slate-800">
        <div className="flex gap-0.5">
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                )}
              >
                <Icon size={14} />
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <OverviewTab
          compilation={compilation}
          onRefresh={() => refreshMutation.mutate({})}
          isRefreshing={refreshMutation.isPending}
        />
      )}
      {activeTab === 'explorer' && (
        <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10">
            <Workflow size={22} className="text-blue-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-200">Open the Graph Workspace</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
              Explore this graph in a full multi-viewport workspace — navigate the graph, click any node,
              and read the source text behind it side-by-side.
            </p>
          </div>
          <button onClick={() => navigate(`/graphs/${compilation.id}/workspace`)} className="btn-primary mt-1">
            <Workflow size={15} />
            Open Workspace
          </button>
        </div>
      )}
      {activeTab === 'schedule' && <ScheduleTab compilation={compilation} />}
      {activeTab === 'acl' && <AclTab compilation={compilation} />}
      {activeTab === 'audit' && <AuditTab compilationId={compilation.id} />}
    </div>
  )
}
