import { useState, useEffect } from 'react'
import {
  Users,
  BarChart3,
  Shield,
  Clock,
  Coins,
  Database,
  CheckCircle,
  XCircle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

interface Stats {
  users: number
  jobs: { total: number; completed: number; failed: number }
  compilations: number
  tokensSpent: number
  connectors: number
}

interface UserRow {
  id: string
  email: string
  name: string
  role: string
  clearance: string
  tokensBalance: number
  tier: string
  emailVerified: boolean
  createdAt: string
}

interface AuditEntry {
  id: string
  userId: string
  action: string
  resourceType: string
  resourceId: string
  details: Record<string, unknown>
  ipAddress: string | null
  createdAt: string
}

type Tab = 'overview' | 'users' | 'audit'

const ROLE_COLORS: Record<string, string> = {
  viewer: 'bg-slate-700 text-slate-300',
  analyst: 'bg-blue-900/50 text-blue-300',
  editor: 'bg-purple-900/50 text-purple-300',
  admin: 'bg-red-900/50 text-red-300',
}

const CLEARANCE_COLORS: Record<string, string> = {
  PUBLIC: 'bg-emerald-900/50 text-emerald-300',
  INTERNAL: 'bg-blue-900/50 text-blue-300',
  CONFIDENTIAL: 'bg-amber-900/50 text-amber-300',
  RESTRICTED: 'bg-red-900/50 text-red-300',
}

export default function AdminPanel() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<Stats | null>(null)
  const [allUsers, setAllUsers] = useState<UserRow[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([])

  useEffect(() => {
    void loadStats()
    void loadUsers()
  }, [])

  useEffect(() => {
    if (tab === 'audit' && auditLogs.length === 0) void loadAudit()
  }, [tab])

  async function loadStats() {
    try {
      const { data } = await api.get('/admin/stats')
      setStats(data)
    } catch { /* non-fatal */ }
  }

  async function loadUsers() {
    try {
      const { data } = await api.get('/admin/users')
      setAllUsers(data.users || [])
    } catch { /* non-fatal */ }
  }

  async function loadAudit() {
    try {
      const { data } = await api.get('/admin/audit?limit=200')
      setAuditLogs(data.logs || [])
    } catch { /* non-fatal */ }
  }

  async function updateRole(userId: string, role: string) {
    const clearanceMap: Record<string, string> = {
      viewer: 'PUBLIC',
      analyst: 'INTERNAL',
      editor: 'CONFIDENTIAL',
      admin: 'RESTRICTED',
    }
    try {
      await api.put(`/admin/users/${userId}/role`, {
        role,
        clearance: clearanceMap[role],
      })
      await loadUsers()
    } catch {
      alert('Failed to update role')
    }
  }

  if (user?.role !== 'admin') {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-center">
          <Shield size={48} className="mx-auto text-red-500/50" />
          <h2 className="mt-4 text-lg font-semibold text-slate-200">Access Denied</h2>
          <p className="mt-2 text-sm text-slate-500">Admin role required</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Admin Panel</h1>
        <p className="text-sm text-slate-500">System administration and user management</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900/50 p-1">
        {([
          { id: 'overview' as Tab, label: 'Overview', icon: BarChart3 },
          { id: 'users' as Tab, label: 'Users', icon: Users },
          { id: 'audit' as Tab, label: 'Audit Log', icon: Clock },
        ]).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-2 text-xs font-medium transition-colors',
              tab === t.id ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'
            )}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && stats && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard icon={Users} label="Users" value={stats.users} />
            <StatCard icon={CheckCircle} label="Jobs Completed" value={stats.jobs.completed} color="text-emerald-400" />
            <StatCard icon={XCircle} label="Jobs Failed" value={stats.jobs.failed} color="text-red-400" />
            <StatCard icon={Database} label="Compilations" value={stats.compilations} />
            <StatCard icon={Coins} label="Tokens Spent" value={stats.tokensSpent} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
              <h3 className="text-sm font-semibold text-slate-200">Job Success Rate</h3>
              <p className="mt-2 text-3xl font-bold text-emerald-400">
                {stats.jobs.total > 0
                  ? `${Math.round((stats.jobs.completed / stats.jobs.total) * 100)}%`
                  : 'N/A'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {stats.jobs.completed} / {stats.jobs.total} jobs
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
              <h3 className="text-sm font-semibold text-slate-200">Connected Integrations</h3>
              <p className="mt-2 text-3xl font-bold text-indigo-400">{stats.connectors}</p>
              <p className="mt-1 text-xs text-slate-500">OAuth connectors active</p>
            </div>
          </div>
        </div>
      )}

      {/* Users */}
      {tab === 'users' && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-4 py-3 font-medium text-slate-500">User</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Role</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Clearance</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Tokens</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Tier</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Verified</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Joined</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {allUsers.map((u) => (
                  <tr key={u.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-slate-200">{u.name}</p>
                        <p className="text-slate-500">{u.email}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', ROLE_COLORS[u.role])}>
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', CLEARANCE_COLORS[u.clearance])}>
                        {u.clearance}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-300">{u.tokensBalance.toLocaleString()}</td>
                    <td className="px-4 py-3 capitalize text-slate-400">{u.tier}</td>
                    <td className="px-4 py-3">
                      {u.emailVerified ? (
                        <CheckCircle size={14} className="text-emerald-400" />
                      ) : (
                        <XCircle size={14} className="text-slate-600" />
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        onChange={(e) => void updateRole(u.id, e.target.value)}
                        className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="analyst">Analyst</option>
                        <option value="editor">Editor</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Audit Log */}
      {tab === 'audit' && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50">
          <div className="max-h-[600px] overflow-y-auto">
            {auditLogs.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">No audit logs found</p>
            ) : (
              <div className="divide-y divide-slate-800/50">
                {auditLogs.map((log) => (
                  <div key={log.id} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-800/30">
                    <Clock size={12} className="mt-1 text-slate-600" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-300">{log.action}</span>
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-500">
                          {log.resourceType}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        Resource: {log.resourceId?.slice(0, 8)}...
                        {log.ipAddress && ` | IP: ${log.ipAddress}`}
                      </p>
                    </div>
                    <span className="text-[10px] text-slate-600">
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  color = 'text-slate-100',
}: {
  icon: typeof Users
  label: string
  value: number
  color?: string
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Icon size={14} />
        {label}
      </div>
      <p className={cn('mt-2 text-2xl font-bold', color)}>{value.toLocaleString()}</p>
    </div>
  )
}
