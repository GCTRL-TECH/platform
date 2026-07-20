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
  ChevronDown,
  ChevronRight,
  KeyRound,
  Pencil,
  Save,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface JobStats { total: number; completed: number; failed: number }
interface Stats {
  users: number
  jobs: JobStats
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
  hasLicense: boolean
  creditsAllocated: number | null
  creditsUsed: number | null
  emailVerified: boolean
  createdAt: string
}

interface License {
  id: string
  licenseKey: string
  tier: string
  creditsAllocated: number
  creditsUsed: number
  creditsRemaining: number
  status: string
  activatedAt: string
}

interface AuditEntry {
  id: string
  userId: string
  action: string
  resourceType: string
  resourceId: string
  ipAddress: string | null
  createdAt: string
}

type Tab = 'overview' | 'users' | 'audit'

// Reserved for future role-coloured badges in user list.
const _ROLE_COLORS: Record<string, string> = {
  viewer:  'bg-slate-700 text-slate-300',
  analyst: 'bg-blue-900/50 text-blue-300',
  editor:  'bg-purple-900/50 text-purple-300',
  admin:   'bg-red-900/50 text-red-300',
}
void _ROLE_COLORS;

const CLEARANCE_COLORS: Record<string, string> = {
  PUBLIC:       'bg-emerald-900/50 text-emerald-300',
  INTERNAL:     'bg-blue-900/50 text-blue-300',
  CONFIDENTIAL: 'bg-amber-900/50 text-amber-300',
  RESTRICTED:   'bg-red-900/50 text-red-300',
}

const TIER_COLORS: Record<string, string> = {
  free:       'text-slate-400',
  business:   'text-indigo-400',
  enterprise: 'text-amber-400',
  // Legacy tiers — kept so old values still render styled.
  starter:    'text-blue-400',
  pro:        'text-purple-400',
}

// ─── License sub-row ──────────────────────────────────────────────────────────

function LicenseRows({ userId }: { userId: string }) {
  const [licenses, setLicenses] = useState<License[] | null>(null)
  const [editing, setEditing] = useState<Record<string, Partial<License>>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    void loadLicenses()
  }, [userId])

  async function loadLicenses() {
    try {
      const { data } = await api.get(`/admin/users/${userId}/licenses`)
      setLicenses(data.licenses || [])
    } catch {
      setLicenses([])
    }
  }

  function startEdit(lic: License) {
    setEditing((prev) => ({
      ...prev,
      [lic.id]: { tier: lic.tier, creditsAllocated: lic.creditsAllocated, status: lic.status },
    }))
  }

  function cancelEdit(licId: string) {
    setEditing((prev) => { const n = { ...prev }; delete n[licId]; return n })
  }

  async function saveEdit(lic: License) {
    const changes = editing[lic.id]
    if (!changes) return
    setSaving(lic.id)
    try {
      await api.put(`/admin/licenses/${lic.id}`, {
        tier: changes.tier,
        credits_allocated: changes.creditsAllocated,
        status: changes.status,
      })
      await loadLicenses()
      cancelEdit(lic.id)
    } catch {
      alert('Failed to save license changes')
    } finally {
      setSaving(null)
    }
  }

  if (licenses === null) {
    return (
      <tr>
        <td colSpan={8} className="px-8 py-3 text-xs text-slate-500">Loading licenses…</td>
      </tr>
    )
  }

  if (licenses.length === 0) {
    return (
      <tr>
        <td colSpan={8} className="px-8 py-3 text-xs text-slate-500 italic">No licenses linked to this account.</td>
      </tr>
    )
  }

  return (
    <>
      <tr>
        <td colSpan={8} className="px-4 pt-3 pb-1">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <KeyRound size={11} />
            Licenses
          </div>
        </td>
      </tr>
      {licenses.map((lic) => {
        const isEditing = !!editing[lic.id]
        const draft = editing[lic.id] ?? {}
        const pct = lic.creditsAllocated > 0 ? (lic.creditsUsed / lic.creditsAllocated) * 100 : 0

        return (
          <tr key={lic.id} className="bg-slate-900/60">
            <td className="pl-10 pr-4 py-2" colSpan={2}>
              <span className="font-mono text-[11px] text-slate-400">{lic.licenseKey}</span>
            </td>
            <td className="px-4 py-2">
              {isEditing ? (
                <select
                  value={String(draft.tier ?? lic.tier)}
                  onChange={(e) => setEditing((prev) => ({ ...prev, [lic.id]: { ...prev[lic.id], tier: e.target.value } }))}
                  className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300"
                >
                  {['free', 'business', 'enterprise'].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              ) : (
                <span className={cn('text-[11px] font-medium capitalize', TIER_COLORS[lic.tier] ?? 'text-slate-400')}>
                  {lic.tier}
                </span>
              )}
            </td>
            <td className="px-4 py-2">
              {isEditing ? (
                <input
                  type="number"
                  value={draft.creditsAllocated ?? lic.creditsAllocated}
                  onChange={(e) => setEditing((prev) => ({ ...prev, [lic.id]: { ...prev[lic.id], creditsAllocated: Number(e.target.value) } }))}
                  className="w-24 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300"
                  min={0}
                />
              ) : (
                <div>
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span>{lic.creditsUsed.toLocaleString()} used</span>
                    <span>{lic.creditsAllocated.toLocaleString()} total</span>
                  </div>
                  <div className="mt-0.5 h-1 w-24 rounded-full bg-slate-800">
                    <div
                      className={cn('h-full rounded-full', pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-emerald-500')}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-slate-500">{lic.creditsRemaining.toLocaleString()} remaining</span>
                </div>
              )}
            </td>
            <td className="px-4 py-2">
              {isEditing ? (
                <select
                  value={String(draft.status ?? lic.status)}
                  onChange={(e) => setEditing((prev) => ({ ...prev, [lic.id]: { ...prev[lic.id], status: e.target.value } }))}
                  className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300"
                >
                  <option value="active">active</option>
                  <option value="suspended">suspended</option>
                  <option value="revoked">revoked</option>
                </select>
              ) : (
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium',
                  lic.status === 'active' ? 'bg-emerald-900/50 text-emerald-300' :
                  lic.status === 'suspended' ? 'bg-amber-900/50 text-amber-300' :
                  'bg-red-900/50 text-red-300'
                )}>
                  {lic.status}
                </span>
              )}
            </td>
            <td className="px-4 py-2 text-[10px] text-slate-500">
              {new Date(lic.activatedAt).toLocaleDateString()}
            </td>
            <td className="px-4 py-2" colSpan={2}>
              {isEditing ? (
                <div className="flex gap-1">
                  <button
                    onClick={() => void saveEdit(lic)}
                    disabled={saving === lic.id}
                    className="flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[10px] text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    <Save size={10} /> Save
                  </button>
                  <button
                    onClick={() => cancelEdit(lic.id)}
                    className="flex items-center gap-1 rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-600"
                  >
                    <X size={10} /> Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => startEdit(lic)}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-700 hover:text-slate-300"
                >
                  <Pencil size={10} /> Edit
                </button>
              )}
            </td>
          </tr>
        )
      })}
      <tr><td colSpan={8} className="h-2" /></tr>
    </>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function AdminPanel() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<Stats | null>(null)
  const [allUsers, setAllUsers] = useState<UserRow[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([])
  const [expandedUser, setExpandedUser] = useState<string | null>(null)
  const [editingTokens, setEditingTokens] = useState<Record<string, number>>({})

  useEffect(() => { void loadStats(); void loadUsers() }, [])
  useEffect(() => { if (tab === 'audit' && auditLogs.length === 0) void loadAudit() }, [tab])

  async function loadStats() {
    try { const { data } = await api.get('/admin/stats'); setStats(data) } catch { /* non-fatal */ }
  }

  async function loadUsers() {
    try {
      const { data } = await api.get('/admin/users')
      setAllUsers(Array.isArray(data) ? data : (data.users || []))
    } catch { /* non-fatal */ }
  }

  async function loadAudit() {
    try { const { data } = await api.get('/admin/audit?limit=200'); setAuditLogs(data.logs || []) } catch { /* non-fatal */ }
  }

  async function updateRole(userId: string, role: string) {
    try {
      await api.put(`/admin/users/${userId}/role`, { role })
      await loadUsers()
    } catch { alert('Failed to update role') }
  }

  async function updateTier(userId: string, tier: string) {
    try {
      await api.put(`/admin/users/${userId}/tier`, { tier })
      await loadUsers()
    } catch { alert('Failed to update tier') }
  }

  async function saveTokens(userId: string) {
    const balance = editingTokens[userId]
    if (balance === undefined) return
    try {
      await api.put(`/admin/users/${userId}/tokens`, { tokens_balance: balance })
      await loadUsers()
      setEditingTokens((prev) => { const n = { ...prev }; delete n[userId]; return n })
    } catch { alert('Failed to update token balance') }
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
          { id: 'users'    as Tab, label: 'Users',    icon: Users },
          { id: 'audit'    as Tab, label: 'Audit Log', icon: Clock },
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
            <StatCard icon={Users}       label="Users"          value={stats.users} />
            <StatCard icon={CheckCircle} label="Jobs Completed" value={stats.jobs.completed} color="text-emerald-400" />
            <StatCard icon={XCircle}     label="Jobs Failed"    value={stats.jobs.failed}    color="text-red-400" />
            <StatCard icon={Database}    label="Compilations"   value={stats.compilations} />
            <StatCard icon={Coins}       label="Tokens Spent"   value={stats.tokensSpent} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
              <h3 className="text-sm font-semibold text-slate-200">Job Success Rate</h3>
              <p className="mt-2 text-3xl font-bold text-emerald-400">
                {stats.jobs.total > 0
                  ? `${Math.round((stats.jobs.completed / stats.jobs.total) * 100)}%`
                  : 'N/A'}
              </p>
              <p className="mt-1 text-xs text-slate-500">{stats.jobs.completed} / {stats.jobs.total} jobs</p>
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
                  <th className="w-6 px-3 py-3" />
                  <th className="px-4 py-3 font-medium text-slate-500">User</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Role</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Clearance</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Token Balance</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Tier</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Verified</th>
                  <th className="px-4 py-3 font-medium text-slate-500">Joined</th>
                </tr>
              </thead>
              <tbody>
                {allUsers.map((u) => {
                  const isExpanded = expandedUser === u.id
                  const isEditingTokens = u.id in editingTokens
                  return (
                    <>
                      <tr
                        key={u.id}
                        className={cn('border-b border-slate-800/50 hover:bg-slate-800/30', isExpanded && 'bg-slate-800/20')}
                      >
                        {/* Expand toggle */}
                        <td className="px-3 py-3">
                          <button
                            onClick={() => setExpandedUser(isExpanded ? null : u.id)}
                            className="text-slate-500 hover:text-slate-300"
                          >
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>

                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-200">{u.name}</p>
                          <p className="text-slate-500">{u.email}</p>
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

                        <td className="px-4 py-3">
                          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', CLEARANCE_COLORS[u.clearance])}>
                            {u.clearance}
                          </span>
                        </td>

                        {/* Inline-editable token balance */}
                        <td className="px-4 py-3">
                          {isEditingTokens ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                value={editingTokens[u.id]}
                                onChange={(e) => setEditingTokens((prev) => ({ ...prev, [u.id]: Number(e.target.value) }))}
                                className="w-20 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-300"
                                min={0}
                              />
                              <button onClick={() => void saveTokens(u.id)} className="text-emerald-400 hover:text-emerald-300"><Save size={12} /></button>
                              <button onClick={() => setEditingTokens((prev) => { const n = { ...prev }; delete n[u.id]; return n })} className="text-slate-500 hover:text-slate-300"><X size={12} /></button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => setEditingTokens((prev) => ({ ...prev, [u.id]: u.tokensBalance }))}
                                className="group flex items-center gap-1 font-mono text-slate-300 hover:text-slate-100"
                              >
                                {u.tokensBalance.toLocaleString()}
                                <Pencil size={10} className="opacity-0 group-hover:opacity-100 text-slate-500" />
                              </button>
                              {u.hasLicense && (
                                <span title="License-based balance" className="text-indigo-400">
                                  <KeyRound size={10} />
                                </span>
                              )}
                            </div>
                          )}
                        </td>

                        <td className="px-4 py-3">
                          <select
                            value={u.tier}
                            onChange={(e) => void updateTier(u.id, e.target.value)}
                            className={cn('rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-medium capitalize', TIER_COLORS[u.tier] ?? 'text-slate-300')}
                          >
                            {['free', 'business', 'enterprise'].map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </td>

                        <td className="px-4 py-3">
                          {u.emailVerified
                            ? <CheckCircle size={14} className="text-emerald-400" />
                            : <XCircle size={14} className="text-slate-600" />}
                        </td>

                        <td className="px-4 py-3 text-slate-500">
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                      </tr>

                      {/* Expandable license rows */}
                      {isExpanded && <LicenseRows key={`lic-${u.id}`} userId={u.id} />}
                    </>
                  )
                })}
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
                        {log.resourceType && (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-500">{log.resourceType}</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        {log.resourceId && `Resource: ${log.resourceId.slice(0, 8)}…`}
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

function StatCard({ icon: Icon, label, value, color = 'text-slate-100' }: {
  icon: typeof Users; label: string; value: number; color?: string
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex items-center gap-2 text-xs text-slate-500"><Icon size={14} />{label}</div>
      <p className={cn('mt-2 text-2xl font-bold', color)}>{value.toLocaleString()}</p>
    </div>
  )
}
