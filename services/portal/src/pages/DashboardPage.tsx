import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { KeyRound, Cpu, CreditCard, ChevronRight, Clock, CheckCircle, XCircle, AlertCircle, Plus, Copy, Check, X } from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
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

function GenerateLicenseModal({ onClose, onGenerated }: { onClose: () => void; onGenerated: (key: string) => void }) {
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => apiPost<{ key: string }>('/v1/licenses', {}),
    onSuccess: (data) => {
      setNewKey(data.key)
      void queryClient.invalidateQueries({ queryKey: ['me'] })
      onGenerated(data.key)
    },
  })

  function copyKey() {
    if (newKey) {
      void navigator.clipboard.writeText(newKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">New License</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>

        {!newKey ? (
          <>
            <p className="text-sm text-slate-400">Generate a new free-tier license key. You can use it to install GCTRL on another machine.</p>
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="btn-primary w-full justify-center"
            >
              {mutation.isPending ? 'Generating...' : <><Plus size={14} /> Generate License Key</>}
            </button>
            {mutation.isError && (
              <p className="text-xs text-red-400">Failed to generate key. Try again.</p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-slate-400">Your new license key:</p>
            <div className="flex items-center gap-2 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2">
              <code className="flex-1 font-mono text-sm text-emerald-300">{newKey}</code>
              <button onClick={copyKey} className="shrink-0 text-slate-500 hover:text-slate-200">
                {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-xs text-slate-500">Use this key during installation: <code className="text-slate-400">http://localhost:3001</code></p>
            <button onClick={onClose} className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2 text-sm text-slate-300 hover:bg-slate-700">Done</button>
          </>
        )}
      </div>
    </div>
  )
}

export function DashboardPage() {
  const { user } = useAuth()
  const [showGenerate, setShowGenerate] = useState(false)

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
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowGenerate(true)}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              <Plus size={13} /> New license
            </button>
            <Link to="/licenses" className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1">
              View all <ChevronRight size={14} />
            </Link>
          </div>
        </div>

        {licenses.length === 0 ? (
          <div className="card text-center py-10">
            <KeyRound size={32} className="mx-auto text-slate-600 mb-3" />
            <p className="text-slate-400">No licenses yet.</p>
            <button onClick={() => setShowGenerate(true)} className="mt-3 text-sm text-blue-400 hover:text-blue-300">
              Generate your first license →
            </button>
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

      {showGenerate && (
        <GenerateLicenseModal
          onClose={() => setShowGenerate(false)}
          onGenerated={() => setShowGenerate(false)}
        />
      )}
    </div>
  )
}
