import { useState, type DragEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bug,
  ThumbsUp,
  ThumbsDown,
  ChevronDown,
  ChevronRight,
  FileText,
  Copy,
  Check,
  Download,
  Loader2,
  AlertCircle,
  X,
  Globe,
  Monitor,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  BUG_STATUS_LABEL,
  createBugSpec,
  decideBug,
  listBugs,
  setBugStatus,
  type BugReport,
  type BugStatus,
} from '@/lib/bugs'

const BOARD_COLUMNS: BugStatus[] = ['reported', 'admitted', 'in_progress', 'done']

const COLUMN_ACCENT: Record<BugStatus, string> = {
  reported: 'text-amber-400',
  admitted: 'text-blue-400',
  in_progress: 'text-indigo-400',
  done: 'text-emerald-400',
  declined: 'text-slate-500',
}

const DRAG_MIME = 'application/x-gctrl-bug-id'

/**
 * Admin triage board for user-submitted bug reports. Columns follow the bug
 * lifecycle; thumbs up/down on a fresh report admits or declines it, any card
 * can be moved with the status picker or by drag and drop. "Create spec.md"
 * asks the API for a Markdown work order over the admitted/open bugs.
 */
export default function BugsBoard() {
  const qc = useQueryClient()
  const { data: bugs = [], isLoading, isError } = useQuery({
    queryKey: ['admin', 'bugs'],
    queryFn: listBugs,
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<BugStatus | null>(null)
  const [showDeclined, setShowDeclined] = useState(false)

  // spec.md panel
  const [spec, setSpec] = useState<{ markdown: string; bugCount: number } | null>(null)
  const [specLoading, setSpecLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'bugs'] })

  async function run(id: string, action: () => Promise<unknown>, failMessage: string) {
    setBusy(id)
    setActionError(null)
    try {
      await action()
      await refresh()
    } catch {
      setActionError(failMessage)
    } finally {
      setBusy(null)
    }
  }

  const decide = (bug: BugReport, decision: 'admit' | 'decline') =>
    run(bug.id, () => decideBug(bug.id, decision), `Could not ${decision} "${bug.title}".`)

  const move = (bug: BugReport, status: BugStatus) => {
    if (bug.status === status) return Promise.resolve()
    return run(bug.id, () => setBugStatus(bug.id, status), `Could not move "${bug.title}" to ${BUG_STATUS_LABEL[status]}.`)
  }

  function onDrop(e: DragEvent, status: BugStatus) {
    e.preventDefault()
    setDragOver(null)
    const id = e.dataTransfer.getData(DRAG_MIME)
    const bug = bugs.find((b) => b.id === id)
    if (bug) void move(bug, status)
  }

  function dropProps(status: BugStatus) {
    return {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dragOver !== status) setDragOver(status)
      },
      onDragLeave: () => setDragOver((cur) => (cur === status ? null : cur)),
      onDrop: (e: DragEvent) => onDrop(e, status),
    }
  }

  async function generateSpec() {
    setSpecLoading(true)
    setActionError(null)
    try {
      setSpec(await createBugSpec())
    } catch {
      setActionError('Could not create the spec. Please try again.')
    } finally {
      setSpecLoading(false)
    }
  }

  function copySpec() {
    if (!spec) return
    void navigator.clipboard.writeText(spec.markdown)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function downloadSpec() {
    if (!spec) return
    const date = new Date().toISOString().slice(0, 10)
    const blob = new Blob([spec.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bug-spec-${date}.md`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const byStatus = (status: BugStatus) =>
    bugs
      .filter((b) => b.status === status)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const declined = byStatus('declined')

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 size={18} className="animate-spin text-slate-500" /></div>
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-slate-500">
          <span className="font-semibold text-slate-200">{bugs.length}</span> reports ·{' '}
          <span className="font-semibold text-amber-400">{byStatus('reported').length}</span> awaiting triage
        </p>
        <button
          onClick={() => void generateSpec()}
          disabled={specLoading}
          className="btn-secondary ml-auto text-xs"
        >
          {specLoading ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
          Create spec.md
        </button>
      </div>

      {(isError || actionError) && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{actionError ?? 'Could not load bug reports.'}</span>
        </div>
      )}

      {/* Spec panel */}
      {spec && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2.5">
            <FileText size={14} className="text-indigo-400" />
            <span className="text-sm font-medium text-slate-200">spec.md</span>
            <span className="text-xs text-slate-500">{spec.bugCount} {spec.bugCount === 1 ? 'bug' : 'bugs'}</span>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={copySpec} className="btn-ghost text-xs" title="Copy Markdown">
                {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button onClick={downloadSpec} className="btn-ghost text-xs" title="Download as bug-spec-YYYY-MM-DD.md">
                <Download size={13} />
                Download
              </button>
              <button onClick={() => setSpec(null)} className="btn-ghost text-xs" aria-label="Close spec panel">
                <X size={13} />
              </button>
            </div>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-slate-300">
            {spec.markdown}
          </pre>
        </div>
      )}

      {/* Kanban */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {BOARD_COLUMNS.map((status) => {
          const items = byStatus(status)
          return (
            <div
              key={status}
              {...dropProps(status)}
              className={cn(
                'flex min-h-[200px] flex-col rounded-xl border bg-slate-900/40 transition-colors',
                dragOver === status ? 'border-indigo-500/60 bg-indigo-500/5' : 'border-slate-800',
              )}
            >
              <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2.5">
                <span className={cn('text-xs font-semibold uppercase tracking-wider', COLUMN_ACCENT[status])}>
                  {BUG_STATUS_LABEL[status]}
                </span>
                <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
                  {items.length}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-2 p-2">
                {items.length === 0 ? (
                  <p className="px-1 py-6 text-center text-[11px] text-slate-600">Nothing here</p>
                ) : (
                  items.map((bug) => (
                    <BugCard
                      key={bug.id}
                      bug={bug}
                      busy={busy === bug.id}
                      onDecide={(d) => void decide(bug, d)}
                      onMove={(s) => void move(bug, s)}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Declined: collapsible, also a drop target */}
      <div
        {...dropProps('declined')}
        className={cn(
          'rounded-xl border bg-slate-900/40 transition-colors',
          dragOver === 'declined' ? 'border-indigo-500/60 bg-indigo-500/5' : 'border-slate-800',
        )}
      >
        <button
          onClick={() => setShowDeclined((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        >
          {showDeclined ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
          <span className={cn('text-xs font-semibold uppercase tracking-wider', COLUMN_ACCENT.declined)}>Declined</span>
          <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">{declined.length}</span>
          <span className="ml-auto text-[10px] text-slate-600">drop a card here to decline it</span>
        </button>
        {showDeclined && (
          <div className="grid grid-cols-1 gap-2 border-t border-slate-800 p-2 md:grid-cols-2 xl:grid-cols-4">
            {declined.length === 0 ? (
              <p className="px-1 py-4 text-[11px] text-slate-600">No declined reports.</p>
            ) : (
              declined.map((bug) => (
                <BugCard
                  key={bug.id}
                  bug={bug}
                  busy={busy === bug.id}
                  onDecide={(d) => void decide(bug, d)}
                  onMove={(s) => void move(bug, s)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function BugCard({
  bug,
  busy,
  onDecide,
  onMove,
}: {
  bug: BugReport
  busy: boolean
  onDecide: (decision: 'admit' | 'decline') => void
  onMove: (status: BugStatus) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const pagePath = (() => {
    try { return new URL(bug.pageUrl).pathname || bug.pageUrl } catch { return bug.pageUrl }
  })()

  return (
    <div
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, bug.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={cn(
        'rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs transition-colors hover:border-slate-700',
        busy ? 'opacity-60' : 'cursor-grab active:cursor-grabbing',
      )}
    >
      <div className="flex items-start gap-2">
        <Bug size={13} className="mt-0.5 shrink-0 text-slate-500" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-slate-200" title={bug.title}>{bug.title}</p>
          <p className="mt-0.5 truncate text-[10px] text-slate-500">
            {bug.reporterEmail || 'unknown reporter'} · {new Date(bug.createdAt).toLocaleString()}
          </p>
        </div>
        {busy && <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-slate-500" />}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono">v{bug.version || '?'}</span>
        <span className="flex min-w-0 items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5" title={bug.pageUrl}>
          <Globe size={9} className="shrink-0" />
          <span className="truncate">{pagePath}</span>
        </span>
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300"
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {expanded ? 'Hide details' : 'Details'}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          <p className="whitespace-pre-wrap rounded-md bg-slate-950/60 px-2 py-1.5 text-[11px] leading-relaxed text-slate-300">
            {bug.description}
          </p>
          <p className="flex items-start gap-1 break-all text-[10px] text-slate-600">
            <Monitor size={9} className="mt-0.5 shrink-0" />
            {bug.userAgent || 'unknown browser'}
          </p>
        </div>
      )}

      <div className="mt-2 flex items-center gap-1 border-t border-slate-800/80 pt-2">
        {bug.status === 'reported' && (
          <>
            <button
              onClick={() => onDecide('admit')}
              disabled={busy}
              title="Admit - this is a bug we will fix"
              className="flex h-7 w-7 items-center justify-center rounded-md text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
            >
              <ThumbsUp size={13} />
            </button>
            <button
              onClick={() => onDecide('decline')}
              disabled={busy}
              title="Decline - not a bug or will not fix"
              className="flex h-7 w-7 items-center justify-center rounded-md text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              <ThumbsDown size={13} />
            </button>
          </>
        )}
        <select
          value={bug.status}
          onChange={(e) => onMove(e.target.value as BugStatus)}
          disabled={busy}
          aria-label="Change status"
          className="ml-auto rounded border border-slate-700 bg-slate-800 px-1.5 py-1 text-[10px] text-slate-300 disabled:opacity-50"
        >
          {(Object.keys(BUG_STATUS_LABEL) as BugStatus[]).map((s) => (
            <option key={s} value={s}>{BUG_STATUS_LABEL[s]}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
