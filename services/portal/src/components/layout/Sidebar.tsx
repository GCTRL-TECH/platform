import { NavLink } from 'react-router-dom'
import { LayoutDashboard, KeyRound, ShieldCheck, Settings, LogOut } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/licenses', icon: KeyRound, label: 'Licenses' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

const adminItems = [
  { to: '/admin', icon: ShieldCheck, label: 'Admin' },
]

export function Sidebar() {
  const { user, logout } = useAuth()

  return (
    <aside className="w-56 flex flex-col bg-slate-900 border-r border-slate-800 shrink-0">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-slate-800">
        <span className="text-lg font-bold text-white tracking-tight">GCTRL</span>
        <p className="text-xs text-slate-500 mt-0.5">License Portal</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-0.5">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => cn(isActive ? 'nav-item-active' : 'nav-item')}
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}

        {user?.role === 'admin' && (
          <>
            <div className="my-2 border-t border-slate-800" />
            {adminItems.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => cn(isActive ? 'nav-item-active' : 'nav-item')}
              >
                <Icon size={16} />
                {label}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      {/* User info + logout */}
      <div className="p-3 border-t border-slate-800">
        <div className="px-3 py-2 mb-1">
          <p className="text-xs font-medium text-slate-300 truncate">{user?.email}</p>
          <p className="text-xs text-slate-500 capitalize">{user?.tier ?? 'free'}</p>
        </div>
        <button onClick={logout} className="nav-item w-full text-red-400 hover:text-red-300 hover:bg-red-500/10">
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  )
}
