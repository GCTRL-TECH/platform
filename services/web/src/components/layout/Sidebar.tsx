import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Zap,
  GitMerge,
  Database,
  BookOpen,
  BookOpenText,
  MessageSquare,
  Settings,
  Timer,
  LogOut,
  ChevronRight,
  Shield,
  ShieldCheck,
  Sparkles,
  Wrench,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useUiMode } from '@/hooks/useUiMode'
import { cn } from '@/lib/utils'

interface NavItemConfig {
  label: string
  icon: LucideIcon
  to: string
  disabled?: boolean
  badge?: string
  /** Only shown in Expert mode. */
  expert?: boolean
  /** Label override shown in Easy mode (falls back to `label`). */
  easyLabel?: string
}

interface NavSection {
  label: string
  items: NavItemConfig[]
}

// User-centric core flow: Knowledge → Access & Ask. Advanced surfaces are
// tagged `expert` and hidden in Easy mode to keep the default UI focused.
const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Knowledge',
    items: [
      { label: 'Knowledge Graphs', icon: Database, to: '/graphs' },
      { label: 'Wiki', icon: BookOpenText, to: '/wiki' },
      { label: 'KEX Extract', easyLabel: 'Add Knowledge', icon: Zap, to: '/kex' },
      { label: 'FUSE Merge', icon: GitMerge, to: '/fuse', expert: true },
      { label: 'Ontologies', icon: BookOpen, to: '/ontologies', expert: true },
      { label: 'Knowledge Quality', icon: ShieldCheck, to: '/quality', expert: true },
      { label: 'Triggers', icon: Timer, to: '/triggers', expert: true },
    ],
  },
  {
    label: 'Access & Ask',
    items: [
      { label: 'Access Control', icon: Shield, to: '/access', expert: true },
      { label: 'Talk to Graph', icon: MessageSquare, to: '/chat' },
      { label: 'Agent', icon: Terminal, to: '/agent' },
    ],
  },
  // Enterprise surfaces (Webhooks, SSO/SCIM, API Keys) now live under Settings
  // as deep-linkable tabs (/settings?tab=webhooks, …) rather than nav items —
  // they are occasional setup, not daily navigation.
]

// Dashboard is above sections, pinned top
const TOP_ITEM: NavItemConfig = {
  label: 'Dashboard',
  icon: LayoutDashboard,
  to: '/dashboard',
}

function UserAvatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500/20 text-xs font-semibold text-blue-400 ring-1 ring-blue-500/30">
      {initials}
    </div>
  )
}

function NavItemLink({
  item,
  collapsed,
  isExpert,
}: {
  item: NavItemConfig
  collapsed: boolean
  isExpert: boolean
}) {
  const Icon = item.icon
  const displayLabel = !isExpert && item.easyLabel ? item.easyLabel : item.label

  if (item.disabled) {
    return (
      <div
        key={item.to}
        className={cn('nav-item-disabled', collapsed && 'justify-center px-0')}
        title={collapsed ? displayLabel : undefined}
      >
        <Icon size={16} />
        {!collapsed && <span className="flex-1">{displayLabel}</span>}
        {!collapsed && item.badge && (
          <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            {item.badge}
          </span>
        )}
      </div>
    )
  }

  return (
    <NavLink
      to={item.to}
      title={collapsed ? displayLabel : undefined}
      className={({ isActive }) =>
        cn(
          isActive ? 'nav-item-active' : 'nav-item',
          'group',
          collapsed && 'justify-center px-0'
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            size={16}
            className={cn(isActive ? 'text-blue-400' : 'text-slate-500 group-hover:text-slate-300')}
          />
          {!collapsed && <span className="flex-1">{displayLabel}</span>}
          {!collapsed && isActive && (
            <ChevronRight size={14} className="text-blue-400/50" />
          )}
        </>
      )}
    </NavLink>
  )
}

export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const { user, logout } = useAuth()
  const { isExpert, setMode } = useUiMode()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  // In Easy mode, hide expert items and any section left empty.
  const sections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => isExpert || !i.expert) }))
    .filter((s) => s.items.length > 0)

  return (
    <aside
      className={`fixed left-0 top-0 flex h-screen flex-col border-r border-slate-800 bg-slate-950 transition-all duration-300 ${collapsed ? 'w-16' : 'w-64'}`}
    >
      {/* Logo */}
      <div
        className={`flex h-16 items-center border-b border-slate-800 ${collapsed ? 'justify-center px-2' : 'px-5'}`}
      >
        {collapsed ? (
          <img src="/gctrl/icon-color.svg?v=2" alt="GCTRL" className="h-8 w-8 shrink-0" />
        ) : (
          <img src="/gctrl/horizontal-color-on-darkbg.svg?v=2" alt="GCTRL" className="h-7 w-auto shrink-0" />
        )}
      </div>

      {/* Navigation */}
      <nav className={`flex-1 overflow-y-auto py-3 ${collapsed ? 'px-1.5' : 'px-3'}`}>
        {/* Dashboard — top-level, no section header */}
        <div className="mb-1">
          <NavItemLink item={TOP_ITEM} collapsed={collapsed} isExpert={isExpert} />
        </div>

        {/* Sectioned navigation */}
        {sections.map((section) => (
          <div key={section.label}>
            {/* Section label — hidden when collapsed, and hidden entirely in Easy mode */}
            {!collapsed && isExpert && (
              <p className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                {section.label}
              </p>
            )}
            {/* Spacer when collapsed to visually separate groups (Expert only) */}
            {collapsed && isExpert && <div className="my-1 border-t border-slate-800/60" />}

            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavItemLink key={item.to} item={item} collapsed={collapsed} isExpert={isExpert} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom: settings + user section */}
      <div className={`border-t border-slate-800 ${collapsed ? 'p-1.5' : 'p-3'}`}>
        {!collapsed && (
          <div className="mb-2 flex items-center gap-3 rounded-lg px-2 py-2">
            {user && <UserAvatar name={user.name} />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-200">{user?.name ?? '—'}</p>
              <p className="truncate text-xs text-slate-500">{user?.email ?? ''}</p>
            </div>
          </div>
        )}

        {/* Easy / Expert mode toggle */}
        {!collapsed ? (
          <div className="mb-2 flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
            <button
              onClick={() => setMode('easy')}
              title="The essentials — everything fuses into your knowledge base automatically"
              className={cn('flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                !isExpert ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300')}
            >
              <Sparkles size={12} /> Easy
            </button>
            <button
              onClick={() => setMode('expert')}
              title="All controls: ontologies, triggers, fusion, access control"
              className={cn('flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                isExpert ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300')}
            >
              <Wrench size={12} /> Expert
            </button>
          </div>
        ) : (
          <button
            onClick={() => setMode(isExpert ? 'easy' : 'expert')}
            title={isExpert ? 'Expert mode (click for Easy)' : 'Easy mode (click for Expert)'}
            className="mb-1 flex w-full items-center justify-center rounded-md p-2 text-slate-500 hover:text-slate-300"
          >
            {isExpert ? <Wrench size={14} /> : <Sparkles size={14} />}
          </button>
        )}

        <div className="mb-1">
          <NavItemLink item={{ label: 'Settings', icon: Settings, to: '/settings' }} collapsed={collapsed} isExpert={isExpert} />
        </div>

        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <button
              className="btn-ghost text-slate-500 hover:text-red-400 p-2"
              onClick={handleLogout}
              title="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        ) : (
          <div className="flex gap-1">
            <button
              className="btn-ghost flex-1 justify-start text-slate-500 hover:text-red-400"
              onClick={handleLogout}
            >
              <LogOut size={15} />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

