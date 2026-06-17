import { useEffect, useRef, useState } from 'react'
import { Loader2, Download, AlertTriangle, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface ModelStatus {
  state: string // starting | downloading | loading | ready | retrying | error
  progress?: number
  attempt?: number
  detail?: string
}

/**
 * First-run notice for the extraction engine. On a fresh install the KEX worker
 * downloads an essential model component (~1.5 GB) before it can extract. We poll
 * /api/kex/model-status and show progress; a stalled download retries itself, and
 * we surface a restart hint only on a hard failure. Renders nothing once ready.
 * (Deliberately does not name the underlying model.)
 */
export function KexEngineBanner() {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const stop = () => { if (timer.current) { window.clearInterval(timer.current); timer.current = null } }
    const poll = async () => {
      try {
        const { data } = await api.get('/kex/model-status')
        if (cancelled) return
        setStatus(data as ModelStatus)
        if ((data as ModelStatus)?.state === 'ready') stop()
      } catch { /* keep polling — KEX may still be booting */ }
    }
    void poll()
    timer.current = window.setInterval(poll, 3000)
    return () => { cancelled = true; stop() }
  }, [])

  if (!status || status.state === 'ready') return null

  const pct = Math.max(0, Math.min(100, Math.round(status.progress ?? 0)))
  const error = status.state === 'error'
  const retrying = status.state === 'retrying'
  const loading = status.state === 'loading'

  const title = error
    ? 'Extraction engine failed to initialise'
    : retrying
      ? 'Download interrupted — retrying automatically…'
      : loading
        ? 'Almost ready — starting the extraction engine…'
        : 'Setting up the extraction engine'

  const subtitle = error
    ? 'An essential component could not be downloaded. Restart the KEX service to try again — it resumes where it left off.'
    : 'Downloading an essential component — a one-time ~1.5 GB setup. Extraction becomes available as soon as this finishes; you can keep using the rest of GCTRL meanwhile.'

  return (
    <div
      className={cn(
        'mb-4 rounded-xl border p-4',
        error ? 'border-red-900/50 bg-red-950/30' : 'border-indigo-800/60 bg-indigo-950/30',
      )}
    >
      <div className="flex items-center gap-2">
        {error ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
        ) : retrying ? (
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-amber-400" />
        ) : loading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-indigo-400" />
        ) : (
          <Download className="h-4 w-4 shrink-0 text-indigo-400" />
        )}
        <span className={cn('text-sm font-medium', error ? 'text-red-200' : 'text-slate-100')}>{title}</span>
        {!error && !loading && <span className="ml-auto text-xs tabular-nums text-slate-400">{pct}%</span>}
      </div>
      <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
      {!error && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-700',
              retrying ? 'bg-amber-400' : 'bg-indigo-500',
              loading && 'animate-pulse',
            )}
            style={{ width: loading ? '100%' : `${pct}%` }}
          />
        </div>
      )}
      {error && (
        <p className="mt-2 font-mono text-[11px] text-slate-500">
          On the host: <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">docker restart gctrl-kex</code>
        </p>
      )}
    </div>
  )
}
