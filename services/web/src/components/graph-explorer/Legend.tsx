/**
 * Legend — bottom-left dynamic legend driven by the metrics.presentTypes set.
 * Shows only types currently visible on the canvas.
 */

import { getNodeColor } from './colors'
import type { ColorBy, GraphNode } from './types'

interface LegendProps {
  presentTypes: Set<string>
  colorBy: ColorBy
}

export function Legend({ presentTypes, colorBy }: LegendProps) {
  const types = Array.from(presentTypes).sort()
  if (types.length === 0) return null

  return (
    <div className="absolute bottom-3 left-3 z-10 max-w-[60%] rounded-md bg-slate-950/75 backdrop-blur-sm px-2.5 py-1.5 border border-slate-800/80">
      <p className="mb-1 text-[9px] uppercase tracking-wide text-slate-600">
        {colorBy === 'wikidata'
          ? 'Wikidata QID'
          : colorBy === 'source'
          ? 'Source job'
          : 'Type'}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {types.map((t) => {
          const color = getNodeColor(
            { id: '', label: '', type: '', properties: { label: t } } as GraphNode,
            'type',
          )
          return (
            <div key={t} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-[10px] text-slate-400 capitalize">{t}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
