import { useState, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { setAgentModelLocal, setRagModelLocal } from '@/lib/models'
import { HardwareCard, type HardwareInfo, type Recommendation } from '../settings/HardwareCard'
import { RuntimeCard } from '../settings/RuntimeCard'
import type { ActiveRuntime } from '../settings/RuntimeSwitcher'
import { useInstalledModels } from '../settings/ModelPickerShared'
import { PurposeCard, type CatalogModel, type CatalogResponse, type ModelPrefs } from './PurposeCard'

// Cookbook previously used its own ActiveRuntimeInfo shape (a subset of
// ActiveRuntime without embedding_mode) — RuntimeCard needs the full shape, so
// this page now fetches the same ActiveRuntime type Settings → AI Models uses.
type ActiveRuntimeInfo = ActiveRuntime

interface PurposeMeta {
  id: CatalogModel['purpose']
  title: string
  blurb: string
  prefKey: keyof ModelPrefs
}

const PURPOSES: PurposeMeta[] = [
  {
    id: 'embedding',
    title: 'Embedding (KEX)',
    blurb: 'Vectorizes every chunk for search & RAG. Kept LOCAL by default — a cloud embedder would burn tokens and add latency at volume.',
    prefKey: 'embeddingModel',
  },
  {
    id: 'relation',
    title: 'Relation extraction (RelEx / KEX)',
    blurb: 'Reads each document and proposes entity relationships. Quality drives the knowledge graph; a stronger model means better edges, at the cost of speed/RAM.',
    prefKey: 'relationModel',
  },
  {
    id: 'distill',
    title: 'Wiki distillation (FUSE)',
    blurb: 'Writes the living wiki prose from your graph. Needs good instruction-following and fluency.',
    prefKey: 'distillModel',
  },
  {
    id: 'agent',
    title: 'Pi agent chat',
    blurb: 'Powers the Pi agent’s conversational + tool-calling loop. A stronger model chains tools more reliably on complex asks.',
    prefKey: 'agentModel',
  },
  {
    id: 'rag',
    title: 'Talk-to-Graph',
    blurb: 'Answers questions grounded in your knowledge graph. A stronger model gives more coherent multi-hop answers.',
    prefKey: 'ragModel',
  },
]

// Per-purpose RUNTIME override columns (P2). All five purposes are wired: the
// KEX/FUSE workers via resolve_purpose injection, agent/rag via the interactive
// resolve_purpose chain (keyless local; cloud stays on the per-user provider).
const RUNTIME_KEYS: Record<CatalogModel['purpose'], { p: keyof ModelPrefs; b: keyof ModelPrefs }> = {
  embedding: { p: 'embeddingProvider', b: 'embeddingBaseUrl' },
  relation: { p: 'relationProvider', b: 'relationBaseUrl' },
  distill: { p: 'distillProvider', b: 'distillBaseUrl' },
  agent: { p: 'agentProvider', b: 'agentBaseUrl' },
  rag: { p: 'ragProvider', b: 'ragBaseUrl' },
}

/**
 * Cookbook — hardware-aware model tuning. Shows detected hardware, a runtime
 * recommendation (when it differs from what's active), and a per-purpose model
 * picker for all five chat/engine purposes GCTRL uses. Defaults always work;
 * this page surfaces measured upgrades for people who want more.
 */
export function CookbookPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)
  const [activeRuntime, setActiveRuntime] = useState<ActiveRuntimeInfo | null>(null)
  const [ollamaOverrideUrl, setOllamaOverrideUrl] = useState<string | null | undefined>(undefined)
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [prefs, setPrefs] = useState<ModelPrefs | null>(null)
  const [loading, setLoading] = useState(true)
  const { items: installedModels, reload: reloadInstalledModels } = useInstalledModels()

  const loadInfra = useCallback(async () => {
    const [hwRes, recRes, rtRes] = await Promise.allSettled([
      api.get<HardwareInfo>('/infra/hardware'),
      api.get<Recommendation>('/infra/recommend'),
      api.get<ActiveRuntimeInfo>('/infra/active-runtime'),
    ])
    if (hwRes.status === 'fulfilled') setHardware(hwRes.value.data)
    if (recRes.status === 'fulfilled') setRecommendation(recRes.value.data)
    if (rtRes.status === 'fulfilled') setActiveRuntime(rtRes.value.data)
  }, [])

  const loadModels = useCallback(async () => {
    const [catRes, prefRes] = await Promise.allSettled([
      api.get<CatalogResponse>('/llm/ollama/catalog'),
      api.get<ModelPrefs>('/llm/model-prefs'),
    ])
    if (catRes.status === 'fulfilled') setCatalog(catRes.value.data)
    if (prefRes.status === 'fulfilled') setPrefs(prefRes.value.data)
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await Promise.allSettled([loadInfra(), loadModels()])
      setLoading(false)
    })()
  }, [loadInfra, loadModels])

  // Persist the FULL prefs object on every purpose change — the PUT endpoint
  // overwrites all columns, so a partial body would silently wipe out the
  // other purposes' saved choices. Local state updates only AFTER the server
  // confirms (W7): an optimistic setPrefs left the card showing a selection
  // the backend never accepted when the PUT failed.
  async function persistPrefs(next: ModelPrefs) {
    await api.put('/llm/model-prefs', {
      embeddingModel: next.embeddingModel,
      embeddingProvider: next.embeddingProvider || 'ollama',
      embeddingBaseUrl: next.embeddingBaseUrl || '',
      relationModel: next.relationModel,
      distillModel: next.distillModel,
      agentModel: next.agentModel,
      ragModel: next.ragModel,
      // P2 per-purpose runtime overrides (empty = inherit; sent every time so the
      // full-overwrite PUT never wipes another purpose's saved override).
      relationProvider: next.relationProvider || '',
      relationBaseUrl: next.relationBaseUrl || '',
      distillProvider: next.distillProvider || '',
      distillBaseUrl: next.distillBaseUrl || '',
      agentProvider: next.agentProvider || '',
      agentBaseUrl: next.agentBaseUrl || '',
      ragProvider: next.ragProvider || '',
      ragBaseUrl: next.ragBaseUrl || '',
    })
    setPrefs(next)
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Cookbook</h2>
        <p className="mt-1 text-sm text-slate-500">
          Get the most out of your hardware. Defaults always work; these are measured upgrades.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 size={16} className="animate-spin" /> Reading your hardware and models…
        </div>
      ) : (
        <>
          <section>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Hardware</p>
            <HardwareCard
              hardware={hardware}
              recommendation={null}
              isAdmin={isAdmin}
              onHardwareRescan={(updated) => setHardware(updated)}
            />
          </section>

          <section>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Runtime</p>
            <RuntimeCard
              hardware={hardware}
              recommendation={recommendation}
              activeRuntime={activeRuntime}
              isAdmin={isAdmin}
              onSwitched={() => void loadInfra()}
              onOllamaOverrideChange={setOllamaOverrideUrl}
            />
          </section>

          <section className="space-y-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Models per purpose</p>
            {PURPOSES.map((p) => {
              const rk = RUNTIME_KEYS[p.id]
              return (
              <PurposeCard
                key={p.id}
                purpose={p.id}
                title={p.title}
                blurb={p.blurb}
                catalog={catalog}
                selected={prefs ? String(prefs[p.prefKey] ?? '') : ''}
                activeRuntime={activeRuntime}
                ollamaOverrideUrl={ollamaOverrideUrl}
                installedModels={installedModels}
                runtimeProvider={rk ? (prefs?.[rk.p] as string | null | undefined) : undefined}
                runtimeBaseUrl={rk ? (prefs?.[rk.b] as string | null | undefined) : undefined}
                onSetRuntime={rk ? async (provider, baseUrl, model) => {
                  if (!prefs) return
                  const next = { ...prefs, [rk.p]: provider, [rk.b]: baseUrl } as ModelPrefs
                  if (model !== undefined) {
                    ;(next as unknown as Record<string, unknown>)[p.prefKey] = model
                    if (p.id === 'agent') setAgentModelLocal(model)
                    if (p.id === 'rag') setRagModelLocal(model)
                  }
                  await persistPrefs(next)
                } : undefined}
                onApply={async (name, provider) => {
                  if (!prefs) return
                  const next = { ...prefs, [p.prefKey]: name } as ModelPrefs
                  // A cloud-hosted pick must persist its provider alongside the
                  // model — the name alone resolves against LOCAL Ollama and
                  // 404s ("model not found"). Conversely, picking a local model
                  // while an ollama_cloud override is stored would be the same
                  // mismatch in reverse, so clear it. Other runtime overrides
                  // (custom base URL etc.) are left untouched.
                  if (rk) {
                    const cur = String(prefs[rk.p] ?? '')
                    if (provider === 'ollama_cloud') {
                      ;(next as unknown as Record<string, unknown>)[rk.p] = 'ollama_cloud'
                    } else if (cur === 'ollama_cloud') {
                      ;(next as unknown as Record<string, unknown>)[rk.p] = ''
                    }
                  }
                  await persistPrefs(next)
                  if (p.id === 'agent') setAgentModelLocal(name, provider)
                  if (p.id === 'rag') setRagModelLocal(name)
                }}
                onReset={async () => {
                  if (!prefs) return
                  await persistPrefs({ ...prefs, [p.prefKey]: '' })
                  await loadModels() // re-fetch so the card shows the recommended default
                }}
                onPulled={() => { void loadModels(); void reloadInstalledModels() }}
              />
            )})}
          </section>
        </>
      )}
    </div>
  )
}
