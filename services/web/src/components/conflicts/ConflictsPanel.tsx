import { useState } from 'react'
import { AlertTriangle, Check, Loader2, FileText, GitMerge, SlidersHorizontal } from 'lucide-react'
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

interface MergeSide {
  uri: string
  name: string | null
  type: string | null
}

interface MergeNeighbour {
  rel: string
  name: string
  outgoing: boolean
}

/** A doubtful entity merge the fusion made on its own (merge review). */
interface EntityMergeReview {
  id: string
  kind: 'entity_merge'
  compilationId: string | null
  a: MergeSide
  b: MergeSide
  score: number | null
  limesScore: number | null
  band: string | null
  methods: string[]
  mergedUri: string | null
  context: {
    rule?: string
    a?: { neighbours?: MergeNeighbour[]; sourceJob?: string | null }
    b?: { neighbours?: MergeNeighbour[]; sourceJob?: string | null }
  }
  status: string
  history: { chosen: string; votes: number; support: number; confidence: number } | null
}

type Conflict = ClassificationConflict | FactConflict | EntityMergeReview

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
  async function resolveMerge(id: string, action: 'same' | 'not_same' | 'dismiss') {
    setBusy(id)
    try { await api.post(`/kg/merge-reviews/${id}/resolve`, { action }); qc.invalidateQueries({ queryKey: ['classification', 'conflicts'] }) }
    finally { setBusy(null) }
  }

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-500" /></div>
  if (conflicts.length === 0) {
    return (
      <div className="space-y-3">
        <MergeRulesPanel />
        <div className="card flex flex-col items-center gap-2 py-12 text-center">
          <Check size={22} className="text-emerald-400" />
          <p className="text-sm text-slate-400">No open conflicts.</p>
          <p className="text-[11px] text-slate-600">
            Conflicts appear when two sources disagree on a fact (e.g. two different CEOs
            for one company), a merge produces two classifications for one element, or the
            fusion joined two entities it was not sure about.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <MergeRulesPanel />
      {conflicts.map((c) =>
        c.kind === 'fact'
          ? <FactConflictCard key={c.id} conflict={c} busy={busy === c.id} onResolve={resolveFact} />
          : c.kind === 'entity_merge'
            ? <EntityMergeCard key={c.id} review={c} busy={busy === c.id} onResolve={resolveMerge} />
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

// ─── Merge review ────────────────────────────────────────────────────────────

const METHOD_LABEL: Record<string, string> = {
  resolver: 'name similarity (LIMES)',
  resolver_review: 'name similarity (LIMES, review band)',
  resolver_fallback: 'name similarity (fallback matcher)',
  apoc: 'identical name',
  smart: 'acronym / word order',
  canonical: 'context embedding',
  'embedding-name': 'name embedding',
  'embedding-desc': 'description embedding',
  'embedding-model': 'model number',
  conex: 'link prediction',
  human: 'confirmed by a person',
}

function MergeSideBox({ side, ctx }: {
  side: MergeSide
  ctx?: { neighbours?: MergeNeighbour[]; sourceJob?: string | null }
}) {
  const neighbours = ctx?.neighbours ?? []
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <p className="truncate text-xs font-medium text-slate-200" title={side.uri}>{side.name ?? side.uri}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">{side.type ?? 'entity'}</p>
      {neighbours.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {neighbours.map((n, i) => (
            <li key={i} className="truncate text-[10px] text-slate-400">
              <span className="text-slate-600">{n.outgoing ? '→' : '←'} {n.rel.replace(/_/g, ' ').toLowerCase()} </span>
              {n.name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-[10px] text-slate-600">no relations</p>
      )}
    </div>
  )
}

/**
 * A doubtful entity merge: the fusion already joined these two nodes on one
 * weak signal. Nothing waits on the answer — "same" confirms it, "not the same"
 * records a cannot-link and re-merges the graph so the node splits, "skip"
 * drops the card. Every answer teaches the decision memory.
 */
function EntityMergeCard({ review: r, busy, onResolve }: {
  review: EntityMergeReview
  busy: boolean
  onResolve: (id: string, action: 'same' | 'not_same' | 'dismiss') => Promise<void>
}) {
  const pct = r.score != null ? `${Math.round(r.score * 100)} %` : '?'
  const method = r.methods.map((m) => METHOD_LABEL[m] ?? m).join(', ')
  const typeLabel = r.a.type ?? 'entity'
  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-200">
            <span className="text-slate-400">Are </span>“{r.a.name ?? '?'}”
            <span className="text-slate-400"> and </span>“{r.b.name ?? '?'}”
            <span className="text-slate-400"> the same {typeLabel}?</span>
            <span className="ml-1.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-sky-300">merge</span>
          </p>
          <p className="mt-0.5 text-xs text-amber-400">
            Merged automatically at {pct} similarity by {method}. Confirm or split to improve future merges.
          </p>
        </div>
        <GitMerge size={14} className="mt-0.5 shrink-0 text-sky-400" />
      </div>

      <div className="flex gap-2">
        <MergeSideBox side={r.a} ctx={r.context?.a} />
        <MergeSideBox side={r.b} ctx={r.context?.b} />
      </div>

      {r.history && r.history.support > 0 && (
        <p className="text-[10px] text-slate-500">
          Similar pairs were answered “{r.history.chosen.replace('_', ' ')}” {r.history.votes} of {r.history.support} times.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void onResolve(r.id, 'same')} disabled={busy}
          className="rounded-md border border-emerald-700/40 bg-emerald-900/20 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-900/40">
          {busy ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}
          Yes, the same
        </button>
        <button onClick={() => void onResolve(r.id, 'not_same')} disabled={busy}
          className="rounded-md border border-amber-700/40 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-900/40">
          No, split them
        </button>
        <button onClick={() => void onResolve(r.id, 'dismiss')} disabled={busy}
          className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300">
          Skip
        </button>
      </div>
      <p className="text-[10px] text-slate-600">
        {r.context?.rule ? <>Rule: <code className="text-slate-500">{r.context.rule}</code>. </> : null}
        Splitting re-merges the knowledge base in the background; the pair never merges again.
      </p>
    </div>
  )
}

// ─── Merge rules ─────────────────────────────────────────────────────────────

interface MergeRule {
  id: string | null
  compilationId: string | null
  entityType: string
  rule: unknown
  ls: string
  sentence: string | null
  origin: 'default' | 'human' | 'learned'
  status: 'active' | 'proposed' | 'retired'
  // preview: the estimate object this API writes, or the one-line summary the
  // LIMES learner (fuse learn.py) writes.
  evidence: { preview?: RulePreview | string; decisions?: number; source?: string } | null
  sourceText: string | null
}

interface RulePreview {
  basedOn?: number
  wouldSplit?: number
  wouldKeep?: number
  examples?: { a: string; b: string; score: number }[]
  note?: string
}

/**
 * The rule the fusion applies per entity type, as one sentence. A person can
 * put a change in their own words; the configured local model turns it into a
 * rule, the panel shows the sentence and an estimate of its effect, and one
 * click applies it (the knowledge base re-merges). Learned proposals arrive the
 * same way. Nothing changes without that click.
 */
function MergeRulesPanel() {
  const qc = useQueryClient()
  const { data, isLoading } = useApiQuery<{ rules: MergeRule[] }>(['kg', 'merge-rules'], '/kg/merge-rules')
  const rules = data?.rules ?? []
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['kg', 'merge-rules'] })

  async function propose(entityType: string) {
    if (!text.trim()) return
    setBusy(entityType); setError(null)
    try {
      await api.post('/kg/merge-rules', { entityType, text: text.trim() })
      setText(''); setEditing(null); refresh()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data
      setError(msg?.error ?? msg?.message ?? 'Could not create the rule.')
    } finally { setBusy(null) }
  }
  async function act(id: string, action: 'apply' | 'retire') {
    setBusy(id); setError(null)
    try { await api.post(`/kg/merge-rules/${id}/${action}`, {}); refresh() }
    finally { setBusy(null) }
  }

  if (isLoading || rules.length === 0) return null
  const active = rules.filter((r) => r.status === 'active')
  const proposed = rules.filter((r) => r.status === 'proposed')

  return (
    <div className="card space-y-3">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left">
        <p className="text-sm font-medium text-slate-200">
          <SlidersHorizontal size={13} className="mr-1.5 inline text-slate-500" />
          Merge rules
          <span className="ml-2 text-[11px] text-slate-500">{active.length} in force{proposed.length ? `, ${proposed.length} proposed` : ''}</span>
        </p>
        <span className="text-[11px] text-slate-500">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="space-y-2">
          {proposed.map((r) => (
            <RuleRow key={r.id ?? r.entityType} rule={r} busy={busy === r.id} onApply={() => r.id && act(r.id, 'apply')} onRetire={() => r.id && act(r.id, 'retire')} />
          ))}
          {active.map((r) => (
            <div key={r.id ?? `default-${r.entityType}`} className="space-y-2">
              <RuleRow rule={r} busy={busy === r.id} onEdit={() => { setEditing(r.entityType); setText(''); setError(null) }}
                onRetire={r.id ? () => act(r.id!, 'retire') : undefined} />
              {editing === r.entityType && (
                <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
                    placeholder="In your own words, e.g. “only merge people when the names are at least 70 % similar” or “Firmen nur bei identischem Namen zusammenführen”"
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600" />
                  <div className="mt-2 flex items-center gap-2">
                    <button onClick={() => void propose(r.entityType)} disabled={busy === r.entityType || !text.trim()}
                      className="rounded-md border border-indigo-700/40 bg-indigo-900/20 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-900/40">
                      {busy === r.entityType ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}
                      Propose rule
                    </button>
                    <button onClick={() => setEditing(null)} className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300">Cancel</button>
                    {error && <span className="text-[11px] text-rose-400">{error}</span>}
                  </div>
                  <p className="mt-1.5 text-[10px] text-slate-600">The proposal is shown with its effect first; nothing changes until you apply it.</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RuleRow({ rule: r, busy, onApply, onRetire, onEdit }: {
  rule: MergeRule
  busy: boolean
  onApply?: () => void
  onRetire?: () => void
  onEdit?: () => void
}) {
  const preview = r.evidence?.preview
  const isProposal = r.status === 'proposed'
  return (
    <div className={cn('rounded-lg border px-3 py-2', isProposal ? 'border-indigo-700/40 bg-indigo-900/10' : 'border-slate-800 bg-slate-900/60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-slate-200">{r.sentence ?? r.ls}</p>
          <p className="mt-0.5 text-[10px] text-slate-500">
            <span className="uppercase tracking-wide">{r.entityType}</span>
            <span> · {isProposal ? 'proposed' : 'in force'} · {r.origin === 'learned' ? 'learned from your answers' : r.origin === 'human' ? 'set by you' : 'built-in default'}</span>
            {r.compilationId ? <span> · this knowledge base only</span> : null}
          </p>
          {isProposal && typeof preview === 'string' && (
            <p className="mt-1 text-[10px] text-amber-400">{preview}</p>
          )}
          {isProposal && preview && typeof preview !== 'string' && (
            <p className="mt-1 text-[10px] text-amber-400">
              {preview.wouldSplit != null
                ? `Would split ${preview.wouldSplit} of ${preview.basedOn ?? 0} existing merges and keep ${preview.wouldKeep ?? 0}.`
                : preview.note}
              {preview.examples?.length ? ` E.g. ${preview.examples.slice(0, 2).map((e) => `“${e.a}” / “${e.b}”`).join(', ')}.` : ''}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isProposal && onApply && (
            <button onClick={onApply} disabled={busy}
              className="rounded-md border border-emerald-700/40 bg-emerald-900/20 px-2.5 py-1 text-[11px] text-emerald-300 hover:bg-emerald-900/40">
              {busy ? <Loader2 size={11} className="mr-1 inline animate-spin" /> : null}Apply
            </button>
          )}
          {!isProposal && onEdit && (
            <button onClick={onEdit} className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-700">Change</button>
          )}
          {onRetire && (
            <button onClick={onRetire} disabled={busy} className="rounded-md px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300">
              {isProposal ? 'Discard' : 'Reset to default'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
