import { useState, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { setAgentModelLocal, setRagModelLocal } from '@/lib/models'
import { HardwareCard, type HardwareInfo, type Recommendation } from '../settings/HardwareCard'
import { RuntimeBanner, type ActiveRuntimeInfo } from './RuntimeBanner'
import { PurposeCard, type CatalogModel, type CatalogResponse, type ModelPrefs } from './PurposeCard'

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
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [prefs, setPrefs] = useState<ModelPrefs | null>(null)
  const [loading, setLoading] = useState(true)

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
  // other purposes' saved choices.
  async function persistPrefs(next: ModelPrefs) {
    setPrefs(next)
    await api.put('/llm/model-prefs', {
      embeddingModel: next.embeddingModel,
      embeddingProvider: next.embeddingProvider || 'ollama',
      embeddingBaseUrl: next.embeddingBaseUrl || '',
      relationModel: next.relationModel,
      distillModel: next.distillModel,
      agentModel: next.agentModel,
      ragModel: next.ragModel,
    })
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
            <RuntimeBanner
              activeRuntime={activeRuntime}
              recommendation={recommendation}
              isAdmin={isAdmin}
              onSwitched={() => void loadInfra()}
            />
          </section>

          <section className="space-y-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Models per purpose</p>
            {PURPOSES.map((p) => (
              <PurposeCard
                key={p.id}
                purpose={p.id}
                title={p.title}
                blurb={p.blurb}
                catalog={catalog}
                selected={prefs ? String(prefs[p.prefKey] ?? '') : ''}
                onApply={async (name) => {
                  if (!prefs) return
                  await persistPrefs({ ...prefs, [p.prefKey]: name })
                  if (p.id === 'agent') setAgentModelLocal(name)
                  if (p.id === 'rag') setRagModelLocal(name)
                }}
                onReset={async () => {
                  if (!prefs) return
                  await persistPrefs({ ...prefs, [p.prefKey]: '' })
                  await loadModels() // re-fetch so the card shows the recommended default
                }}
                onPulled={() => void loadModels()}
              />
            ))}
          </section>
        </>
      )}
    </div>
  )
}
