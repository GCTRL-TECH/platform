import { useState, useRef, useEffect } from 'react'
import { X, AlertTriangle, Loader2, Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getToken } from '@/lib/auth'

interface Props {
  onClose: () => void
  /** Pre-fill the embedding model to use for reindex (from active runtime). */
  embeddingModel?: string
  embeddingProvider?: string
  embeddingBase?: string
}

type Phase = 'confirm' | 'streaming' | 'done' | 'error'

const CONFIRM_TEXT = 'REINDEX'

/**
 * Double-opt-in modal for the /api/infra/reindex SSE endpoint.
 * Gate: checkbox + typed "REINDEX" — both required before the button enables.
 * Streams progress steps via the SSE parser (same frame format as LicenseBanner UpdateModal).
 */
export function AdvancedEmbeddingModal({ onClose, embeddingModel = '', embeddingProvider = '', embeddingBase = '' }: Props) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [checked, setChecked] = useState(false)
  const [typed, setTyped] = useState('')
  const [steps, setSteps] = useState<string[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const stepsEndRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll the step log
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [steps])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
    }
  }, [])

  const canConfirm = checked && typed === CONFIRM_TEXT

  async function startReindex() {
    if (!canConfirm) return
    setPhase('streaming')
    setSteps([])
    setErrorMsg('')

    const controller = new AbortController()
    controllerRef.current = controller

    try {
      const token = getToken()
      const resp = await fetch('/api/infra/reindex', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          confirm: true,
          confirm_text: CONFIRM_TEXT,
          embedding_model: embeddingModel,
          embedding_base: embeddingBase || undefined,
          embedding_provider: embeddingProvider || undefined,
        }),
        signal: controller.signal,
      })

      if (!resp.ok || !resp.body) {
        setErrorMsg(resp.status === 401 ? 'Not authorized.' : `Server returned ${resp.status}`)
        setPhase('error')
        return
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // SSE frame parser — same logic as LicenseBanner UpdateModal
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
            return
          } else if (eventType === 'error') {
            try {
              const parsed = JSON.parse(dataStr) as { message?: string }
              setErrorMsg(parsed.message ?? 'Reindex failed')
            } catch {
              setErrorMsg(dataStr || 'Reindex failed')
            }
            setPhase('error')
            controller.abort()
            return
          }
        }
      }
      // Stream ended without done event
      if (phase !== 'done') {
        setPhase('done') // treat clean end as done
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setErrorMsg('Connection lost during reindex')
        setPhase('error')
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">Re-embed All Knowledge Bases</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Warning banner — always visible */}
          <div className="flex items-start gap-3 rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="text-xs text-amber-200/90 space-y-1">
              <p className="font-medium text-amber-300">This operation re-embeds every document in every knowledge base.</p>
              <p className="text-amber-200/70">
                Vector search will be degraded while re-indexing runs. Depending on the number of
                documents this can take minutes to hours. It cannot be undone mid-flight — wait for
                completion before restarting the service.
              </p>
            </div>
          </div>

          {phase === 'confirm' && (
            <>
              <div className="space-y-3">
                {/* Step 1 — checkbox */}
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-800 accent-indigo-500"
                  />
                  <span className="text-sm text-slate-300">
                    I understand this will re-index <strong className="text-slate-100">all</strong> knowledge
                    bases and that search quality will be temporarily degraded during the process.
                  </span>
                </label>

                {/* Step 2 — type confirmation */}
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium text-slate-400">
                    Type <span className="font-mono font-semibold text-slate-200">{CONFIRM_TEXT}</span> to confirm
                  </label>
                  <input
                    type="text"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={CONFIRM_TEXT}
                    className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-1.5 font-mono text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={onClose}
                  className="rounded-md px-4 py-1.5 text-sm text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void startReindex()}
                  disabled={!canConfirm}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-40',
                    canConfirm
                      ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                      : 'bg-slate-800 text-slate-500',
                  )}
                >
                  Start Re-embedding
                  <ChevronRight size={14} />
                </button>
              </div>
            </>
          )}

          {phase === 'streaming' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <Loader2 size={14} className="animate-spin text-indigo-400" />
                Re-indexing in progress — do not close or restart GCTRL…
              </div>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-1">
                {steps.map((step, i) => (
                  <p key={i} className="text-[11px] font-mono text-slate-400">{step}</p>
                ))}
                {steps.length === 0 && (
                  <p className="text-[11px] text-slate-600">Waiting for first step…</p>
                )}
                <div ref={stepsEndRef} />
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-4 py-3">
                <Check size={15} className="text-emerald-400" />
                <p className="text-sm text-emerald-300">Re-indexing complete. All knowledge bases are up to date.</p>
              </div>
              {steps.length > 0 && (
                <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-1">
                  {steps.map((step, i) => (
                    <p key={i} className="text-[11px] font-mono text-slate-400">{step}</p>
                  ))}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-3">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-400" />
                <div className="text-sm text-red-300">
                  <p className="font-medium">Re-indexing failed</p>
                  {errorMsg && <p className="mt-1 text-xs text-red-400/80">{errorMsg}</p>}
                </div>
              </div>
              {steps.length > 0 && (
                <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-1">
                  {steps.map((step, i) => (
                    <p key={i} className="text-[11px] font-mono text-slate-400">{step}</p>
                  ))}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="rounded-md border border-slate-700 bg-slate-800 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
