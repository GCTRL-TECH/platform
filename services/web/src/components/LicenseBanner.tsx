import { useEffect, useState, useCallback } from 'react'
import { X, RefreshCw, Copy, Check } from 'lucide-react'
import { cn, agentHealthUrl } from '@/lib/utils'

interface AgentStatus {
  activated: boolean
  valid: boolean
  tier: string
  balance: number
  updateAvailable: boolean
  updateRequired: boolean
  latestVersion: string
}

interface ProgressLine {
  step: string
  message: string
  image?: string
  container?: string
}

const MANUAL_COMMAND = 'curl -fsSL https://gctrl.tech/update | bash'

export function UpdateModal({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<ProgressLine[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [manualCommand, setManualCommand] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const es = new EventSource('/api/update', { withCredentials: true })

    es.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data) as ProgressLine
      setLines((prev) => {
        // Collapse repeated pull progress lines into the last entry for the same image
        if (data.step === 'pull' && prev.length > 0) {
          const last = prev[prev.length - 1]!
          if (last.step === 'pull' && last.image === data.image) {
            return [...prev.slice(0, -1), data]
          }
        }
        return [...prev, data]
      })
    })

    es.addEventListener('done', () => {
      setDone(true)
      es.close()
      setTimeout(() => window.location.reload(), 4000)
    })

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { message?: string; manualCommand?: string }
        setError(data.message ?? 'Update failed')
        if (data.manualCommand) setManualCommand(data.manualCommand)
      } catch {
        setError('Update failed — run manually')
        setManualCommand(MANUAL_COMMAND)
      }
      es.close()
    })

    // If EventSource itself errors (e.g. 503 no socket)
    es.onerror = () => {
      if (!done && !error) {
        setError('Could not reach update service')
        setManualCommand(MANUAL_COMMAND)
        es.close()
      }
    }

    return () => es.close()
  }, [])

  function copyCommand() {
    void navigator.clipboard.writeText(manualCommand || MANUAL_COMMAND)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <RefreshCw size={15} className={cn('text-blue-400', !done && !error && 'animate-spin')} />
            <span className="text-sm font-semibold text-slate-200">
              {done ? 'Update complete' : error ? 'Update failed' : 'Updating GCTRL…'}
            </span>
          </div>
          {(done || error) && (
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
              <X size={16} />
            </button>
          )}
        </div>

        {/* Progress log */}
        <div className="max-h-64 overflow-y-auto px-5 py-3 font-mono text-[11px] text-slate-400 space-y-0.5">
          {lines.map((line, i) => (
            <div key={i} className={cn(
              line.step === 'pulled' || line.step === 'restarted' ? 'text-emerald-400' : 'text-slate-400'
            )}>
              {line.message}
            </div>
          ))}
          {lines.length === 0 && !error && (
            <div className="text-slate-500">Connecting to update service…</div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 px-5 py-4">
          {done && (
            <p className="text-sm text-emerald-400 text-center">
              Reloading in a moment…
            </p>
          )}
          {error && (
            <div className="space-y-3">
              <p className="text-sm text-red-400">{error}</p>
              <p className="text-xs text-slate-500">Run this command on your server to update manually:</p>
              <div className="flex items-center gap-2 rounded-md bg-slate-950 px-3 py-2">
                <code className="flex-1 text-[11px] text-slate-300 break-all">{manualCommand || MANUAL_COMMAND}</code>
                <button
                  onClick={copyCommand}
                  className="shrink-0 text-slate-500 hover:text-slate-200"
                  title="Copy"
                >
                  {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function LicenseBanner() {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [showModal, setShowModal] = useState(false)

  const fetchStatus = useCallback(() => {
    fetch(`${agentHealthUrl()}/status`)
      .then((r) => r.json())
      .then((d) => setStatus(d as AgentStatus))
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  if (!status) return null

  return (
    <>
      {showModal && <UpdateModal onClose={() => setShowModal(false)} />}

      {status.updateRequired && (
        <div className="flex items-center justify-center gap-3 bg-red-600 px-4 py-2 text-sm text-white">
          <span>
            Required update (v{status.latestVersion}) — operations are blocked until updated.
          </span>
          <button
            onClick={() => setShowModal(true)}
            className="rounded bg-red-800 px-2 py-0.5 text-xs font-medium hover:bg-red-700"
          >
            Update now
          </button>
          <span className="text-red-200">or:</span>
          <code className="rounded bg-red-800 px-1.5 py-0.5 text-xs">{MANUAL_COMMAND}</code>
        </div>
      )}

      {!status.updateRequired && status.updateAvailable && (
        <div className="flex items-center justify-center gap-3 bg-yellow-500 px-4 py-2 text-sm text-black">
          <span>Update available — v{status.latestVersion}</span>
          <button
            onClick={() => setShowModal(true)}
            className="rounded bg-yellow-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-yellow-600"
          >
            Update now
          </button>
        </div>
      )}

      {!status.updateRequired && !status.updateAvailable && status.balance <= 0 && status.tier === 'free' && (
        <div className="flex items-center justify-center gap-2 bg-orange-500 px-4 py-2 text-sm text-white">
          <span>Tokens exhausted.</span>
          <a
            href="https://gctrl.tech/billing"
            className="font-medium underline"
            target="_blank"
            rel="noreferrer"
          >
            Top up at gctrl.tech
          </a>
        </div>
      )}
    </>
  )
}

export function useLicenseStatus() {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchStatus = useCallback(() => {
    fetch(`${agentHealthUrl()}/status`)
      .then((r) => r.json())
      .then((d) => {
        setStatus(d as AgentStatus)
        setLoading(false)
      })
      .catch(() => {
        setStatus(null)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 60 * 1000) // poll every 60s
    return () => clearInterval(interval)
  }, [fetchStatus])

  return { status, loading, refetch: fetchStatus }
}
