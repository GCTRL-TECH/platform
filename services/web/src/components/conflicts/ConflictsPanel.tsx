import { useState } from 'react'
import { AlertTriangle, Check, Loader2, FileText } from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClassificationConflict {
  id: string
  kind?: 'classification'
  compilationId: string | null
  elementKind: string
  elementKey: string
  labels: { rank: number; level_name?: string }[]
  suggestion: { action: string; rank: number | null; rationale: string } | null
  status: string
}

interface FactTail {
  value: string
  uri: string
  sourceDoc: string | null
  // Readable name of the source document (server-resolved from sourceDoc); the
  // raw id alone is undecidable — this is what lets the user judge the source.
  sourceDocName?: string | null
  sourceDocModifiedAt: number | null
  assertedAt: number | null
  confidence: number | null
  authority: 'current' | 'superseded'
}

interface FactConflict {
  id: string
  kind: 'fact'
  compilationId: string | null
  relation: string
  keyUri: string
  keyName: string
  keySide: string
  tails: FactTail[]
  authorityWinner: string | null
  status: string
}

type Conflict = ClassificationConflict | FactConflict

function fmtEpochMs(ms: number | null): string | null {
  if (!ms) return null
  try { return new Date(ms).toLocaleDateString() } catch { return null }
}

// ─── Panel ───────────────────────────────────────────────────────────────────

/**
 * All open knowledge conflicts for the caller — fact conflicts (two sources
 * disagree on one entity's value) and classification conflicts (a merge produced
 * two clearance labels for one element). Reusable so it can live on the dedicated
 * Knowledge Quality page (and anywhere else that needs a reconcile surface).
 */
export function ConflictsPanel() {
  const qc = useQueryClient()
  const { data, isLoading } = useApiQuery<{ conflicts: Conflict[] }>(['classification', 'conflicts'], '/classification/conflicts')
  const conflicts = data?.conflicts ?? []
  const [busy, setBusy] = useState<string | null>(null)

  async function suggest(id: string) {
    setBusy(id)
    try { await api.post(`/classification/conflicts/${id}/suggest`, {}); qc.invalidateQueries({ queryKey: ['classification', 'conflicts'] }) }
    finally { setBusy(null) }
  }
  async function resolve(id: string, action: string, rank?: number | null) {
    setBusy(id)
    try { await api.post(`/classification/conflicts/${id}/resolve`, { action, rank }); qc.invalidateQueries({ queryKey: ['classification', 'conflicts'] }) }
    finally { setBusy(null) }
  }
  async function resolveFact(id: string, action: string, pickedTail?: string) {
    setBusy(id)
    try { await api.post(`/kg/conflicts/${id}/resolve`, { action, pickedTail }); qc.invalidateQueries({ queryKey: ['classification', 'conflicts'] }) }
    finally { setBusy(null) }
  }

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-500" /></div>
  if (conflicts.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-2 py-12 text-center">
        <Check size={22} className="text-emerald-400" />
        <p className="text-sm text-slate-400">No open conflicts.</p>
        <p className="text-[11px] text-slate-600">
          Conflicts appear when two sources disagree on a fact (e.g. two different CEOs
          for one company), or a merge produces two classifications for one element.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {conflicts.map((c) =>
        c.kind === 'fact'
          ? <FactConflictCard key={c.id} conflict={c} busy={busy === c.id} onResolve={resolveFact} />
          : <ClassificationConflictCard key={c.id} conflict={c} busy={busy === c.id} onSuggest={suggest} onResolve={resolve} />
      )}
    </div>
  )
}

function ClassificationConflictCard({ conflict: c, busy, onSuggest, onResolve }: {
  conflict: ClassificationConflict
  busy: boolean
  onSuggest: (id: string) => Promise<void>
  onResolve: (id: string, action: string, rank?: number | null) => Promise<void>
}) {
  const name = c.elementKey.split(/[_|]/)[0]
  const levels = c.labels.map((l) => l.level_name ?? `rank ${l.rank}`).join(' vs ')
  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-200">
            {name}
            <span className="ml-1.5 rounded bg-slate-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">classification</span>
            <span className="ml-1 text-[10px] uppercase text-slate-600">({c.elementKind})</span>
          </p>
          <p className="mt-0.5 text-xs text-amber-400">Conflicting: {levels}</p>
        </div>
        <button onClick={() => void onSuggest(c.id)} disabled={busy} className="btn-ghost text-xs">
          {busy ? <Loader2 size={12} className="animate-spin" /> : null} Suggest
        </button>
      </div>
      {c.suggestion && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs">
          <span className="font-medium text-indigo-300">Suggestion: {c.suggestion.action}</span>
          <span className="ml-1 text-slate-400">— {c.suggestion.rationale}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void onResolve(c.id, 'keep')} disabled={busy} className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700">Keep most-permissive</button>
        {c.labels.map((l) => (
          <button key={l.rank} onClick={() => void onResolve(c.id, 'remove_label', l.rank)} disabled={busy}
            className="rounded-md border border-amber-700/40 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-900/40">
            Remove “{l.level_name ?? l.rank}” label
          </button>
        ))}
        <button onClick={() => void onResolve(c.id, 'dismiss')} disabled={busy} className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300">Dismiss</button>
      </div>
    </div>
  )
}

/// P3 — a fact conflict: sources assert different values for a functional
/// relation of one entity. Competing values are listed with the SOURCE DOCUMENT
/// each came from + date, so the user can judge which to trust; the recency-
/// authority winner is highlighted.
function FactConflictCard({ conflict: c, busy, onResolve }: {
  conflict: FactConflict
  busy: boolean
  onResolve: (id: string, action: string, pickedTail?: string) => Promise<void>
}) {
  const relLabel = c.relation.replace(/_/g, ' ')
  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          {/* Plain-language claim so the conflict is understandable at a glance:
              "What is <entity>'s <relation>? N sources disagree." */}
          <p className="text-sm font-medium text-slate-200">
            <span className="text-slate-400">What is </span>
            {c.keyName}<span className="text-slate-400">’s {relLabel}?</span>
            <span className="ml-1.5 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-indigo-300">fact</span>
          </p>
          <p className="mt-0.5 text-xs text-amber-400">
            {c.tails.length} sources disagree — pick the correct value below.
          </p>
        </div>
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
      </div>

      <div className="space-y-1.5">
        {c.tails.map((t) => {
          const isWinner = t.authority === 'current'
          const date = fmtEpochMs(t.sourceDocModifiedAt) ?? fmtEpochMs(t.assertedAt)
          const docLabel = t.sourceDocName || (t.sourceDoc ? `doc ${t.sourceDoc.slice(0, 8)}` : 'source unknown')
          return (
            <div key={t.uri || t.value}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border px-3 py-2',
                isWinner ? 'border-emerald-700/40 bg-emerald-900/15' : 'border-slate-800 bg-slate-900/60',
              )}>
              <div className="min-w-0">
                <p className={cn('truncate text-xs font-medium', isWinner ? 'text-emerald-300' : 'text-slate-300')}>
                  {t.value}
                  {isWinner && <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-400">current</span>}
                </p>
                <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-slate-500">
                  <FileText size={9} className="shrink-0 text-slate-600" />
                  <span className="truncate" title={t.sourceDoc ?? undefined}>{docLabel}</span>
                  {date ? <span>· {date}</span> : null}
                  {t.confidence != null ? <span>· conf {t.confidence.toFixed(2)}</span> : null}
                </p>
              </div>
              {!isWinner && (
                <button onClick={() => void onResolve(c.id, 'pick', t.value)} disabled={busy}
                  className="shrink-0 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-700">
                  Keep this instead
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void onResolve(c.id, 'accept_winner')} disabled={busy || !c.authorityWinner}
          className="rounded-md border border-emerald-700/40 bg-emerald-900/20 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-900/40">
          {busy ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}
          Accept “{c.authorityWinner ?? '?'}” (newest source)
        </button>
        <button onClick={() => void onResolve(c.id, 'dismiss')} disabled={busy}
          className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300">
          Dismiss — both are valid
        </button>
      </div>
      <p className="text-[10px] text-slate-600">
        Accepting a value deletes the losing relationships and blocks them from re-extraction.
      </p>
    </div>
  )
}
