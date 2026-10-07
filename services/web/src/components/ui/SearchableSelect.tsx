import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SearchableSelectOption {
  value: string
  label: string
  /** Pinned options (e.g. "All", "Web login") stay visible whatever the query. */
  pinned?: boolean
}

/** Case-insensitive substring match on the label; pinned options always pass. */
export function filterOptions(options: SearchableSelectOption[], query: string): SearchableSelectOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => o.pinned || o.label.toLowerCase().includes(q))
}

interface SearchableSelectProps {
  value: string
  onChange: (value: string) => void
  options: SearchableSelectOption[]
  /** Accessible name of the trigger and the search field. */
  ariaLabel: string
  searchPlaceholder?: string
  /** Highlights the trigger border (e.g. when a filter is active). */
  active?: boolean
  className?: string
}

/**
 * Compact select with a type-to-filter search field. The popover is portalled to
 * <body> so it is not clipped by `overflow-hidden` cards. Keyboard: arrows/Home/End
 * move, Enter picks, Escape clears the query first and closes on the second press.
 */
export function SearchableSelect({
  value, onChange, options, ariaLabel, searchPlaceholder = 'Search...', active, className,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const id = useId()
  const listId = `${id}-list`

  const filtered = useMemo(() => filterOptions(options, query), [options, query])
  const selected = options.find((o) => o.value === value)

  const close = (refocus = true) => {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }
  const pick = (o: SearchableSelectOption) => {
    onChange(o.value)
    close()
  }

  // On open: start at the selected option.
  useEffect(() => {
    if (!open) return
    const i = options.findIndex((o) => o.value === value)
    setActiveIdx(i >= 0 ? i : 0)
  }, [open])

  // Typing resets the highlight to the first match.
  useEffect(() => { setActiveIdx(0) }, [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect()
      const flip = r.bottom + 300 > window.innerHeight && r.top > 300
      const width = Math.max(r.width, 240)
      setPos({
        ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        left: Math.min(r.left, Math.max(8, window.innerWidth - width - 8)),
        width,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      close(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = filtered.length - 1
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, last)); break
      case 'ArrowUp': e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); break
      case 'Home': e.preventDefault(); setActiveIdx(0); break
      case 'End': e.preventDefault(); setActiveIdx(Math.max(last, 0)); break
      case 'Enter': {
        e.preventDefault()
        const o = filtered[activeIdx]
        if (o) pick(o)
        break
      }
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (query) setQuery('')
        else close()
        break
      case 'Tab': close(false); break
    }
  }

  const activeOption = filtered[activeIdx]

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${selected?.label ?? ''}`}
        title={selected?.label}
        className={cn(
          'flex max-w-[160px] items-center gap-1 rounded border bg-slate-800 px-1 py-0.5 text-left text-[10px] text-slate-300',
          active ? 'border-indigo-500' : 'border-slate-700',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? ''}</span>
        <ChevronDown size={10} className="shrink-0 text-slate-500" />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="fixed z-[90] space-y-1 rounded-lg border border-slate-700 bg-slate-900 p-1.5 shadow-xl"
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
        >
          <div className="relative">
            <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              role="combobox"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              aria-label={ariaLabel}
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeOption ? `${id}-opt-${activeIdx}` : undefined}
              className="w-full rounded border border-slate-700 bg-slate-800 py-1 pl-6 pr-2 text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="max-h-60 overflow-y-auto">
            {filtered.map((o, i) => {
              const sel = o.value === value
              return (
                <li
                  key={o.value}
                  id={`${id}-opt-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={sel}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px]',
                    i === activeIdx ? 'bg-slate-800 text-slate-100' : 'text-slate-300',
                    o.pinned && 'text-slate-400',
                  )}
                >
                  <span className="flex w-3 shrink-0 justify-center">
                    {sel && <Check size={11} className="text-emerald-400" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                </li>
              )
            })}
            {filtered.every((o) => o.pinned) && query.trim() && (
              <li className="px-2 py-1.5 text-center text-[10px] text-slate-500" role="presentation">No matches</li>
            )}
          </ul>
        </div>,
        document.body,
      )}
    </>
  )
}
