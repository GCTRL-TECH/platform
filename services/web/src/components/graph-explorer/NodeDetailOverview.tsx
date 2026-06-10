/**
 * NodeDetailOverview tab — stats grid + properties table + Wikidata link.
 */

import { ExternalLink } from 'lucide-react'
import { resolveTypeLabel, resolveWikidataQid, getNodeColor } from './colors'
import type { ColorBy, EntityDetail, GraphNode } from './types'

interface NodeDetailOverviewProps {
  entityName: string
  detail: EntityDetail | null
  localNode: GraphNode | null
  colorBy: ColorBy
  inDegree: number
  outDegree: number
  neighborCount: number
}

const SKIP_PROPERTY_KEYS = new Set([
  '_owner',
  '_source_job',
  'created_at',
  'createdAt',
  'name',
  'label',
  'type',
])

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-100 tabular-nums">{value}</p>
    </div>
  )
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function NodeDetailOverview({
  entityName,
  detail,
  localNode,
  colorBy,
  inDegree,
  outDegree,
  neighborCount,
}: NodeDetailOverviewProps) {
  // Prefer backend entity properties; fall back to local node properties.
  const properties: Record<string, unknown> =
    detail?.properties ?? localNode?.properties ?? {}
  const baseNode: GraphNode = localNode ?? {
    id: detail?.id ?? entityName,
    label: detail?.label ?? entityName,
    type: detail?.type ?? 'Entity',
    properties,
  }

  const typeLabel = resolveTypeLabel(baseNode)
  const qid = resolveWikidataQid(baseNode)
  const color = getNodeColor(baseNode, colorBy)
  const chunkCount = detail?.chunkCount ?? 0
  const createdAt = properties['created_at'] ?? properties['createdAt']

  const propertyEntries = Object.entries(properties).filter(
    ([k]) => !SKIP_PROPERTY_KEYS.has(k),
  )

  return (
    <div className="space-y-4">
      {/* Type badge + Wikidata link */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium capitalize"
          style={{ backgroundColor: `${color}22`, color }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color }}
          />
          {typeLabel}
        </span>
        {qid && (
          <a
            href={`https://www.wikidata.org/wiki/${qid}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] text-slate-300 hover:text-indigo-300 hover:border-indigo-500/40 transition-colors"
          >
            {qid}
            <ExternalLink size={10} />
          </a>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="In-degree" value={inDegree} />
        <StatCard label="Out-degree" value={outDegree} />
        <StatCard label="Chunks" value={chunkCount} />
        <StatCard label="Neighbors" value={neighborCount} />
      </div>

      {/* Properties */}
      <div>
        <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">
          Properties
        </p>
        {propertyEntries.length === 0 ? (
          <p className="text-xs italic text-slate-600">No additional properties.</p>
        ) : (
          <div className="rounded-lg border border-slate-800 overflow-hidden divide-y divide-slate-800">
            {propertyEntries.map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-2 px-3 py-2 text-xs">
                <span className="font-mono text-[10px] uppercase tracking-wide text-slate-500 truncate">
                  {k}
                </span>
                <span className="col-span-2 text-slate-300 break-words">
                  {renderValue(v)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {createdAt !== undefined && (
        <p className="text-[10px] text-slate-600">
          Created: <span className="text-slate-500">{renderValue(createdAt)}</span>
        </p>
      )}
    </div>
  )
}
