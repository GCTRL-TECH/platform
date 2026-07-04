import { useState, useEffect } from 'react'
import { Check, Sparkles, AlertTriangle, Download, Loader2, Zap, Gauge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'

export interface CatalogModel {
  name: string
  purpose: 'embedding' | 'relation' | 'distill' | 'agent' | 'rag'
  sizeGb: number
  ramGb: number
  speed: number   // 1..5
  quality: number // 1..5
  recommended: boolean
  note: string
  installed: boolean
  fitsRam: boolean
}

export interface CatalogResponse {
  systemRamGb: number
  ollamaBase: string
  ollamaReachable: boolean
  installed: string[]
  catalog: CatalogModel[]
}

export interface ModelPrefs {
  embeddingModel: string
  embeddingProvider: string
  embeddingBaseUrl: string | null
  relationModel: string
  distillModel: string
  agentModel: string
  ragModel: string
}

/** 1..5 level bar (speed / quality) — minimal vector dots, mirrors Settings → AI Models. */
function LevelBar({ level, icon: Icon, label }: { level: number; icon: typeof Zap; label: string }) {
  return (
    <span className="flex items-center gap-1" title={`${label}: ${level}/5`}>
      <Icon size={11} className="text-slate-500" />
      <span className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={cn('h-1.5 w-1.5 rounded-full', i <= level ? 'bg-indigo-400' : 'bg-slate-700')} />
        ))}
      </span>
    </span>
  )
}

interface Props {
  purpose: CatalogModel['purpose']
  title: string
  blurb: string
  catalog: CatalogResponse | null
  /** Current selection for this purpose (already resolved with the recommended default). */
  selected: string
  /** Install (if needed) then persist this model as the purpose's pref. */
  onApply: (modelName: string) => Promise<void>
  /** Reset this purpose back to the recommended default. */
  onReset: () => Promise<void>
  /** Called after a successful install so the parent can refresh the catalog. */
  onPulled: () => void
}

/**
 * One purpose's model chooser — mirrors the card/badge styling of
 * Settings → AI Models → ModelChooser, but with a per-card Apply/Reset instead
 * of one global save (the Cookbook applies purpose-by-purpose).
 */
export function PurposeCard({ purpose, title, blurb, catalog, selected, onApply, onReset, onPulled }: Props) {
  const [applying, setApplying] = useState<string | null>(null)
  const [pulling, setPulling] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [custom, setCustom] = useState(selected)

  useEffect(() => setCustom(selected), [selected])

  const models = (catalog?.catalog ?? []).filter((m) => m.purpose === purpose)
  const installedList = catalog?.installed ?? []
  const isInstalled = (n: string) =>
    installedList.some((i) => i === n || i.split(':')[0] === n.split(':')[0])

  async function pullThenApply(name: string) {
    if (!name || applying !== null || pulling !== null) return
    setMsg(null)
    if (!isInstalled(name)) {
      setPulling(name)
      try {
        const { data } = await api.post('/llm/ollama/pull', { model: name })
        if (!data.ok) {
          setMsg({ ok: false, text: `Install failed: ${data.error ?? 'unknown error'}` })
          setPulling(null)
          return
        }
        onPulled()
      } catch {
        setMsg({ ok: false, text: 'Install failed — is Ollama reachable?' })
        setPulling(null)
        return
      }
      setPulling(null)
    }
    setApplying(name)
    try {
      await onApply(name)
      setMsg({ ok: true, text: `Applied ${name}.` })
    } catch {
      setMsg({ ok: false, text: 'Apply failed.' })
    } finally {
      setApplying(null)
    }
  }

  async function handleReset() {
    setResetting(true)
    setMsg(null)
    try {
      await onReset()
      setMsg({ ok: true, text: 'Reset to the recommended default.' })
    } catch {
      setMsg({ ok: false, text: 'Reset failed.' })
    } finally {
      setResetting(false)
    }
  }

  const busy = applying !== null || pulling !== null

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-200">{title}</h3>
        <button
          onClick={() => void handleReset()}
          disabled={resetting || busy}
          className="text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-50"
        >
          {resetting ? 'Resetting…' : 'Reset to default'}
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">{blurb}</p>

      {msg && (
        <div className={cn(
          'mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[11px]',
          msg.ok ? 'border-emerald-900/40 bg-emerald-950/20 text-emerald-300' : 'border-red-900/40 bg-red-950/20 text-red-400'
        )}>
          {msg.ok ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className="space-y-2">
        {models.map((m) => {
          const isSel = m.name === selected
          const isApplying = applying === m.name
          const isPulling = pulling === m.name
          return (
            <div
              key={m.name}
              className={cn(
                'rounded-lg border p-3 transition-colors',
                isSel ? 'border-indigo-500/60 bg-indigo-500/5' : 'border-slate-800 bg-slate-900/40'
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                  isSel ? 'border-indigo-400 bg-indigo-400' : 'border-slate-600'
                )}>
                  {isSel && <span className="h-1.5 w-1.5 rounded-full bg-slate-950" />}
                </span>
                <span className="font-mono text-sm text-slate-200">{m.name}</span>
                {m.recommended && (
                  <span className="flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-300">
                    <Sparkles size={9} /> Recommended
                  </span>
                )}
                {m.installed ? (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                    <Check size={9} /> Installed
                  </span>
                ) : (
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">Not installed</span>
                )}
                {!m.fitsRam && (
                  <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                    <AlertTriangle size={9} /> May not fit your RAM
                  </span>
                )}
                <div className="ml-auto flex items-center gap-3">
                  <LevelBar level={m.speed} icon={Zap} label="Speed" />
                  <LevelBar level={m.quality} icon={Gauge} label="Quality" />
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[11px] text-slate-500">
                <span>{m.note}</span>
                <span className="text-slate-600">·</span>
                <span>{m.sizeGb} GB download</span>
                <span className="text-slate-600">·</span>
                <span>~{m.ramGb} GB RAM</span>
                <button
                  onClick={() => void pullThenApply(m.name)}
                  disabled={isSel || busy}
                  className="ml-auto flex items-center gap-1.5 rounded-md bg-indigo-500/20 px-2.5 py-1 text-[11px] font-medium text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:opacity-50"
                >
                  {isPulling ? (
                    <><Loader2 size={11} className="animate-spin" /> Downloading {m.sizeGb} GB…</>
                  ) : isApplying ? (
                    <><Loader2 size={11} className="animate-spin" /> Applying…</>
                  ) : isSel ? (
                    <><Check size={11} /> Active</>
                  ) : !m.installed ? (
                    <><Download size={11} /> Install &amp; apply</>
                  ) : (
                    'Apply'
                  )}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Escape hatch: any exact model name (not-yet-pulled, or a remote/cloud
          model the engine should call by name). */}
      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-slate-500">Custom:</span>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="exact model name, e.g. gpt-oss:120b-cloud"
          className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
        />
        <button
          onClick={() => void pullThenApply(custom.trim())}
          disabled={!custom.trim() || custom.trim() === selected || busy}
          className="shrink-0 rounded-md bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
        >
          Apply
        </button>
      </div>
    </section>
  )
}
