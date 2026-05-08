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
  BarChart2,
  Table2,
  Code2,
  Search,
  Palette,
  Server,
  RefreshCw,
  Wifi,
  WifiOff,
  KeyRound,
  Shield,
  Loader2,
  ArrowUpCircle,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { UpdateModal, useLicenseStatus } from '@/components/LicenseBanner'

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = 'license' | 'models' | 'integrations' | 'skills' | 'mcp' | 'n8n' | 'account' | 'infrastructure'

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

interface RagSkill {
  id: string
  name: string
  description: string
  icon: typeof Brain
  implemented: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS: Tab[] = [
  { id: 'license', label: 'License', icon: Shield },
  { id: 'models', label: 'AI Models', icon: Brain },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'skills', label: 'Skills & Plugins', icon: Puzzle },
  { id: 'mcp', label: 'MCP Server', icon: Code2 },
  { id: 'n8n', label: 'n8n', icon: Plug },
  { id: 'infrastructure', label: 'Infrastructure', icon: Server },
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

const RAG_SKILLS: RagSkill[] = [
  {
    id: 'excalidraw',
    name: 'Excalidraw Diagrams',
    description: 'Generate visual diagrams from knowledge',
    icon: Palette,
    implemented: false,
  },
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Enrich answers with web results',
    icon: Search,
    implemented: true,
  },
  {
    id: 'chart-gen',
    name: 'Chart Generation',
    description: 'Render charts from structured data',
    icon: BarChart2,
    implemented: false,
  },
  {
    id: 'table-analysis',
    name: 'Table Analysis',
    description: 'Parse and reason over tabular data',
    icon: Table2,
    implemented: false,
  },
  {
    id: 'code-execution',
    name: 'Code Execution',
    description: 'Run code snippets and return results',
    icon: Code2,
    implemented: false,
  },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-4 text-sm font-semibold text-slate-300">{children}</h2>
  )
}

function ApiKeyRow({ field }: { field: ApiKeyField }) {
  const storageKey = `apikey_${field.id}`
  const [value, setValue] = useState(() => localStorage.getItem(storageKey) ?? '')
  const [show, setShow] = useState(false)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    if (value.trim()) {
      localStorage.setItem(storageKey, value.trim())
    } else {
      localStorage.removeItem(storageKey)
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const hasKey = !!localStorage.getItem(storageKey)

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-200">{field.label}</span>
          {hasKey ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              <Check size={9} />
              Active
            </span>
          ) : (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
              Not set
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={field.placeholder}
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
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
            saved
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
          )}
        >
          {saved ? <Check size={14} /> : <Save size={14} />}
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>

      {hasKey && (
        <div className="mt-3">
          <p className="mb-1.5 text-[11px] text-slate-500">Models unlocked:</p>
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
      )}
    </div>
  )
}

// ConnectorModal removed — replaced by unified inline integrations list

// ─── Tab: AI Models ───────────────────────────────────────────────────────────

function ModelsTab() {
  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>API Keys for Cloud Models</SectionHeader>
        <div className="space-y-3">
          {API_KEY_FIELDS.map((field) => (
            <ApiKeyRow key={field.id} field={field} />
          ))}
        </div>
      </section>

      <section>
        <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-sm font-medium text-slate-300">Local Ollama</span>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              Always Available
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Local Ollama models (llama3.2, mistral, qwen2.5, etc.) run on your machine and are always
            available without API keys — fully GDPR-compliant, no data leaves your device.
          </p>
        </div>
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
    setConnecting(provider)
    try {
      const { data } = await api.get(`/connectors/auth/${provider}`)
      if (data.authUrl) {
        window.open(data.authUrl, '_blank', 'width=600,height=700')
      } else if (data.error) {
        alert(data.error)
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Connection failed'
      alert(msg)
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
                  ) : (
                    <button
                      onClick={() => handleConnect(p.id)}
                      disabled={connecting === p.id || !p.isConfigured}
                      title={!p.isConfigured ? 'Configure credentials first' : undefined}
                      className={cn(
                        'rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
                        p.isConfigured
                          ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                          : 'bg-slate-800 text-slate-600 cursor-not-allowed',
                        'disabled:opacity-50'
                      )}
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

function SkillsTab() {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('rag_skills') ?? '{}')
    } catch {
      return {}
    }
  })

  function toggle(id: string, implemented: boolean) {
    if (!implemented) return
    const next = { ...enabled, [id]: !enabled[id] }
    setEnabled(next)
    localStorage.setItem('rag_skills', JSON.stringify(next))
  }

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>RAG Skills</SectionHeader>
        <div className="space-y-2">
          {RAG_SKILLS.map((skill) => (
            <div
              key={skill.id}
              className={cn(
                'flex items-center justify-between rounded-lg border p-4 transition-colors',
                skill.implemented
                  ? 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                  : 'border-slate-800/60 bg-slate-900/20 opacity-60'
              )}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800">
                  <skill.icon size={16} className="text-slate-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-200">{skill.name}</p>
                    {!skill.implemented && (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-500">
                        Coming Soon
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">{skill.description}</p>
                </div>
              </div>

              {/* Toggle */}
              <button
                onClick={() => toggle(skill.id, skill.implemented)}
                disabled={!skill.implemented}
                className={cn(
                  'relative h-5 w-9 rounded-full transition-colors focus:outline-none',
                  enabled[skill.id] && skill.implemented
                    ? 'bg-blue-500'
                    : 'bg-slate-700',
                  !skill.implemented && 'cursor-not-allowed'
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
                    enabled[skill.id] && skill.implemented ? 'left-[18px]' : 'left-0.5'
                  )}
                />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

// ─── Tab: MCP Server ──────────────────────────────────────────────────────────

function McpTab() {
  const [copied, setCopied] = useState('')

  function copyText(text: string, id: string) {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(''), 2000)
  }

  const mcpConfig = JSON.stringify({
    GCTRL: {
      command: 'node',
      args: ['d:/N8N/Projekte/Databorg/GCTRL/services/mcp/dist/index.js'],
      env: {
        GCTRL_API_URL: 'http://localhost:4000/api',
        GCTRL_API_TOKEN: '<your-jwt-token>',
      },
    },
  }, null, 2)

  const tools = [
    { name: 'GCTRL_extract', desc: 'Extract knowledge from text → Neo4j entities + Qdrant vectors' },
    { name: 'GCTRL_query', desc: 'Ask questions about knowledge graphs (hybrid RAG)' },
    { name: 'GCTRL_store', desc: 'Store knowledge — like Obsidian notes but with KG extraction' },
    { name: 'GCTRL_search_entities', desc: 'Search entities by name or type' },
    { name: 'GCTRL_list_graphs', desc: 'List all knowledge graph compilations' },
    { name: 'GCTRL_fuse', desc: 'Merge extraction jobs into unified graphs' },
    { name: 'GCTRL_list_ontologies', desc: 'List available ontologies' },
    { name: 'GCTRL_list_extractions', desc: 'List recent extraction jobs' },
    { name: 'GCTRL_schema', desc: 'Get the knowledge graph schema' },
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
                http://localhost:4000/api
              </code>
              <button
                onClick={() => copyText('http://localhost:4000/api', 'endpoint')}
                className="btn-ghost text-slate-500 hover:text-slate-300"
              >
                {copied === 'endpoint' ? <Check size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-500">MCP Server Path</label>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300 font-mono break-all">
                d:/N8N/Projekte/Databorg/GCTRL/services/mcp/dist/index.js
              </code>
              <button
                onClick={() => copyText('d:/N8N/Projekte/Databorg/GCTRL/services/mcp/dist/index.js', 'path')}
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
          Replace <code className="text-amber-400">&lt;your-jwt-token&gt;</code> with a token from{' '}
          <code className="text-blue-400">POST /api/auth/login</code>
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

  function copyText(text: string, id: string) {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(''), 2000)
  }

  const installCmd = 'cd ~/.n8n && npm install n8n-nodes-GCTRL'
  const credentialConfig = JSON.stringify({
    baseUrl: 'http://localhost:4000',
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

// ─── Tab: Account ─────────────────────────────────────────────────────────────

function AccountTab() {
  const { user, logout } = useAuth()
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
                {user?.tokensBalance.toLocaleString() ?? '0'}
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

const SERVICE_META: Array<{
  key: keyof SetupStatus['services']
  label: string
  description: string
  icon: string
}> = [
  { key: 'neo4j',    label: 'Neo4j',        description: 'Knowledge graph database',  icon: '🔵' },
  { key: 'qdrant',   label: 'Qdrant',        description: 'Vector store for RAG',       icon: '🟣' },
  { key: 'ollama',   label: 'Ollama',        description: 'Local LLM inference',        icon: '🦙' },
  { key: 'postgres', label: 'PostgreSQL',    description: 'Metadata & job storage',     icon: '🐘' },
  { key: 'redis',    label: 'Redis',         description: 'Job queue & cache',          icon: '🔴' },
]

function ServiceRow({ label, description, icon, status, loading }: {
  label: string
  description: string
  icon: string
  status: ServiceStatus | undefined
  loading: boolean
}) {
  const connected = status?.connected ?? false
  const latency = status?.latencyMs
  const url = status?.url

  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xl">{icon}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-200">{label}</span>
            {!loading && (
              connected
                ? <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400"><Wifi size={9} />connected</span>
                : <span className="flex items-center gap-1 text-[10px] font-medium text-red-400"><WifiOff size={9} />offline</span>
            )}
            {loading && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-500" />}
          </div>
          <p className="text-[11px] text-slate-500 truncate">{description}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {url && url !== '(configured)' && (
          <span className="hidden sm:block text-[10px] font-mono text-slate-500 max-w-[160px] truncate">{url}</span>
        )}
        {latency !== null && latency !== undefined && (
          <span className="text-[10px] text-slate-500">{latency}ms</span>
        )}
        <div className={cn(
          'h-2 w-2 rounded-full',
          loading ? 'animate-pulse bg-slate-600' : connected ? 'bg-emerald-500' : 'bg-red-500'
        )} />
      </div>
    </div>
  )
}

function InfrastructureTab() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const { status: agentStatus } = useLicenseStatus()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get<SetupStatus>('/api/setup/status')
      setStatus(res.data)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to reach API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const allConnected = status
    ? Object.values(status.services).every((s) => s.connected)
    : false

  return (
    <div className="space-y-8">
      {/* Status Overview */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <SectionHeader>Service Status</SectionHeader>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

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
          {SERVICE_META.map(({ key, label, description, icon }) => (
            <ServiceRow
              key={key}
              label={label}
              description={description}
              icon={icon}
              status={status?.services[key]}
              loading={loading}
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
                <p className="text-sm text-slate-400">
                  {agentStatus ? 'Your installation is up to date.' : 'Agent unreachable — status unknown.'}
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
    </div>
  )
}

// ─── Tab: License ─────────────────────────────────────────────────────────────

function LicenseTab() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [key, setKey] = useState(() => localStorage.getItem('gctrl_license_key') ?? '')
  const [show, setShow] = useState(false)
  const [activating, setActivating] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

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

  const hasKey = !!localStorage.getItem('gctrl_license_key')

  return (
    <div className="space-y-6 max-w-xl">
      <section>
        <SectionHeader>License Key</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-4">
          {hasKey && (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
                <Check size={10} /> Active
              </span>
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">License Key</label>
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
            {activating ? 'Activating…' : 'Activate / Update Key'}
          </button>
        </div>
      </section>

      <section>
        <SectionHeader>Token Balance</SectionHeader>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold text-slate-100">
                {(user?.tokensBalance ?? 0).toLocaleString()}
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
  const [activeTab, setActiveTab] = useState<TabId>('models')

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
        {activeTab === 'mcp' && <McpTab />}
        {activeTab === 'n8n' && <N8nTab />}
        {activeTab === 'infrastructure' && <InfrastructureTab />}
        {activeTab === 'account' && <AccountTab />}
      </main>
    </div>
  )
}

