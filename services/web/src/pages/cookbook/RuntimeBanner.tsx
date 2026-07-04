import { useState, useRef, useEffect } from 'react'
import { Sparkles, Zap, Loader2, Check, AlertTriangle } from 'lucide-react'
import { getToken } from '@/lib/auth'

export interface ActiveRuntimeInfo {
  provider: string
  base_url: string | null
  model: string | null
  configured: boolean
  healthy: boolean
}

export interface RecommendationInfo {
  runtime: string
  model: string
  rationale: string
  speedup_estimate: string
}

interface Props {
  activeRuntime: ActiveRuntimeInfo | null
  recommendation: RecommendationInfo | null
  isAdmin: boolean
  onSwitched?: () => void
}

type Phase = 'idle' | 'streaming' | 'done' | 'error'

/**
 * Indigo "you could be running faster" banner — only rendered when the
 * hardware-based recommendation differs from the currently active runtime.
 * Admins get an inline "Switch now" that streams POST /infra/switch-runtime
 * (same SSE fetch-stream pattern as Settings → Infrastructure); non-admins see
 * the recommendation with a note to ask an admin.
 */
export function RuntimeBanner({ activeRuntime, recommendation, isAdmin, onSwitched }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [steps, setSteps] = useState<string[]>([])
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const stepsEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [steps])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  if (!recommendation || !activeRuntime) return null

  // Only show a banner when the recommendation actually differs from what's
  // running right now — otherwise it's noise ("we recommend what you have").
  const differs =
    recommendation.runtime !== activeRuntime.provider ||
    (activeRuntime.model != null && recommendation.model !== activeRuntime.model)
  if (!differs) return null

  async function handleSwitch() {
    const controller = new AbortController()
    controllerRef.current = controller
    setPhase('streaming')
    setSteps([])
    setError('')

    try {
      const token = getToken()
      const resp = await fetch('/api/infra/switch-runtime', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ runtime: recommendation!.runtime, model: recommendation!.model }),
        signal: controller.signal,
      })

      if (!resp.ok || !resp.body) {
        setError(resp.status === 401 ? 'Not authorized.' : `Server returned ${resp.status}`)
        setPhase('error')
        return
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

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
          const dataStr = dataLines.join('\n')
          if (eventType === 'progress') {
            try {
              const parsed = JSON.parse(dataStr) as { message?: string }
              if (parsed.message) setSteps((s) => [...s, parsed.message!])
            } catch {
              if (dataStr) setSteps((s) => [...s, dataStr])
            }
          } else if (eventType === 'done') {
            setPhase('done')
            controller.abort()
            onSwitched?.()
            return
          } else if (eventType === 'error') {
            try {
              const parsed = JSON.parse(dataStr) as { message?: string }
              setError(parsed.message ?? 'Switch failed')
            } catch {
              setError(dataStr || 'Switch failed')
            }
            setPhase('error')
            controller.abort()
            return
          }
        }
      }
      // Stream closed WITHOUT an explicit `done`/`error` terminal event (W7):
      // proxy cut, server crash mid-switch. Treat as failure — the backend's
      // switch state is unknown, reporting success here would be a lie.
      setError('Stream ended before the switch confirmed — check the active runtime')
      setPhase('error')
    } catch {
      if (!controller.signal.aborted) {
        setError('Connection lost')
        setPhase('error')
      }
    }
  }

  return (
    <div className="rounded-lg border border-indigo-800/40 bg-indigo-950/20 px-4 py-4 space-y-3">
      <div className="flex items-start gap-2">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-violet-400" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-200">
            Your hardware can run faster with{' '}
            <span className="text-indigo-300">{recommendation.runtime}</span>
            {' '}+{' '}
            <span className="font-mono text-cyan-300">{recommendation.model}</span>
          </p>
          <p className="mt-1 text-xs text-slate-400">{recommendation.rationale}</p>
          {recommendation.speedup_estimate && (
            <p className="mt-1 text-[11px] text-violet-300/80">
              Estimated speedup: {recommendation.speedup_estimate} (estimate — actual results vary by workload)
            </p>
          )}
        </div>
      </div>

      {phase === 'streaming' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 size={12} className="animate-spin text-indigo-400" />
            Switching runtime…
          </div>
          <div className="max-h-32 overflow-y-auto rounded border border-slate-800 bg-slate-950 p-2 space-y-0.5">
            {steps.map((s, i) => <p key={i} className="text-[10px] font-mono text-slate-400">{s}</p>)}
            <div ref={stepsEndRef} />
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-900/40 bg-emerald-950/20 px-3 py-2">
          <Check size={12} className="text-emerald-400" />
          <p className="text-xs text-emerald-300">Switched — this recommendation will no longer show.</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2">
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-xs text-red-300">{error || 'Switch failed'}</p>
          </div>
          <button onClick={() => setPhase('idle')} className="text-[11px] text-slate-400 hover:text-slate-200">
            Try again
          </button>
        </div>
      )}

      {(phase === 'idle' || phase === 'error') && (
        isAdmin ? (
          <button
            onClick={() => void handleSwitch()}
            className="flex items-center gap-1.5 rounded-md bg-indigo-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 transition-colors"
          >
            <Zap size={12} />
            Switch now
          </button>
        ) : (
          <p className="text-[11px] text-slate-500">Ask your admin to apply this from the Cookbook.</p>
        )
      )}
    </div>
  )
}
