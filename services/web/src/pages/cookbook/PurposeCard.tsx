import { useState, useEffect } from 'react'
import { Check, Sparkles, AlertTriangle, Download, Loader2, Zap, Gauge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { ActiveRuntime } from '../settings/RuntimeSwitcher'
import { RuntimeModelPicker } from '../settings/RuntimeModelPicker'
import { bundledGenerationRuntimeId, describeRuntimeShort } from '../settings/runtimeLabel'
import { AllInstalledModelsRow, PullAnyModelRow, type InstalledModelEntry } from '../settings/ModelPickerShared'

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
  // P2 per-purpose runtime overrides (null/empty = inherit the global runtime).
  relationProvider?: string | null
  relationBaseUrl?: string | null
  distillProvider?: string | null
  distillBaseUrl?: string | null
  agentProvider?: string | null
  agentBaseUrl?: string | null
  ragProvider?: string | null
  ragBaseUrl?: string | null
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
  /** Install (if needed) then persist this model as the purpose's pref.
   *  `provider` is set for cloud-hosted picks (e.g. 'ollama_cloud') — the model
   *  name alone would resolve against LOCAL Ollama and 404. */
  onApply: (modelName: string, provider?: string) => Promise<void>
  /** Reset this purpose back to the recommended default. */
  onReset: () => Promise<void>
  /** Called after a successful install so the parent can refresh the catalog. */
  onPulled: () => void
  /** The globally active generation runtime — drives the "runs on" chip and the
   * llama.cpp/vLLM model-catalog branch below. */
  activeRuntime?: ActiveRuntime | null
  /** Ollama location (bundled vs. native) — undefined when unknown (non-admin). */
  ollamaOverrideUrl?: string | null | undefined
  /** Every model GET /llm/models can currently address (Ollama + connected cloud), for the open "All installed models" selection. */
  installedModels?: InstalledModelEntry[]
  /** P2 per-purpose runtime override (current value). null/empty = inherit global. */
  runtimeProvider?: string | null
  runtimeBaseUrl?: string | null
  /** When provided, renders a per-purpose Runtime override row that saves
   *  {provider, baseUrl, model} for this purpose. */
  onSetRuntime?: (provider: string, baseUrl: string, model?: string) => Promise<void>
}

/**
 * One purpose's model chooser — mirrors the card/badge styling of
 * Settings → AI Models → ModelChooser, but with a per-card Apply/Reset instead
 * of one global save (the Cookbook applies purpose-by-purpose).
 */
export function PurposeCard({
  purpose, title, blurb, catalog, selected, onApply, onReset, onPulled,
  activeRuntime = null, ollamaOverrideUrl, installedModels = [],
  runtimeProvider, runtimeBaseUrl, onSetRuntime,
}: Props) {
  const [applying, setApplying] = useState<string | null>(null)
  const [pulling, setPulling] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [custom, setCustom] = useState(selected)

  useEffect(() => setCustom(selected), [selected])

  const models = (catalog?.catalog ?? []).filter((m) => m.purpose === purpose)
  const installedList = catalog?.installed ?? []
  const curatedNames = new Set(models.map((m) => m.name))
  const isInstalled = (n: string) =>
    installedList.some((i) => i === n || i.split(':')[0] === n.split(':')[0])

  const runtimeId = purpose === 'embedding' ? null : bundledGenerationRuntimeId(activeRuntime)
  const ollamaSuffix = ollamaOverrideUrl === undefined ? '' : ollamaOverrideUrl ? ' · native' : ' · bundled'
  const runtimeChip = purpose === 'embedding'
    ? `Ollama${ollamaSuffix}`
    : `${describeRuntimeShort(activeRuntime)}${describeRuntimeShort(activeRuntime) === 'Ollama' ? ollamaSuffix : ''}`

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

  // Everything AllInstalledModelsRow lists is already installed/reachable —
  // apply directly, no pull step (unlike pullThenApply, used by the curated
  // cards where "Install & apply" may need to pull first).
  async function selectInstalled(name: string, provider?: string) {
    if (!name || busy) return
    setApplying(name)
    setMsg(null)
    try {
      await onApply(name, provider)
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
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-slate-200">{title}</h3>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400" title="Which runtime this purpose executes on">
            Runs on: {runtimeChip}
          </span>
        </div>
        <button
          onClick={() => void handleReset()}
          disabled={resetting || busy}
          className="text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-50"
        >
          {resetting ? 'Resetting…' : 'Reset to default'}
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">{blurb}</p>

      {onSetRuntime && (
        <RuntimeOverrideRow provider={runtimeProvider} baseUrl={runtimeBaseUrl} model={selected} onSet={onSetRuntime} />
      )}

      {runtimeId && (
        <div className="mb-3 rounded-md border border-indigo-800/30 bg-indigo-950/10 p-3">
          <p className="mb-2 text-[11px] text-indigo-300">
            This purpose currently executes on <strong>{runtimeId === 'llamacpp' ? 'llama.cpp' : 'vLLM'}</strong>, not
            Ollama — pick a model from its catalog below (embeddings always run on Ollama regardless of the active
            generation runtime).
          </p>
          <RuntimeModelPicker
            runtime={runtimeId}
            value={selected}
            onChange={(name) => void onApply(name)}
            systemRamGb={catalog?.systemRamGb}
          />
        </div>
      )}

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

      {/* Open selection: every installed/reachable model, not just the curated
          cards above — click to select. */}
      <AllInstalledModelsRow
        purpose={purpose}
        curatedNames={curatedNames}
        ollamaInstalled={installedList}
        cloudModels={installedModels}
        selected={selected}
        onSelect={(name, provider) => void selectInstalled(name, provider)}
      />

      {/* Pull any tag by name — installs then applies it for this purpose. */}
      <PullAnyModelRow
        onPulled={async (name) => {
          onPulled()
          await onApply(name)
        }}
      />

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

const OLLAMA_HOST = 'http://host.docker.internal:11434'

/** Per-purpose Runtime + Model (P2). Choose which INSTANCE this purpose runs on —
 *  inherit the global runtime, bundled Ollama (CPU), native Ollama (GPU on this
 *  host), or a custom /v1 endpoint (local vLLM, LM Studio, Ollama cloud) — and
 *  then pick a model from THAT instance's installed models. So e.g. KEX embedding
 *  can run on native GPU Ollama while chat rides a cloud endpoint. Keyless local
 *  endpoints only for the batch workers (KEX/FUSE). */
function RuntimeOverrideRow({
  provider, baseUrl, model, onSet,
}: {
  provider?: string | null
  baseUrl?: string | null
  model?: string
  onSet: (provider: string, baseUrl: string, model?: string) => Promise<void>
}) {
  const derived = !provider ? 'inherit'
    : (provider === 'ollama' && baseUrl === OLLAMA_HOST) ? 'native'
    : (provider === 'ollama') ? 'bundled'
    : 'custom'
  const [mode, setMode] = useState(derived)
  const [customUrl, setCustomUrl] = useState(provider === 'ollama' ? '' : (baseUrl ?? ''))
  const [instModels, setInstModels] = useState<string[]>([])
  const [instLoading, setInstLoading] = useState(false)
  const [instErr, setInstErr] = useState('')
  const [pickModel, setPickModel] = useState(model ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setMode(derived) }, [derived])
  useEffect(() => { setPickModel(model ?? '') }, [model])

  function target(m: string): { provider: string; base: string } | null {
    if (m === 'inherit') return null
    if (m === 'bundled') return { provider: 'ollama', base: '' }
    if (m === 'native') return { provider: 'ollama', base: OLLAMA_HOST }
    return { provider: 'openai_compatible', base: customUrl.trim() }
  }

  async function loadInstance(t: { provider: string; base: string }) {
    setInstLoading(true); setInstErr(''); setInstModels([])
    try {
      const { data } = await api.get<{ reachable: boolean; models: string[] }>(
        `/llm/instance-models?provider=${encodeURIComponent(t.provider)}&base=${encodeURIComponent(t.base)}`
      )
      setInstModels(data.models ?? [])
      if (!data.reachable) setInstErr('Instance not reachable — is it running?')
    } catch { setInstErr('Could not load models') } finally { setInstLoading(false) }
  }

  // Load the instance's models whenever a concrete (non-custom-without-url) override is active.
  useEffect(() => {
    const t = target(mode)
    if (t && !(mode === 'custom' && !t.base)) void loadInstance(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  async function commit(prov: string, base: string, mdl?: string) {
    setSaving(true)
    try { await onSet(prov, base, mdl) } finally { setSaving(false) }
  }

  return (
    <div className="mb-3 space-y-2 rounded-md border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] font-medium text-slate-400">Runtime</span>
        <select
          value={mode}
          disabled={saving}
          onChange={(e) => {
            const v = e.target.value
            setMode(v)
            if (v === 'inherit') void commit('', '') // clear override, keep the model picked below
            // bundled/native/custom: load the instance's models, then Save applies {provider, base, model}
          }}
          style={{ colorScheme: 'dark' }}
          className="flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[12px] text-slate-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
        >
          <option value="inherit">Inherit global runtime</option>
          <option value="bundled">Ollama — bundled (CPU)</option>
          <option value="native">Ollama — native (this host, GPU)</option>
          <option value="custom">Custom /v1 endpoint…</option>
        </select>
      </div>

      {mode === 'custom' && (
        <input
          value={customUrl}
          onChange={(e) => setCustomUrl(e.target.value)}
          onBlur={() => { const t = target('custom'); if (t?.base) void loadInstance(t) }}
          placeholder="http://host:port/v1  (vLLM, LM Studio, Ollama cloud…)"
          className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
        />
      )}

      {mode !== 'inherit' && (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] font-medium text-slate-400">Model</span>
          {instLoading ? (
            <span className="flex items-center gap-1 text-[11px] text-slate-500"><Loader2 size={11} className="animate-spin" /> Loading models…</span>
          ) : (
            <select
              value={pickModel}
              onChange={(e) => setPickModel(e.target.value)}
              style={{ colorScheme: 'dark' }}
              className="flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[12px] text-slate-200 focus:border-indigo-500 focus:outline-none"
            >
              <option value="">{instModels.length ? 'Select a model…' : 'No models on this instance'}</option>
              {instModels.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          <button
            onClick={() => { const t = target(mode); if (t) void commit(t.provider, t.base, pickModel || undefined) }}
            disabled={saving || (mode === 'custom' && !customUrl.trim())}
            className="shrink-0 rounded bg-indigo-500/20 px-2.5 py-1 text-[11px] font-medium text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {instErr && <p className="text-[10px] text-amber-400">{instErr}</p>}
      <p className="text-[10px] text-slate-500">
        {mode === 'inherit'
          ? 'Follows the global runtime. Pick a specific instance to run this purpose there — e.g. native Ollama for GPU.'
          : 'Model list = what that instance has installed. Keyless local endpoints only for the batch workers (KEX/FUSE).'}
      </p>
    </div>
  )
}
