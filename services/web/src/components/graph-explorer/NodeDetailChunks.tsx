/**
 * NodeDetailChunks tab — lazy-loaded markdown chunks mentioning this entity.
 */

import { Suspense, lazy } from 'react'
import { FileText, AlertCircle } from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'
import { SourceJobLabel, type SourceJobInfo } from '@/components/SourceJobLabel'
import type { ChunksResponse } from './types'

const MarkdownView = lazy(() => import('./MarkdownView'))

interface KexJobsResponse {
  jobs?: SourceJobInfo[]
}

interface NodeDetailChunksProps {
  entityName: string
  compilationId: string
  enabled: boolean
  onNavigateToEntity: (entityName: string) => void
}

export function NodeDetailChunks({
  entityName,
  compilationId,
  enabled,
  onNavigateToEntity,
}: NodeDetailChunksProps) {
  const { data, isLoading, error } = useApiQuery<ChunksResponse>(
    ['kex', 'chunks', entityName, compilationId],
    `/kex/chunks?entity=${encodeURIComponent(entityName)}&compilationId=${encodeURIComponent(
      compilationId,
    )}&limit=20`,
    { enabled },
  )

  const { data: kexData } = useApiQuery<KexJobsResponse>(['kex', 'jobs'], '/kex/jobs')
  const kexJobs = kexData?.jobs

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-500" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        <AlertCircle size={14} /> Failed to load chunks.
      </div>
    )
  }

  const chunks = data?.chunks ?? []

  if (chunks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <FileText size={22} className="text-slate-700" />
        <p className="text-sm text-slate-500">
          No chunks found mentioning this entity.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">
        {chunks.length} chunk{chunks.length === 1 ? '' : 's'}
        {data?.total !== undefined && data.total > chunks.length && (
          <span className="ml-1 normal-case tracking-normal text-slate-600">
            (of {data.total.toLocaleString()} total)
          </span>
        )}
      </p>

      {chunks.map((chunk) => (
        <article
          key={chunk.id}
          className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden"
        >
          <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
            {chunk.sourceJobId ? (
              <SourceJobLabel jobId={chunk.sourceJobId} jobs={kexJobs} hideUuid />
            ) : (
              <p className="truncate text-xs font-medium text-slate-400">
                {chunk.source ?? 'Unknown source'}
              </p>
            )}
          </header>
          <div className="px-3 py-3">
            <Suspense
              fallback={
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="h-3 w-3 animate-spin rounded-full border border-slate-700 border-t-indigo-500" />
                  Rendering…
                </div>
              }
            >
              <MarkdownView>{chunk.content ?? ''}</MarkdownView>
            </Suspense>
          </div>

          {(() => {
            // entity_mentions comes back as objects ({text,label,type,…}) — NOT
            // strings. Rendering an object as a React child throws and blanks the
            // whole panel, so normalize each mention to its display name and dedupe.
            const names = Array.from(
              new Set(
                (chunk.entityMentions ?? [])
                  .map((m) =>
                    typeof m === 'string'
                      ? m
                      : (m as { text?: string; name?: string; label?: string })?.text ??
                        (m as { name?: string })?.name ??
                        (m as { label?: string })?.label ??
                        '',
                  )
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            )
            if (names.length === 0) return null
            return (
              <div className="border-t border-slate-800 px-3 py-2 flex flex-wrap gap-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-600 mr-1 self-center">
                  Mentions:
                </span>
                {names.map((name) => (
                  <button
                    key={name}
                    onClick={() => onNavigateToEntity(name)}
                    className="inline-flex rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 hover:border-indigo-500/40 hover:text-indigo-200 transition-colors"
                  >
                    {name}
                  </button>
                ))}
              </div>
            )
          })()}
        </article>
      ))}
    </div>
  )
}
