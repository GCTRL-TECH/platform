/**
 * The knowledge-base picker of the token dialog: a searchable, folder-grouped
 * checkbox list.
 *
 * It used to be every graph of the account in creation order, in a 44px-tall scroll
 * box — on a shared instance that is 130+ rows, many with the same name, and the only
 * way to find one was scrolling. Now the search filters on NAME and FOLDER PATH (so
 * "bosak" finds that colleague's personal graph, "dena" the client's), and the rows sit
 * under their folder.
 */
import { type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useKbGroups, type FiledKb } from '@/lib/kbFolders'

interface KbPickerListProps<T extends FiledKb> {
  items: T[]
  selected: Set<string>
  onToggle: (id: string) => void
  query: string
  onQueryChange: (q: string) => void
  /** Reason why this graph cannot be picked; the row is then shown disabled. */
  lockedReason?: (item: T) => string | null
  /** Badges after the name (classification, "Code", …). */
  badge?: (item: T) => ReactNode
  emptyLabel?: string
  /** Tailwind max-height of the scroll area. */
  maxHeightClass?: string
}

export function KbPickerList<T extends FiledKb>({
  items, selected, onToggle, query, onQueryChange,
  lockedReason, badge, emptyLabel = 'No graphs yet.', maxHeightClass = 'max-h-56',
}: KbPickerListProps<T>) {
  const { groups, matched, total } = useKbGroups(items, query)

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by name or folder…"
          className="w-full rounded-lg border border-slate-800 bg-slate-950/60 py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-500/50 focus:outline-none"
        />
      </div>

      <div className={cn(maxHeightClass, 'space-y-1 overflow-y-auto rounded-lg border border-slate-800 p-2')}>
        {total === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-slate-600">{emptyLabel}</p>
        ) : matched === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-slate-600">
            No graph matches "{query.trim()}".
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.path}>
              {/* The folder is the distinguishing information — it stays visible while
                  scrolling, otherwise two identical names are again indistinguishable. */}
              <p className="sticky top-0 z-10 -mx-2 bg-slate-900/95 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 backdrop-blur">
                {g.path}
              </p>
              {g.items.map((c) => {
                const checked = selected.has(c.id)
                const locked = lockedReason?.(c) ?? null
                return (
                  <label
                    key={c.id}
                    title={locked ?? undefined}
                    className={cn('flex items-center gap-2 rounded px-2 py-1.5',
                      locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-slate-800/50')}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!!locked}
                      onChange={() => onToggle(c.id)}
                    />
                    <span className="flex-1 truncate text-xs text-slate-300">{c.name}</span>
                    {badge?.(c)}
                  </label>
                )
              })}
            </div>
          ))
        )}
      </div>

      {query.trim() !== '' && total > 0 && (
        <p className="text-[10px] text-slate-600">
          {matched} of {total} graphs
        </p>
      )}
    </div>
  )
}
