/**
 * PrivacyDialog — "Private Memory" control for a graph compilation.
 *
 * Three modes, stored on `compilations.privacy_mode` (migration 065):
 *   - open        (default): unchanged — content may reach any configured LLM.
 *   - cloaked:     cloud models see pseudonyms (Person-7, [AMOUNT-2], ...)
 *                  instead of your real entities; answers are restored to
 *                  plain text before you see them.
 *   - local_only:  this graph's content never reaches a cloud model at all —
 *                  a request that would need one is refused outright.
 *
 * Mirrors EmbedShareDialog's session-only PUT pattern (`/kg/compilations/:id`).
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldCheck, ShieldOff, ShieldEllipsis, X, Loader2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export type PrivacyMode = 'open' | 'cloaked' | 'local_only'

interface PrivacyDialogProps {
  open: boolean
  onClose: () => void
  compilationId: string
  compilationName: string
  privacyMode: PrivacyMode
  onPrivacyModeChange: (mode: PrivacyMode) => void
}

const OPTIONS: Array<{ mode: PrivacyMode; label: string; description: string; icon: typeof ShieldCheck }> = [
  {
    mode: 'open',
    label: 'Open',
    description: 'Unchanged — this graph\'s content may reach any model you\'ve configured, local or cloud.',
    icon: ShieldEllipsis,
  },
  {
    mode: 'cloaked',
    label: 'Cloaked',
    description: 'Cloud models see pseudonyms instead of your entities (Person-7, [AMOUNT-2], ...) — the real names never leave this machine. Local models always see plain text.',
    icon: ShieldCheck,
  },
  {
    mode: 'local_only',
    label: 'Local-only',
    description: 'Never leaves this machine — a request that would need a cloud model is refused instead of rerouted. Requires a local model (see Cookbook) to use this graph at all.',
    icon: ShieldOff,
  },
]

export function PrivacyDialog({
  open, onClose, compilationId, compilationName, privacyMode, onPrivacyModeChange,
}: PrivacyDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!open) return null

  async function setMode(mode: PrivacyMode) {
    if (mode === privacyMode) return
    setBusy(true); setError(null)
    try {
      await api.put(`/kg/compilations/${compilationId}`, { privacyMode: mode })
      onPrivacyModeChange(mode)
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to update privacy mode')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-[80] bg-black/60" onClick={onClose} />
      <div className="fixed inset-0 z-[81] flex items-center justify-center p-4">
        <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <ShieldCheck size={15} className="text-indigo-400" /> Privacy — “{compilationName}”
            </h2>
            <button onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200">
              <X size={15} />
            </button>
          </div>

          <div className="max-h-[70vh] overflow-y-auto p-4 space-y-3">
            <p className="text-xs text-slate-400">
              Controls what a CLOUD LLM ever sees when it answers a question grounded in this graph
              (Talk-to-Graph, the Pi agent, and wiki distillation). Local models always see plain text.
            </p>

            {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}

            <div className="space-y-2">
              {OPTIONS.map(({ mode, label, description, icon: Icon }) => {
                const active = privacyMode === mode
                return (
                  <button
                    key={mode}
                    onClick={() => void setMode(mode)}
                    disabled={busy}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                      active
                        ? 'border-indigo-500/60 bg-indigo-500/10'
                        : 'border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-800/40',
                    )}
                  >
                    <Icon size={16} className={cn('mt-0.5 shrink-0', active ? 'text-indigo-300' : 'text-slate-500')} />
                    <span className="min-w-0">
                      <span className={cn('flex items-center gap-2 text-xs font-semibold', active ? 'text-indigo-200' : 'text-slate-200')}>
                        {label}
                        {active && busy && <Loader2 size={11} className="animate-spin text-slate-500" />}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{description}</span>
                    </span>
                  </button>
                )
              })}
            </div>

            {privacyMode === 'local_only' && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>Talk-to-Graph and the Pi agent will refuse to answer from this graph while a cloud model is selected — switch to a local model (Cookbook) or change this setting.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
