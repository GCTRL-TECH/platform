import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'

export interface RuntimeModel {
  id: string
  label: string
  arg: string
  ram_gb: number
}

interface Props {
  runtime: string
  value: string
  onChange: (model: string) => void
  systemRamGb?: number
  disabled?: boolean
}

/**
 * Fetches the model catalog for a given runtime kind and renders a <select>.
 * Shows a "may not fit" hint when a model's RAM requirement exceeds available system RAM.
 * Every <select> has style={{ colorScheme: 'dark' }} to prevent white-on-white options.
 */
export function RuntimeModelPicker({ runtime, value, onChange, systemRamGb, disabled }: Props) {
  const [models, setModels] = useState<RuntimeModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!runtime) return
    let cancelled = false
    setLoading(true)
    setError('')
    void api
      .get<RuntimeModel[]>(`/infra/models?runtime=${encodeURIComponent(runtime)}`)
      .then(({ data }) => {
        if (!cancelled) setModels(data)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load models')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [runtime])

  const selected = models.find((m) => m.arg === value || m.id === value)
  const tooLarge = selected && systemRamGb != null && selected.ram_gb > systemRamGb

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <Loader2 size={12} className="animate-spin" />
        Loading models…
      </div>
    )
  }

  if (error) {
    return <p className="text-[11px] text-red-400">{error}</p>
  }

  if (models.length === 0) {
    return <p className="text-[11px] text-slate-500">No models available for this runtime.</p>
  }

  return (
    <div className="space-y-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ colorScheme: 'dark' }}
        className="w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
      >
        <option value="">Select a model…</option>
        {models.map((m) => (
          <option key={m.id} value={m.arg || m.id}>
            {m.label}
            {m.ram_gb ? ` · ${m.ram_gb} GB RAM` : ''}
            {systemRamGb != null && m.ram_gb > systemRamGb ? ' ⚠ may not fit' : ''}
          </option>
        ))}
      </select>
      {tooLarge && (
        <p className="flex items-center gap-1 text-[11px] text-amber-400">
          <AlertTriangle size={11} />
          This model needs ~{selected.ram_gb} GB RAM — your system has {systemRamGb} GB. It may fail to load.
        </p>
      )}
    </div>
  )
}
