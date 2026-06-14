import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TabDef {
  id: string
  label: string
  icon?: LucideIcon
  badge?: number
}

/**
 * Minimal controlled tab bar — the parent owns the active id. Used by the
 * Access Control page (and reusable elsewhere) instead of duplicating the
 * ad-hoc string-state tab pattern scattered across the app.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabDef[]
  active: string
  onChange: (id: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex gap-0.5 border-b border-slate-800', className)}>
      {tabs.map((t) => {
        const Icon = t.icon
        const isActive = t.id === active
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
              isActive
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            )}
          >
            {Icon && <Icon size={14} />}
            {t.label}
            {t.badge !== undefined && t.badge > 0 && (
              <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
                {t.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
