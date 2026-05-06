import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { KeyRound, ChevronRight, Clock } from 'lucide-react'
import { apiGet } from '@/lib/api'
import type { PortalLicense } from '@/hooks/useAuth'
import { formatDistanceToNow } from 'date-fns'

function statusBadge(status: string) {
  switch (status) {
    case 'active': return <span className="badge-green">Active</span>
    case 'inactive': return <span className="badge-yellow">Inactive</span>
    case 'revoked': return <span className="badge-red">Revoked</span>
    default: return <span className="badge-slate">{status}</span>
  }
}

export function LicensesPage() {
  const { data: licenses = [], isLoading } = useQuery({
    queryKey: ['licenses'],
    queryFn: () => apiGet<PortalLicense[]>('/v1/licenses'),
  })

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-32 bg-slate-800 rounded" />
        {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-slate-800 rounded-xl" />)}
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white">Licenses</h1>
        <p className="text-sm text-slate-400 mt-1">{licenses.length} license{licenses.length !== 1 ? 's' : ''} on your account</p>
      </div>

      {licenses.length === 0 ? (
        <div className="card text-center py-12">
          <KeyRound size={36} className="mx-auto text-slate-600 mb-4" />
          <p className="text-slate-300 font-medium">No licenses found</p>
          <p className="text-sm text-slate-500 mt-2">Your free license should appear here after registration.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {licenses.map((license) => (
            <Link
              key={license.id}
              to={`/licenses/${license.id}`}
              className="card flex items-center gap-4 hover:border-slate-700 hover:bg-slate-800/60 transition-all"
            >
              <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
                <KeyRound size={16} className="text-slate-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-sm text-slate-200 truncate">{license.key}</span>
                  {statusBadge(license.status)}
                  <span className="badge-blue capitalize">{license.tier}</span>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  {license.activatedAt
                    ? <span>Activated {formatDistanceToNow(new Date(license.activatedAt), { addSuffix: true })}</span>
                    : <span>Not yet activated</span>
                  }
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
  )
}
