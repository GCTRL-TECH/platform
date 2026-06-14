import { useState, useEffect, useCallback } from 'react'
import {
  Shield,
  Check,
  X,
  Eye,
  EyeOff,
  Copy,
  Loader2,
  KeyRound,
  Trash2,
  Plus,
  ChevronDown,
  AlertCircle,
  Pencil,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SSOConfig {
  id: string
  provider: string
  clientId: string
  issuerUrl: string
  scopes: string[]
  isActive: boolean
  createdAt: string
}

interface SSOConfigResponse {
  config: SSOConfig | null
}

interface SCIMToken {
  id: string
  description: string
  lastUsedAt: string | null
  createdAt: string
}

interface SCIMTokensResponse {
  tokens: SCIMToken[]
}

interface SCIMTokenCreated {
  token: string
  id: string
}

interface SSOFormState {
  provider: string
  clientId: string
  clientSecret: string
  issuerUrl: string
  scopes: string
}

const PROVIDER_SUGGESTIONS = ['okta', 'azure', 'keycloak', 'google'] as const

const DEFAULT_FORM: SSOFormState = {
  provider: '',
  clientId: '',
  clientSecret: '',
  issuerUrl: '',
  scopes: 'openid email profile',
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function formatRelativeDate(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString()
}

// ─── Callback URL Info Box ─────────────────────────────────────────────────────

function CopyableBox({ label, value, id, copied, onCopy }: {
  label: string
  value: string
  id: string
  copied: string
  onCopy: (value: string, id: string) => void
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-slate-500">{label}</p>
      <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2">
        <code className="flex-1 truncate font-mono text-xs text-slate-300 select-all">{value}</code>
        <button
          onClick={() => onCopy(value, id)}
          className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
          title="Copy to clipboard"
        >
          {copied === id ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  )
}

// ─── SSO Config Form ──────────────────────────────────────────────────────────

function SSOConfigForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: SSOFormState
  onSave: (form: SSOFormState) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<SSOFormState>(initial ?? DEFAULT_FORM)
  const [showSecret, setShowSecret] = useState(false)
  const [showProviderDropdown, setShowProviderDropdown] = useState(false)

  function set(key: keyof SSOFormState, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const isValid =
    form.provider.trim() &&
    form.clientId.trim() &&
    form.clientSecret.trim() &&
    form.issuerUrl.trim()

  return (
    <div className="space-y-4">
      {/* Provider */}
      <div className="relative">
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Provider</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={form.provider}
              onChange={(e) => set('provider', e.target.value)}
              placeholder="e.g. okta, azure, keycloak, google"
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowProviderDropdown((v) => !v)}
            className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-400 hover:bg-slate-700 transition-colors"
            title="Pick a provider"
          >
            Suggest
            <ChevronDown size={11} />
          </button>
        </div>
        {showProviderDropdown && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setShowProviderDropdown(false)} />
            <div className="absolute right-0 top-full z-40 mt-1 w-40 rounded-lg border border-slate-700 bg-slate-900 shadow-xl overflow-hidden">
              {PROVIDER_SUGGESTIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => { set('provider', p); setShowProviderDropdown(false) }}
                  className="flex w-full items-center px-3 py-2 text-left text-sm capitalize text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Client ID */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Client ID</label>
        <input
          type="text"
          value={form.clientId}
          onChange={(e) => set('clientId', e.target.value)}
          placeholder="Your OAuth application's client ID"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
        />
      </div>

      {/* Client Secret */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Client Secret</label>
        <div className="relative">
          <input
            type={showSecret ? 'text' : 'password'}
            value={form.clientSecret}
            onChange={(e) => set('clientSecret', e.target.value)}
            placeholder="Client secret (stored encrypted)"
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 pr-10 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
          />
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
          >
            {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {/* Issuer URL */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Issuer URL</label>
        <input
          type="url"
          value={form.issuerUrl}
          onChange={(e) => set('issuerUrl', e.target.value)}
          placeholder="https://accounts.google.com"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
        />
        <p className="mt-1 text-[11px] text-slate-600">
          The OIDC discovery URL. The platform will append <code className="text-slate-500">/.well-known/openid-configuration</code> automatically.
        </p>
      </div>

      {/* Scopes */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Scopes</label>
        <input
          type="text"
          value={form.scopes}
          onChange={(e) => set('scopes', e.target.value)}
          placeholder="openid email profile"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
        />
        <p className="mt-1 text-[11px] text-slate-600">
          Comma-separated list of OAuth scopes to request from your identity provider.
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={!isValid || saving}
          className="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SSOPage() {
  // ── SSO Config State ─────────────────────────────────────────────────────────
  const [config, setConfig] = useState<SSOConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [showConfigForm, setShowConfigForm] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [deletingConfig, setDeletingConfig] = useState(false)

  // ── SCIM Token State ─────────────────────────────────────────────────────────
  const [scimTokens, setScimTokens] = useState<SCIMToken[]>([])
  const [scimLoading, setScimLoading] = useState(true)
  const [newTokenDesc, setNewTokenDesc] = useState('')
  const [generatingToken, setGeneratingToken] = useState(false)
  const [freshToken, setFreshToken] = useState<string | null>(null)
  const [freshTokenDismissed, setFreshTokenDismissed] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  // ── Copy State ───────────────────────────────────────────────────────────────
  const [copied, setCopied] = useState('')

  const callbackUrl = `${window.location.origin}/api/auth/sso/oidc/callback`
  const scimEndpoint = `${window.location.origin}/api/scim/v2`

  // ── Copy Helper ──────────────────────────────────────────────────────────────
  function copyText(value: string, id: string) {
    void navigator.clipboard.writeText(value)
    setCopied(id)
    setTimeout(() => setCopied(''), 2000)
  }

  // ── Load SSO Config ──────────────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    setConfigLoading(true)
    try {
      const { data } = await api.get<SSOConfigResponse>('/auth/sso/config')
      setConfig(data.config)
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 404) {
        // endpoint not yet implemented — treat as unconfigured
        setConfig(null)
      } else {
        setConfigError('Failed to load SSO configuration.')
      }
    } finally {
      setConfigLoading(false)
    }
  }, [])

  // ── Load SCIM Tokens ─────────────────────────────────────────────────────────
  const loadScimTokens = useCallback(async () => {
    setScimLoading(true)
    try {
      const { data } = await api.get<SCIMTokensResponse>('/auth/sso/scim-tokens')
      setScimTokens(data.tokens ?? [])
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status !== 404) {
        // non-404 errors are unexpected but not critical here
      }
      setScimTokens([])
    } finally {
      setScimLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
    void loadScimTokens()
  }, [loadConfig, loadScimTokens])

  // ── Save SSO Config ───────────────────────────────────────────────────────────
  async function handleSaveConfig(form: SSOFormState) {
    setConfigSaving(true)
    setConfigError(null)
    try {
      const scopes = form.scopes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      await api.post('/auth/sso/config', {
        provider: form.provider.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim(),
        issuerUrl: form.issuerUrl.trim(),
        scopes,
      })
      setShowConfigForm(false)
      await loadConfig()
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to save SSO configuration.'
      setConfigError(msg)
    } finally {
      setConfigSaving(false)
    }
  }

  // ── Delete SSO Config ─────────────────────────────────────────────────────────
  async function handleDeleteConfig() {
    if (!confirm('Remove SSO configuration? Users will no longer be able to sign in via SSO.')) return
    setDeletingConfig(true)
    try {
      await api.delete('/auth/sso/config')
      setConfig(null)
      setShowConfigForm(false)
    } catch {
      setConfigError('Failed to remove SSO configuration.')
    } finally {
      setDeletingConfig(false)
    }
  }

  // ── Generate SCIM Token ───────────────────────────────────────────────────────
  async function handleGenerateToken() {
    if (!newTokenDesc.trim()) return
    setGeneratingToken(true)
    try {
      const { data } = await api.post<SCIMTokenCreated>('/auth/sso/scim-tokens', {
        description: newTokenDesc.trim(),
      })
      setFreshToken(data.token)
      setFreshTokenDismissed(false)
      setNewTokenDesc('')
      await loadScimTokens()
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to generate token.'
      alert(msg)
    } finally {
      setGeneratingToken(false)
    }
  }

  // ── Revoke SCIM Token ─────────────────────────────────────────────────────────
  async function handleRevokeToken(id: string) {
    if (!confirm('Revoke this SCIM token? Any provisioning using it will stop working.')) return
    setRevokingId(id)
    try {
      await api.delete(`/auth/sso/scim-tokens/${id}`)
      setScimTokens((prev) => prev.filter((t) => t.id !== id))
    } catch {
      alert('Failed to revoke token.')
    } finally {
      setRevokingId(null)
    }
  }

  // ── Derive form initial values from existing config (for editing) ─────────────
  function configToForm(cfg: SSOConfig): SSOFormState {
    return {
      provider: cfg.provider,
      clientId: cfg.clientId,
      clientSecret: '', // never pre-fill the secret
      issuerUrl: cfg.issuerUrl,
      scopes: cfg.scopes.join(', '),
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8 max-w-2xl">
      {/* ── Page Header ────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2.5 mb-1">
          <Shield size={20} className="text-indigo-400" />
          <h1 className="text-xl font-semibold text-slate-100">Enterprise SSO</h1>
        </div>
        <p className="text-sm text-slate-500">
          Connect an identity provider for single sign-on. Users provisioned via SSO can also be
          managed through SCIM v2.
        </p>
      </div>

      {/* ── OIDC Configuration Card ────────────────────────────────────────── */}
      <section>
        <h2 className="mb-4 text-sm font-semibold text-slate-300">OIDC Configuration</h2>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          {configError && (
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-3 text-sm text-red-400">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>{configError}</span>
              <button
                onClick={() => setConfigError(null)}
                className="ml-auto shrink-0 text-red-600 hover:text-red-400"
              >
                <X size={13} />
              </button>
            </div>
          )}

          {configLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 size={14} className="animate-spin" />
              Loading configuration…
            </div>
          ) : config && !showConfigForm ? (
            // ── Configured State ────────────────────────────────────────────
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                    config.isActive
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-amber-500/10 text-amber-400'
                  )}
                >
                  {config.isActive ? <Check size={10} /> : <AlertCircle size={10} />}
                  {config.isActive ? 'Active' : 'Inactive'}
                </span>
                <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium capitalize text-slate-300">
                  {config.provider}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-500">Provider</p>
                  <p className="capitalize text-slate-200">{config.provider}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-500">Client ID</p>
                  <p className="font-mono text-[12px] text-slate-300">
                    {config.clientId.length > 24
                      ? `${config.clientId.slice(0, 8)}${'•'.repeat(8)}${config.clientId.slice(-4)}`
                      : config.clientId}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="mb-1 text-xs font-medium text-slate-500">Issuer URL</p>
                  <p className="font-mono text-[12px] text-slate-300 break-all">{config.issuerUrl}</p>
                </div>
                <div className="col-span-2">
                  <p className="mb-1 text-xs font-medium text-slate-500">Scopes</p>
                  <div className="flex flex-wrap gap-1.5">
                    {config.scopes.map((s) => (
                      <span
                        key={s}
                        className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <p className="text-[11px] text-slate-600">
                Configured {new Date(config.createdAt).toLocaleString()}
              </p>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => setShowConfigForm(true)}
                  className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors"
                >
                  <Pencil size={12} />
                  Edit
                </button>
                <button
                  onClick={() => void handleDeleteConfig()}
                  disabled={deletingConfig}
                  className="flex items-center gap-1.5 rounded-md border border-red-900/40 bg-red-950/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950/30 disabled:opacity-50 transition-colors"
                >
                  {deletingConfig ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Disable
                </button>
              </div>
            </div>
          ) : showConfigForm ? (
            // ── Config Form ────────────────────────────────────────────────
            <SSOConfigForm
              initial={config ? configToForm(config) : undefined}
              onSave={(form) => void handleSaveConfig(form)}
              onCancel={() => { setShowConfigForm(false); setConfigError(null) }}
              saving={configSaving}
            />
          ) : (
            // ── Empty State ────────────────────────────────────────────────
            <div className="flex flex-col items-center py-8 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800">
                <Shield size={22} className="text-slate-500" />
              </div>
              <p className="text-sm font-medium text-slate-300">Not configured</p>
              <p className="mt-1 max-w-xs text-xs text-slate-500">
                No identity provider connected. Configure OIDC to let users sign in with your
                organization's IdP.
              </p>
              <button
                onClick={() => setShowConfigForm(true)}
                className="mt-4 flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
              >
                <Plus size={14} />
                Configure SSO
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ── Callback URL Info Box ───────────────────────────────────────────── */}
      <section>
        <h2 className="mb-4 text-sm font-semibold text-slate-300">Callback URL</h2>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <p className="mb-4 text-xs text-slate-500">
            Register this URL as the redirect / callback URI in your identity provider's application
            settings.
          </p>
          <CopyableBox
            label="OIDC Callback URL"
            value={callbackUrl}
            id="callback-url"
            copied={copied}
            onCopy={copyText}
          />
        </div>
      </section>

      {/* ── SCIM v2 Section ─────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-4 text-sm font-semibold text-slate-300">SCIM v2 Provisioning</h2>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 space-y-6">
          <p className="text-xs text-slate-500">
            SCIM tokens allow your identity provider to automatically provision and deprovision
            users. Generate a token and enter it in your IdP's SCIM configuration.
          </p>

          {/* SCIM Endpoint */}
          <CopyableBox
            label="SCIM Endpoint"
            value={scimEndpoint}
            id="scim-endpoint"
            copied={copied}
            onCopy={copyText}
          />

          {/* Fresh Token Reveal */}
          {freshToken && !freshTokenDismissed && (
            <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-medium text-emerald-300">
                  New SCIM token generated — copy it now. It won't be shown again.
                </p>
                <button
                  onClick={() => setFreshTokenDismissed(true)}
                  className="shrink-0 text-emerald-700 hover:text-emerald-400 transition-colors"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-xs text-emerald-200 select-all">
                  {freshToken}
                </code>
                <button
                  onClick={() => copyText(freshToken, 'fresh-scim-token')}
                  className="shrink-0 flex items-center gap-1.5 rounded-md bg-emerald-700 hover:bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition-colors"
                >
                  {copied === 'fresh-scim-token' ? (
                    <>
                      <Check size={12} /> Copied
                    </>
                  ) : (
                    <>
                      <Copy size={12} /> Copy
                    </>
                  )}
                </button>
              </div>
              <button
                onClick={() => setFreshTokenDismissed(true)}
                className="text-[11px] text-emerald-600 hover:text-emerald-400 underline underline-offset-2 transition-colors"
              >
                I've saved it — dismiss
              </button>
            </div>
          )}

          {/* Token Table */}
          <div>
            <p className="mb-3 text-xs font-medium text-slate-400">Existing Tokens</p>
            {scimLoading ? (
              <div className="flex items-center gap-2 py-4 text-xs text-slate-500">
                <Loader2 size={13} className="animate-spin" />
                Loading tokens…
              </div>
            ) : scimTokens.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 py-6 text-center">
                <KeyRound size={18} className="mx-auto text-slate-600" />
                <p className="mt-2 text-xs text-slate-500">No SCIM tokens yet</p>
              </div>
            ) : (
              <div className="rounded-lg border border-slate-800 overflow-hidden">
                {/* Table header */}
                <div className="grid grid-cols-[1fr_100px_100px_36px] gap-3 border-b border-slate-800 bg-slate-950/40 px-4 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-slate-600">
                    Description
                  </p>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-slate-600">
                    Last Used
                  </p>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-slate-600">
                    Created
                  </p>
                  <span />
                </div>
                {/* Rows */}
                <div className="divide-y divide-slate-800/60">
                  {scimTokens.map((token) => (
                    <div
                      key={token.id}
                      className="grid grid-cols-[1fr_100px_100px_36px] items-center gap-3 px-4 py-2.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <KeyRound size={13} className="shrink-0 text-slate-500" />
                        <span className="truncate text-sm text-slate-200">{token.description}</span>
                      </div>
                      <span className="text-xs text-slate-500">
                        {formatRelativeDate(token.lastUsedAt)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {formatRelativeDate(token.createdAt)}
                      </span>
                      <button
                        onClick={() => void handleRevokeToken(token.id)}
                        disabled={revokingId === token.id}
                        title="Revoke token"
                        className="flex items-center justify-center rounded p-1.5 text-slate-600 hover:bg-red-950/30 hover:text-red-400 disabled:opacity-50 transition-colors"
                      >
                        {revokingId === token.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Generate Token Form */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-4 space-y-3">
            <p className="text-xs font-medium text-slate-300">Generate Token</p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newTokenDesc}
                onChange={(e) => setNewTokenDesc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleGenerateToken() }}
                placeholder="Token description (e.g. Okta SCIM Provisioner)"
                className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
              <button
                onClick={() => void handleGenerateToken()}
                disabled={!newTokenDesc.trim() || generatingToken}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {generatingToken ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plus size={14} />
                )}
                Generate
              </button>
            </div>
            <p className="text-[11px] text-slate-600">
              The token will be shown once after creation. Store it securely — it cannot be
              retrieved afterwards.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
