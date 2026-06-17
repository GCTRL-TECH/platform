import { useEffect, useState, useCallback, useRef } from 'react'
import { X, RefreshCw, Copy, Check } from 'lucide-react'
import { cn, agentHealthUrl } from '@/lib/utils'
import { getToken } from '@/lib/auth'

export interface AgentStatus {
  activated: boolean
  valid: boolean
  tier: string
  balance: number
  updateAvailable: boolean
  updateRequired: boolean
  latestVersion: string
  currentVersion?: string
}

interface ProgressLine {
  step: string
  message: string
  image?: string
  container?: string
}

const MANUAL_COMMAND = 'curl -fsSL https://gctrl.tech/update | bash'

// How long to wait for the first SSE event before declaring the connection stalled.
const STALL_TIMEOUT_MS = 25_000

/**
 * UpdateModal state machine:
 *   connecting → pulling → restarting → done
 *                                     ↘ error  (from any prior state)
 *
 * - connecting: SSE opened, no progress event yet. A stall timer is armed; if no
 *   progress/done/error arrives within STALL_TIMEOUT_MS we flip to `error`.
 * - pulling:    at least one `pull`/`pulled` progress event seen.
 * - restarting: a `restart`/`restarted` progress event seen.
 * - done:       `done` event — auto-reloads after a short delay.
 * - error:      explicit error event, transport onerror, or stall timeout. Always
 *               offers the manual command + a Retry button. Never shown while still
 *               legitimately connecting.
 */
type UpdatePhase = 'connecting' | 'pulling' | 'restarting' | 'done' | 'error'

function phaseFromStep(step: string): UpdatePhase | null {
  if (step === 'pull' || step === 'pulled') return 'pulling'
  if (step === 'restart' || step === 'restarting' || step === 'restarted') return 'restarting'
  return null
}

const PHASE_LABEL: Record<UpdatePhase, string> = {
  connecting: 'Connecting to update service…',
  pulling: 'Pulling new images…',
  restarting: 'Restarting services…',
  done: 'Update complete',
  error: 'Update failed',
}

export function UpdateModal({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<ProgressLine[]>([])
  const [phase, setPhase] = useState<UpdatePhase>('connecting')
  const [error, setError] = useState('')
  const [manualCommand, setManualCommand] = useState('')
  const [copied, setCopied] = useState(false)
  // Bumping this re-runs the SSE effect for the Retry button.
  const [attempt, setAttempt] = useState(0)

  // Live refs so async SSE callbacks read current phase without re-subscribing.
  const phaseRef = useRef<UpdatePhase>('connecting')
  phaseRef.current = phase

  useEffect(() => {
    setLines([])
    setError('')
    setManualCommand('')
    setPhase('connecting')
    phaseRef.current = 'connecting'

    // NOTE: this used to use EventSource, but `/api/update` is behind require_auth
    // and EventSource cannot send an `Authorization: Bearer` header — so the SSE
    // request was unauthenticated → 401 → "Could not reach update service". We
    // stream via fetch (which CAN send the token) and parse SSE frames by hand,
    // the same pattern AgentProvider uses for the agent chat stream.
    const controller = new AbortController()
    let closed = false

    const fail = (message: string, cmd?: string) => {
      if (closed) return
      if (phaseRef.current === 'done') return // never override terminal success
      closed = true
      window.clearTimeout(stallTimer)
      setError(message)
      setManualCommand(cmd ?? MANUAL_COMMAND)
      setPhase('error')
      controller.abort()
    }

    // Stall guard: no event at all within the window → treat as unreachable.
    const stallTimer = window.setTimeout(() => {
      fail('Update service did not respond. It may be unreachable or stalled.')
    }, STALL_TIMEOUT_MS)

    const advance = (next: UpdatePhase) => {
      setPhase((prev) => {
        if (prev === 'done' || prev === 'error') return prev
        if (prev === 'restarting' && next === 'pulling') return prev
        return next
      })
    }

    const dispatch = (eventType: string, dataStr: string) => {
      if (eventType === 'progress') {
        window.clearTimeout(stallTimer) // first byte of life
        let data: ProgressLine
        try { data = JSON.parse(dataStr) as ProgressLine } catch { return }
        const next = phaseFromStep(data.step)
        if (next) advance(next)
        else if (phaseRef.current === 'connecting') advance('pulling')
        setLines((prev) => {
          if (data.step === 'pull' && prev.length > 0) {
            const last = prev[prev.length - 1]!
            if (last.step === 'pull' && last.image === data.image) {
              return [...prev.slice(0, -1), data]
            }
          }
          return [...prev, data]
        })
      } else if (eventType === 'done') {
        window.clearTimeout(stallTimer)
        closed = true
        setPhase('done')
        phaseRef.current = 'done'
        controller.abort()
        setTimeout(() => window.location.reload(), 4000)
      } else if (eventType === 'error') {
        try {
          const data = JSON.parse(dataStr) as { message?: string; manualCommand?: string }
          fail(data.message ?? 'Update failed', data.manualCommand)
        } catch {
          fail('Update failed — run manually')
        }
      }
    }

    void (async () => {
      try {
        const token = getToken()
        const resp = await fetch('/api/update', {
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          signal: controller.signal,
        })
        if (!resp.ok || !resp.body) {
          fail(resp.status === 401
            ? 'Not authorized to run the update (please sign in again).'
            : 'Could not reach update service')
          return
        }
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        // SSE frames are separated by a blank line; each frame has `event:` +
        // `data:` lines (and `:`-prefixed keep-alive comments we skip).
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let sep: number
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            let eventType = 'message'
            const dataLines: string[] = []
            for (const rawLine of frame.split('\n')) {
              const line = rawLine.replace(/\r$/, '')
              if (line.startsWith(':')) continue
              if (line.startsWith('event:')) eventType = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
            }
            if (eventType !== 'message' || dataLines.length) dispatch(eventType, dataLines.join('\n'))
          }
        }
        // Stream ended without a terminal `done` → surface it (the api restarts
        // itself AFTER `done`, so a clean end always has `done` first).
        if (!closed && phaseRef.current !== 'done') {
          fail('Update stream ended before completing.')
        }
      } catch (e) {
        if (!controller.signal.aborted) fail('Could not reach update service')
      }
    })()

    return () => {
      closed = true
      window.clearTimeout(stallTimer)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  function copyCommand() {
    void navigator.clipboard.writeText(manualCommand || MANUAL_COMMAND)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const done = phase === 'done'
  const isError = phase === 'error'
  const closable = done || isError

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <RefreshCw size={15} className={cn('text-blue-400', !done && !isError && 'animate-spin')} />
            <span className="text-sm font-semibold text-slate-200">
              {done ? 'Update complete' : isError ? 'Update failed' : 'Updating GCTRL…'}
            </span>
          </div>
          {closable && (
            <button onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-slate-300">
              <X size={16} />
            </button>
          )}
        </div>

        {/* Phase indicator (hidden once terminal) */}
        {!closable && (
          <div className="px-5 pt-3 text-xs font-medium text-slate-300">
            {PHASE_LABEL[phase]}
          </div>
        )}

        {/* Progress log */}
        <div className="max-h-64 overflow-y-auto px-5 py-3 font-mono text-[11px] text-slate-400 space-y-0.5">
          {lines.map((line, i) => (
            <div key={i} className={cn(
              line.step === 'pulled' || line.step === 'restarted' ? 'text-emerald-400' : 'text-slate-400'
            )}>
              {line.message}
            </div>
          ))}
          {lines.length === 0 && !isError && (
            <div className="text-slate-500">{PHASE_LABEL[phase]}</div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 px-5 py-4">
          {done && (
            <p className="text-sm text-emerald-400 text-center">
              Reloading in a moment…
            </p>
          )}
          {isError && (
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
              <button
                onClick={() => setAttempt((n) => n + 1)}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
              >
                <RefreshCw size={14} />
                Retry
              </button>
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
