/**
 * NodeDetailSource tab — where this entity came from.
 *
 * Shows the most-recent source job's origin (a traceable path/reference + kind),
 * a safe link to the full extraction job, and the actual extracted **source text**
 * (the chunks stored in the vector DB) rendered inline so you can read the full
 * context without leaving the explorer.
 *
 * Note: Neo4j stores only the most recent `_source_job` on the entity, so the
 * origin card is a single-job summary by design; the chunks below can span
 * multiple sources.
 */

import { ExternalLink, FileWarning, Layers, MapPin, Quote } from 'lucide-react'
import { NodeDetailChunks } from './NodeDetailChunks'
import type { EntityDetail } from './types'

interface NodeDetailSourceProps {
  detail: EntityDetail | null
  isLoading: boolean
  entityName: string
  compilationId: string
  enabled: boolean
  onNavigateToEntity: (entityName: string) => void
}

// Friendly label for the extraction job type.
function sourceKind(type?: string): string {
  switch (type) {
    case 'kex_upload':
      return 'File upload'
    case 'kex_connector':
      return 'Connector (Drive / SharePoint / Obsidian)'
    case 'kex_extract':
      return 'Note / pasted text'
    default:
      return type ?? 'Unknown'
  }
}

export function NodeDetailSource({
  detail,
  isLoading,
  entityName,
  compilationId,
  enabled,
  onNavigateToEntity,
}: NodeDetailSourceProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-500" />
      </div>
    )
  }

  const job = detail?.lastSourceJob
  const groundingChunks = detail?.groundingChunks ?? []

  return (
    <div className="space-y-4">
      {/* Precise, entity-grounded source text (P2a) — every snippet here is
          guaranteed to actually mention THIS node, via its graph URI, not just
          a name/substring match (see the broader "Source text" list below). */}
      {groundingChunks.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            <Quote size={11} className="text-indigo-400" />
            Sources
          </p>
          <div className="space-y-2">
            {groundingChunks.map((chunk) => (
              <div
                key={chunk.id}
                className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5"
              >
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                  {chunk.snippet}
                </p>
                {(chunk.jobId || chunk.createdAt) && (
                  <div className="mt-2 flex items-center justify-between border-t border-slate-800 pt-1.5">
                    {chunk.createdAt && (
                      <span className="text-[10px] text-slate-500">{chunk.createdAt}</span>
                    )}
                    {chunk.jobId && (
                      <a
                        href={`/kex/${chunk.jobId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] font-medium text-indigo-300 hover:text-indigo-200 transition-colors"
                      >
                        Open source job
                        <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!job?.id ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <FileWarning size={22} className="text-slate-700" />
          <p className="text-sm text-slate-500">No source job recorded for this entity.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
          <div className="border-b border-slate-800 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <MapPin size={13} className="shrink-0 text-indigo-400" />
              <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                Original source
              </span>
              <span className="ml-auto rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[9px] text-slate-400">
                {sourceKind(job.type)}
              </span>
            </div>
            {/* Full origin path — untruncated so it stays traceable even if the
                file later moves. */}
            <p className="mt-1.5 break-all font-mono text-xs leading-relaxed text-slate-200">
              {job.source || '(unknown source)'}
            </p>
          </div>

          <div className="px-3 py-2.5 space-y-1.5">
            {job.createdAt && (
              <div className="flex items-baseline gap-2 text-xs">
                <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
                  Extracted
                </span>
                <span className="text-slate-300">{job.createdAt}</span>
              </div>
            )}
            <div className="flex items-baseline gap-2 text-xs">
              <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
                Job ID
              </span>
              <span className="font-mono text-[10px] text-slate-500 break-all">{job.id}</span>
            </div>
          </div>

          {/* Open the extraction job in a NEW tab — never replaces the explorer,
              so going back is never an empty page. */}
          <div className="border-t border-slate-800 px-3 py-2">
            <a
              href={`/kex/${job.id}`}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors"
            >
              Open extraction job
              <ExternalLink size={11} />
            </a>
          </div>
        </div>
      )}

      {/* The actual extracted source text (chunks from the vector DB). */}
      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
          <Layers size={11} className="text-slate-600" />
          Source text
        </p>
        <NodeDetailChunks
          entityName={entityName}
          compilationId={compilationId}
          enabled={enabled}
          onNavigateToEntity={onNavigateToEntity}
        />
      </div>
    </div>
  )
}
