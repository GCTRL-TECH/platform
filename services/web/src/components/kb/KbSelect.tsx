/**
 * A dropdown of knowledge bases, grouped by folder.
 *
 * Every such dropdown used to be one flat run of names in creation order. With one
 * account per company that means dozens of entries and several identical names — the
 * folder is the only thing that tells "Personal" from "Personal". `<optgroup>` puts the
 * path above the names, so the list reads as Users / Projects / Global instead of as a
 * pile, and the native keyboard search still works.
 */
import { type CSSProperties } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { groupByFolder, useFolderPaths, type FiledKb } from '@/lib/kbFolders'

interface KbSelectProps<T extends FiledKb> {
  value: string
  onChange: (id: string) => void
  items: T[]
  /** Label of the empty option. Omit to render no empty option. */
  placeholder?: string
  /** Extra text after the name, e.g. "1,204 nodes". */
  meta?: (item: T) => string | null | undefined
  className?: string
  style?: CSSProperties
  disabled?: boolean
  id?: string
  /** Renders the chevron on top of the select (the app's own select styling). */
  chevron?: boolean
}

export function KbSelect<T extends FiledKb>({
  value, onChange, items, placeholder, meta, className, style, disabled, id, chevron = true,
}: KbSelectProps<T>) {
  const paths = useFolderPaths()
  const groups = groupByFolder(items, paths)

  const select = (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(className, chevron && 'appearance-none')}
      style={style}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {groups.map((g) => (
        <optgroup key={g.path} label={g.path}>
          {g.items.map((c) => {
            const suffix = meta?.(c)
            return (
              <option key={c.id} value={c.id}>
                {suffix ? `${c.name} — ${suffix}` : c.name}
              </option>
            )
          })}
        </optgroup>
      ))}
    </select>
  )

  if (!chevron) return select
  return (
    <div className="relative">
      {select}
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
      />
    </div>
  )
}
