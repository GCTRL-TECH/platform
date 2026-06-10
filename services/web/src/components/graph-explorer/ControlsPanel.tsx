/**
 * ControlsPanel — top-right floating toolbar.
 *
 * Drives:
 *   - Color by  [type / wikidata / source job]
 *   - Size by   [degree / uniform]
 *   - Type filter chips
 *   - Show labels toggle
 *   - 2D / 3D toggle
 *   - Reset + Fit
 */

import { Box, Square, Tag, Filter, Maximize2, RotateCcw, Type } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getNodeColor } from './colors'
import type { ColorBy, SizeBy, ViewMode, GraphNode } from './types'

interface ControlsPanelProps {
  viewMode: ViewMode
  onViewModeChange: (v: ViewMode) => void

  colorBy: ColorBy
  onColorByChange: (v: ColorBy) => void

  sizeBy: SizeBy
  onSizeByChange: (v: SizeBy) => void

  showLabels: boolean
  onShowLabelsChange: (v: boolean) => void

  presentTypes: Set<string>
  typeFilter: Set<string>
  onTypeFilterToggle: (type: string) => void
  onTypeFilterReset: () => void

  onFit: () => void
  onReset: () => void

  nodeCount: number
  edgeCount: number
}

const SEGMENT_BTN =
  'flex items-center gap-1 px-2 py-1 text-[11px] font-medium transition-colors'

export function ControlsPanel({
  viewMode,
  onViewModeChange,
  colorBy,
  onColorByChange,
  sizeBy,
  onSizeByChange,
  showLabels,
  onShowLabelsChange,
  presentTypes,
  typeFilter,
  onTypeFilterToggle,
  onTypeFilterReset,
  onFit,
  onReset,
  nodeCount,
  edgeCount,
}: ControlsPanelProps) {
  const allTypes = Array.from(presentTypes).sort()
  const allOn = typeFilter.size === 0
  const filterActive = !allOn

  return (
    <div className="absolute right-3 top-3 z-20 w-64 rounded-xl border border-slate-700/60 bg-slate-950/85 backdrop-blur-sm shadow-xl text-slate-200">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Controls
          </span>
          <span className="text-[10px] text-slate-600 tabular-nums">
            {nodeCount.toLocaleString()} · {edgeCount.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onFit}
            title="Fit graph to viewport"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          >
            <Maximize2 size={12} />
          </button>
          <button
            onClick={onReset}
            title="Reset view"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      <div className="px-3 py-2.5 space-y-3">
        {/* Color by */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5 flex items-center gap-1">
            <Tag size={10} /> Color by
          </p>
          <div className="flex items-center rounded-md border border-slate-700 bg-slate-900 overflow-hidden">
            {(['type', 'wikidata', 'source'] as ColorBy[]).map((opt) => (
              <button
                key={opt}
                onClick={() => onColorByChange(opt)}
                className={cn(
                  SEGMENT_BTN,
                  'flex-1 justify-center',
                  colorBy === opt
                    ? 'bg-indigo-500/15 text-indigo-300'
                    : 'text-slate-500 hover:text-slate-300',
                  opt !== 'type' && 'border-l border-slate-700',
                )}
              >
                {opt === 'type' ? 'Type' : opt === 'wikidata' ? 'Wikidata' : 'Source'}
              </button>
            ))}
          </div>
        </div>

        {/* Size by */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">
            Size by
          </p>
          <div className="flex items-center rounded-md border border-slate-700 bg-slate-900 overflow-hidden">
            {(['degree', 'uniform'] as SizeBy[]).map((opt) => (
              <button
                key={opt}
                onClick={() => onSizeByChange(opt)}
                className={cn(
                  SEGMENT_BTN,
                  'flex-1 justify-center capitalize',
                  sizeBy === opt
                    ? 'bg-indigo-500/15 text-indigo-300'
                    : 'text-slate-500 hover:text-slate-300',
                  opt !== 'degree' && 'border-l border-slate-700',
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>

        {/* Show labels */}
        <label className="flex items-center gap-2 cursor-pointer text-[11px] text-slate-300">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => onShowLabelsChange(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500/40"
          />
          <Type size={11} className="text-slate-500" />
          Show labels on canvas
        </label>

        {/* Type filter */}
        {allTypes.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center gap-1">
                <Filter size={10} /> Filter types
              </p>
              {filterActive && (
                <button
                  onClick={onTypeFilterReset}
                  className="text-[10px] text-indigo-300 hover:text-indigo-200 transition-colors"
                >
                  Show all
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pr-1">
              {allTypes.map((t) => {
                const active = allOn || typeFilter.has(t)
                const color = getNodeColor(
                  { id: '', label: '', type: '', properties: { label: t } } as GraphNode,
                  'type',
                )
                return (
                  <button
                    key={t}
                    onClick={() => onTypeFilterToggle(t)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                      active
                        ? 'border-slate-600 bg-slate-800 text-slate-200'
                        : 'border-slate-800 bg-slate-900/60 text-slate-600',
                    )}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: color, opacity: active ? 1 : 0.4 }}
                    />
                    <span className="capitalize">{t}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* 2D / 3D */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">
            View
          </p>
          <div className="flex items-center rounded-md border border-slate-700 bg-slate-900 overflow-hidden">
            <button
              onClick={() => onViewModeChange('2d')}
              className={cn(
                SEGMENT_BTN,
                'flex-1 justify-center',
                viewMode === '2d'
                  ? 'bg-indigo-500/15 text-indigo-300'
                  : 'text-slate-500 hover:text-slate-300',
              )}
            >
              <Square size={11} /> 2D
            </button>
            <button
              onClick={() => onViewModeChange('3d')}
              className={cn(
                SEGMENT_BTN,
                'flex-1 justify-center border-l border-slate-700',
                viewMode === '3d'
                  ? 'bg-indigo-500/15 text-indigo-300'
                  : 'text-slate-500 hover:text-slate-300',
              )}
            >
              <Box size={11} /> 3D
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
