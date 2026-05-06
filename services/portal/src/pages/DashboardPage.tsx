import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { KeyRound, Cpu, CreditCard, ChevronRight, Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react'
import { apiGet } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import type { PortalLicense } from '@/hooks/useAuth'
import { formatDistanceToNow } from 'date-fns'

interface MeResponse {
  user: { id: string; email: string; role: string; tier: string; creditsBalance: number }
  licenses: PortalLicense[]
}

function statusBadge(status: string) {
  switch (status) {
    case 'active': return <span className="badge-green">Active</span>
    case 'inactive': return <span className="badge-yellow">Inactive</span>
    case 'revoked': return <span className="badge-red">Revoked</span>
    default: return <span className="badge-slate">{status}</span>
  }
}

function statusIcon(status: string) {
  switch (status) {
    case 'active': return <CheckCircle size={14} className="text-emerald-400" />
    case 'inactive': return <AlertCircle size={14} className="text-amber-400" />
    case 'revoked': return <XCircle size={14} className="text-red-400" />
    default: return <AlertCircle size={14} className="text-slate-400" />
  }
}

export function DashboardPage() {
  const { user } = useAuth()

  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => apiGet<MeResponse>('/v1/me'),
  })

  const licenses = data?.licenses ?? []
  const activeLicenses = licenses.filter((l) => l.status === 'active').length

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-slate-800 rounded" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <div key={i} className="h-28 bg-slate-800 rounded-xl" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-sm text-slate-400 mt-1">Welcome back, {user?.email}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
            <KeyRound size={18} className="text-blue-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{licenses.length}</p>
            <p className="text-xs text-slate-400">Total licenses</p>
          </div>
        </div>
        <div className="card flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <Cpu size={18} className="text-emerald-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{activeLicenses}</p>
            <p className="text-xs text-slate-400">Active installs</p>
          </div>
        </div>
        <div className="card flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <CreditCard size={18} className="text-amber-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{(data?.user.creditsBalance ?? 0).toLocaleString()}</p>
            <p className="text-xs text-slate-400">Credits remaining</p>
          </div>
        </div>
      </div>

      {/* License list */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-white">Your licenses</h2>
          <Link to="/licenses" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
            View all <ChevronRight size={14} />
          </Link>
        </div>

        {licenses.length === 0 ? (
          <div className="card text-center py-10">
            <KeyRound size={32} className="mx-auto text-slate-600 mb-3" />
            <p className="text-slate-400">No licenses yet.</p>
            <p className="text-sm text-slate-500 mt-1">Contact support to request a license.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {licenses.slice(0, 5).map((license) => (
              <Link
                key={license.id}
                to={`/licenses/${license.id}`}
                className="card flex items-center gap-4 hover:border-slate-700 hover:bg-slate-800/60 transition-all cursor-pointer"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {statusIcon(license.status)}
                    <span className="font-mono text-sm text-slate-200 truncate">{license.key}</span>
                    {statusBadge(license.status)}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-slate-500">
                    <span className="capitalize">{license.tier}</span>
                    {license.lastHeartbeatAt && (
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        Last seen {formatDistanceToNow(new Date(license.lastHeartbeatAt), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight size={16} className="text-slate-600 shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
