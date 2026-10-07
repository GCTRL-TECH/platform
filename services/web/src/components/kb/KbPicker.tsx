import { useEffect, useMemo, useRef, useState, useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, Check, Folder, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useKbTree, type KbItem, type KbFolderNode } from '@/hooks/useKbTree'

type Single = {
  mode: 'single'
  value: string | null
  onChange: (id: string | null, item?: KbItem) => void
  allowNone?: boolean
  noneLabel?: string
  placeholder?: string
}
type Multi = {
  mode: 'multi'
  value: Iterable<string>
  onChange: (ids: string[]) => void
  renderRowExtra?: (item: KbItem, selected: boolean) => ReactNode
  isDisabled?: (item: KbItem) => boolean
  maxHeight?: string
}
export type KbPickerProps = (Single | Multi) & {
  types?: string[]
  disabled?: boolean
  className?: string
  compact?: boolean
}

type Tree = ReturnType<typeof useKbTree>

const CLEARANCE_BADGE: Record<string, string> = {
  PUBLIC: 'badge-green',
  INTERNAL: 'badge-blue',
  CONFIDENTIAL: 'badge-yellow',
  STRICTLY_CONFIDENTIAL: 'badge-red',
}

function TypeBadge({ type }: { type: string }) {
  if (type === 'CODE')
    return (
      <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-cyan-300 ring-1 ring-cyan-500/30">
        Code
      </span>
    )
  if (type === 'WIKI')
    return (
      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300 ring-1 ring-violet-500/30">
        Wiki
      </span>
    )
  return (
    <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400 ring-1 ring-slate-500/30">
      Raw
    </span>
  )
}

function countItems(n: KbFolderNode): number {
  return n.items.length + n.children.reduce((s, c) => s + countItems(c), 0)
}
function collectItems(n: KbFolderNode): KbItem[] {
  return [...n.items, ...n.children.flatMap((c) => collectItems(c))]
}

interface TreeViewProps {
  tree: Tree
  multi: boolean
  selected: Set<string>
  onPick: (item: KbItem) => void
  onToggleFolder: (items: KbItem[], allSelected: boolean) => void
  isDisabled?: (i: KbItem) => boolean
  renderRowExtra?: (item: KbItem, selected: boolean) => ReactNode
  query: string
  compact?: boolean
}

function TreeView({
  tree, multi, selected, onPick, onToggleFolder, isDisabled, renderRowExtra, query, compact,
}: TreeViewProps) {
  const { folders, rootItems, items, pathFor, isLoading } = tree
  const [open, setOpen] = useState<Set<string>>(new Set())
  const q = query.trim().toLowerCase()
  const dis = (i: KbItem) => !!isDisabled?.(i)
  const rowPad = compact ? 'py-1' : 'py-1.5'

  const itemRow = (it: KbItem, depth: number, showPath: boolean) => {
    const sel = selected.has(it.id)
    const d = dis(it)
    const path = showPath ? pathFor(it.id) : []
    return (
      <div
        key={it.id}
        role="option"
        aria-selected={sel}
        onClick={() => !d && onPick(it)}
        className={cn(
          'flex items-center gap-2 rounded px-2 text-xs',
          rowPad,
          d ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-slate-800/60',
          !multi && sel && 'bg-slate-800/60',
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {multi ? (
          <input type="checkbox" checked={sel} disabled={d} readOnly className="pointer-events-none" />
        ) : (
          <span className="flex w-3.5 shrink-0 justify-center">
            {sel && <Check size={13} className="text-emerald-400" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-slate-200">{it.name}</span>
          {path.length > 0 && (
            <span className="block truncate text-[10px] text-slate-500">{path.join(' / ')}</span>
          )}
        </span>
        {renderRowExtra?.(it, sel)}
        <TypeBadge type={it.type} />
        {it.classification && (
          <span className={cn('text-[10px]', CLEARANCE_BADGE[it.classification] ?? 'badge-slate')}>
            {it.classification}
          </span>
        )}
      </div>
    )
  }

  if (isLoading) return <p className="px-2 py-3 text-center text-[11px] text-slate-500">Loading...</p>
  if (items.length === 0)
    return <p className="px-2 py-3 text-center text-[11px] text-slate-500">No knowledge bases yet</p>

  if (q) {
    const matches = items.filter(
      (i) => i.name.toLowerCase().includes(q) || pathFor(i.id).some((p) => p.toLowerCase().includes(q)),
    )
    if (matches.length === 0)
      return <p className="px-2 py-3 text-center text-[11px] text-slate-500">No matches</p>
    return <div role="listbox">{matches.map((i) => itemRow(i, 0, true))}</div>
  }

  const folderRow = (f: KbFolderNode, depth: number): ReactNode => {
    const total = countItems(f)
    if (total === 0) return null
    const isOpen = open.has(f.id)
    const all = collectItems(f).filter((i) => !dis(i))
    const nSel = all.filter((i) => selected.has(i.id)).length
    const allSel = all.length > 0 && nSel === all.length
    return (
      <div key={f.id}>
        <div
          className={cn('flex cursor-pointer items-center gap-2 rounded px-2 text-xs hover:bg-slate-800/40', rowPad)}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() =>
            setOpen((p) => {
              const n = new Set(p)
              if (n.has(f.id)) n.delete(f.id)
              else n.add(f.id)
              return n
            })
          }
        >
          {isOpen ? (
            <ChevronDown size={13} className="shrink-0 text-slate-500" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-slate-500" />
          )}
          {multi && (
            <input
              type="checkbox"
              checked={allSel}
              disabled={all.length === 0}
              ref={(el) => {
                if (el) el.indeterminate = nSel > 0 && !allSel
              }}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggleFolder(all, allSel)}
            />
          )}
          <Folder size={13} className="shrink-0 text-amber-400/80" />
          <span className="min-w-0 flex-1 truncate text-slate-300">{f.name}</span>
          <span className="text-[10px] text-slate-500">{total}</span>
        </div>
        {isOpen && (
          <div>
            {f.children.map((c) => folderRow(c, depth + 1))}
            {f.items.map((i) => itemRow(i, depth + 1, false))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div role="listbox">
      {folders.map((f) => folderRow(f, 0))}
      {rootItems.map((i) => itemRow(i, 0, false))}
    </div>
  )
}

export function KbPicker(props: KbPickerProps) {
  const tree = useKbTree({ types: props.types })
  const [query, setQuery] = useState('')
  const [popOpen, setPopOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null)

  const multiKey = props.mode === 'multi' ? Array.from(props.value).join('|') : ''
  const multiSelected = useMemo(
    () => new Set(multiKey ? multiKey.split('|') : []),
    [multiKey],
  )

  useLayoutEffect(() => {
    if (!popOpen || !triggerRef.current) return
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect()
      const flip = r.bottom + 340 > window.innerHeight && r.top > 340
      setPos({
        ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        left: Math.min(r.left, Math.max(8, window.innerWidth - 308)),
        width: Math.max(r.width, 300),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [popOpen])

  useEffect(() => {
    if (!popOpen) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setPopOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopOpen(false)
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [popOpen])

  const searchBox = (
    <div className="relative">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={cn('input-field pl-9', props.compact && 'py-1.5 text-xs')}
        placeholder="Search knowledge bases..."
        autoFocus={props.mode === 'single'}
      />
    </div>
  )

  if (props.mode === 'multi') {
    const emit = (s: Set<string>) => props.onChange(Array.from(s))
    return (
      <div className={cn('space-y-2', props.disabled && 'pointer-events-none opacity-60', props.className)}>
        {searchBox}
        <div
          className={cn(
            'overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/40 p-1',
            props.maxHeight ?? 'max-h-64',
          )}
        >
          <TreeView
            tree={tree}
            multi
            selected={multiSelected}
            onPick={(it) => {
              const s = new Set(multiSelected)
              if (s.has(it.id)) s.delete(it.id)
              else s.add(it.id)
              emit(s)
            }}
            onToggleFolder={(its, allSel) => {
              const s = new Set(multiSelected)
              for (const i of its) {
                if (allSel) s.delete(i.id)
                else s.add(i.id)
              }
              emit(s)
            }}
            isDisabled={props.isDisabled}
            renderRowExtra={props.renderRowExtra}
            query={query}
            compact={props.compact}
          />
        </div>
        <p className="text-[11px] text-slate-500">{multiSelected.size} selected</p>
      </div>
    )
  }

  const selItem = props.value ? tree.byId.get(props.value) : undefined
  const selPath = selItem ? tree.pathFor(selItem.id) : []
  const label = selItem
    ? selItem.name
    : props.value
      ? tree.isLoading
        ? 'Loading...'
        : 'Unknown knowledge base'
      : props.allowNone
        ? (props.noneLabel ?? 'None')
        : (props.placeholder ?? 'Select a knowledge base...')

  const pick = (it: KbItem | null) => {
    props.onChange(it ? it.id : null, it ?? undefined)
    setPopOpen(false)
    setQuery('')
  }

  return (
    <div className={cn('relative', props.className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={props.disabled}
        onClick={() => setPopOpen((o) => !o)}
        className={cn(
          'input-field flex w-full items-center gap-2 text-left',
          props.compact && 'py-1.5 text-xs',
          props.disabled && 'opacity-60',
        )}
        aria-haspopup="listbox"
        aria-expanded={popOpen}
      >
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', !selItem && 'text-slate-500')}>{label}</span>
          {selPath.length > 0 && (
            <span className="block truncate text-[10px] text-slate-500">{selPath.join(' / ')}</span>
          )}
        </span>
        <ChevronDown size={14} className="shrink-0 text-slate-500" />
      </button>
      {popOpen &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="fixed z-[90] space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-xl"
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
          >
            {searchBox}
            {props.allowNone && (
              <div
                onClick={() => pick(null)}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60"
              >
                <X size={13} className="text-slate-500" />
                {props.noneLabel ?? 'None'}
              </div>
            )}
            <div className="max-h-64 overflow-y-auto">
              <TreeView
                tree={tree}
                multi={false}
                selected={new Set(props.value ? [props.value] : [])}
                onPick={pick}
                onToggleFolder={() => {}}
                query={query}
                compact={props.compact}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
