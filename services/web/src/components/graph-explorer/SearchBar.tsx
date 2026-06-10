/**
 * SearchBar — debounced entity search lifted from the original GraphExplorer.
 *
 * Calls `/kg/graph/search?q=&limit=20` 300ms after typing stops, shows a
 * dropdown of matches, and reports the chosen node up.
 */

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { apiGet } from '@/lib/api'
import { getNodeColor, resolveTypeLabel } from './colors'
import type { ColorBy, GraphNode } from './types'

interface SearchBarProps {
  colorBy: ColorBy
  onSelect: (node: GraphNode) => void
  className?: string
}

interface SearchResponse {
  nodes: GraphNode[]
}

export function SearchBar({ colorBy, onSelect, className }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GraphNode[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim()) {
      setResults([])
      setOpen(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const data = await apiGet<SearchResponse>(
          `/kg/graph/search?q=${encodeURIComponent(query.trim())}&limit=20`,
        )
        setResults(data.nodes ?? [])
        setOpen(true)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  function handleSelect(node: GraphNode) {
    setQuery('')
    setOpen(false)
    onSelect(node)
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <Search
        size={13}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
      />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Search entities…"
        className="w-full rounded-lg border border-slate-700 bg-slate-800/80 pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 transition-colors"
      />
      {loading && (
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin rounded-full border border-indigo-400/30 border-t-indigo-400" />
      )}

      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-slate-700 bg-slate-900 shadow-xl overflow-hidden z-30 max-h-72 overflow-y-auto">
          {results.map((node) => {
            const typeLabel = resolveTypeLabel(node)
            return (
              <button
                key={node.id}
                onMouseDown={() => handleSelect(node)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-800 transition-colors"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: getNodeColor(node, colorBy) }}
                />
                <span className="text-xs text-slate-200 truncate">{node.label}</span>
                <span className="ml-auto text-[10px] text-slate-600 shrink-0">
                  {typeLabel}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
