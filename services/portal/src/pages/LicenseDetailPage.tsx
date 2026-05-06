import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Clock, Terminal, Copy, CheckCircle } from 'lucide-react'
import { useState } from 'react'
import { apiGet } from '@/lib/api'
import type { PortalLicense } from '@/hooks/useAuth'
import { formatDistanceToNow, format } from 'date-fns'

interface UsageDay {
  day: string
  totalCredits: number
  totalChars: number
  operations: number
}

interface UsageResponse {
  licenseId: string
  days: UsageDay[]
}

function statusBadge(status: string) {
  switch (status) {
    case 'active': return <span className="badge-green">Active</span>
    case 'inactive': return <span className="badge-yellow">Inactive</span>
    case 'revoked': return <span className="badge-red">Revoked</span>
    default: return <span className="badge-slate">{status}</span>
  }
}

function UsageChart({ days }: { days: UsageDay[] }) {
  if (days.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-slate-500">
        No usage in the last 30 days
      </div>
    )
  }

  const max = Math.max(...days.map((d) => d.totalCredits), 1)

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-1 h-32">
        {days.map((d) => {
          const height = Math.max((d.totalCredits / max) * 100, 2)
          return (
            <div
              key={d.day}
              className="relative flex-1 group"
            >
              <div
                className="w-full bg-blue-500/70 rounded-t hover:bg-blue-400/90 transition-colors cursor-default"
                style={{ height: `${height}%` }}
              />
              {/* Tooltip */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                <p className="font-medium">{format(new Date(d.day), 'MMM d')}</p>
                <p>{d.totalCredits.toLocaleString()} credits</p>
                <p>{d.operations} ops</p>
              </div>
            </div>
          )
        })}
      </div>
      {/* X-axis labels (sparse) */}
      <div className="flex justify-between text-xs text-slate-600">
        <span>{days[0] ? format(new Date(days[0].day), 'MMM d') : ''}</span>
        <span>{days[Math.floor(days.length / 2)] ? format(new Date(days[Math.floor(days.length / 2)]!.day), 'MMM d') : ''}</span>
        <span>{days[days.length - 1] ? format(new Date(days[days.length - 1]!.day), 'MMM d') : ''}</span>
      </div>
    </div>
  )
}

export function LicenseDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [copied, setCopied] = useState(false)

  const { data: licenses = [] } = useQuery({
    queryKey: ['licenses'],
    queryFn: () => apiGet<PortalLicense[]>('/v1/licenses'),
  })

  const { data: usage, isLoading: usageLoading } = useQuery({
    queryKey: ['license-usage', id],
    queryFn: () => apiGet<UsageResponse>(`/v1/licenses/${id}/usage`),
    enabled: !!id,
  })

  const license = licenses.find((l) => l.id === id)

  const installCommand = `curl -fsSL https://gctrl.tech/install | bash -s -- --key ${license?.key ?? '<your-key>'}`

  function copyInstall() {
    navigator.clipboard.writeText(installCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const totalCredits = usage?.days.reduce((sum, d) => sum + d.totalCredits, 0) ?? 0
  const totalOps = usage?.days.reduce((sum, d) => sum + d.operations, 0) ?? 0

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Link to="/licenses" className="btn-ghost p-2">
          <ArrowLeft size={16} />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-white">License Detail</h1>
          {license && (
            <p className="text-xs text-slate-500 font-mono mt-0.5">{license.key}</p>
          )}
        </div>
      </div>

      {license && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300">License info</h2>
            <div className="flex items-center gap-2">
              {statusBadge(license.status)}
              <span className="badge-blue capitalize">{license.tier}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-slate-500 text-xs mb-1">License key</p>
              <p className="font-mono text-slate-200 text-xs break-all">{license.key}</p>
            </div>
            <div>
              <p className="text-slate-500 text-xs mb-1">Status</p>
              <p className="text-slate-200 capitalize">{license.status}</p>
            </div>
            <div>
              <p className="text-slate-500 text-xs mb-1">Last heartbeat</p>
              <p className="text-slate-200 flex items-center gap-1">
                {license.lastHeartbeatAt
                  ? <><Clock size={12} /> {formatDistanceToNow(new Date(license.lastHeartbeatAt), { addSuffix: true })}</>
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-slate-500 text-xs mb-1">Activated</p>
              <p className="text-slate-200">
                {license.activatedAt
                  ? format(new Date(license.activatedAt), 'PPP')
                  : 'Not yet activated'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Install command */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <Terminal size={14} />
          Install command
        </h2>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs">
          <span className="flex-1 text-slate-300 break-all">{installCommand}</span>
          <button
            onClick={copyInstall}
            className="shrink-0 p-1.5 text-slate-500 hover:text-slate-200 transition-colors"
            title="Copy"
          >
            {copied ? <CheckCircle size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
        </div>
        <p className="text-xs text-slate-500">Run this on your Linux machine with Docker installed.</p>
      </div>

      {/* Usage chart */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">Usage — last 30 days</h2>
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <span><span className="text-white font-medium">{totalCredits.toLocaleString()}</span> credits</span>
            <span><span className="text-white font-medium">{totalOps}</span> operations</span>
          </div>
        </div>

        {usageLoading ? (
          <div className="h-32 bg-slate-800 rounded animate-pulse" />
        ) : (
          <UsageChart days={usage?.days ?? []} />
        )}
      </div>
    </div>
  )
}
