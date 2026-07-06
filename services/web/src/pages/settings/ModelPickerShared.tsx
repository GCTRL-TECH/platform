import { useState, useCallback, useEffect } from 'react'
import { Check, AlertTriangle, Loader2, Download } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'

/**
 * Shared "open model selection" building blocks for Settings → AI Models
 * (ModelChooser) and Cookbook (PurposeCard). Both surfaces need the same three
 * things beyond the curated top-3-per-purpose list: every model actually
 * installed/reachable for the user (GET /llm/models), a way to pull any tag by
 * name, and a place to render both. Kept endpoint-driven — no hardcoded model
 * names live here.
 */

export interface InstalledModelEntry {
  provider: string
  model: string
  name: string
  available: boolean
  requiresKey: boolean
}

/**
 * GET /llm/models — every model the user can currently address: locally
 * installed Ollama tags, ollama.com cloud tags (if a key is set), and curated
 * models for any cloud provider the user has connected. Excludes
 * embedding-only models server-side, so this is only useful for the
 * generation purposes (relation / distill / agent / rag), not embedding.
 */
export function useInstalledModels() {
  const [items, setItems] = useState<InstalledModelEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get<InstalledModelEntry[] | { models: InstalledModelEntry[] }>('/llm/models')
      setItems(Array.isArray(data) ? data : data.models ?? [])
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return { items, loading, reload: load }
}

/**
 * Free-text "pull any model" row — installs an arbitrary Ollama tag (any name
 * from ollama.com/library, not limited to the curated/installed lists) and
 * hands the name back on success so the caller can select + persist it.
 */
export function PullAnyModelRow({
  onPulled,
  disabled,
}: {
  onPulled: (modelName: string) => void | Promise<void>
  disabled?: boolean
}) {
  const [value, setValue] = useState('')
  const [pulling, setPulling] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function handlePull() {
    const name = value.trim()
    if (!name || pulling) return
    setPulling(true)
    setMsg(null)
    try {
      const { data } = await api.post('/llm/ollama/pull', { model: name })
      if (data.ok) {
        setMsg({ ok: true, text: `Installed ${name}.` })
        await onPulled(name)
        setValue('')
      } else {
        setMsg({ ok: false, text: `Install failed: ${data.error ?? 'unknown error'}` })
      }
    } catch {
      setMsg({ ok: false, text: 'Install failed — is Ollama reachable?' })
    } finally {
      setPulling(false)
    }
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-slate-500">Pull any model:</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handlePull() }}
          placeholder="e.g. mistral-nemo, qwen2.5:32b, llama3.3:70b"
          disabled={disabled || pulling}
          className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={() => void handlePull()}
          disabled={disabled || pulling || !value.trim()}
          className="shrink-0 flex items-center gap-1.5 rounded-md bg-indigo-500/20 px-2.5 py-1 text-[11px] font-medium text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:opacity-50"
        >
          {pulling ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
          {pulling ? 'Installing…' : 'Pull & select'}
        </button>
      </div>
      <p className="pl-[92px] text-[10px] text-slate-600">Any tag from ollama.com/library.</p>
      {msg && (
        <div className={cn(
          'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px]',
          msg.ok ? 'border-emerald-900/40 bg-emerald-950/20 text-emerald-300' : 'border-red-900/40 bg-red-950/20 text-red-400',
        )}>
          {msg.ok ? <Check size={12} className="mt-0.5 shrink-0" /> : <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
          <span>{msg.text}</span>
        </div>
      )}
    </div>
  )
}

/** True for names that look like an embedding model (mirrors the backend's is_embedding_model heuristic closely enough for UI filtering). */
export function looksLikeEmbeddingModel(name: string): boolean {
  return /embed|minilm|nomic|bge|mxbai|gte|e5-/i.test(name)
}

/**
 * Every installed/reachable model NOT already covered by the curated
 * recommended cards for this purpose — the "open selection" the founder asked
 * for, instead of being capped at 3 curated entries. Combines:
 *   - other installed Ollama tags (from the /llm/ollama/catalog `installed` list)
 *   - for non-embedding purposes, cloud-connected models from GET /llm/models
 *     (that endpoint already excludes embedding-only models server-side)
 */
export function AllInstalledModelsRow({
  purpose,
  curatedNames,
  ollamaInstalled,
  cloudModels,
  selected,
  onSelect,
}: {
  purpose: 'embedding' | 'relation' | 'distill' | 'agent' | 'rag'
  curatedNames: Set<string>
  ollamaInstalled: string[]
  cloudModels: InstalledModelEntry[]
  selected: string
  onSelect: (name: string, provider?: string) => void
}) {
  const isEmbedding = purpose === 'embedding'
  const localOthers = ollamaInstalled
    .filter((n) => !curatedNames.has(n) && !curatedNames.has(n.split(':')[0]))
    .filter((n) => (isEmbedding ? looksLikeEmbeddingModel(n) : !looksLikeEmbeddingModel(n)))
  const cloudOthers = isEmbedding
    ? []
    : cloudModels.filter((m) => m.provider !== 'ollama' && !curatedNames.has(m.model))

  if (localOthers.length === 0 && cloudOthers.length === 0) return null

  return (
    <div className="mt-2">
      <p className="mb-1.5 text-[11px] text-slate-500">All installed models:</p>
      <div className="flex flex-wrap gap-1.5">
        {localOthers.map((n) => (
          <button
            key={n}
            onClick={() => onSelect(n)}
            className={cn(
              'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
              n === selected
                ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-300'
                : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600',
            )}
          >
            {n}
          </button>
        ))}
        {cloudOthers.map((m) => (
          <button
            key={`${m.provider}:${m.model}`}
            onClick={() => onSelect(m.model, m.provider)}
            title={m.name}
            className={cn(
              'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
              m.model === selected
                ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-300'
                : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600',
            )}
          >
            {m.name}
          </button>
        ))}
      </div>
    </div>
  )
}
