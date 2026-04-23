import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Zap,
  GitMerge,
  Database,
  BookOpen,
  MessageSquare,
  Settings,
  Coins,
  Shield,
  Timer,
  LogOut,
  ChevronRight,
  Hexagon,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

interface NavItemConfig {
  label: string
  icon: LucideIcon
  to: string
  disabled?: boolean
  badge?: string
}

interface NavSection {
  label: string
  items: NavItemConfig[]
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Knowledge Management',
    items: [
      { label: 'KEX Extract', icon: Zap, to: '/kex' },
      { label: 'FUSE Merge', icon: GitMerge, to: '/fuse' },
      { label: 'Knowledge Graphs', icon: Database, to: '/graphs' },
      { label: 'Ontologies', icon: BookOpen, to: '/ontologies' },
      { label: 'Triggers', icon: Timer, to: '/triggers' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { label: 'Talk to Graph', icon: MessageSquare, to: '/chat' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { label: 'Tokens', icon: Coins, to: '/billing' },
      { label: 'Admin', icon: Shield, to: '/admin' },
      { label: 'Settings', icon: Settings, to: '/settings' },
    ],
  },
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
}: {
  item: NavItemConfig
  collapsed: boolean
}) {
  const Icon = item.icon

  if (item.disabled) {
    return (
      <div
        key={item.to}
        className={cn('nav-item-disabled', collapsed && 'justify-center px-0')}
        title={collapsed ? item.label : undefined}
      >
        <Icon size={16} />
        {!collapsed && <span className="flex-1">{item.label}</span>}
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
      title={collapsed ? item.label : undefined}
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
          {!collapsed && <span className="flex-1">{item.label}</span>}
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
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <aside
      className={`fixed left-0 top-0 flex h-screen flex-col border-r border-slate-800 bg-slate-950 transition-all duration-300 ${collapsed ? 'w-16' : 'w-64'}`}
    >
      {/* Logo */}
      <div
        className={`flex h-16 items-center border-b border-slate-800 ${collapsed ? 'justify-center px-2' : 'gap-2.5 px-5'}`}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500">
          <Hexagon size={16} className="text-white" fill="white" />
        </div>
        {!collapsed && (
          <div>
            <span className="text-sm font-semibold text-slate-100">GCTRL</span>
            <p className="text-[10px] text-slate-500 leading-tight">Knowledge Platform</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className={`flex-1 overflow-y-auto py-3 ${collapsed ? 'px-1.5' : 'px-3'}`}>
        {/* Dashboard — top-level, no section header */}
        <div className="mb-1">
          <NavItemLink item={TOP_ITEM} collapsed={collapsed} />
        </div>

        {/* Sectioned navigation */}
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            {/* Section label — hidden when collapsed */}
            {!collapsed && (
              <p className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                {section.label}
              </p>
            )}
            {/* Spacer when collapsed to visually separate groups */}
            {collapsed && <div className="my-1 border-t border-slate-800/60" />}

            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavItemLink key={item.to} item={item} collapsed={collapsed} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom: user section */}
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

