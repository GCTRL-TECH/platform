/**
 * NodeDetailDossier tab — the HOT memory tier (A2) for this entity.
 *
 * A dossier is the compiled, authoritative per-entity memory: an LLM-synthesized
 * summary, the entity's relations as key facts (with confidence), the origin
 * files it was extracted from, and a timeline. It is the highest-trust block the
 * RAG/agent injects (A3). Built on-the-fly server-side when first requested.
 *
 * Pinning a dossier raises its rank in the injection hierarchy (pinned > dossier).
 */

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Pin, PinOff, FileText, Clock, Sparkles, AlertCircle } from 'lucide-react'
import { useApiQuery, useApiMutation } from '@/hooks/useApi'

interface DossierFact {
  rel: string
  target: string
  direction?: string
  confidence?: number | null
  type?: string
}
interface DossierTimelineEntry {
  date: string
  fact: string
}
interface DossierResponse {
  id: string
  entityName: string
  summary: string
  keyFacts: DossierFact[]
  originFiles: string[]
  timeline: DossierTimelineEntry[]
  trust: number
  pinned: boolean
  heat: number
  accessCount: number
}

interface NodeDetailDossierProps {
  entityName: string
  enabled: boolean
  onNavigateToEntity: (entityName: string) => void
}

function relLabel(rel: string): string {
  return rel.replace(/_/g, ' ').toLowerCase()
}

export function NodeDetailDossier({ entityName, enabled, onNavigateToEntity }: NodeDetailDossierProps) {
  const queryClient = useQueryClient()
  const queryKey = ['kg', 'dossier', entityName]

  const { data, isLoading, error } = useApiQuery<DossierResponse>(
    queryKey,
    `/kg/dossier?name=${encodeURIComponent(entityName)}`,
    { enabled: enabled && !!entityName, retry: 0 },
  )

  const [optimisticPinned, setOptimisticPinned] = useState<boolean | null>(null)
  const pinMutation = useApiMutation<{ pinned: boolean }, { name: string; pinned: boolean }>(
    '/kg/dossier/pin', 'POST',
    {
      onSuccess: (res) => {
        setOptimisticPinned(res.pinned)
        void queryClient.invalidateQueries({ queryKey })
      },
      onError: () => setOptimisticPinned(null),
    },
  )

  if (isLoading) {
    return <div className="py-8 text-center text-xs text-slate-500">Compiling dossier…</div>
  }

  // A 404 means the user owns no node with this name → no dossier can be built.
  if (error || !data) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-slate-700/50 bg-slate-900/40 px-3 py-3 text-[11px] text-slate-400">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-slate-500" />
        <span>No dossier available for this entity yet. Dossiers are compiled for the
          most-connected entities during distillation, or on demand when queried.</span>
      </div>
    )
  }

  const pinned = optimisticPinned ?? data.pinned

  return (
    <div className="space-y-4 text-[12px]">
      {/* Header: trust + pin */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-indigo-300">
          <Sparkles size={12} />
          <span>Dossier · trust {data.trust.toFixed(2)}{pinned ? ' · pinned' : ''}</span>
        </div>
        <button
          onClick={() => pinMutation.mutate({ data: { name: entityName, pinned: !pinned } })}
          disabled={pinMutation.isPending}
          className={cn(
            'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
            pinned
              ? 'border-amber-600/50 bg-amber-950/30 text-amber-300 hover:bg-amber-900/40'
              : 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200',
          )}
          title={pinned ? 'Unpin dossier' : 'Pin dossier (raises injection priority)'}
        >
          {pinned ? <PinOff size={12} /> : <Pin size={12} />}
          {pinned ? 'Unpin' : 'Pin'}
        </button>
      </div>

      {/* Summary */}
      {data.summary && (
        <p className="leading-relaxed text-slate-200">{data.summary}</p>
      )}

      {/* Key facts */}
      {data.keyFacts?.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Key facts</h3>
          <ul className="space-y-1">
            {data.keyFacts.slice(0, 20).map((f, i) => (
              <li key={i} className="flex items-baseline gap-1 text-slate-300">
                <span className="text-slate-500">{f.direction === 'in' ? '←' : '→'}</span>
                <span>
                  <span className="text-slate-400">{relLabel(f.rel)} </span>
                  <button
                    onClick={() => onNavigateToEntity(f.target)}
                    className="text-indigo-300 hover:underline"
                  >{f.target}</button>
                  {typeof f.confidence === 'number' && (
                    <span className="ml-1 text-[10px] tabular-nums text-slate-500">
                      ({Math.round(f.confidence * 100)}%)
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Timeline */}
      {data.timeline?.length > 0 && (
        <section>
          <h3 className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <Clock size={11} /> Timeline
          </h3>
          <ul className="space-y-1">
            {data.timeline.map((t, i) => (
              <li key={i} className="text-slate-300">{t.fact}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Origin files */}
      {data.originFiles?.length > 0 && (
        <section>
          <h3 className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <FileText size={11} /> Origin files
          </h3>
          <ul className="space-y-1">
            {data.originFiles.map((f, i) => (
              <li key={i} className="truncate text-slate-400" title={f}>{f}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// Local cn to avoid an extra import path mismatch.
function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}
