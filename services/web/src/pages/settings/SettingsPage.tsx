import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Brain,
  Plug,
  Puzzle,
  User,
  Eye,
  EyeOff,
  Save,
  Check,
  X,
  LogOut,
  Coins,
  ChevronRight,
  Database,
  Cloud,
  Github,
  Slack,
  Globe,
  Mic,
  Code2,
  Search,
  Server,
  RefreshCw,
  Wifi,
  WifiOff,
  KeyRound,
  Shield,
  Loader2,
  ArrowUpCircle,
  Bot,
  Lock,
  ExternalLink,
  Webhook,
  Sparkles,
  Trash2,
  Plus,
  AlertTriangle,
  ShieldAlert,
  Download,
  Gauge,
  Zap,
  Cpu,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useApiQuery } from '@/hooks/useApi'
import { usePublicConfig } from '@/hooks/usePublicConfig'
import { useTokenBalance } from '@/hooks/useTokenBalance'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { api, apiGet } from '@/lib/api'
import { UpdateModal, useLicenseStatus } from '@/components/LicenseBanner'
import ObsidianVaultManager from '@/components/connectors/ObsidianVaultManager'
import SSOPage from './SSOPage'
import WebhooksPage from './WebhooksPage'
import { NativeOllamaGuide } from './NativeOllamaGuide'
import { HardwareCard, type HardwareInfo, type Recommendation } from './HardwareCard'
import { RuntimeSwitcher, type ActiveRuntime } from './RuntimeSwitcher'
import { AdvancedEmbeddingModal } from './AdvancedEmbeddingModal'

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = 'license' | 'models' | 'integrations' | 'skills' | 'agent' | 'mcp' | 'n8n' | 'webhooks' | 'account' | 'infrastructure' | 'memory' | 'profile' | 'sso'

interface Tab {
  id: TabId
  label: string
  icon: typeof Brain
}

interface ApiKeyField {
  id: string
  label: string
  provider: string
  placeholder: string
  modelsEnabled: string[]
}

interface ConnectedAccount {
  id: string
  name: string
  description: string
  icon: typeof Brain
  connected: boolean
}

interface Connector {
  id: string
  name: string
  category: string
  icon: typeof Brain
  available: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS: Tab[] = [
  { id: 'license', label: 'License', icon: Shield },
  { id: 'models', label: 'AI Models', icon: Brain },
  { id: 'skills', label: 'Skills & Plugins', icon: Puzzle },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'mcp', label: 'MCP Server', icon: Code2 },
  { id: 'n8n', label: 'n8n', icon: Plug },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
  { id: 'infrastructure', label: 'Infrastructure', icon: Server },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'profile', label: 'Personal Memory', icon: Sparkles },
  { id: 'sso', label: 'SSO / SCIM', icon: KeyRound },
  { id: 'account', label: 'Account', icon: User },
]

const API_KEY_FIELDS: ApiKeyField[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'OpenAI',
    placeholder: 'sk-...',
    modelsEnabled: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo', 'text-embedding-3-large'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'Anthropic',
    placeholder: 'sk-ant-...',
    modelsEnabled: ['claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'OpenRouter',
    placeholder: 'sk-or-...',
    modelsEnabled: ['Meta Llama 3.3 70B', 'Qwen2.5 72B', 'Gemini Flash 2.0', '300+ models'],
  },
]

const CONNECTED_ACCOUNTS: ConnectedAccount[] = [
  {
    id: 'google',
    name: 'Google Workspace',
    description: 'Connect Google Drive, Gmail, Calendar',
    icon: Globe,
    connected: false,
  },
  {
    id: 'microsoft',
    name: 'Microsoft 365',
    description: 'Connect OneDrive, SharePoint, Outlook',
    icon: Cloud,
    connected: false,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Connect Slack workspace',
    icon: Slack,
    connected: false,
  },
]

const CONNECTORS: Connector[] = [
  // Databases
  { id: 'postgresql', name: 'PostgreSQL', category: 'Databases', icon: Database, available: true },
  { id: 'mysql', name: 'MySQL', category: 'Databases', icon: Database, available: true },
  { id: 'mongodb', name: 'MongoDB', category: 'Databases', icon: Database, available: true },
  // Cloud Storage
  { id: 's3', name: 'AWS S3', category: 'Cloud Storage', icon: Cloud, available: true },
  { id: 'gcs', name: 'Google Cloud Storage', category: 'Cloud Storage', icon: Cloud, available: true },
  { id: 'azure', name: 'Azure Blob', category: 'Cloud Storage', icon: Cloud, available: true },
  { id: 'minio', name: 'MinIO', category: 'Cloud Storage', icon: Cloud, available: true },
  { id: 'dropbox', name: 'Dropbox', category: 'Cloud Storage', icon: Cloud, available: true },
  // Project Tools
  { id: 'jira', name: 'Jira', category: 'Project Tools', icon: Globe, available: true },
  { id: 'confluence', name: 'Confluence', category: 'Project Tools', icon: Globe, available: true },
  { id: 'notion', name: 'Notion', category: 'Project Tools', icon: Globe, available: true },
  { id: 'linear', name: 'Linear', category: 'Project Tools', icon: Globe, available: true },
  // Code
  { id: 'github', name: 'GitHub', category: 'Code', icon: Github, available: true },
  { id: 'gitlab', name: 'GitLab', category: 'Code', icon: Code2, available: false },
  // CRM
  { id: 'salesforce', name: 'Salesforce', category: 'CRM', icon: Globe, available: true },
  { id: 'hubspot', name: 'HubSpot', category: 'CRM', icon: Globe, available: true },
  // Web & Other
  { id: 'webcrawler', name: 'Web Crawler', category: 'Web', icon: Search, available: true },
  { id: 'whisper', name: 'Audio/Video (Whisper)', category: 'Other', icon: Mic, available: true },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-4 text-sm font-semibold text-slate-300">{children}</h2>
  )
}

interface LlmProviderState {
  provider: string
  connected: boolean
  isActive: boolean
  baseUrl: string | null
  defaultModel: string | null
  hasKey: boolean
}

/// Per-provider Connect card backed by `/api/llm/providers`. Cloud providers take
/// an API key (+ Test); the stored key is never shown (masked/omitted by the API).
function ProviderCard({
  field,
  state,
  onChanged,
}: {
  field: ApiKeyField
  state: LlmProviderState | undefined
  onChanged: () => void
}) {
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'error' | null>(null)
  const [testMsg, setTestMsg] = useState<string>('')

  const connected = !!state?.connected

  async function handleSave() {
    if (!value.trim()) return
    setBusy(true)
    setTestResult(null)
    try {
      await api.put('/llm/providers', { provider: field.id, apiKey: value.trim() })
      setValue('')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function handleTest() {
    setBusy(true)
    setTestResult(null)
    try {
      // Save first if a fresh key was typed, so Test exercises it.
      if (value.trim()) {
        await api.put('/llm/providers', { provider: field.id, apiKey: value.trim() })
        setValue('')
        onChanged()
      }
      const { data } = await api.post(`/llm/providers/${field.id}/test`)
      setTestResult(data.ok ? 'ok' : 'error')
      setTestMsg(data.ok ? 'Connection OK' : (data.error ?? 'Test failed'))
    } catch {
      setTestResult('error')
      setTestMsg('Test failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleDisconnect() {
    setBusy(true)
    try {
      await api.delete(`/llm/providers/${field.id}`)
      setTestResult(null)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-200">{field.label}</span>
          {connected ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              <Check size={9} />
              Connected
            </span>
          ) : (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
              Not connected
            </span>
          )}
        </div>
        {connected && (
          <button
            onClick={handleDisconnect}
            disabled={busy}
            className="text-[11px] text-slate-500 hover:text-red-400 disabled:opacity-50"
          >
            Disconnect
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={connected ? '•••••••• (key stored — enter new to replace)' : field.placeholder}
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 pr-10 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <button
          onClick={handleSave}
          disabled={busy || !value.trim()}
          className="flex items-center gap-1.5 rounded-md bg-blue-500/20 px-3 py-2 text-sm font-medium text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
        <button
          onClick={handleTest}
          disabled={busy || (!connected && !value.trim())}
          className="flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          Test
        </button>
      </div>

      {testResult && (
        <p className={cn('mt-2 text-[11px]', testResult === 'ok' ? 'text-emerald-400' : 'text-red-400')}>
          {testMsg}
        </p>
      )}

      <div className="mt-3">
        <p className="mb-1.5 text-[11px] text-slate-500">Models:</p>
        <div className="flex flex-wrap gap-1.5">
          {field.modelsEnabled.map((model) => (
            <span
              key={model}
              className="rounded-md bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-400"
            >
              {model}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ConnectorModal removed — replaced by unified inline integrations list

// ─── Model chooser (KEX embedding / relation + wiki distill) ──────────────────

interface CatalogModel {
  name: string
  purpose: 'embedding' | 'relation' | 'distill'
  sizeGb: number
  ramGb: number
  speed: number   // 1..5
  quality: number // 1..5
  recommended: boolean
  note: string
  installed: boolean
  fitsRam: boolean
}

interface CatalogResponse {
  systemRamGb: number
  ollamaBase: string
  ollamaReachable: boolean
  installed: string[]
  catalog: CatalogModel[]
}

interface ModelPrefs {
  embeddingModel: string
  embeddingProvider: string
  embeddingBaseUrl: string | null
  relationModel: string
  distillModel: string
}

const PURPOSE_META: Record<CatalogModel['purpose'], { title: string; blurb: string; prefKey: keyof ModelPrefs }> = {
  embedding: {
    title: 'Embedding model (KEX)',
    blurb: 'Vectorizes every chunk for search & RAG. Kept LOCAL by default — a cloud embedder would burn tokens and add latency on high volume. nomic-embed-text is fast, low-RAM, and the recommended default.',
    prefKey: 'embeddingModel',
  },
  relation: {
    title: 'Relation extraction model (KEX)',
    blurb: 'Reads each document and proposes entity relationships. Quality drives the knowledge graph; a stronger model means better edges, at the cost of speed/RAM.',
    prefKey: 'relationModel',
  },
  distill: {
    title: 'Wiki distillation model (FUSE)',
    blurb: 'Writes the living wiki prose from your graph. Needs good instruction-following and fluency.',
    prefKey: 'distillModel',
  },
}

/** 1..5 level bar (speed / quality) — minimal vector dots, CI-aligned. */
function LevelBar({ level, icon: Icon, label }: { level: number; icon: typeof Zap; label: string }) {
  return (
    <span className="flex items-center gap-1" title={`${label}: ${level}/5`}>
      <Icon size={11} className="text-slate-500" />
      <span className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={cn('h-1.5 w-1.5 rounded-full', i <= level ? 'bg-indigo-400' : 'bg-slate-700')}
          />
        ))}
      </span>
    </span>
  )
}

function ModelChooser() {
  const [data, setData] = useState<CatalogResponse | null>(null)
  const [prefs, setPrefs] = useState<ModelPrefs | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullMsg, setPullMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const loadCatalog = useCallback(async () => {
    try {
      const { data } = await api.get('/llm/ollama/catalog')
      setData(data as CatalogResponse)
    } catch { /* non-fatal */ }
  }, [])

  const loadPrefs = useCallback(async () => {
    try {
      const { data } = await api.get('/llm/model-prefs')
      setPrefs(data as ModelPrefs)
    } catch { /* non-fatal */ }
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await Promise.all([loadCatalog(), loadPrefs()])
      setLoading(false)
    })()
  }, [loadCatalog, loadPrefs])

  function selected(purpose: CatalogModel['purpose']): string {
    if (!prefs) return ''
    return String(prefs[PURPOSE_META[purpose].prefKey] ?? '')
  }

  function choose(purpose: CatalogModel['purpose'], name: string) {
    setPrefs((p) => (p ? { ...p, [PURPOSE_META[purpose].prefKey]: name } : p))
    setSaved(false)
  }

  async function savePrefs() {
    if (!prefs) return
    setSaving(true)
    try {
      await api.put('/llm/model-prefs', {
        embeddingModel: prefs.embeddingModel,
        embeddingProvider: prefs.embeddingProvider || 'ollama',
        embeddingBaseUrl: prefs.embeddingBaseUrl || '',
        relationModel: prefs.relationModel,
        distillModel: prefs.distillModel,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch { /* non-fatal */ } finally {
      setSaving(false)
    }
  }

  async function pull(name: string) {
    setPulling(name)
    setPullMsg(null)
    try {
      const { data } = await api.post('/llm/ollama/pull', { model: name })
      if (data.ok) {
        setPullMsg({ ok: true, text: `Installed ${name}.` })
        await loadCatalog()
      } else {
        setPullMsg({ ok: false, text: `Install failed: ${data.error ?? 'unknown error'}` })
      }
    } catch {
      setPullMsg({ ok: false, text: `Install failed — is Ollama reachable?` })
    } finally {
      setPulling(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-6 text-sm text-slate-500">
        <Loader2 size={15} className="animate-spin" /> Probing your Ollama for installed models…
      </div>
    )
  }

  const purposes: CatalogModel['purpose'][] = ['embedding', 'relation', 'distill']

  return (
    <div className="space-y-5">
      {/* System summary */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3 text-xs">
        <span className="flex items-center gap-1.5 text-slate-300" title={data?.ollamaBase}>
          <Cpu size={13} className="text-indigo-400" />
          Ollama: <span className="font-mono text-slate-400">{data?.ollamaBase ?? 'unknown'}</span>
        </span>
        <span className="text-slate-600">·</span>
        {data?.ollamaReachable ? (
          <span className="flex items-center gap-1 text-emerald-400">
            <Wifi size={12} /> Ollama reachable ({data.installed.length} model{data.installed.length === 1 ? '' : 's'} installed)
          </span>
        ) : (
          <span className="flex items-center gap-1 text-amber-400">
            <WifiOff size={12} /> Ollama not reachable
          </span>
        )}
        <button
          onClick={() => void loadCatalog()}
          className="ml-auto flex items-center gap-1 text-slate-500 hover:text-slate-300"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Not reachable → guide the user through exposing native Ollama (GPU). */}
      {data && !data.ollamaReachable && (
        <NativeOllamaGuide ollamaBase={data.ollamaBase} onRetest={() => void loadCatalog()} />
      )}

      {pullMsg && (
        <div className={cn(
          'flex items-start gap-2 rounded-md border px-3 py-2 text-[11px]',
          pullMsg.ok
            ? 'border-emerald-900/40 bg-emerald-950/20 text-emerald-300'
            : 'border-red-900/40 bg-red-950/20 text-red-400'
        )}>
          {pullMsg.ok ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
          <span>{pullMsg.text}</span>
        </div>
      )}

      {purposes.map((purpose) => {
        const meta = PURPOSE_META[purpose]
        const models = (data?.catalog ?? []).filter((m) => m.purpose === purpose)
        const sel = selected(purpose)
        const installedList = data?.installed ?? []
        const isInstalled = (n: string) =>
          installedList.some((i) => i === n || i.split(':')[0] === n.split(':')[0])
        const selInstalled = isInstalled(sel)
        // Installed models NOT in the curated set — surfaced so a user whose local
        // generation models crash (or who runs cloud-passthrough models) can still
        // pick something that works here, without code changes. Embedding models
        // are name-gated so chat models don't pollute the embedding picker.
        const isEmbeddingName = (n: string) => /embed|minilm|nomic|bge|mxbai|gte|e5-/i.test(n)
        const curatedNames = new Set(models.map((m) => m.name))
        const otherInstalled = installedList
          .filter((n) => !curatedNames.has(n) && !curatedNames.has(n.split(':')[0]))
          .filter((n) => (purpose === 'embedding' ? isEmbeddingName(n) : !isEmbeddingName(n)))
        return (
          <section key={purpose}>
            <h3 className="text-sm font-medium text-slate-200">{meta.title}</h3>
            <p className="mb-3 mt-0.5 text-xs text-slate-500">{meta.blurb}</p>
            <div className="space-y-2">
              {models.map((m) => {
                const isSel = m.name === sel
                return (
                  <div
                    key={m.name}
                    onClick={() => choose(purpose, m.name)}
                    className={cn(
                      'cursor-pointer rounded-lg border p-3 transition-colors',
                      isSel
                        ? 'border-indigo-500/60 bg-indigo-500/5'
                        : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
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
                        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
                          Not installed
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
                      {!m.installed && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void pull(m.name) }}
                          disabled={pulling !== null}
                          className="ml-auto flex items-center gap-1.5 rounded-md bg-indigo-500/20 px-2.5 py-1 text-[11px] font-medium text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:opacity-50"
                        >
                          {pulling === m.name ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                          {pulling === m.name ? 'Installing…' : 'Install'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Other installed models (e.g. cloud-passthrough or non-curated
                locals) — pick one when the curated locals don't run on this box. */}
            {otherInstalled.length > 0 && (
              <div className="mt-2">
                <p className="mb-1.5 text-[11px] text-slate-500">Other installed models on your Ollama:</p>
                <div className="flex flex-wrap gap-1.5">
                  {otherInstalled.map((n) => (
                    <button
                      key={n}
                      onClick={() => choose(purpose, n)}
                      className={cn(
                        'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                        n === sel
                          ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-300'
                          : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600'
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Escape hatch: any model name (handles models not yet pulled, or a
                remote/cloud model the engine should call by name). */}
            <div className="mt-2 flex items-center gap-2">
              <span className="shrink-0 text-[11px] text-slate-500">Custom:</span>
              <input
                value={sel}
                onChange={(e) => choose(purpose, e.target.value)}
                placeholder="exact model name, e.g. gpt-oss:120b-cloud"
                className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </div>

            {/* Only warn about a missing install when we can actually see the
                installed set — if Ollama is unreachable the list is empty and
                every model would falsely look uninstalled. */}
            {sel && !selInstalled && data?.ollamaReachable && (
              <p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-400">
                <AlertTriangle size={11} />
                {curatedNames.has(sel)
                  ? "The selected model isn't installed yet — click Install so the engine can use it."
                  : `"${sel}" isn't installed on your Ollama — pull it first, or pick an installed model above.`}
              </p>
            )}
          </section>
        )
      })}

      <div className="flex items-center gap-3 border-t border-slate-800 pt-4">
        <button
          onClick={() => void savePrefs()}
          disabled={saving || !prefs}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition-colors',
            saved ? 'bg-emerald-500/20 text-emerald-400' : 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30',
            'disabled:opacity-50'
          )}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
          {saved ? 'Saved' : 'Save model selection'}
        </button>
        <p className="text-[11px] text-slate-500">
          Applies to your next extraction / distillation. No code changes needed.
        </p>
      </div>
    </div>
  )
}

// ─── Tab: AI Models ───────────────────────────────────────────────────────────

function ModelsTab() {
  const [providers, setProviders] = useState<LlmProviderState[]>([])
  const [ollamaBase, setOllamaBase] = useState('')
  const [ollamaKey, setOllamaKey] = useState('')
  const [ollamaHasKey, setOllamaHasKey] = useState(false)
  const [ollamaSaved, setOllamaSaved] = useState(false)
  const [ollamaTesting, setOllamaTesting] = useState(false)
  const [ollamaTest, setOllamaTest] = useState<{ ok: boolean; msg: string } | null>(null)
  // The base URL the server currently has persisted (for the status chip).
  const [ollamaSavedBase, setOllamaSavedBase] = useState<string | null>(null)

  const loadProviders = useCallback(async () => {
    try {
      const { data } = await api.get('/llm/providers')
      const list = (data.providers ?? []) as LlmProviderState[]
      setProviders(list)
      const ollama = list.find((p) => p.provider === 'ollama')
      if (ollama?.baseUrl) setOllamaBase(ollama.baseUrl)
      setOllamaSavedBase(ollama?.baseUrl ?? null)
      setOllamaHasKey(Boolean(ollama?.hasKey))
    } catch { /* non-fatal */ }
  }, [])

  useEffect(() => { void loadProviders() }, [loadProviders])

  const stateFor = (id: string) => providers.find((p) => p.provider === id)

  async function saveOllamaBase() {
    try {
      const body: { provider: string; baseUrl?: string; apiKey?: string } = {
        provider: 'ollama',
        baseUrl: ollamaBase.trim() || undefined,
      }
      // Only send the key when the user typed one (sealed server-side). Empty input
      // leaves the existing stored key untouched.
      if (ollamaKey.trim()) body.apiKey = ollamaKey.trim()
      await api.put('/llm/providers', body)
      setOllamaKey('')
      setOllamaSaved(true)
      setTimeout(() => setOllamaSaved(false), 2000)
      void loadProviders()
    } catch { /* non-fatal */ }
  }

  async function testOllama() {
    setOllamaTesting(true)
    setOllamaTest(null)
    try {
      // Persist the current base + (if typed) key first so Test exercises them.
      const body: { provider: string; baseUrl?: string; apiKey?: string } = {
        provider: 'ollama',
        baseUrl: ollamaBase.trim() || undefined,
      }
      if (ollamaKey.trim()) body.apiKey = ollamaKey.trim()
      await api.put('/llm/providers', body)
      if (ollamaKey.trim()) setOllamaKey('')
      const { data } = await api.post('/llm/providers/ollama/test') as {
        data: { ok?: boolean; baseUrl?: string; resolvedBase?: string; models?: unknown; error?: string }
      }
      // Backend returns { ok, baseUrl, resolvedBase, models }. `models` may be an
      // array of model names or a numeric count depending on the build — handle both.
      const modelCount = Array.isArray(data.models)
        ? data.models.length
        : (typeof data.models === 'number' ? data.models : undefined)
      const target = data.resolvedBase || data.baseUrl || ollamaBase.trim() || 'Ollama'
      setOllamaTest({
        ok: !!data.ok,
        msg: data.ok
          ? `Connected to ${target}${modelCount !== undefined ? ` — ${modelCount} model${modelCount === 1 ? '' : 's'} available` : ''}`
          : (data.error ?? 'Test failed — is the URL reachable?'),
      })
      void loadProviders()
    } catch {
      setOllamaTest({ ok: false, msg: 'Test failed — is the URL reachable?' })
    } finally {
      setOllamaTesting(false)
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>Cloud Model Providers</SectionHeader>
        <div className="space-y-3">
          {API_KEY_FIELDS.map((field) => (
            <ProviderCard
              key={field.id}
              field={field}
              state={stateFor(field.id)}
              onChanged={loadProviders}
            />
          ))}
        </div>
      </section>

      <section>
        <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-sm font-medium text-slate-300">Local Ollama</span>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              Connected / local
            </span>
            {/* Status chip: shows the base URL the server currently has persisted. */}
            <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
              {ollamaSavedBase ? `Saved base: ${ollamaSavedBase}` : 'Saved base: bundled (http://localhost:11434)'}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Local Ollama models (llama3.2, mistral, qwen2.5, etc.) run on your machine and are always
            available without API keys — fully GDPR-compliant, no data leaves your device. For a
            remote or auth-protected Ollama (e.g. ollama.com / <code>:cloud</code> models), set the
            base URL and an API key below.
          </p>
          <div className="mt-3 space-y-2">
            <input
              value={ollamaBase}
              onChange={(e) => setOllamaBase(e.target.value)}
              placeholder="http://localhost:11434"
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
            <div className="flex gap-2">
              <input
                type="password"
                value={ollamaKey}
                onChange={(e) => setOllamaKey(e.target.value)}
                placeholder={ollamaHasKey ? '•••••••• (key stored — leave blank to keep)' : 'API key (optional, for remote/cloud Ollama)'}
                className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              />
              <button
                onClick={saveOllamaBase}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap',
                  ollamaSaved
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                )}
              >
                {ollamaSaved ? <Check size={14} /> : <Save size={14} />}
                {ollamaSaved ? 'Saved' : 'Save'}
              </button>
              <button
                onClick={testOllama}
                disabled={ollamaTesting}
                className="flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
              >
                {ollamaTesting ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />}
                Test connection
              </button>
            </div>
            {ollamaTest && (
              <div className={cn(
                'flex items-start gap-2 rounded-md border px-3 py-2 text-[11px]',
                ollamaTest.ok
                  ? 'border-emerald-900/40 bg-emerald-950/20 text-emerald-300'
                  : 'border-red-900/40 bg-red-950/20 text-red-400'
              )}>
                {ollamaTest.ok ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
                <span>{ollamaTest.msg}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section>
        <SectionHeader>Pipeline models (out-of-the-box)</SectionHeader>
        <p className="mb-4 -mt-2 text-xs text-slate-500">
          Choose the models KEX and FUSE use for embedding, relation extraction, and wiki
          distillation. Recommended defaults run locally on your Ollama for speed and GDPR
          compliance. Missing models can be installed with one click.
        </p>
        <ModelChooser />
      </section>
    </div>
  )
}

// ─── Tab: Integrations ────────────────────────────────────────────────────────

interface LiveConnector {
  id: string
  provider: string
  label: string
  providerEmail: string | null
  isActive: boolean
  lastSyncAt: string | null
  createdAt: string
}

interface ProviderConfig {
  id: string
  name: string
  description: string
  setupUrl: string
  redirectUri: string
  scopes: string[]
  configured: boolean
}

function IntegrationsTab() {
  const { user } = useAuth()
  const [liveConnectors, setLiveConnectors] = useState<LiveConnector[]>([])
  const [connecting, setConnecting] = useState<string | null>(null)
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([])
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [configForm, setConfigForm] = useState<{ clientId: string; clientSecret: string }>({ clientId: '', clientSecret: '' })
  const [configSaving, setConfigSaving] = useState(false)
  // Add source dropdown
  const [showAddSource, setShowAddSource] = useState(false)
  const [sourceSearch, setSourceSearch] = useState('')
  const [addedSources, setAddedSources] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('bh_added_sources') ?? '[]') } catch { return [] }
  })

  const loadConnectors = useCallback(async () => {
    try {
      const { data } = await api.get('/connectors')
      setLiveConnectors(data.connectors || [])
    } catch { /* non-fatal */ }
  }, [])

  const loadProviderConfigs = useCallback(async () => {
    try {
      const { data } = await api.get('/connectors/config/providers')
      setProviderConfigs(data.providers || [])
    } catch { /* non-fatal */ }
  }, [])

  useEffect(() => { void loadConnectors(); void loadProviderConfigs() }, [loadConnectors, loadProviderConfigs])

  const handleConnect = async (provider: string) => {
    const callerIsAdmin = user?.role === 'admin'
    // When OAuth isn't configured yet, don't dead-end: for an admin, open the
    // inline credentials form right here (that's the thing they need to fill in,
    // and it lives on this very page) instead of an alert telling them to "go to
    // Settings" — where they already are.
    const openSetup = () => {
      setExpandedRow(provider)
      setConfigForm({ clientId: '', clientSecret: '' })
    }
    setConnecting(provider)
    try {
      const { data } = await api.get(`/connectors/auth/${provider}`)
      if (data.authUrl) {
        window.open(data.authUrl, '_blank', 'width=600,height=700')
      } else if (data.error) {
        if (callerIsAdmin) openSetup()
        else alert(data.error)
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Connection failed'
      // 400 "not configured" → guide the admin into the setup form; surface other
      // (network/server) errors so they aren't silently swallowed.
      const notConfigured = /not configured|client id|client secret|Settings/i.test(msg)
      if (callerIsAdmin && notConfigured) openSetup()
      else alert(msg)
    } finally {
      setConnecting(null)
      setTimeout(() => void loadConnectors(), 3000)
    }
  }

  const handleDisconnect = async (connectorId: string) => {
    if (!confirm('Disconnect this account?')) return
    try {
      await api.delete(`/connectors/${connectorId}`)
      await loadConnectors()
    } catch { alert('Failed to disconnect') }
  }

  const handleToggleExpand = async (providerId: string) => {
    if (expandedRow === providerId) {
      setExpandedRow(null)
      return
    }
    setExpandedRow(providerId)
    setConfigForm({ clientId: '', clientSecret: '' })
    if (user?.role === 'admin') {
      try {
        const { data } = await api.get(`/connectors/config/${providerId}`)
        if (data.clientId) setConfigForm((prev) => ({ ...prev, clientId: data.clientId }))
      } catch { /* ignore */ }
    }
  }

  const handleSaveConfig = async (providerId: string) => {
    if (!configForm.clientId || !configForm.clientSecret) return
    setConfigSaving(true)
    try {
      await api.put(`/connectors/config/${providerId}`, configForm)
      setExpandedRow(null)
      setConfigForm({ clientId: '', clientSecret: '' })
      await loadProviderConfigs()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to save'
      alert(msg)
    } finally { setConfigSaving(false) }
  }

  const handleRemoveConfig = async (providerId: string) => {
    if (!confirm('Remove OAuth credentials?')) return
    try {
      await api.delete(`/connectors/config/${providerId}`)
      await loadProviderConfigs()
    } catch { alert('Failed to remove') }
  }

  const handleAddSource = (sourceId: string) => {
    if (!addedSources.includes(sourceId)) {
      const next = [...addedSources, sourceId]
      setAddedSources(next)
      localStorage.setItem('bh_added_sources', JSON.stringify(next))
    }
    setShowAddSource(false)
    setSourceSearch('')
  }

  const handleRemoveSource = (sourceId: string) => {
    const next = addedSources.filter((s) => s !== sourceId)
    setAddedSources(next)
    localStorage.setItem('bh_added_sources', JSON.stringify(next))
  }

  const getAccountState = (provider: string) => liveConnectors.filter((c) => c.provider === provider)
  const getProviderCfg = (provider: string) => providerConfigs.find((p) => p.id === provider)
  const isAdmin = user?.role === 'admin'

  // All OAuth providers shown as unified list items
  const oauthProviders = CONNECTED_ACCOUNTS.map((account) => {
    const live = getAccountState(account.id)
    const cfg = getProviderCfg(account.id)
    return { ...account, live, cfg, isConnected: live.length > 0, isConfigured: cfg?.configured ?? false }
  })

  // Filterable source list for dropdown
  const allSources = CONNECTORS.filter((c) => !addedSources.includes(c.id))
  const filteredSources = sourceSearch
    ? allSources.filter((c) => c.name.toLowerCase().includes(sourceSearch.toLowerCase()) || c.category.toLowerCase().includes(sourceSearch.toLowerCase()))
    : allSources

  return (
    <div className="space-y-6">
      {/* ── OAuth Integrations (unified rows) ─────────────────────── */}
      <section>
        <SectionHeader>Integrations</SectionHeader>
        <div className="space-y-1">
          {oauthProviders.map((p) => (
            <div key={p.id}>
              {/* Main row */}
              <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3 hover:border-slate-700 transition-colors">
                {/* Icon + name + status */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800">
                  <p.icon size={15} className="text-slate-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-200">{p.name}</span>
                    {p.isConnected && (
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-400">
                        Connected
                      </span>
                    )}
                    {!p.isConfigured && !p.isConnected && isAdmin && (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-500">
                        Needs Setup
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-slate-500">
                    {p.isConnected
                      ? p.live.map((c) => c.providerEmail || c.label).join(', ')
                      : p.description}
                  </p>
                  {!p.isConnected && !p.isConfigured && !isAdmin && (
                    <p className="mt-0.5 text-[10px] text-amber-500/80">
                      Ask an administrator to add {p.name} OAuth credentials before connecting.
                    </p>
                  )}
                </div>

                {/* Action buttons (all inline) */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {isAdmin && (
                    <button
                      onClick={() => void handleToggleExpand(p.id)}
                      className={cn(
                        'rounded border px-2 py-1 text-[10px] font-medium transition-colors',
                        expandedRow === p.id
                          ? 'border-indigo-700 bg-indigo-950/40 text-indigo-300'
                          : p.isConfigured
                            ? 'border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-300'
                            : 'border-amber-800/50 bg-amber-950/20 text-amber-400 hover:bg-amber-950/40'
                      )}
                    >
                      {p.isConfigured ? 'Credentials' : 'Setup'}
                    </button>
                  )}
                  {p.isConnected ? (
                    <button
                      onClick={() => p.live[0] && handleDisconnect(p.live[0].id)}
                      className="rounded border border-red-900/50 px-2 py-1 text-[10px] font-medium text-red-400 hover:bg-red-950/30 transition-colors"
                    >
                      Disconnect
                    </button>
                  ) : !p.isConfigured && isAdmin ? (
                    // Admin can configure credentials → guide them into the inline Setup form
                    // instead of a dead, greyed-out Connect button.
                    <button
                      onClick={() => void handleToggleExpand(p.id)}
                      className="rounded bg-amber-600/90 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-amber-500 transition-colors"
                    >
                      Set up &amp; Connect
                    </button>
                  ) : (
                    // Credentials may come from server env vars even when `configured` is
                    // false in the DB, so always let the user attempt the connection. The
                    // backend returns a clear, actionable error if OAuth truly isn't set up.
                    <button
                      onClick={() => handleConnect(p.id)}
                      disabled={connecting === p.id}
                      className="rounded bg-indigo-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
                    >
                      {connecting === p.id ? 'Connecting...' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded credentials form (inline, below the row) */}
              {expandedRow === p.id && isAdmin && (
                <div className="mx-4 mb-1 rounded-b-lg border border-t-0 border-slate-800 bg-slate-950/60 px-4 py-3">
                  <div className="flex items-start gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-[10px] font-medium text-slate-500">Client ID</label>
                          <input
                            type="text"
                            value={configForm.clientId}
                            onChange={(e) => setConfigForm((prev) => ({ ...prev, clientId: e.target.value }))}
                            placeholder="Paste Client ID"
                            className="mt-0.5 w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-[10px] font-medium text-slate-500">Client Secret</label>
                          <input
                            type="password"
                            value={configForm.clientSecret}
                            onChange={(e) => setConfigForm((prev) => ({ ...prev, clientSecret: e.target.value }))}
                            placeholder="Paste Client Secret"
                            className="mt-0.5 w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 text-[10px] text-slate-500">
                          <span>
                            Redirect URI:{' '}
                            <code className="rounded bg-slate-800 px-1 py-0.5 text-indigo-400 select-all">
                              {p.cfg?.redirectUri || ''}
                            </code>
                          </span>
                          <a href={p.cfg?.setupUrl || '#'} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300">
                            Open Developer Portal
                          </a>
                        </div>
                        <div className="flex gap-1.5">
                          {p.isConfigured && (
                            <button onClick={() => handleRemoveConfig(p.id)} className="rounded border border-red-900/50 px-2 py-1 text-[10px] text-red-400 hover:bg-red-950/30">
                              Remove
                            </button>
                          )}
                          <button
                            onClick={() => void handleSaveConfig(p.id)}
                            disabled={configSaving || !configForm.clientId || !configForm.clientSecret}
                            className="rounded bg-indigo-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                          >
                            {configSaving ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Obsidian Vaults (not OAuth — local / server / REST) ────── */}
      <section>
        <SectionHeader>Obsidian Vaults</SectionHeader>
        <p className="mb-3 text-xs text-slate-500">
          Connect Obsidian vaults from a local drive, a server-mounted folder, or the REST API plugin,
          then extract them in <span className="text-slate-400">KEX → Sources → Obsidian</span>.
        </p>
        <ObsidianVaultManager />
      </section>

      {/* ── Added Data Sources (list + add button) ────────────────── */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <SectionHeader>Data Sources</SectionHeader>
          <div className="relative">
            <button
              onClick={() => setShowAddSource(!showAddSource)}
              className="flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors"
            >
              <span className="text-base leading-none">+</span> Add Source
            </button>

            {/* Dropdown with search */}
            {showAddSource && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => { setShowAddSource(false); setSourceSearch('') }} />
                <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
                  <div className="p-2">
                    <input
                      type="text"
                      value={sourceSearch}
                      onChange={(e) => setSourceSearch(e.target.value)}
                      placeholder="Search sources..."
                      autoFocus
                      className="w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                  <div className="max-h-60 overflow-y-auto px-1 pb-1">
                    {filteredSources.length === 0 ? (
                      <p className="px-3 py-4 text-center text-xs text-slate-500">No sources found</p>
                    ) : (
                      filteredSources.map((source) => (
                        <button
                          key={source.id}
                          onClick={() => handleAddSource(source.id)}
                          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-slate-800 transition-colors"
                        >
                          <source.icon size={14} className="shrink-0 text-slate-500" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-slate-300">{source.name}</p>
                            <p className="text-[10px] text-slate-600">{source.category}</p>
                          </div>
                          {source.available ? (
                            <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[8px] text-emerald-400">Ready</span>
                          ) : (
                            <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[8px] text-slate-500">Soon</span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {addedSources.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-800 py-8 text-center">
            <Plug size={20} className="mx-auto text-slate-600" />
            <p className="mt-2 text-xs text-slate-500">No data sources added yet</p>
            <p className="text-[10px] text-slate-600">Click "Add Source" to connect databases, cloud storage, and more</p>
          </div>
        ) : (
          <div className="space-y-1">
            {addedSources.map((sourceId) => {
              const source = CONNECTORS.find((c) => c.id === sourceId)
              if (!source) return null
              const isConfigOpen = expandedRow === `source-${sourceId}`
              return (
                <div key={sourceId}>
                  <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800">
                      <source.icon size={15} className="text-slate-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-slate-200">{source.name}</span>
                      <p className="text-[10px] text-slate-600">{source.category}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {source.available && (
                        <button
                          onClick={() => setExpandedRow(isConfigOpen ? null : `source-${sourceId}`)}
                          className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-300 hover:bg-slate-700"
                        >
                          {isConfigOpen ? 'Close' : 'Configure'}
                        </button>
                      )}
                      {!source.available && (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-500">Coming Soon</span>
                      )}
                      <button
                        onClick={() => handleRemoveSource(sourceId)}
                        className="rounded p-1 text-slate-600 hover:bg-slate-800 hover:text-slate-400 transition-colors"
                        title="Remove source"
                      >
                        <X size={12} />
                    </button>
                  </div>
                </div>
                {/* Inline config form */}
                {isConfigOpen && source.available && (
                  <SourceConfigForm sourceId={sourceId} sourceName={source.name} category={source.category} />
                )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

// ─── Source Config Form (inline, per source type) ─────────────────────────────

function SourceConfigForm({ sourceId }: { sourceId: string; sourceName: string; category: string }) {
  const [config, setConfig] = useState<Record<string, string>>({})
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  // Field definitions per source type
  const fields: Array<{ key: string; label: string; type?: string; placeholder?: string }> = (() => {
    if (['postgresql', 'mysql', 'mongodb'].includes(sourceId)) {
      return [
        { key: 'host', label: 'Host', placeholder: 'localhost' },
        { key: 'port', label: 'Port', placeholder: sourceId === 'mongodb' ? '27017' : sourceId === 'mysql' ? '3306' : '5432' },
        { key: 'database', label: 'Database', placeholder: 'mydb' },
        { key: 'username', label: 'Username', placeholder: 'user' },
        { key: 'password', label: 'Password', type: 'password' },
      ]
    }
    if (['s3', 'gcs', 'azure', 'minio'].includes(sourceId)) {
      return [
        { key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.amazonaws.com' },
        { key: 'region', label: 'Region', placeholder: 'us-east-1' },
        { key: 'accessKeyId', label: 'Access Key ID' },
        { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password' },
        { key: 'bucket', label: 'Bucket', placeholder: 'my-bucket' },
      ]
    }
    if (sourceId === 'dropbox') return [{ key: 'accessToken', label: 'Access Token', type: 'password' }]
    if (sourceId === 'salesforce') return [
      { key: 'instanceUrl', label: 'Instance URL', placeholder: 'https://mycompany.salesforce.com' },
      { key: 'accessToken', label: 'Access Token', type: 'password' },
    ]
    if (sourceId === 'hubspot') return [{ key: 'accessToken', label: 'API Token', type: 'password' }]
    if (['jira', 'confluence'].includes(sourceId)) return [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://mycompany.atlassian.net' },
      { key: 'email', label: 'Email' },
      { key: 'apiToken', label: 'API Token', type: 'password' },
    ]
    if (sourceId === 'notion') return [{ key: 'apiToken', label: 'Integration Token', type: 'password' }]
    if (sourceId === 'linear') return [{ key: 'apiKey', label: 'API Key', type: 'password' }]
    if (sourceId === 'webcrawler') return [
      { key: 'url', label: 'Start URL', placeholder: 'https://example.com' },
      { key: 'maxDepth', label: 'Max Depth', placeholder: '3' },
      { key: 'maxPages', label: 'Max Pages', placeholder: '50' },
    ]
    if (sourceId === 'github') return [{ key: 'accessToken', label: 'Personal Access Token', type: 'password' }]
    return []
  })()

  async function handleSync() {
    setSyncing(true); setResult(null)
    try {
      let endpoint = ''
      let body: Record<string, unknown> = {}

      if (['postgresql', 'mysql', 'mongodb'].includes(sourceId)) {
        // First test connection, then list tables
        const testResp = await api.post('/database/test-connection', { config: { type: sourceId, ...config, port: parseInt(config.port || '5432') } })
        const tables = (testResp.data.tables || []).map((t: { name: string }) => t.name).slice(0, 10)
        if (tables.length === 0) { setResult('No tables found'); return }
        endpoint = '/database/sync'
        body = { config: { type: sourceId, ...config, port: parseInt(config.port || '5432') }, tables }
      } else if (['s3', 'gcs', 'azure', 'minio'].includes(sourceId)) {
        endpoint = '/sources/s3/sync'
        body = { config: { provider: sourceId, ...config }, keys: [] } // User would need to specify keys
        setResult('S3 sync requires file keys. Use the KEX Connected Sources tab to browse and select files.')
        return
      } else if (sourceId === 'dropbox') {
        endpoint = '/sources/dropbox/sync'
        body = { config, paths: [] }
        setResult('Dropbox sync requires file paths. Use the KEX Connected Sources tab.')
        return
      } else if (sourceId === 'salesforce') {
        endpoint = '/sources/salesforce/sync'
        body = { config, objects: ['contacts', 'deals', 'accounts'] }
      } else if (sourceId === 'hubspot') {
        endpoint = '/sources/hubspot/sync'
        body = { config, objects: ['contacts', 'deals', 'companies'] }
      } else if (sourceId === 'jira') {
        endpoint = '/sources/jira/sync'
        body = { config }
      } else if (sourceId === 'confluence') {
        endpoint = '/sources/confluence/sync'
        body = { config }
      } else if (sourceId === 'notion') {
        endpoint = '/sources/notion/sync'
        body = { config }
      } else if (sourceId === 'linear') {
        endpoint = '/sources/linear/sync'
        body = { config }
      } else if (sourceId === 'webcrawler') {
        endpoint = '/crawler/crawl'
        body = { url: config.url, maxDepth: parseInt(config.maxDepth || '3'), maxPages: parseInt(config.maxPages || '50') }
      } else {
        setResult('Sync not implemented for this source yet'); return
      }

      const { data } = await api.post(endpoint, body)
      const synced = data.synced ?? data.extracted ?? data.crawled ?? 0
      setResult(`Synced ${synced} items to KEX. Check Your Extractions for progress.`)
    } catch (err: unknown) {
      setResult((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Sync failed')
    } finally { setSyncing(false) }
  }

  if (fields.length === 0) return <p className="px-4 py-2 text-[10px] text-slate-500">No configuration needed for this source.</p>

  return (
    <div className="mx-4 mb-1 rounded-b-lg border border-t-0 border-slate-800 bg-slate-950/60 px-4 py-3">
      <div className="grid grid-cols-2 gap-2">
        {fields.map((f) => (
          <div key={f.key} className={f.key === 'url' || f.key === 'baseUrl' || f.key === 'instanceUrl' || f.key === 'endpoint' ? 'col-span-2' : ''}>
            <label className="text-[10px] font-medium text-slate-500">{f.label}</label>
            <input
              type={f.type || 'text'}
              value={config[f.key] || ''}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
              placeholder={f.placeholder || ''}
              className="mt-0.5 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        ))}
      </div>
      {result && (
        <p className={cn('mt-2 text-[10px]', result.includes('failed') || result.includes('error') ? 'text-red-400' : 'text-emerald-400')}>{result}</p>
      )}
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => void handleSync()}
          disabled={syncing || fields.some((f) => !f.type && !config[f.key]?.trim())}
          className="rounded bg-indigo-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Sync to KEX'}
        </button>
      </div>
    </div>
  )
}

// ─── Tab: Skills & Plugins ────────────────────────────────────────────────────

interface AgentSkill {
  id: string
  slug: string
  name: string
  description: string | null
  kind: 'builtin' | 'curated' | 'github'
  repoUrl: string | null
  locked: boolean
  enabled: boolean
  system: boolean
}

function skillIcon(kind: AgentSkill['kind'], slug: string) {
  if (kind === 'github') return Github
  if (slug === 'rag-expert') return Search
  if (slug === 'database-engineer') return Database
  if (kind === 'builtin') return Brain
  return Puzzle
}

function SkillsTab() {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [repoUrl, setRepoUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/skills')
      setSkills(data.skills ?? [])
    } catch {
      setError('Failed to load skills')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function toggle(skill: AgentSkill) {
    if (skill.locked) return
    // Optimistic flip
    const next = !skill.enabled
    setSkills((prev) => prev.map((s) => (s.slug === skill.slug ? { ...s, enabled: next } : s)))
    try {
      await api.post(`/skills/${skill.slug}/toggle`, { enabled: next })
    } catch {
      // Revert on failure
      setSkills((prev) => prev.map((s) => (s.slug === skill.slug ? { ...s, enabled: !next } : s)))
    }
  }

  async function addGithub() {
    if (!repoUrl.trim()) return
    setAdding(true); setError(null)
    try {
      await api.post('/skills', { repoUrl: repoUrl.trim() })
      setRepoUrl('')
      await load()
    } catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not add skill')
    } finally {
      setAdding(false)
    }
  }

  async function removeGithub(id: string) {
    setSkills((prev) => prev.filter((s) => s.id !== id))
    try {
      await api.delete(`/skills/id/${id}`)
    } catch {
      await load()
    }
  }

  const systemSkills = skills.filter((s) => s.system)
  const githubSkills = skills.filter((s) => !s.system && s.kind === 'github')

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>Agent Skills</SectionHeader>
        <p className="mb-4 text-xs text-slate-500">
          Skills shape what the Pi agent is good at. Built-in tools are always on; curated skills can be toggled per account.
        </p>
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : (
          <div className="space-y-2">
            {systemSkills.map((skill) => {
              const Icon = skillIcon(skill.kind, skill.slug)
              return (
                <div
                  key={skill.slug}
                  className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 p-4 transition-colors hover:border-slate-700"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800">
                      <Icon size={16} className="text-slate-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-200">{skill.name}</p>
                        {skill.locked && (
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-400">
                            Built-in · always on
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">{skill.description}</p>
                    </div>
                  </div>

                  <button
                    onClick={() => void toggle(skill)}
                    disabled={skill.locked}
                    title={skill.locked ? 'Built-in skill — cannot be disabled' : undefined}
                    className={cn(
                      'relative h-5 w-9 rounded-full transition-colors focus:outline-none',
                      skill.enabled ? 'bg-blue-500' : 'bg-slate-700',
                      skill.locked && 'cursor-not-allowed opacity-70'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
                        skill.enabled ? 'left-[18px]' : 'left-0.5'
                      )}
                    />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <SectionHeader>Skills from GitHub</SectionHeader>
        <p className="mb-3 text-xs text-slate-500">
          Add any public skill repo — we'll use its <code className="text-slate-400">SKILL.md</code>, a <code className="text-slate-400">manifest.json</code>/<code className="text-slate-400">plugin.json</code>, or fall back to its <code className="text-slate-400">README.md</code>. Paste a repo or a link to a specific skill folder. Its guidance is folded into the agent.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addGithub() }}
            placeholder="https://github.com/owner/repo"
            className="flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={() => void addGithub()}
            disabled={adding || !repoUrl.trim()}
            className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {adding ? <Loader2 size={13} className="animate-spin" /> : <Github size={13} />} Add
          </button>
        </div>
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}

        {githubSkills.length > 0 && (
          <div className="mt-4 space-y-2">
            {githubSkills.map((skill) => (
              <div key={skill.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800">
                    <Github size={16} className="text-slate-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-200">{skill.name}</p>
                    {skill.repoUrl && (
                      <a href={skill.repoUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-400 hover:underline">
                        {skill.repoUrl.replace('https://github.com/', '')}
                      </a>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => void removeGithub(skill.id)}
                  className="rounded p-1.5 text-slate-600 hover:bg-slate-800 hover:text-red-400 transition-colors"
                  title="Remove skill"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ─── Tab: Agent ───────────────────────────────────────────────────────────────

function AgentTab() {
  const [providers, setProviders] = useState<LlmProviderState[]>([])
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [gatewayEnabled, setGatewayEnabled] = useState<boolean | null>(null)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api.get('/llm/providers')
        setProviders((data.providers ?? []) as LlmProviderState[])
      } catch { /* non-fatal */ }
      try {
        const { data } = await api.get('/skills')
        setSkills((data.skills ?? []) as AgentSkill[])
      } catch { /* non-fatal */ }
      try {
        const { data } = await api.get('/agent/gateway/status')
        setGatewayEnabled(!!data.enabled)
      } catch { setGatewayEnabled(false) }
    })()
  }, [])

  function copyText(text: string, id: string) {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(''), 2000)
  }

  const activeProvider = providers.find((p) => p.isActive)
    ?? providers.find((p) => p.connected)
    ?? providers.find((p) => p.provider === 'ollama')
  const activeModel = activeProvider?.defaultModel ?? null
  const enabledSkills = skills.filter((s) => s.enabled).length

  const [mcpToken, setMcpToken] = useState<string | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [genErr, setGenErr] = useState<string | null>(null)

  // One-click full-access token for the MCP gateway: a max-rank, non-KB-scoped
  // Access Token. Shown once (only the hash is stored), revocable on /access.
  async function generateFullAccessToken() {
    setGenBusy(true); setGenErr(null)
    try {
      const { data } = await api.post('/users/api-keys', {
        name: 'Full Access (MCP)',
        maxClearanceRank: 1000,
        kbScoped: false,
      })
      setMcpToken(data.key as string)
    } catch (err: unknown) {
      setGenErr((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not create token')
    } finally {
      setGenBusy(false)
    }
  }

  const origin = window.location.origin
  const endpoint = `${origin}/api/agent/mcp`
  const tokenForConfig = mcpToken ?? '<your-access-token>'

  const mcpConfig = JSON.stringify({
    gctrl: {
      url: endpoint,
      headers: {
        Authorization: `ApiKey ${tokenForConfig}`,
      },
    },
  }, null, 2)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Pi Agent Harness</h2>
        <p className="mt-1 text-sm text-slate-500">
          Pi is GCTRL&apos;s built-in knowledge agent. It reasons over your graphs with a
          connected LLM and a set of clearance-scoped tools. You can expose it to external
          multi-agent orchestrators over the network via the MCP gateway below.
        </p>
      </div>

      {/* ── Harness summary ─────────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2">
            <Brain size={15} className="text-blue-400" />
            <span className="text-sm font-medium text-slate-200">Connected LLM</span>
          </div>
          <p className="mt-2 text-sm text-slate-300 capitalize">
            {activeProvider ? activeProvider.provider : 'Local Ollama'}
          </p>
          <p className="text-xs text-slate-500 font-mono">
            {activeModel ?? 'default model'}
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2">
            <Puzzle size={15} className="text-violet-400" />
            <span className="text-sm font-medium text-slate-200">Enabled Skills</span>
          </div>
          <p className="mt-2 text-2xl font-semibold text-slate-100">{enabledSkills}</p>
          <p className="text-xs text-slate-500">
            shaping Pi&apos;s behavior — manage in <span className="text-slate-400">Skills &amp; Plugins</span>
          </p>
        </div>
      </section>

      {/* ── External access (MCP gateway) ───────────────────────────── */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-slate-300" />
            <h3 className="text-sm font-semibold text-slate-200">External Access — MCP Gateway</h3>
          </div>
          {gatewayEnabled === null ? (
            <span className="flex items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-1 text-[11px] text-slate-400">
              <Loader2 size={10} className="animate-spin" /> Checking…
            </span>
          ) : gatewayEnabled ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
              <Wifi size={11} /> Enabled
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-400">
              <WifiOff size={11} /> Disabled
            </span>
          )}
        </div>

        <p className="text-xs text-slate-500">
          Exposes the Pi harness as a remote{' '}
          <span className="text-slate-400">MCP-over-HTTP</span> endpoint so external orchestrators
          (Hermes, OpenClaw, Codex, any MCP client) can drive it over the network. Every call is
          authenticated with a scoped Access Token, filtered to that token&apos;s clearance and
          per-graph grants, and written to the access audit log.
        </p>

        {!gatewayEnabled && gatewayEnabled !== null && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2.5">
            <Lock size={13} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="text-[11px] text-amber-200/90">
              <p className="font-medium text-amber-300">Currently disabled.</p>
              <p className="mt-0.5 text-amber-200/70">
                The gateway is on by default; it was turned off via{' '}
                <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-amber-300">GCTRL_AGENT_GATEWAY_ENABLED=false</code>.
                Remove that (or set it to <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-amber-300">true</code>) in the API
                server environment and restart to re-enable.
              </p>
            </div>
          </div>
        )}

        {/* Endpoint */}
        <div className="mt-4">
          <label className="text-xs text-slate-500">Endpoint URL</label>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-slate-800 px-3 py-2 font-mono text-xs text-slate-300 break-all">
              {endpoint}
            </code>
            <button
              onClick={() => copyText(endpoint, 'endpoint')}
              className="btn-ghost text-slate-500 hover:text-slate-300"
            >
              {copied === 'endpoint' ? <Check size={14} /> : <ChevronRight size={14} />}
            </button>
          </div>
        </div>

        {/* Client config */}
        <div className="mt-4">
          <label className="text-xs text-slate-500">MCP client config (remote, HTTP transport)</label>
          <div className="relative mt-1">
            <pre className="overflow-x-auto whitespace-pre rounded-lg bg-slate-800 p-4 font-mono text-xs text-slate-300">
{mcpConfig}
            </pre>
            <button
              onClick={() => copyText(mcpConfig, 'config')}
              className="absolute right-2 top-2 rounded-lg bg-slate-700 px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200 transition-colors"
            >
              {copied === 'config' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {/* Full-access token generator — fills the config above on success */}
          <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
            {mcpToken ? (
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                  <Check size={12} /> Full-access token created — copy it now, it won&apos;t be shown again.
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <code className="flex-1 rounded bg-slate-800 px-2.5 py-1.5 font-mono text-xs text-amber-300 break-all">{mcpToken}</code>
                  <button onClick={() => copyText(mcpToken, 'token')} className="rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:text-white">
                    {copied === 'token' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="mt-2 text-[10px] text-slate-500">
                  It&apos;s now in your API keys (config above is filled in) and can be revoked anytime on the{' '}
                  <a href="/access" className="text-blue-400 hover:underline">Access Control page</a>.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-slate-500">
                  Need a token fast? Generate a <span className="text-slate-300">full-access</span> one (shown once, revocable).
                </p>
                <button
                  onClick={() => void generateFullAccessToken()}
                  disabled={genBusy}
                  className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {genBusy ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
                  Generate full-access token
                </button>
              </div>
            )}
            {genErr && <p className="mt-2 text-[11px] text-red-400">{genErr}</p>}
            <p className="mt-2 text-[10px] text-slate-600">
              Or scope a narrower token (clearance + per-graph grants) on the{' '}
              <a href="/access" className="inline-flex items-center gap-0.5 text-blue-400 hover:underline">
                Access Control page <ExternalLink size={10} /></a>. All calls are audited and clearance-scoped.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}

// ─── Tab: MCP Server ──────────────────────────────────────────────────────────

function McpTab() {
  const [copied, setCopied] = useState('')
  const cfg = usePublicConfig()
  const mcpEndpoint = cfg.mcpEndpoint // e.g. http://localhost:3001/api

  function copyText(text: string, id: string) {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(''), 2000)
  }

  // The MCP server runs on the USER's machine over stdio, so its filesystem
  // path is client-side and unknown to the server. Ship a portable placeholder
  // the user replaces with their own checkout/install path — never a baked-in
  // absolute developer path.
  const mcpServerPath = '/path/to/gctrl/services/mcp/dist/index.js'

  const mcpConfig = JSON.stringify({
    mcpServers: {
      gctrl: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          GCTRL_API_URL: mcpEndpoint,
          GCTRL_API_TOKEN: '<your-access-token>',
        },
      },
    },
  }, null, 2)

  const tools = [
    { name: 'gctrl_extract', desc: 'Extract knowledge from text → Neo4j entities + Qdrant vectors' },
    { name: 'gctrl_query', desc: 'Ask questions about knowledge graphs (hybrid RAG)' },
    { name: 'gctrl_store', desc: 'Store knowledge — like Obsidian notes but with KG extraction' },
    { name: 'gctrl_search_entities', desc: 'Search entities by name or type' },
    { name: 'gctrl_list_graphs', desc: 'List all knowledge graph compilations' },
    { name: 'gctrl_fuse', desc: 'Merge extraction jobs into unified graphs' },
    { name: 'gctrl_list_ontologies', desc: 'List available ontologies' },
    { name: 'gctrl_list_extractions', desc: 'List recent extraction jobs' },
    { name: 'gctrl_schema', desc: 'Get the knowledge graph schema' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">MCP Server</h2>
        <p className="mt-1 text-sm text-slate-500">
          Connect Claude Code or any MCP-compatible AI agent to GCTRL as a persistent knowledge store.
        </p>
      </div>

      {/* Status */}
      <div className="card flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10">
          <Code2 size={20} className="text-emerald-400" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-slate-200">Server Status</p>
          <p className="text-xs text-slate-500">Running on stdio transport — connect via Claude Code MCP settings</p>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Ready
        </span>
      </div>

      {/* Connection Info */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Connection Details</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-500">API Endpoint</label>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300 font-mono">
                {mcpEndpoint}
              </code>
              <button
                onClick={() => copyText(mcpEndpoint, 'endpoint')}
                className="btn-ghost text-slate-500 hover:text-slate-300"
              >
                {copied === 'endpoint' ? <Check size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-500">
              MCP Server Path <span className="text-slate-600">— replace with your local checkout path</span>
            </label>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300 font-mono break-all">
                {mcpServerPath}
              </code>
              <button
                onClick={() => copyText(mcpServerPath, 'path')}
                className="btn-ghost text-slate-500 hover:text-slate-300"
              >
                {copied === 'path' ? <Check size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Setup Instructions */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Setup for Claude Code</h3>
        <p className="mb-3 text-xs text-slate-500">
          Add to your Claude Code MCP settings or run <code className="text-blue-400">/mcp add</code>:
        </p>
        <div className="relative">
          <pre className="rounded-lg bg-slate-800 p-4 text-xs text-slate-300 font-mono overflow-x-auto whitespace-pre">
{mcpConfig}
          </pre>
          <button
            onClick={() => copyText(mcpConfig, 'config')}
            className="absolute right-2 top-2 rounded-lg bg-slate-700 px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200 transition-colors"
          >
            {copied === 'config' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          Replace <code className="text-amber-400">&lt;your-access-token&gt;</code> with a scoped
          Access Token (created on the{' '}
          <a href="/access" className="text-blue-400 hover:underline">Access Control</a> page). It
          is sent as <code className="text-blue-400">Authorization: ApiKey &lt;token&gt;</code>.
        </p>
      </div>

      {/* Available Tools */}
      <div className="card p-0 overflow-hidden">
        <div className="border-b border-slate-800 px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-200">
            Available Tools <span className="text-slate-600">({tools.length})</span>
          </h3>
        </div>
        <div className="divide-y divide-slate-800">
          {tools.map((tool) => (
            <div key={tool.name} className="flex items-start gap-3 px-5 py-3">
              <code className="mt-0.5 shrink-0 rounded bg-blue-500/10 px-2 py-0.5 text-[11px] font-mono text-blue-400">
                {tool.name}
              </code>
              <p className="text-xs text-slate-400">{tool.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Use Cases */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Use Cases</h3>
        <ul className="space-y-2 text-xs text-slate-400">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-400">●</span>
            <span><strong className="text-slate-300">Persistent Memory</strong> — Store project context, decisions, and progress that survives across sessions</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-blue-400">●</span>
            <span><strong className="text-slate-300">Team Knowledge Base</strong> — Multiple agents share and query the same knowledge graphs</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-violet-400">●</span>
            <span><strong className="text-slate-300">Document Intelligence</strong> — Extract entities and relations from any document, query them in natural language</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-amber-400">●</span>
            <span><strong className="text-slate-300">Grounded Answers</strong> — AI answers backed by graph facts + document context, with confidence scores and source tracing</span>
          </li>
        </ul>
      </div>
    </div>
  )
}

// ─── Tab: n8n Integration ─────────────────────────────────────────────────────

function N8nTab() {
  const [copied, setCopied] = useState('')
  const cfg = usePublicConfig()

  function copyText(text: string, id: string) {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(''), 2000)
  }

  const installCmd = 'cd ~/.n8n && npm install n8n-nodes-GCTRL'
  const credentialConfig = JSON.stringify({
    baseUrl: cfg.apiOrigin,
    authMethod: 'emailPassword',
    email: '(your email)',
    password: '(your password)',
  }, null, 2)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">n8n Integration</h2>
        <p className="mt-1 text-sm text-slate-500">
          Use GCTRL as native nodes inside n8n workflows — extract knowledge, query graphs, and give AI agents persistent memory.
        </p>
      </div>

      {/* Package Info */}
      <div className="card flex items-center gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-orange-500/10">
          <span className="text-lg font-bold text-orange-400">n8n</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-slate-200">n8n-nodes-GCTRL</p>
          <p className="text-xs text-slate-500">Community node package — 4 nodes, 1 credential type</p>
        </div>
        <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
          v0.1.0
        </span>
      </div>

      {/* Installation */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Installation</h3>
        <p className="mb-3 text-xs text-slate-500">
          Install the community node in your n8n instance:
        </p>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-600">Option 1: n8n UI (recommended)</label>
            <div className="mt-1 rounded-lg bg-slate-800 p-3 text-xs text-slate-400">
              <ol className="list-inside list-decimal space-y-1">
                <li>Go to <strong className="text-slate-300">Settings &gt; Community Nodes</strong> in n8n</li>
                <li>Click <strong className="text-slate-300">Install a community node</strong></li>
                <li>Enter: <code className="rounded bg-slate-700 px-1.5 py-0.5 text-orange-300">n8n-nodes-GCTRL</code></li>
                <li>Click <strong className="text-slate-300">Install</strong></li>
              </ol>
            </div>
          </div>

          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-600">Option 2: CLI</label>
            <div className="relative mt-1">
              <code className="block rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300 font-mono">
                {installCmd}
              </code>
              <button
                onClick={() => copyText(installCmd, 'install')}
                className="absolute right-2 top-1.5 rounded bg-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
              >
                {copied === 'install' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-600">Option 3: Local development</label>
            <div className="mt-1 rounded-lg bg-slate-800 p-3 text-xs text-slate-400">
              The package source is at <code className="text-blue-400">GCTRL/n8n-nodes-GCTRL/</code>.
              Run <code className="text-orange-300">npm run build</code> then symlink into your n8n custom nodes directory.
            </div>
          </div>
        </div>
      </div>

      {/* Credential Setup */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Credential Setup</h3>
        <p className="mb-3 text-xs text-slate-500">
          After installation, create a <strong className="text-slate-300">GCTRL API</strong> credential in n8n:
        </p>
        <div className="relative">
          <pre className="rounded-lg bg-slate-800 p-4 text-xs text-slate-300 font-mono overflow-x-auto whitespace-pre">
{credentialConfig}
          </pre>
          <button
            onClick={() => copyText(credentialConfig, 'cred')}
            className="absolute right-2 top-2 rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200"
          >
            {copied === 'cred' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-600">
          Supports API Key auth (recommended for production) or Email/Password with auto-refreshing JWT.
        </p>
      </div>

      {/* Available Nodes */}
      <div className="card p-0 overflow-hidden">
        <div className="border-b border-slate-800 px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-200">
            Available Nodes <span className="text-slate-600">(4)</span>
          </h3>
        </div>
        <div className="divide-y divide-slate-800">
          {[
            {
              name: 'GCTRL',
              type: 'Action',
              color: 'text-blue-400 bg-blue-500/10',
              desc: 'All-in-one node with operations for Knowledge (Extract, Store, Upload, Jobs), Query (Ask, Schema), Graphs (List, Create, Refresh, Delete), Fusion (Merge, Jobs), Entities (Search), and Ontologies (List).',
            },
            {
              name: 'GCTRL Trigger',
              type: 'Trigger',
              color: 'text-emerald-400 bg-emerald-500/10',
              desc: 'Polling trigger that fires when extraction or fusion jobs complete. Use to chain workflows: extract → fuse → notify.',
            },
            {
              name: 'GCTRL Memory',
              type: 'AI Memory',
              color: 'text-violet-400 bg-violet-500/10',
              desc: 'Persistent memory for AI Agent nodes. Unlike in-memory stores, conversations become structured knowledge with entities and embeddings. Survives across workflow executions.',
            },
            {
              name: 'GCTRL Knowledge Tool',
              type: 'AI Tool',
              color: 'text-amber-400 bg-amber-500/10',
              desc: 'Give AI agents access to your knowledge graphs during reasoning. Returns grounded answers with confidence scores and sources. Scope to specific compilations.',
            },
          ].map((node) => (
            <div key={node.name} className="px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-200">{node.name}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-medium', node.color)}>
                  {node.type}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{node.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Workflow Examples */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Workflow Ideas</h3>
        <div className="space-y-3">
          {[
            {
              title: 'Auto-Extract on File Upload',
              flow: 'Webhook Trigger → GCTRL Extract → GCTRL Fuse → Slack Notification',
              desc: 'Automatically extract knowledge from uploaded documents and merge into a unified graph.',
            },
            {
              title: 'AI Agent with Knowledge Memory',
              flow: 'Chat Trigger → AI Agent + GCTRL Memory + GCTRL Knowledge Tool',
              desc: 'Chat agent that remembers conversations as knowledge and queries your graphs for grounded answers.',
            },
            {
              title: 'Scheduled Google Drive Sync',
              flow: 'Schedule Trigger → Google Drive (List) → GCTRL Extract (loop) → GCTRL Fuse',
              desc: 'Periodically sync new files from Drive into GCTRL knowledge graphs.',
            },
            {
              title: 'GitHub Issue Intelligence',
              flow: 'GitHub Trigger (new issue) → GCTRL Extract → GCTRL Query → GitHub (add comment)',
              desc: 'Auto-analyze new issues against your knowledge base and add relevant context as comments.',
            },
          ].map((example) => (
            <div key={example.title} className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
              <p className="text-xs font-medium text-slate-200">{example.title}</p>
              <p className="mt-1 font-mono text-[10px] text-indigo-400">{example.flow}</p>
              <p className="mt-1 text-[11px] text-slate-500">{example.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Tab: Personal Memory (A6 — user-profile personalization, GDPR-aware) ──────

interface ProfileFact {
  category: string
  fact: string
}

interface UserProfile {
  enabled: boolean
  facts: ProfileFact[]
  summary: string
  updatedAt: string | null
}

const FACT_CATEGORIES = ['role', 'expertise', 'preference', 'working_style', 'context', 'other']

function PersonalMemoryTab() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [facts, setFacts] = useState<ProfileFact[]>([])
  const [summary, setSummary] = useState('')
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get<UserProfile>('/user/profile')
      setProfile(data)
      setFacts(Array.isArray(data.facts) ? data.facts : [])
      setSummary(data.summary || '')
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to load profile')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleEnabled(next: boolean) {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { data } = await api.put<UserProfile>('/user/profile', { enabled: next })
      setProfile(data)
      setNotice(next ? 'Personal memory enabled.' : 'Personal memory disabled.')
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to update')
    } finally {
      setSaving(false)
    }
  }

  async function buildProfile() {
    setBuilding(true)
    setError(null)
    setNotice(null)
    try {
      const { data } = await api.post<UserProfile & { messageCount?: number }>('/user/profile/build')
      setProfile(data)
      setFacts(Array.isArray(data.facts) ? data.facts : [])
      setSummary(data.summary || '')
      const n = (data as any).messageCount
      setNotice(
        n === 0
          ? 'No standard-mode conversation history yet — have a few standard chats first, then rebuild.'
          : `Profile built from ${n ?? 'your'} standard-mode messages.`,
      )
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Build failed')
    } finally {
      setBuilding(false)
    }
  }

  async function saveEdits() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const clean = facts
        .map((f) => ({ category: (f.category || 'other').trim(), fact: (f.fact || '').trim() }))
        .filter((f) => f.fact)
      const { data } = await api.put<UserProfile>('/user/profile', { facts: clean, summary: summary.trim() })
      setProfile(data)
      setFacts(Array.isArray(data.facts) ? data.facts : [])
      setSummary(data.summary || '')
      setNotice('Saved.')
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function eraseAll() {
    if (!window.confirm('Delete your personal memory permanently? This wipes all distilled facts and your summary. This cannot be undone.')) {
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await api.delete('/user/profile')
      setProfile({ enabled: false, facts: [], summary: '', updatedAt: null })
      setFacts([])
      setSummary('')
      setNotice('Your personal memory was erased.')
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Erase failed')
    } finally {
      setSaving(false)
    }
  }

  const enabled = profile?.enabled ?? false

  return (
    <div className="space-y-8">
      {/* Opt-in */}
      <section>
        <SectionHeader>Personal Memory</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-4">
          <div className="flex items-start gap-3">
            <Sparkles size={18} className="mt-0.5 shrink-0 text-violet-400" />
            <div className="flex-1">
              <p className="text-sm text-slate-300">
                Let the assistant distil durable facts about you (your role, expertise, preferences, working
                style) from your <span className="font-medium text-slate-200">standard-mode</span> conversations,
                and use them to personalize answers.
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Privacy by design: this is <span className="text-slate-400">opt-in</span>. Incognito chats are
                never read and never personalized. You can view, edit, and permanently erase this memory at any
                time.
              </p>
            </div>
            <button
              type="button"
              disabled={saving || loading}
              onClick={() => toggleEnabled(!enabled)}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                enabled ? 'bg-violet-500' : 'bg-slate-700',
                (saving || loading) && 'opacity-50',
              )}
              aria-pressed={enabled}
              aria-label="Toggle personal memory"
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                  enabled ? 'translate-x-6' : 'translate-x-1',
                )}
              />
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              <X size={14} /> {error}
            </div>
          )}
          {notice && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-900/50 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
              <Check size={14} /> {notice}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!enabled || building || saving}
              onClick={buildProfile}
              className={cn(
                'inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500',
                (!enabled || building || saving) && 'cursor-not-allowed opacity-50',
              )}
            >
              {building ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {building ? 'Building…' : 'Build my profile'}
            </button>
            {profile?.updatedAt && (
              <span className="inline-flex items-center text-[11px] text-slate-500">
                Last updated {new Date(profile.updatedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* View / edit */}
      <section>
        <SectionHeader>Distilled Facts</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">Summary</label>
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={3}
                  placeholder="A short summary of who you are and how you like to work. Build your profile to auto-fill this, or write it yourself."
                  className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-500">Facts</label>
                {facts.length === 0 && (
                  <p className="text-xs text-slate-600">
                    No facts yet. Build your profile or add facts manually.
                  </p>
                )}
                {facts.map((f, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      value={FACT_CATEGORIES.includes(f.category) ? f.category : 'other'}
                      onChange={(e) => {
                        const next = [...facts]
                        next[i] = { ...next[i], category: e.target.value }
                        setFacts(next)
                      }}
                      className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-xs text-slate-300 focus:border-violet-500 focus:outline-none"
                    >
                      {FACT_CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <input
                      value={f.fact}
                      onChange={(e) => {
                        const next = [...facts]
                        next[i] = { ...next[i], fact: e.target.value }
                        setFacts(next)
                      }}
                      className="flex-1 rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-sm text-slate-200 focus:border-violet-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setFacts(facts.filter((_, j) => j !== i))}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-red-400"
                      aria-label="Remove fact"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setFacts([...facts, { category: 'other', fact: '' }])}
                  className="inline-flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-300"
                >
                  <Plus size={14} /> Add fact
                </button>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={saveEdits}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-600',
                    saving && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Save
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Erase (right-to-be-forgotten) */}
      <section>
        <SectionHeader>Right to be Forgotten</SectionHeader>
        <div className="rounded-lg border border-red-900/40 bg-red-950/20 p-4">
          <div className="flex items-start gap-3">
            <Trash2 size={18} className="mt-0.5 shrink-0 text-red-400" />
            <div className="flex-1">
              <p className="text-sm text-slate-300">Delete my personal memory</p>
              <p className="mt-1 text-[11px] text-slate-500">
                Permanently wipes all distilled facts and your summary (GDPR / DSGVO erasure). This cannot be
                undone.
              </p>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={eraseAll}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border border-red-700 bg-red-900/40 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-900/70',
                saving && 'cursor-not-allowed opacity-50',
              )}
            >
              <Trash2 size={14} /> Delete my personal memory
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

// ─── Tab: Account ─────────────────────────────────────────────────────────────

function AccountTab() {
  const { user, logout } = useAuth()
  const { balance: liveBalance } = useTokenBalance()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  const TIER_COLORS: Record<string, string> = {
    free: 'bg-slate-800 text-slate-400',
    starter: 'bg-blue-500/20 text-blue-400',
    pro: 'bg-emerald-500/20 text-emerald-400',
    enterprise: 'bg-amber-500/20 text-amber-400',
  }

  return (
    <div className="space-y-8">
      {/* Profile */}
      <section>
        <SectionHeader>Profile</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Display Name</label>
              <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-300">
                {user?.name ?? '—'}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Email</label>
              <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-300">
                {user?.email ?? '—'}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Role</label>
              <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm capitalize text-slate-300">
                {user?.role ?? '—'}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Clearance</label>
              <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-300">
                {user?.clearance ?? '—'}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-slate-600">Profile details are managed by your administrator.</p>
        </div>
      </section>

      {/* Token Balance */}
      <section>
        <SectionHeader>Token Balance</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-3">
            <Coins size={20} className="text-amber-400" />
            <div>
              <p className="text-xl font-semibold text-slate-100">
                {liveBalance.toLocaleString()}
              </p>
              <p className="text-xs text-slate-500">tokens remaining</p>
            </div>
            {user?.tier && (
              <span
                className={cn(
                  'ml-auto rounded-full px-3 py-1 text-xs font-medium capitalize',
                  TIER_COLORS[user.tier] ?? 'bg-slate-800 text-slate-400'
                )}
              >
                {user.tier} plan
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Default Ontology */}
      <section>
        <SectionHeader>Default Ontology</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-300">
                {user?.defaultOntologyId
                  ? `Ontology ID: ${user.defaultOntologyId}`
                  : 'No default ontology selected'}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Used as the default when creating new extractions and fusions.
              </p>
            </div>
            <button
              onClick={() => navigate('/ontologies')}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors"
            >
              Manage
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      </section>

      {/* Access Tokens — managed in Access Control (no duplicate CRUD here) */}
      <section>
        <SectionHeader>Access Tokens</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <KeyRound size={18} className="text-slate-500" />
              <div>
                <p className="text-sm text-slate-300">Manage access tokens in Access Control</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Create, scope (clearance + per-graph grants), and revoke API tokens there.
                </p>
              </div>
            </div>
            <button
              onClick={() => navigate('/access')}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors"
            >
              Access Control
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      </section>

      {/* Danger Zone */}
      <section>
        <SectionHeader>Session</SectionHeader>
        <div className="rounded-lg border border-red-900/30 bg-red-950/10 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-200">Sign Out</p>
              <p className="text-xs text-slate-500">End your current session and return to login.</p>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/20 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-950/40 transition-colors"
            >
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

// ─── Tab: Infrastructure ──────────────────────────────────────────────────────

interface ServiceStatus {
  connected: boolean
  latencyMs: number | null
  url: string
  source?: 'default' | 'override'
  swappable?: boolean
}

interface SetupStatus {
  services: {
    neo4j:    ServiceStatus
    qdrant:   ServiceStatus
    ollama:   ServiceStatus
    postgres: ServiceStatus
    redis:    ServiceStatus
  }
}

// `swap` is the backend service id used by /api/infra/overrides/:service. Only
// services GCTRL can be pointed at an external instance of are swappable; Redis
// (job queue/cache) stays bundled. `placeholder` is the URL format hint.
const SERVICE_META: Array<{
  key: keyof SetupStatus['services']
  label: string
  description: string
  icon: string
  swap?: { service: 'neo4j' | 'qdrant' | 'ollama' | 'postgres'; placeholder: string; hasAuth: boolean }
}> = [
  { key: 'neo4j',    label: 'Neo4j',        description: 'Knowledge graph database',  icon: '🔵', swap: { service: 'neo4j',    placeholder: 'bolt://host:7687',          hasAuth: true } },
  { key: 'qdrant',   label: 'Qdrant',        description: 'Vector store for RAG',       icon: '🟣', swap: { service: 'qdrant',   placeholder: 'http://host:6333',          hasAuth: false } },
  { key: 'ollama',   label: 'Ollama',        description: 'Local LLM inference',        icon: '🦙', swap: { service: 'ollama',   placeholder: 'http://host:11434',         hasAuth: false } },
  { key: 'postgres', label: 'PostgreSQL',    description: 'Metadata & job storage',     icon: '🐘', swap: { service: 'postgres', placeholder: 'postgres://user@host:5432/db', hasAuth: true } },
  { key: 'redis',    label: 'Redis',         description: 'Job queue & cache',          icon: '🔴' },
]

interface ServiceOverride {
  service: 'neo4j' | 'qdrant' | 'ollama' | 'postgres'
  url: string | null
  username: string | null
  hasSecret: boolean
  updatedAt: string | null
  source?: 'default' | 'override'
  defaultUrl?: string
  note: string
}

type SwapMeta = NonNullable<(typeof SERVICE_META)[number]['swap']>

function ServiceRow({ label, description, icon, status, loading, swap, override, onOverrideChanged }: {
  label: string
  description: string
  icon: string
  status: ServiceStatus | undefined
  loading: boolean
  swap?: SwapMeta
  override?: ServiceOverride
  onOverrideChanged?: () => void
}) {
  const connected = status?.connected ?? false
  const latency = status?.latencyMs
  const url = status?.url
  const [expanded, setExpanded] = useState(false)
  const [resetting, setResetting] = useState(false)
  // "override" wins from either source (status probe or the overrides list).
  const usingExternal = status?.source === 'override' || !!override?.url

  async function handleReset() {
    if (!swap) return
    if (!confirm(`Reset ${label} to the bundled default? (Restart GCTRL to apply across services.)`)) return
    setResetting(true)
    try {
      await api.delete(`/infra/overrides/${swap.service}`)
      onOverrideChanged?.()
    } catch { /* non-fatal */ } finally { setResetting(false) }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xl">{icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-200">{label}</span>
              {usingExternal ? (
                <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[9px] font-medium text-indigo-300">External</span>
              ) : (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-300/80">Default · bundled</span>
              )}
              {!loading && (
                connected
                  ? <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400"><Wifi size={9} />Online</span>
                  : <span className="flex items-center gap-1 text-[10px] font-medium text-red-400"><WifiOff size={9} />Offline</span>
              )}
              {loading && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-500" />}
            </div>
            <p className="text-[11px] text-slate-500 truncate">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {url && (
            <span className="hidden sm:block text-[10px] font-mono text-slate-500 max-w-[160px] truncate">{url}</span>
          )}
          {latency !== null && latency !== undefined && (
            <span className="text-[10px] text-slate-500">{latency}ms</span>
          )}
          <div className={cn(
            'h-2 w-2 rounded-full',
            loading ? 'animate-pulse bg-slate-600' : connected ? 'bg-emerald-500' : 'bg-red-500'
          )} />
          {swap && usingExternal && (
            <button
              onClick={() => void handleReset()}
              disabled={resetting}
              title="Remove the external override and return to the bundled service"
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-medium text-amber-400/90 hover:bg-slate-700 disabled:opacity-50"
            >
              {resetting ? <Loader2 size={11} className="animate-spin" /> : 'Reset to default'}
            </button>
          )}
          {swap && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className={cn(
                'rounded border px-2 py-1 text-[10px] font-medium transition-colors',
                expanded
                  ? 'border-indigo-700 bg-indigo-950/40 text-indigo-300'
                  : 'border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-300'
              )}
            >
              Swap
            </button>
          )}
        </div>
      </div>
      {swap && expanded && (
        <SwapForm swap={swap} override={override} onChanged={onOverrideChanged} />
      )}
    </div>
  )
}

/// Per-service form to point GCTRL at an EXTERNAL instance. Test hits the backend
/// connectivity probe for the typed (or saved) target; Save persists the override
/// (secret sealed server-side). The apply-note is honest: Ollama/Qdrant take
/// effect for new requests; Postgres/Neo4j need a restart.
function SwapForm({ swap, override, onChanged }: {
  swap: SwapMeta
  override?: ServiceOverride
  onChanged?: () => void
}) {
  const [url, setUrl] = useState(override?.url ?? '')
  const [username, setUsername] = useState(override?.username ?? '')
  const [secret, setSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [saved, setSaved] = useState(false)

  async function handleTest() {
    setBusy(true); setTestResult(null)
    try {
      const { data } = await api.post(`/infra/overrides/${swap.service}/test`, {
        url: url.trim() || undefined,
      })
      setTestResult({
        ok: !!data.ok,
        msg: data.ok ? `Reachable${data.latencyMs != null ? ` · ${data.latencyMs}ms` : ''}` : (data.error ?? 'Unreachable'),
      })
    } catch {
      setTestResult({ ok: false, msg: 'Test request failed' })
    } finally { setBusy(false) }
  }

  async function handleSave() {
    if (!url.trim()) return
    setBusy(true); setSaved(false); setTestResult(null)
    try {
      await api.put(`/infra/overrides/${swap.service}`, {
        url: url.trim(),
        username: swap.hasAuth ? (username.trim() || undefined) : undefined,
        secret: swap.hasAuth ? (secret.trim() || undefined) : undefined,
      })
      setSecret('')
      setSaved(true)
      onChanged?.()
      setTimeout(() => setSaved(false), 4000)
    } catch {
      setTestResult({ ok: false, msg: 'Save failed' })
    } finally { setBusy(false) }
  }

  return (
    <div className="border-t border-slate-800 bg-slate-950/50 px-4 py-3 space-y-2">
      <p className="text-[11px] text-slate-500">
        Point GCTRL at an external {swap.service} instance instead of the bundled one.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="text-[10px] font-medium text-slate-500">URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={swap.placeholder}
            className="mt-0.5 w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        {swap.hasAuth && (
          <>
            <div>
              <label className="text-[10px] font-medium text-slate-500">Username</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                className="mt-0.5 w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-slate-500">
                Password / secret {override?.hasSecret && <span className="text-slate-600">(stored)</span>}
              </label>
              <div className="relative mt-0.5">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={override?.hasSecret ? '•••••• (enter to replace)' : 'secret'}
                  className="w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 pr-8 text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                />
                <button type="button" onClick={() => setShowSecret((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                  {showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {testResult && (
        <p className={cn('text-[11px]', testResult.ok ? 'text-emerald-400' : 'text-red-400')}>{testResult.msg}</p>
      )}

      {/* Honest apply note */}
      <p className="text-[10px] text-amber-400/80">
        Saved overrides apply across all services after a GCTRL restart. Reset any time to return to the bundled default.
      </p>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => void handleTest()}
          disabled={busy}
          className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-[10px] font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : 'Test'}
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={busy || !url.trim()}
          className={cn(
            'flex items-center gap-1 rounded px-3 py-1 text-[10px] font-medium text-white disabled:opacity-50',
            saved ? 'bg-emerald-600' : 'bg-indigo-600 hover:bg-indigo-500'
          )}
        >
          {saved ? <Check size={11} /> : <Save size={11} />}
          {saved ? 'Saved — restart to apply' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function InfrastructureTab() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [overrides, setOverrides] = useState<ServiceOverride[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const { status: agentStatus } = useLicenseStatus()
  const { data: updateCheck, isError: updateCheckError } = useQuery<{ current: string; latest: string; updateAvailable: boolean }>({
    queryKey: ['update', 'check'],
    queryFn: () => apiGet('/update/check'),
    refetchInterval: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    staleTime: 55 * 60 * 1000,
    retry: false,
  })

  const loadOverrides = useCallback(async () => {
    try {
      const { data } = await api.get('/infra/overrides')
      setOverrides((data.overrides ?? []) as ServiceOverride[])
    } catch { /* non-fatal */ }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // `api` already prefixes baseURL `/api`; the path must NOT repeat it or it
      // resolves to /api/api/setup/status → 404, leaving every service "Offline".
      const res = await api.get<SetupStatus>('/setup/status')
      setStatus(res.data)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to reach API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh(); void loadOverrides() }, [refresh, loadOverrides])

  const overrideFor = (svc?: SwapMeta['service']) => overrides.find((o) => o.service === svc)

  const allConnected = status
    ? Object.values(status.services).every((s) => s.connected)
    : false

  return (
    <div className="space-y-8">
      {/* Status Overview */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <SectionHeader>Standard Infrastructure</SectionHeader>
          <button
            onClick={() => { void refresh(); void loadOverrides() }}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Re-check
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          This is your bundled stack — it runs locally and comes <span className="text-emerald-300/80">online out of the box</span>. Each service shows live status. Only change a part if you need to: <span className="text-slate-400">Swap</span> points it at an external instance, and <span className="text-amber-400/80">Reset to default</span> returns it to the bundled one.
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {!error && !loading && allConnected && (
          <div className="mb-4 rounded-lg border border-emerald-900/40 bg-emerald-950/10 px-4 py-2 text-sm text-emerald-400 flex items-center gap-2">
            <Check size={14} />
            All services connected and healthy
          </div>
        )}

        <div className="space-y-2">
          {SERVICE_META.map(({ key, label, description, icon, swap }) => (
            <ServiceRow
              key={key}
              label={label}
              description={description}
              icon={icon}
              status={status?.services[key]}
              loading={loading}
              swap={swap}
              override={overrideFor(swap?.service)}
              onOverrideChanged={loadOverrides}
            />
          ))}
        </div>
      </section>

      {/* Connection Info */}
      <section>
        <SectionHeader>Connection Details</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-3">
          {status && SERVICE_META.map(({ key, label }) => {
            const svc = status.services[key]
            if (!svc || svc.url === '(configured)') return null
            return (
              <div key={key} className="flex items-center justify-between text-sm">
                <span className="text-slate-500">{label}</span>
                <span className="font-mono text-[11px] text-slate-300">{svc.url}</span>
              </div>
            )
          })}
          {!status && !loading && (
            <p className="text-sm text-slate-500">No data — click Refresh to check connections.</p>
          )}
        </div>
      </section>

      {/* Ollama Model Hint */}
      <section>
        <SectionHeader>Local LLM (Ollama)</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-3">
          <p className="text-sm text-slate-400">
            GCTRL uses Ollama for local, GDPR-compliant inference. Your data never leaves the machine.
          </p>
          <div className="rounded-md bg-slate-950 border border-slate-800 px-3 py-2 font-mono text-xs text-slate-300 space-y-1">
            <p className="text-slate-500"># Pull a recommended model</p>
            <p>docker exec gctrl-ollama ollama pull qwen2.5:7b</p>
            <p className="text-slate-500 mt-2"># Or use your native Ollama</p>
            <p>ollama pull qwen2.5:7b</p>
          </div>
          <p className="text-[11px] text-slate-500">
            Recommended: <span className="text-slate-300">qwen2.5:7b</span> (4 GB) ·
            Larger: <span className="text-slate-300">qwen2.5:14b</span>, <span className="text-slate-300">mistral</span> ·
            Fast: <span className="text-slate-300">phi3.5</span>
          </p>
        </div>
      </section>

      {/* Software Update */}
      <section>
        <SectionHeader>Software Update</SectionHeader>
        <div className={cn(
          'rounded-lg border p-4 space-y-3',
          agentStatus?.updateRequired
            ? 'border-red-900/50 bg-red-950/20'
            : agentStatus?.updateAvailable
            ? 'border-yellow-900/50 bg-yellow-950/10'
            : 'border-slate-800 bg-slate-900/50'
        )}>
          {/* Status line */}
          <div className="flex items-center justify-between">
            <div>
              {agentStatus?.updateRequired && (
                <p className="text-sm font-medium text-red-400">
                  Required update — v{agentStatus.latestVersion} available. Operations blocked until updated.
                </p>
              )}
              {!agentStatus?.updateRequired && agentStatus?.updateAvailable && (
                <p className="text-sm font-medium text-yellow-400">
                  Update available — v{agentStatus.latestVersion}
                </p>
              )}
              {!agentStatus?.updateAvailable && !agentStatus?.updateRequired && (
                updateCheck?.updateAvailable ? (
                  <p className="text-sm font-medium text-yellow-400">
                    Update available — v{updateCheck.latest}
                  </p>
                ) : (
                  <p className="text-sm text-slate-400">
                    {agentStatus || updateCheck || updateCheckError
                      ? "You're up to date — no new version available."
                      : 'Checking for updates…'}
                  </p>
                )
              )}
              {updateCheck?.current && (
                <p className="mt-1 text-[11px] text-slate-500">
                  Current version: v{updateCheck.current}
                </p>
              )}
              <p className="mt-1 text-[11px] text-slate-500">
                Pulls latest Docker images and recreates all containers in place. Takes ~1–2 min.
              </p>
            </div>
            <button
              onClick={() => setShowUpdateModal(true)}
              className={cn(
                'ml-4 flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                agentStatus?.updateRequired
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : agentStatus?.updateAvailable
                  ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                  : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
              )}
            >
              <ArrowUpCircle size={15} />
              Update now
            </button>
          </div>

          {/* Manual fallback */}
          <div className="rounded-md bg-slate-950 border border-slate-800 px-3 py-2 font-mono text-xs text-slate-500">
            <span className="text-slate-600"># Or run on the server:</span>
            <br />
            <span className="text-slate-400">curl -fsSL https://gctrl.tech/update | bash</span>
          </div>
        </div>
      </section>

      {showUpdateModal && <UpdateModal onClose={() => setShowUpdateModal(false)} />}

      {/* AI Runtime section — inline, below infra/update */}
      <AiRuntimeSection />
    </div>
  )
}

// ─── AI Runtime section (sub-component of InfrastructureTab) ─────────────────

function AiRuntimeSection() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)
  const [activeRuntime, setActiveRuntime] = useState<ActiveRuntime | null>(null)
  const [loading, setLoading] = useState(true)
  const [showEmbeddingModal, setShowEmbeddingModal] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [hwRes, recRes, rtRes] = await Promise.allSettled([
        api.get<HardwareInfo>('/infra/hardware'),
        api.get<Recommendation>('/infra/recommend'),
        api.get<ActiveRuntime>('/infra/active-runtime'),
      ])
      if (hwRes.status === 'fulfilled') setHardware(hwRes.value.data)
      if (recRes.status === 'fulfilled') setRecommendation(recRes.value.data)
      if (rtRes.status === 'fulfilled') setActiveRuntime(rtRes.value.data)
    } catch { /* non-fatal */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionHeader>AI Runtime</SectionHeader>
        {loading && <Loader2 size={13} className="animate-spin text-slate-500" />}
      </div>
      <p className="mb-4 text-xs text-slate-500">
        Choose which local or remote LLM runtime GCTRL uses for knowledge extraction and inference.
        Switching takes effect immediately for new jobs. Re-embedding is needed only when you change the embedding model.
      </p>

      {/* Hardware card + recommendation */}
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Hardware</p>
        <HardwareCard
          hardware={hardware}
          recommendation={recommendation}
          isAdmin={isAdmin}
          onHardwareRescan={(updated) => setHardware(updated)}
          onSwitchToRecommended={(runtime, model) => {
            setActiveRuntime((prev) => prev ? { ...prev, provider: runtime, model } : prev)
          }}
        />
      </div>

      {/* Runtime switcher */}
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Runtime</p>
        <RuntimeSwitcher
          hardware={hardware}
          isAdmin={isAdmin}
          activeRuntime={activeRuntime}
          onSwitched={() => void load()}
        />
      </div>

      {/* Advanced: re-embed */}
      {isAdmin && (
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Advanced</p>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-200">Re-embed all knowledge bases</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Re-runs the embedding pipeline over every document with the current embedding model.
                Use after switching to a new embedding model, or to recover from index corruption.
                Search is degraded while this runs.
              </p>
            </div>
            <button
              onClick={() => setShowEmbeddingModal(true)}
              className="shrink-0 flex items-center gap-1.5 rounded-md border border-amber-700/50 bg-amber-950/20 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-950/40 transition-colors"
            >
              <Gauge size={12} />
              Re-embed…
            </button>
          </div>
        </div>
      )}

      {showEmbeddingModal && (
        <AdvancedEmbeddingModal
          embeddingModel={activeRuntime?.model ?? ''}
          embeddingProvider={activeRuntime?.provider ?? ''}
          embeddingBase={activeRuntime?.base_url ?? ''}
          onClose={() => setShowEmbeddingModal(false)}
        />
      )}
    </section>
  )
}

// ─── Tab: Memory Health ───────────────────────────────────────────────────────

interface MemoryHealth {
  coverage: number
  stores: {
    entities: number
    edges: number
    chunks: { live: number; archived: number }
    dossiers: { live: number; archived: number; pinned: number }
    wikiPages: number
  }
  heat: { hot: number; warm: number; cold: number }
  trust: { high: number; mid: number; low: number }
  lastRun: {
    startedAt: string
    finishedAt: string | null
    durationMs: number
    trigger: string
    summary: {
      decayed_dossiers?: number
      decayed_chunks?: number
      deduped_chunks?: number
      promoted?: number
      evicted_dossiers?: number
      evicted_chunks?: number
    }
  } | null
}

/** A small labelled metric tile. */
function MetricTile({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn('mt-1.5 text-2xl font-semibold', accent ?? 'text-slate-100')}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
    </div>
  )
}

/** A horizontal 3-segment distribution bar (hot/warm/cold, high/mid/low). */
function DistBar({ segments }: { segments: Array<{ label: string; value: number; color: string }> }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        {segments.map((s) => (
          <div key={s.label} className={s.color} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className={cn('h-2 w-2 rounded-full', s.color)} />
            {s.label} <span className="font-mono text-slate-300">{s.value}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function MemoryTab() {
  const [health, setHealth] = useState<MemoryHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [lastResult, setLastResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const { data } = await api.get<MemoryHealth>('/memory/health')
      setHealth(data)
    } catch {
      setError('Failed to load memory health')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function runMaintenance() {
    setRunning(true); setLastResult(null)
    try {
      const { data } = await api.post('/memory/maintenance/run')
      const s = data.summary ?? {}
      setLastResult(
        `Cycle complete in ${s.durationMs ?? 0}ms — decayed ${(s.decayedDossiers ?? 0) + (s.decayedChunks ?? 0)}, ` +
        `deduped ${s.dedupedChunks ?? 0}, promoted ${s.promoted ?? 0}, ` +
        `evicted ${(s.evictedDossiers ?? 0) + (s.evictedChunks ?? 0)}.`
      )
      await load()
    } catch {
      setLastResult('Maintenance run failed.')
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" /> Loading memory health…</div>
  }
  if (error || !health) {
    return (
      <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-3 text-sm text-red-400">
        {error || 'No data'}
        <button onClick={() => void load()} className="ml-3 underline">Retry</button>
      </div>
    )
  }

  const { stores, heat, trust, lastRun } = health
  const coveragePct = Math.round(health.coverage * 100)

  return (
    <div className="space-y-8">
      {/* ── Header + Run-now ─────────────────────────────────────────── */}
      <section>
        <div className="mb-1 flex items-center justify-between">
          <SectionHeader>Memory Health</SectionHeader>
          <button
            onClick={() => void runMaintenance()}
            disabled={running}
            className="flex items-center gap-1.5 rounded-md bg-blue-500/20 px-3 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {running ? 'Running…' : 'Run maintenance now'}
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          The memory-governance cycle (decay → dedup → promote → evict → refresh) runs automatically every
          10 minutes and keeps your knowledge base self-maintaining — fully local, no data leaves the machine.
        </p>
        {lastResult && (
          <div className="mb-4 rounded-lg border border-emerald-900/40 bg-emerald-950/10 px-4 py-2 text-sm text-emerald-400 flex items-center gap-2">
            <Check size={14} /> {lastResult}
          </div>
        )}
      </section>

      {/* ── Top metrics ──────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile
          label="Dossier coverage"
          value={`${coveragePct}%`}
          sub={`${stores.dossiers.live} / ${stores.entities} entities`}
          accent={coveragePct >= 50 ? 'text-emerald-400' : coveragePct >= 20 ? 'text-amber-400' : 'text-slate-100'}
        />
        <MetricTile label="Entities" value={stores.entities} sub={`${stores.edges} edges`} />
        <MetricTile label="Chunks" value={stores.chunks.live} sub={`${stores.chunks.archived} archived`} />
        <MetricTile
          label="Dossiers"
          value={stores.dossiers.live}
          sub={`${stores.dossiers.pinned} pinned · ${stores.dossiers.archived} archived`}
        />
      </section>

      {/* ── Distributions ────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <p className="mb-3 text-xs font-medium text-slate-300">Chunk heat distribution</p>
          <DistBar segments={[
            { label: 'Hot', value: heat.hot, color: 'bg-rose-500' },
            { label: 'Warm', value: heat.warm, color: 'bg-amber-500' },
            { label: 'Cold', value: heat.cold, color: 'bg-slate-600' },
          ]} />
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <p className="mb-3 text-xs font-medium text-slate-300">Dossier trust distribution</p>
          <DistBar segments={[
            { label: 'High (≥0.8)', value: trust.high, color: 'bg-emerald-500' },
            { label: 'Mid', value: trust.mid, color: 'bg-amber-500' },
            { label: 'Low (<0.4)', value: trust.low, color: 'bg-rose-500' },
          ]} />
        </div>
      </section>

      {/* ── Store sizes ──────────────────────────────────────────────── */}
      <section>
        <SectionHeader>Store sizes</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-2 text-sm">
          {[
            ['Graph entities (Neo4j)', stores.entities],
            ['Graph edges (Neo4j)', stores.edges],
            ['Text chunks — live (Postgres/Qdrant)', stores.chunks.live],
            ['Text chunks — archived', stores.chunks.archived],
            ['Entity dossiers — live', stores.dossiers.live],
            ['Entity dossiers — archived', stores.dossiers.archived],
            ['Entity dossiers — pinned', stores.dossiers.pinned],
            ['Wiki pages', stores.wikiPages],
          ].map(([label, value]) => (
            <div key={label as string} className="flex items-center justify-between">
              <span className="text-slate-500">{label}</span>
              <span className="font-mono text-[12px] text-slate-300">{value as number}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Last maintenance run ─────────────────────────────────────── */}
      <section>
        <SectionHeader>Last maintenance run</SectionHeader>
        {lastRun ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs">
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                lastRun.trigger === 'manual' ? 'bg-blue-500/10 text-blue-400' : 'bg-slate-800 text-slate-400'
              )}>
                {lastRun.trigger}
              </span>
              <span className="text-slate-500">
                {new Date(lastRun.startedAt).toLocaleString()} · {lastRun.durationMs}ms
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
              {[
                ['Decayed dossiers', lastRun.summary.decayed_dossiers],
                ['Decayed chunks', lastRun.summary.decayed_chunks],
                ['Deduped chunks', lastRun.summary.deduped_chunks],
                ['Promoted', lastRun.summary.promoted],
                ['Evicted dossiers', lastRun.summary.evicted_dossiers],
                ['Evicted chunks', lastRun.summary.evicted_chunks],
              ].map(([label, value]) => (
                <div key={label as string} className="flex items-center justify-between">
                  <span className="text-slate-500">{label}</span>
                  <span className="font-mono text-[12px] text-slate-300">{(value as number) ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-800 py-6 text-center text-xs text-slate-500">
            No maintenance run recorded yet — it runs automatically every 10 minutes, or press “Run maintenance now”.
          </div>
        )}
      </section>
    </div>
  )
}

// ─── Tab: License ─────────────────────────────────────────────────────────────

interface CurrentLicense {
  licenseKey: string       // masked unless reveal=true
  masked: string
  tier: string
  creditsAllocated: number
  creditsUsed: number
  creditsRemaining: number
  status: string
  activatedAt: string
}

interface CurrentLicenseResponse {
  license: CurrentLicense | null
}

function LicenseTab() {
  const { user } = useAuth()
  const { balance: liveBalance } = useTokenBalance()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [revealedFull, setRevealedFull] = useState<string | null>(null)
  const [revealing, setRevealing] = useState(false)
  const [activating, setActivating] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // Fetch the most recent active license linked to this user.
  const { data: licenseData, isLoading: licenseLoading, refetch: refetchLicense } =
    useApiQuery<CurrentLicenseResponse>(['billing', 'license'], '/billing/license')
  const license = licenseData?.license ?? null

  async function handleReveal() {
    if (revealedFull) {
      setRevealedFull(null)
      return
    }
    setRevealing(true)
    try {
      const { data } = await api.get<CurrentLicenseResponse>('/billing/license', {
        params: { reveal: true },
      })
      if (data.license?.licenseKey) setRevealedFull(data.license.licenseKey)
    } catch { /* silent — masked stays */ }
    finally { setRevealing(false) }
  }

  async function handleCopy() {
    const fullKey = revealedFull ?? null
    if (!fullKey) {
      // Need to fetch full key first
      try {
        const { data } = await api.get<CurrentLicenseResponse>('/billing/license', {
          params: { reveal: true },
        })
        if (data.license?.licenseKey) {
          await navigator.clipboard.writeText(data.license.licenseKey)
          setResult({ ok: true, msg: 'License key copied to clipboard' })
          setTimeout(() => setResult(null), 2500)
        }
      } catch {
        setResult({ ok: false, msg: 'Could not copy license key' })
      }
    } else {
      try {
        await navigator.clipboard.writeText(fullKey)
        setResult({ ok: true, msg: 'License key copied to clipboard' })
        setTimeout(() => setResult(null), 2500)
      } catch { /* clipboard denied */ }
    }
  }

  async function handleActivate() {
    if (!key.trim()) return
    setActivating(true)
    setResult(null)
    try {
      const res = await fetch('/api/setup/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: key.trim() }),
      })
      const data = await res.json() as { ok?: boolean; error?: string; tier?: string; credits_balance?: number }
      if (res.ok && data.ok) {
        localStorage.setItem('gctrl_license_key', key.trim())
        localStorage.setItem('gctrl_activated', 'true')
        // Link the license to the logged-in user account
        try {
          await api.post('/billing/license', {
            license_key: key.trim(),
            tier: data.tier,
            credits_allocated: data.credits_balance,
          })
        } catch { /* non-fatal — license stored locally, user can re-link later */ }
        // Invalidate dependent queries so the displayed balance + license refresh.
        queryClient.invalidateQueries({ queryKey: ['billing', 'balance'] })
        queryClient.invalidateQueries({ queryKey: ['billing', 'license'] })
        queryClient.invalidateQueries({ queryKey: ['users', 'me'] })
        void refetchLicense()
        setKey('')
        setRevealedFull(null)
        setResult({ ok: true, msg: 'License activated and linked to your account' })
      } else {
        setResult({ ok: false, msg: data.error ?? 'Activation failed' })
      }
    } catch {
      setResult({ ok: false, msg: 'Could not reach activation service' })
    } finally {
      setActivating(false)
    }
  }

  const displayKey = revealedFull ?? license?.licenseKey ?? ''
  // Only treat the install as registered when a license is present AND active.
  // A non-null-but-inactive license (or no license at all) is a GRACE PERIOD, and
  // we must never render a key-like string that implies it's already registered.
  const isActivated = license?.status === 'active'

  return (
    <div className="space-y-6 max-w-xl">
      {/* Current license card */}
      <section>
        <SectionHeader>Current License</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-4">
          {licenseLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 size={14} className="animate-spin" />
              Loading license…
            </div>
          ) : isActivated && license ? (
            <>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
                  <Check size={10} /> {license.status === 'active' ? 'Active' : license.status}
                </span>
                <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-300 capitalize">
                  {license.tier}
                </span>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">License Key</label>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={displayKey}
                    className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-300 select-all focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleReveal()}
                    title={revealedFull ? 'Hide full key' : 'Reveal full key'}
                    className="rounded-md border border-slate-700 bg-slate-800 px-3 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {revealing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : revealedFull ? (
                      <EyeOff size={14} />
                    ) : (
                      <Eye size={14} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    title="Copy to clipboard"
                    className="rounded-md border border-slate-700 bg-slate-800 px-3 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div>
                  <p className="text-slate-500">Allocated</p>
                  <p className="mt-0.5 font-medium text-slate-200">
                    {license.creditsAllocated.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Used</p>
                  <p className="mt-0.5 font-medium text-slate-200">
                    {Math.max(0, license.creditsAllocated - liveBalance).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Remaining</p>
                  <p className="mt-0.5 font-medium text-emerald-400">
                    {liveBalance.toLocaleString()}
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-slate-600">
                Activated {new Date(license.activatedAt).toLocaleString()}
              </p>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400">
                  <AlertTriangle size={11} /> Not activated
                </span>
                <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-400">
                  Grace period
                </span>
              </div>
              <div className="flex items-start gap-2.5 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2.5">
                <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-400" />
                <div className="text-xs text-amber-200/90">
                  <p className="font-medium text-amber-300">This installation is running in a grace period.</p>
                  <p className="mt-1 text-amber-200/70">
                    Performance is throttled and capacity is limited until a license is
                    activated. Activate a license below to unlock full extraction, fusion,
                    and query throughput.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Activate / replace license */}
      <section>
        <SectionHeader>{isActivated ? 'Replace License Key' : 'Activate License Key'}</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              {isActivated ? 'New License Key' : 'License Key'}
            </label>
            <div className="flex gap-2">
              <input
                type={show ? 'text' : 'password'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleActivate()}
                placeholder="GCTRL-XXXX-XXXX-XXXX-XXXX-XXXX"
                className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShow(v => !v)}
                className="rounded-md border border-slate-700 bg-slate-800 px-3 text-slate-500 hover:text-slate-300 transition-colors"
              >
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          {result && (
            <p className={cn('text-xs', result.ok ? 'text-emerald-400' : 'text-red-400')}>
              {result.msg}
            </p>
          )}
          <button
            onClick={() => void handleActivate()}
            disabled={!key.trim() || activating}
            className="flex items-center gap-2 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            {activating ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {activating ? 'Activating…' : isActivated ? 'Replace License Key' : 'Activate License Key'}
          </button>
        </div>
      </section>

      <section>
        <SectionHeader>Token Balance</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold text-slate-100">
                {liveBalance.toLocaleString()}
                <span className="ml-1 text-sm font-normal text-slate-500">tokens remaining</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Plan: <span className="capitalize text-slate-300">{user?.tier ?? 'free'}</span>
              </p>
            </div>
            <button
              onClick={() => navigate('/billing')}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors"
            >
              Full Usage <ChevronRight size={12} />
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function SettingsPage() {
  // Deep-linkable via `?tab=<id>` (e.g. /settings?tab=models). Defaults to
  // 'models' when the param is missing or unknown — non-breaking.
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const param = new URLSearchParams(window.location.search).get('tab')
    return TABS.some((t) => t.id === param) ? (param as TabId) : 'models'
  })

  const currentTab = TABS.find((t) => t.id === activeTab)!

  return (
    <div className="flex h-full animate-fade-in">
      {/* Vertical Tab Sidebar */}
      <aside className="w-52 shrink-0 border-r border-slate-800 py-6 pr-0">
        <p className="mb-3 px-4 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
          Settings
        </p>
        <nav className="space-y-0.5 px-2">
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  activeTab === tab.id
                    ? 'bg-blue-500/10 text-blue-400'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                )}
              >
                <Icon
                  size={15}
                  className={activeTab === tab.id ? 'text-blue-400' : 'text-slate-500'}
                />
                {tab.label}
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Content Area */}
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-100">{currentTab.label}</h1>
          <div className="mt-1 h-px bg-slate-800" />
        </div>

        {activeTab === 'license' && <LicenseTab />}
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'integrations' && <IntegrationsTab />}
        {activeTab === 'skills' && <SkillsTab />}
        {activeTab === 'agent' && <AgentTab />}
        {activeTab === 'mcp' && <McpTab />}
        {activeTab === 'n8n' && <N8nTab />}
        {activeTab === 'webhooks' && <WebhooksPage />}
        {activeTab === 'infrastructure' && <InfrastructureTab />}
        {activeTab === 'memory' && <MemoryTab />}
        {activeTab === 'profile' && <PersonalMemoryTab />}
        {activeTab === 'sso' && <SSOPage />}
        {activeTab === 'account' && <AccountTab />}
      </main>
    </div>
  )
}

