import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, X } from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'
import { api } from '@/lib/api'

interface GuardrailEvent {
  id: string
  createdAt: string
  kind: string
  detail: Record<string, unknown>
}

interface GuardrailResponse {
  state: {
    consecutiveFailures: number
    lastProbeAt: string | null
    lastError: string | null
    revertedAt: string | null
    revertedFrom: { provider?: string; base_url?: string | null; model?: string | null } | null
  }
  events: GuardrailEvent[]
}

function describeEvent(e: GuardrailEvent): string {
  if (e.kind === 'runtime_reverted') {
    const reason = typeof e.detail.reason === 'string' ? e.detail.reason : 'repeated failures'
    const from = e.detail.from as { provider?: string; model?: string } | undefined
    const src = from?.provider ? ` (was ${from.provider}${from.model ? ` / ${from.model}` : ''})` : ''
    return `LLM runtime reverted to bundled Ollama after 3 consecutive failures: ${reason}${src}.`
  }
  if (e.kind === 'degraded_jobs') {
    const count = typeof e.detail.count === 'number' ? e.detail.count : 'Several'
    return `${count} extraction job(s) completed in degraded mode (relations skipped) in the last hour.`
  }
  return `Guardrail event: ${e.kind}`
}

/**
 * Global amber banner surfacing guardrail events (auto-reverted runtime,
 * degraded-job spikes) — polls GET /infra/guardrail every 60s. Mounted once in
 * the app shell so it's visible from anywhere. Dismissible per-event.
 */
export function GuardrailBanner() {
  const navigate = useNavigate()
  const [dismissing, setDismissing] = useState<string | null>(null)

  const { data, refetch } = useApiQuery<GuardrailResponse>(
    ['infra', 'guardrail'],
    '/infra/guardrail',
    { refetchInterval: 60_000, retry: false }
  )

  const events = data?.events ?? []
  if (events.length === 0) return null

  async function dismiss(id: string) {
    setDismissing(id)
    try {
      await api.post(`/infra/guardrail/events/${id}/dismiss`)
      await refetch()
    } catch {
      /* non-fatal — will retry on next poll */
    } finally {
      setDismissing(null)
    }
  }

  return (
    <div className="space-y-0.5">
      {events.map((e) => (
        <div
          key={e.id}
          className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-sm text-black"
        >
          <AlertTriangle size={15} className="shrink-0" />
          <span>{describeEvent(e)}</span>
          <button
            onClick={() => navigate('/cookbook')}
            className="rounded bg-amber-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-800"
          >
            Open Cookbook
          </button>
          <button
            onClick={() => void dismiss(e.id)}
            disabled={dismissing === e.id}
            className="ml-1 rounded p-0.5 text-amber-950/70 hover:bg-amber-600 hover:text-black disabled:opacity-50"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
