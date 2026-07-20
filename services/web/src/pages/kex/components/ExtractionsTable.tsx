import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, Loader2, Settings2, ChevronDown, ChevronRight, Clock, XCircle, RotateCw } from 'lucide-react'
// query client not used directly
import { api } from '@/lib/api'
// cn utility not needed here
import { JobRow, getJobName, type KexJob } from './JobRow'
import { BatchRow, type JobBatch } from './BatchRow'
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal'

interface ExtractionsTableProps {
  refetchKey?: number // increment to force refetch
}

export function ExtractionsTable({ refetchKey }: ExtractionsTableProps) {
  const [jobs, setJobs] = useState<KexJob[]>([])
  const [batches, setBatches] = useState<JobBatch[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [threads, setThreads] = useState(1)
  const [_queueDepth, setQueueDepth] = useState(0)
  const [queueJobs, setQueueJobs] = useState<Array<{ id: string; type: string; status: string; input?: Record<string, unknown>; createdAt: string; batchId?: string | null }>>([])
  const [queueExpanded, setQueueExpanded] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const LIMIT = 50

  const initialLoadDone = useRef(false)

  // Load jobs (showSpinner=false for background polls to prevent flicker)
  const loadJobs = useCallback(async (offsetVal: number, append = false, showSpinner = true) => {
    if (append) setLoadingMore(true)
    else if (showSpinner && !initialLoadDone.current) setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offsetVal) })
      if (search) params.set('search', search)
      const { data } = await api.get(`/kex/jobs?${params}`)
      if (append) {
        setJobs((prev) => [...prev, ...(data.jobs || [])])
      } else {
        setJobs(data.jobs || [])
        setBatches(data.batches || [])
      }
      setHasMore(data.hasMore ?? false)
      initialLoadDone.current = true
    } catch { /* ignore */ }
    finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [search])

  // Load queue info + pending jobs
  const loadQueue = useCallback(async () => {
    try {
      const { data } = await api.get('/kex/queue')
      setQueueDepth(data.depth ?? 0)
      setThreads(data.threads ?? 1)
      setQueueJobs(data.pendingJobs ?? [])
    } catch { /* ignore */ }
  }, [])

  // Initial load + polling (polls don't show spinner)
  useEffect(() => {
    initialLoadDone.current = false
    setOffset(0)
    void loadJobs(0, false, true)
    void loadQueue()
    const interval = setInterval(() => { void loadJobs(0, false, false); void loadQueue() }, 5000)
    return () => clearInterval(interval)
  }, [search, refetchKey, loadJobs, loadQueue])

  // Infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasMore && !loadingMore) {
        const nextOffset = offset + LIMIT
        setOffset(nextOffset)
        void loadJobs(nextOffset, true)
      }
    }, { threshold: 0.1 })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, offset, loadJobs])

  async function handleCancel(jobId: string) {
    try {
      await api.post(`/kex/jobs/${jobId}/cancel`)
      void loadJobs(0)
    } catch { /* ignore */ }
  }

  function retryError(e: unknown): string {
    return (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Retry failed'
  }

  async function handleRetry(jobId: string) {
    try {
      await api.post(`/kex/jobs/${jobId}/retry`)
      void loadJobs(0)
      void loadQueue()
    } catch (e) { alert(retryError(e)) }
  }

  const [retryingAll, setRetryingAll] = useState(false)
  async function handleRetryAllFailed() {
    setRetryingAll(true)
    try {
      await api.post('/kex/jobs/retry-failed')
      void loadJobs(0)
      void loadQueue()
    } catch (e) { alert(retryError(e)) }
    finally { setRetryingAll(false) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await api.delete(`/kex/jobs/${deleteTarget.id}`)
      void loadJobs(0)
      setDeleteTarget(null)
    } catch { /* ignore */ }
    finally { setIsDeleting(false) }
  }

  async function handleSetThreads(n: number) {
    setThreads(n)
    try { await api.put('/kex/threads', { threads: n }) } catch { /* ignore */ }
  }

  // Merge batches and standalone jobs into a timeline sorted by createdAt
  const timeline: Array<{ type: 'batch'; batch: JobBatch } | { type: 'job'; job: KexJob }> = []
  for (const b of batches) timeline.push({ type: 'batch', batch: b })
  for (const j of jobs) timeline.push({ type: 'job', job: j })
  timeline.sort((a, b) => {
    const aDate = a.type === 'batch' ? a.batch.createdAt : a.job.createdAt
    const bDate = b.type === 'batch' ? b.batch.createdAt : b.job.createdAt
    return new Date(bDate).getTime() - new Date(aDate).getTime()
  })

  return (
    <div className="card p-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-200">Your Extractions</h3>
        </div>
        <div className="flex items-center gap-2">
          {/* Retry all failed — shown when the current view has failed jobs */}
          {jobs.some((j) => j.status === 'failed') && (
            <button
              onClick={() => void handleRetryAllFailed()}
              disabled={retryingAll}
              className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 transition-colors hover:text-indigo-400 disabled:opacity-50"
              title="Retry all failed jobs (connector jobs re-fetch; direct uploads need re-upload)"
            >
              <RotateCw size={11} className={retryingAll ? 'animate-spin' : ''} />
              Retry failed
            </button>
          )}
          {/* Search */}
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0) }}
              placeholder="Search..."
              className="w-32 rounded border border-slate-700 bg-slate-800 py-1 pl-6 pr-2 text-[10px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          {/* Threads */}
          <div className="flex items-center gap-1 text-[10px] text-slate-500">
            <Settings2 size={11} />
            <select
              value={threads}
              onChange={(e) => void handleSetThreads(parseInt(e.target.value))}
              className="rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-[10px] text-slate-300"
            >
              {[1, 2, 3, 4, 5, 10].map((n) => (
                <option key={n} value={n}>{n} thread{n > 1 ? 's' : ''}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Queue row (collapsible, shown when standalone pending items exist — batch jobs shown inside batch rows) */}
      {queueJobs.filter((qj) => !qj.batchId).length > 0 && (
        <div className="border-b border-slate-800">
          <button
            onClick={() => setQueueExpanded(!queueExpanded)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-slate-800/30 transition-colors"
          >
            {queueExpanded ? <ChevronDown size={11} className="text-slate-500" /> : <ChevronRight size={11} className="text-slate-500" />}
            <Clock size={12} className="text-indigo-400" />
            <span className="text-[11px] font-medium text-slate-300">Queue</span>
            <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-medium text-indigo-400">
              {queueJobs.filter((qj) => !qj.batchId).length} pending
            </span>
          </button>
          {queueExpanded && (
            <div className="bg-slate-950/30 divide-y divide-slate-800/30">
              {queueJobs.filter((qj) => !qj.batchId).map((qj) => {
                const name = getJobName(qj as KexJob)
                return (
                  <div key={qj.id} className="flex items-center gap-2 px-6 py-1.5">
                    <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                    <span className="min-w-0 flex-1 truncate text-[10px] text-slate-400">{name}</span>
                    <span className="text-[9px] text-slate-600 capitalize">{qj.status}</span>
                    <button
                      onClick={async () => { try { await api.post(`/kex/jobs/${qj.id}/cancel`); void loadQueue() } catch {} }}
                      className="rounded p-0.5 text-slate-600 hover:text-red-400 transition-colors"
                      title="Cancel"
                    >
                      <XCircle size={11} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Job list */}
      <div className="max-h-[500px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-slate-500" />
          </div>
        ) : timeline.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-xs text-slate-500">No extractions yet</p>
            <p className="mt-1 text-[10px] text-slate-600">Submit text, upload a file, or sync from connected sources</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {timeline.map((item) =>
              item.type === 'batch' ? (
                <BatchRow
                  key={`batch-${item.batch.id}`}
                  batch={item.batch}
                  onCancelJob={handleCancel}
                  onDeleteJob={(id, name) => setDeleteTarget({ id, name })}
                />
              ) : (
                <JobRow
                  key={`job-${item.job.id}`}
                  job={item.job}
                  onCancel={handleCancel}
                  onDelete={(id, name) => setDeleteTarget({ id, name })}
                  onRetry={handleRetry}
                />
              )
            )}
          </div>
        )}

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} className="h-1" />
        {loadingMore && (
          <div className="flex items-center justify-center py-3">
            <Loader2 size={14} className="animate-spin text-slate-600" />
          </div>
        )}
      </div>

      {/* Delete modal */}
      <ConfirmDeleteModal
        open={!!deleteTarget}
        title="Delete Extraction"
        description={`Delete "${deleteTarget?.name ?? ''}" and its results? This cannot be undone.`}
        confirmPhrase="delete"
        confirmText="Delete"
        isDeleting={isDeleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
