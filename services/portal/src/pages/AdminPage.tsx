import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Users, KeyRound, BarChart3, Tag, AlertTriangle, KeySquare, X, type LucideIcon } from 'lucide-react'
import { apiGet, apiPost, apiPatch } from '@/lib/api'
import { formatDistanceToNow } from 'date-fns'

interface AdminUser {
  id: string
  email: string
  role: string
  tier: string
  creditsBalance: number
  suspended: boolean
  createdAt: string
}

interface AnalyticsSummary {
  totalUsers: number
  activeUsers: number
  totalCreditsSpent: number
}

type Tab = 'users' | 'licenses' | 'versions' | 'analytics'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'licenses', label: 'Issue License', icon: KeyRound },
  { id: 'versions', label: 'Versions', icon: Tag },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
]

const TIERS = ['free', 'starter', 'pro', 'enterprise']

function UsersTab() {
  const qc = useQueryClient()

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => apiGet<AdminUser[]>('/admin/users'),
  })

  const [creditAmounts, setCreditAmounts] = useState<Record<string, string>>({})
  const [pwdInputs, setPwdInputs] = useState<Record<string, string>>({})
  const [pwdOpen, setPwdOpen] = useState<Record<string, boolean>>({})

  const tierMutation = useMutation({
    mutationFn: ({ userId, tier }: { userId: string; tier: string }) =>
      apiPatch(`/admin/users/${userId}/tier`, { tier }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  const suspendMutation = useMutation({
    mutationFn: (userId: string) => apiPatch(`/admin/users/${userId}/suspend`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  const creditsMutation = useMutation({
    mutationFn: ({ userId, amount }: { userId: string; amount: number }) =>
      apiPost(`/admin/users/${userId}/credits`, { amount, reason: 'manual adjustment' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })

  const resetPwdMutation = useMutation({
    mutationFn: ({ userId, password }: { userId: string; password: string }) =>
      apiPost(`/admin/users/${userId}/reset-password`, { password }),
    onSuccess: (_data, { userId }) => {
      setPwdOpen((p) => ({ ...p, [userId]: false }))
      setPwdInputs((p) => ({ ...p, [userId]: '' }))
    },
  })

  if (isLoading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-16 bg-slate-800 rounded animate-pulse" />)}</div>

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800">
            <th className="table-header">Email</th>
            <th className="table-header">Tier</th>
            <th className="table-header">Credits</th>
            <th className="table-header">Status</th>
            <th className="table-header">Joined</th>
            <th className="table-header">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
              <td className="table-cell">
                <span className={u.role === 'admin' ? 'text-blue-300' : ''}>{u.email}</span>
                {u.role === 'admin' && <span className="badge-blue ml-2">admin</span>}
              </td>
              <td className="table-cell">
                <select
                  value={u.tier}
                  onChange={(e) => tierMutation.mutate({ userId: u.id, tier: e.target.value })}
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
                >
                  {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td className="table-cell">
                <div className="flex items-center gap-2">
                  <span>{u.creditsBalance.toLocaleString()}</span>
                  <input
                    type="number"
                    placeholder="±"
                    className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
                    value={creditAmounts[u.id] ?? ''}
                    onChange={(e) => setCreditAmounts((p) => ({ ...p, [u.id]: e.target.value }))}
                  />
                  <button
                    className="text-xs text-blue-400 hover:text-blue-300"
                    onClick={() => {
                      const amount = parseInt(creditAmounts[u.id] ?? '0')
                      if (amount) {
                        creditsMutation.mutate({ userId: u.id, amount })
                        setCreditAmounts((p) => ({ ...p, [u.id]: '' }))
                      }
                    }}
                  >
                    Apply
                  </button>
                </div>
              </td>
              <td className="table-cell">
                {u.suspended
                  ? <span className="badge-red">Suspended</span>
                  : <span className="badge-green">Active</span>
                }
              </td>
              <td className="table-cell text-slate-500 text-xs">
                {formatDistanceToNow(new Date(u.createdAt), { addSuffix: true })}
              </td>
              <td className="table-cell">
                <div className="flex flex-col gap-1.5">
                  {/* Reset password */}
                  {pwdOpen[u.id] ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="password"
                        placeholder="New password"
                        className="w-28 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
                        value={pwdInputs[u.id] ?? ''}
                        onChange={(e) => setPwdInputs((p) => ({ ...p, [u.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const pw = pwdInputs[u.id] ?? ''
                            if (pw.length >= 8) resetPwdMutation.mutate({ userId: u.id, password: pw })
                          }
                        }}
                        autoFocus
                      />
                      <button
                        className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                        disabled={!pwdInputs[u.id] || (pwdInputs[u.id]?.length ?? 0) < 8 || resetPwdMutation.isPending}
                        onClick={() => {
                          const pw = pwdInputs[u.id] ?? ''
                          if (pw.length >= 8) resetPwdMutation.mutate({ userId: u.id, password: pw })
                        }}
                      >
                        Set
                      </button>
                      <button
                        className="text-slate-500 hover:text-slate-300"
                        aria-label="Cancel"
                        onClick={() => setPwdOpen((p) => ({ ...p, [u.id]: false }))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
                      onClick={() => setPwdOpen((p) => ({ ...p, [u.id]: true }))}
                    >
                      <KeySquare size={12} />
                      Reset pwd
                    </button>
                  )}
                  {/* Suspend */}
                  {!u.suspended && u.role !== 'admin' && (
                    <button
                      className="btn-danger text-xs"
                      onClick={() => {
                        if (confirm(`Suspend ${u.email}?`)) suspendMutation.mutate(u.id)
                      }}
                    >
                      <AlertTriangle size={12} />
                      Suspend
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IssueLicenseTab() {
  const qc = useQueryClient()
  const [userId, setUserId] = useState('')
  const [tier, setTier] = useState('free')
  const [result, setResult] = useState<{ key: string } | null>(null)

  const { data: users = [] } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => apiGet<AdminUser[]>('/admin/users'),
  })

  const mutation = useMutation({
    mutationFn: (data: { userId: string; tier: string }) =>
      apiPost<{ licenseKey: string }>('/admin/licenses/issue', data),
    onSuccess: (data) => {
      setResult({ key: data.licenseKey })
      qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })

  return (
    <div className="max-w-sm space-y-4">
      <div>
        <label className="label">User</label>
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="input-field"
        >
          <option value="">Select user…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.email}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Tier</label>
        <select value={tier} onChange={(e) => setTier(e.target.value)} className="input-field">
          {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <button
        className="btn-primary"
        disabled={!userId || mutation.isPending}
        onClick={() => mutation.mutate({ userId, tier })}
      >
        {mutation.isPending ? 'Issuing…' : 'Issue license'}
      </button>
      {result && (
        <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <p className="text-xs text-slate-400 mb-1">New license key:</p>
          <p className="font-mono text-sm text-emerald-300 break-all">{result.key}</p>
        </div>
      )}
    </div>
  )
}

function VersionsTab() {
  const [version, setVersion] = useState('')
  const [channel, setChannel] = useState('stable')
  const [changelog, setChangelog] = useState('')
  const [required, setRequired] = useState(false)
  const [success, setSuccess] = useState(false)

  const mutation = useMutation({
    mutationFn: (data: object) => apiPost('/admin/versions', data),
    onSuccess: () => { setSuccess(true); setTimeout(() => setSuccess(false), 3000) },
  })

  return (
    <div className="max-w-sm space-y-4">
      <div>
        <label className="label">Version (e.g. 1.2.3)</label>
        <input value={version} onChange={(e) => setVersion(e.target.value)} className="input-field" placeholder="1.0.0" />
      </div>
      <div>
        <label className="label">Channel</label>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className="input-field">
          <option value="stable">stable</option>
          <option value="beta">beta</option>
          <option value="dev">dev</option>
        </select>
      </div>
      <div>
        <label className="label">Changelog (optional)</label>
        <textarea
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          className="input-field h-24 resize-none"
          placeholder="What changed in this release…"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
          className="rounded border-slate-700 bg-slate-800 text-blue-500"
        />
        Force update (clients must update before using)
      </label>
      <button
        className="btn-primary"
        disabled={!version || mutation.isPending}
        onClick={() => mutation.mutate({ version, channel, changelog, updateRequired: required, rolloutPercent: 100 })}
      >
        {mutation.isPending ? 'Publishing…' : 'Publish version'}
      </button>
      {success && <p className="text-sm text-emerald-400">Version published successfully.</p>}
    </div>
  )
}

function AnalyticsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-analytics'],
    queryFn: () => apiGet<AnalyticsSummary>('/admin/analytics/summary'),
  })

  if (isLoading) return <div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="h-24 bg-slate-800 rounded-xl animate-pulse" />)}</div>

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {[
        { label: 'Total users', value: data?.totalUsers ?? 0 },
        { label: 'Active users', value: data?.activeUsers ?? 0 },
        { label: 'Total credits spent', value: (data?.totalCreditsSpent ?? 0).toLocaleString() },
      ].map(({ label, value }) => (
        <div key={label} className="card">
          <p className="text-3xl font-bold text-white mb-1">{value}</p>
          <p className="text-sm text-slate-400">{label}</p>
        </div>
      ))}
    </div>
  )
}

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('users')

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white">Admin</h1>
        <p className="text-sm text-slate-400 mt-1">Manage users, licenses, and deployments</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="card">
        {tab === 'users' && <UsersTab />}
        {tab === 'licenses' && <IssueLicenseTab />}
        {tab === 'versions' && <VersionsTab />}
        {tab === 'analytics' && <AnalyticsTab />}
      </div>
    </div>
  )
}
