import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Shield, KeyRound, ScrollText, Plus, Trash2, X, Copy, Check,
  Loader2, Coins, Pencil, Bot, ChevronDown, ChevronUp,
} from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Tabs } from '@/components/ui/Tabs'
import ClassificationPage from '@/pages/admin/ClassificationPage'

// ─── Shared types ──────────────────────────────────────────────────────────────

interface Grant { compilationId: string; compilationName: string; grantedRank: number | null }
interface ApiKey {
  id: string
  name: string
  keyPrefix: string | null
  maxClearanceRank: number
  maxClearanceLevel: string | null
  maxClearanceLevelId: string | null
  expiresAt: string | null
  createdAt: string
  kbScoped?: boolean
  grants: Grant[]
}
interface Level { id: string; name: string; display_name: string; rank: number; color: string; is_system?: boolean }
interface Compilation { id: string; name: string; classification: string }

const CLEARANCE_BADGE: Record<string, string> = {
  PUBLIC: 'badge-green', INTERNAL: 'badge-blue',
  CONFIDENTIAL: 'badge-yellow', STRICTLY_CONFIDENTIAL: 'badge-red',
}
function rankLevelName(rank: number): string {
  if (rank <= 0) return 'PUBLIC'
  if (rank <= 100) return 'INTERNAL'
  if (rank <= 200) return 'CONFIDENTIAL'
  return 'STRICTLY_CONFIDENTIAL'
}

// ─── Page ──────────────────────────────────────────────────────────────────────

type TabId = 'tokens' | 'classification' | 'audit'

export default function AccessControlPage() {
  const [tab, setTab] = useState<TabId>('tokens')

  const tabs = [
    { id: 'tokens', label: 'Access Tokens', icon: KeyRound },
    { id: 'classification', label: 'Classification', icon: Shield },
    { id: 'audit', label: 'Audit Trail', icon: ScrollText },
  ]

  return (
    <div className="space-y-6 animate-slide-up">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Access Control</h2>
        <p className="mt-1 text-sm text-slate-500">
          Define who — and which agents — can see each knowledge graph. Tokens carry a
          clearance level plus optional access to specific graphs.
        </p>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />

      {tab === 'tokens' && <TokensSection />}
      {tab === 'classification' && <ClassificationPage />}
      {tab === 'audit' && <AuditSection />}
    </div>
  )
}

// ─── Tokens ────────────────────────────────────────────────────────────────────

function TokensSection() {
  const qc = useQueryClient()
  const { data: keysData, isLoading } = useApiQuery<{ apiKeys: ApiKey[] }>(['users', 'api-keys'], '/users/api-keys')
  const { data: levelsData } = useApiQuery<{ levels: Level[] }>(['classification', 'levels'], '/classification/levels')
  const { data: compsData } = useApiQuery<{ compilations: Compilation[] }>(['kg', 'compilations'], '/kg/compilations')

  const keys = keysData?.apiKeys ?? []
  const levels = (levelsData?.levels ?? []).slice().sort((a, b) => a.rank - b.rank)
  const comps = compsData?.compilations ?? []

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [levelId, setLevelId] = useState('')
  const [expiryDays, setExpiryDays] = useState<number | null>(null)
  const [grantIds, setGrantIds] = useState<Set<string>>(new Set())
  const [kbScoped, setKbScoped] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [freshKey, setFreshKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLevelId, setEditLevelId] = useState('')

  // Default selection = lowest-rank (most permissive) level once levels load.
  const defaultLevelId = levels[0]?.id ?? ''

  async function handleSaveEdit(id: string) {
    await api.put(`/users/api-keys/${id}`, { maxClearanceLevelId: editLevelId || defaultLevelId })
    setEditingId(null)
    qc.invalidateQueries({ queryKey: ['users', 'api-keys'] })
  }

  function reset() {
    setName(''); setLevelId(''); setExpiryDays(null); setGrantIds(new Set()); setKbScoped(false); setError(null)
  }

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true); setError(null)
    try {
      const expiresAt = expiryDays
        ? new Date(Date.now() + expiryDays * 86400_000).toISOString()
        : null
      const grants = Array.from(grantIds).map((compilationId) => ({ compilationId, grantedRank: null }))
      const { data } = await api.post<{ key: string }>('/users/api-keys', {
        name: name.trim(), maxClearanceLevelId: levelId || defaultLevelId, expiresAt, grants, kbScoped,
      })
      setFreshKey(data.key)
      setShowForm(false); reset()
      qc.invalidateQueries({ queryKey: ['users', 'api-keys'] })
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to create token')
    } finally { setCreating(false) }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Revoke this access token? Agents using it lose access immediately.')) return
    await api.delete(`/users/api-keys/${id}`)
    qc.invalidateQueries({ queryKey: ['users', 'api-keys'] })
  }

  async function toggleGrant(keyId: string, compId: string, has: boolean) {
    if (has) await api.delete(`/users/api-keys/${keyId}/grants/${compId}`)
    else await api.post(`/users/api-keys/${keyId}/grants`, { compilationId: compId, grantedRank: null })
    qc.invalidateQueries({ queryKey: ['users', 'api-keys'] })
  }

  return (
    <div className="space-y-4">
      <ConnectHelp />

      {/* One-time key reveal */}
      {freshKey && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="mb-2 text-xs font-medium text-emerald-300">
            Copy your token now — it won't be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-slate-950 px-3 py-2 font-mono text-xs text-emerald-200">{freshKey}</code>
            <button
              onClick={() => { navigator.clipboard.writeText(freshKey); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700"
            >
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </button>
            <button onClick={() => setFreshKey(null)} className="rounded-md p-2 text-slate-500 hover:text-slate-300"><X size={14} /></button>
          </div>
          <AgentSnippet token={freshKey} />
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Access Tokens</h3>
        <button onClick={() => { setShowForm((v) => !v); reset() }} disabled={showForm} className="btn-primary">
          <Plus size={14} /> New Token
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="card space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Token Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hermes agent" autoFocus
                className="input-field" />
            </div>
            <div>
              <label className="label">Base Clearance</label>
              <select value={levelId || defaultLevelId} onChange={(e) => setLevelId(e.target.value)} className="input-field">
                {levels.map((l) => <option key={l.id} value={l.id}>{l.display_name}{l.is_system === false ? ' (custom)' : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Expires</label>
              <select value={expiryDays ?? ''} onChange={(e) => setExpiryDays(e.target.value ? Number(e.target.value) : null)} className="input-field">
                <option value="">Never</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </select>
            </div>
          </div>

          {/* KB-scope toggle — for colleague tokens (Single-Owner + Scoped Tokens) */}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
            <input type="checkbox" checked={kbScoped} onChange={(e) => setKbScoped(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="text-xs font-medium text-slate-200">Scope to specific knowledge bases (colleague token)</span>
              <span className="mt-0.5 block text-[11px] text-slate-500">
                When on, this token can read &amp; write ONLY the graphs selected below — every other knowledge
                base is invisible. When off, the token has full owner access (selections merely raise clearance).
              </span>
            </span>
          </label>

          <div>
            <label className="label">{kbScoped ? 'Knowledge bases this token may access (exclusive)' : 'Per-graph access (beyond base clearance)'}</label>
            <p className="mb-2 text-[11px] text-slate-600">
              {kbScoped
                ? 'This token can read & write ONLY the selected graphs, capped at its base clearance. Nothing else is visible.'
                : 'Grant this token access to specific graphs even if their classification exceeds its base clearance.'}
            </p>
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-800 p-2">
              {comps.length === 0 ? (
                <p className="px-2 py-3 text-center text-[11px] text-slate-600">No graphs yet.</p>
              ) : comps.map((c) => {
                const checked = grantIds.has(c.id)
                return (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-800/50">
                    <input type="checkbox" checked={checked}
                      onChange={() => setGrantIds((prev) => { const n = new Set(prev); checked ? n.delete(c.id) : n.add(c.id); return n })} />
                    <span className="flex-1 text-xs text-slate-300">{c.name}</span>
                    <span className={cn('text-[10px]', CLEARANCE_BADGE[c.classification] ?? 'badge-slate')}>{c.classification}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button onClick={() => { setShowForm(false); reset() }} className="btn-ghost text-sm">Cancel</button>
            <button onClick={() => void handleCreate()} disabled={creating || !name.trim()} className="btn-primary">
              {creating ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Create Token
            </button>
          </div>
        </div>
      )}

      {/* Token list */}
      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-500" /></div>
        ) : keys.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">No access tokens yet.</p>
        ) : (
          <div className="divide-y divide-slate-800">
            {keys.map((k) => (
              <div key={k.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-200">{k.name}</span>
                      {editingId === k.id ? (
                        <span className="inline-flex items-center gap-1">
                          <select value={editLevelId || defaultLevelId} onChange={(e) => setEditLevelId(e.target.value)}
                            className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200 focus:border-indigo-500 focus:outline-none">
                            {levels.map((l) => <option key={l.id} value={l.id}>{l.display_name}{l.is_system === false ? ' (custom)' : ''}</option>)}
                          </select>
                          <button onClick={() => void handleSaveEdit(k.id)} className="rounded p-0.5 text-emerald-400 hover:bg-slate-700"><Check size={12} /></button>
                          <button onClick={() => setEditingId(null)} className="rounded p-0.5 text-slate-500 hover:bg-slate-700"><X size={12} /></button>
                        </span>
                      ) : (
                        <>
                          {(() => {
                            const lvl = levels.find((l) => l.id === k.maxClearanceLevelId)
                            return lvl ? (
                              <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${lvl.color}22`, color: lvl.color }}>
                                {lvl.display_name}
                              </span>
                            ) : (
                              <span className={cn(CLEARANCE_BADGE[k.maxClearanceLevel ?? rankLevelName(k.maxClearanceRank)] ?? 'badge-slate', 'text-[10px]')}>
                                {k.maxClearanceLevel ?? rankLevelName(k.maxClearanceRank)}
                              </span>
                            )
                          })()}
                          <button onClick={() => { setEditingId(k.id); setEditLevelId(k.maxClearanceLevelId ?? '') }}
                            className="rounded p-0.5 text-slate-600 hover:bg-slate-700 hover:text-slate-300" title="Edit clearance">
                            <Pencil size={11} />
                          </button>
                        </>
                      )}
                      {k.kbScoped && (
                        <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300 ring-1 ring-violet-500/30" title="Scoped to specific knowledge bases only">
                          KB-scoped
                        </span>
                      )}
                      <code className="font-mono text-[11px] text-slate-600">{k.keyPrefix}…</code>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-600">
                      {k.expiresAt ? `Expires ${new Date(k.expiresAt).toLocaleDateString()}` : 'Never expires'}
                    </p>
                    {/* Grants */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-slate-600">Graph access:</span>
                      {k.grants.length === 0 && <span className="text-[11px] text-slate-600">base clearance only</span>}
                      {k.grants.map((g) => (
                        <span key={g.compilationId} className="inline-flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-300">
                          {g.compilationName}
                          <button onClick={() => void toggleGrant(k.id, g.compilationId, true)} className="hover:text-red-300"><X size={9} /></button>
                        </span>
                      ))}
                      <GrantAdder keyId={k.id} comps={comps} existing={new Set(k.grants.map((g) => g.compilationId))} onAdd={(cid) => toggleGrant(k.id, cid, false)} />
                    </div>
                  </div>
                  <button onClick={() => void handleDelete(k.id)} className="rounded p-1.5 text-slate-500 hover:bg-slate-700 hover:text-red-400" title="Revoke">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function GrantAdder({ comps, existing, onAdd }: {
  keyId: string; comps: Compilation[]; existing: Set<string>; onAdd: (compId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const available = comps.filter((c) => !existing.has(c.id))
  if (available.length === 0) return null

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: r.left })
    }
    setOpen((v) => !v)
  }

  // Rendered in a portal with fixed positioning so the menu floats on top and
  // is never clipped by the token card's overflow.
  return (
    <>
      <button ref={btnRef} onClick={toggle}
        className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-slate-700 px-2 py-0.5 text-[10px] text-slate-500 hover:border-indigo-500/40 hover:text-indigo-300">
        <Plus size={9} /> grant
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div className="fixed z-[61] max-h-56 w-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-2xl"
            style={{ top: pos.top, left: pos.left }}>
            {available.map((c) => (
              <button key={c.id} onClick={() => { onAdd(c.id); setOpen(false) }}
                className="block w-full rounded px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800">
                {c.name}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

// ─── How agents connect (persistent explainer) ───────────────────────────────────

function ConnectHelp() {
  const [open, setOpen] = useState(false)
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001'
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between px-4 py-2.5 text-left">
        <span className="flex items-center gap-2 text-xs font-medium text-slate-300">
          <Bot size={14} className="text-indigo-400" /> How does an agent connect with a token?
        </span>
        {open ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-slate-800 px-4 py-3 text-[11px] leading-relaxed text-slate-400">
          <p>
            An access token is an agent's <span className="text-slate-300">login</span> — you don't paste it into a chat.
            You put it in the agent's <span className="text-slate-300">configuration</span> so the agent authenticates as
            that token, seeing exactly its clearance + graph grants and nothing more. Three ways:
          </p>
          <ol className="ml-4 list-decimal space-y-1.5">
            <li>
              <span className="font-medium text-slate-300">Remote MCP</span> (Claude Code, Cursor, OpenClaw, Codex …): when you
              create a token below, copy the zero-install <code className="text-slate-300">.mcp.json</code> snippet (token
              pre-filled, points at the GCTRL gateway). A KB-scoped token exposes only its assigned knowledge base(s).
            </li>
            <li>
              <span className="font-medium text-slate-300">Env / CLI / harness</span>: set{' '}
              <code className="text-slate-300">GCTRL_API_TOKEN=&lt;token&gt;</code> and{' '}
              <code className="text-slate-300">GCTRL_API_URL={origin}/api</code>.
            </li>
            <li>
              <span className="font-medium text-slate-300">Direct HTTP</span>: send header{' '}
              <code className="text-slate-300">Authorization: ApiKey &lt;token&gt;</code> to{' '}
              <code className="text-slate-300">POST {origin}/api/agent/tools/&lt;tool&gt;</code>.
            </li>
          </ol>
          <p className="text-slate-500">
            The secret is shown <span className="text-slate-400">once</span> at creation. Every call the agent makes is
            audited (Audit Trail tab), and revoking the token cuts the agent off immediately.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Agent connect snippet (token pre-filled) ────────────────────────────────────

function AgentSnippet({ token }: { token: string }) {
  const [copied, setCopied] = useState<'remote' | 'local' | null>(null)
  const [skillCopied, setSkillCopied] = useState(false)
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001'

  async function copySkill() {
    try {
      const { data } = await api.get('/agent/skill.md', { responseType: 'text' })
      await navigator.clipboard.writeText(typeof data === 'string' ? data : String(data))
      setSkillCopied(true); setTimeout(() => setSkillCopied(false), 1500)
    } catch { /* non-fatal */ }
  }

  // Recommended: zero-install remote HTTP-MCP — point any agent harness (Claude
  // Code, Cursor, OpenClaw, Codex …) at the GCTRL gateway with this scoped token.
  // The agent sees ONLY what the token is cleared & scoped for. No local build.
  const remote = JSON.stringify({
    mcpServers: {
      gctrl: {
        type: 'http',
        url: `${origin}/api/agent/mcp`,
        headers: { Authorization: `ApiKey ${token}` },
      },
    },
  }, null, 2)

  // Fallback: run the bundled MCP server locally (stdio transport).
  const local = JSON.stringify({
    mcpServers: {
      gctrl: {
        command: 'node',
        args: ['/path/to/gctrl/services/mcp/dist/index.js'],
        env: { GCTRL_API_URL: `${origin}/api`, GCTRL_API_TOKEN: token },
      },
    },
  }, null, 2)

  function copy(which: 'remote' | 'local', text: string) {
    navigator.clipboard.writeText(text); setCopied(which); setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="mt-3 space-y-3 border-t border-emerald-500/20 pt-3">
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-emerald-300">
          Connect any agent — paste this into <code className="text-emerald-200">.mcp.json</code> (zero install, recommended):
        </p>
        <div className="relative">
          <pre className="max-h-52 overflow-auto rounded bg-slate-950 p-3 text-[10px] leading-relaxed text-slate-300"><code>{remote}</code></pre>
          <button onClick={() => copy('remote', remote)}
            className="absolute right-2 top-2 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700">
            {copied === 'remote' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-slate-500">
          Remote MCP over HTTP — works in Claude Code, Cursor, OpenClaw, Codex and any MCP client. The agent
          authenticates as this token, seeing exactly its clearance + knowledge-base scope and nothing more.
          Requires the gateway to be enabled (<code className="text-slate-400">GCTRL_AGENT_GATEWAY_ENABLED=true</code>).
        </p>
      </div>

      <details className="text-[10px] text-slate-500">
        <summary className="cursor-pointer text-slate-400">Prefer a local MCP server (stdio)?</summary>
        <div className="relative mt-1.5">
          <pre className="max-h-52 overflow-auto rounded bg-slate-950 p-3 text-[10px] leading-relaxed text-slate-300"><code>{local}</code></pre>
          <button onClick={() => copy('local', local)}
            className="absolute right-2 top-2 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700">
            {copied === 'local' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-1.5">
          Or call tools directly: <code className="text-slate-400">Authorization: ApiKey {'<token>'}</code> → <code className="text-slate-400">POST {origin}/api/agent/tools/&lt;tool&gt;</code>.
        </p>
      </details>

      {/* GCTRL Memory skill — teaches the agent to use the layers + write back */}
      <div className="rounded border border-violet-500/20 bg-violet-500/5 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium text-violet-300">Add the GCTRL Memory skill</p>
          <button onClick={() => void copySkill()}
            className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700">
            {skillCopied ? 'Copied SKILL.md' : 'Copy SKILL.md'}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-slate-500">
          Drop this into your agent's skills/rules (a Claude Code skill, a Cursor rule, …) so it uses the hot/warm/cold/wiki
          layers and <span className="text-slate-300">writes its conclusions back</span> — turning GCTRL into compounding
          memory. The agent only sees the knowledge bases this token is granted.
        </p>
      </div>
    </div>
  )
}

// ─── Audit ───────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string
  action: string
  resourceType: string | null
  resourceId: string | null
  tokenId: string | null
  via: string | null
  clearanceUsed: string | null
  classificationAccessed: string | null
  granted: boolean | null
  createdAt: string
}

function AuditSection() {
  const [onlyDenied, setOnlyDenied] = useState(false)
  const url = `/audit?limit=100${onlyDenied ? '&granted=false' : ''}`
  const { data, isLoading } = useApiQuery<{ entries: AuditEntry[]; total: number }>(['audit', onlyDenied ? 'denied' : 'all'], url)
  const entries = data?.entries ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">{data?.total ?? 0} access events</p>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={onlyDenied} onChange={(e) => setOnlyDenied(e.target.checked)} /> Denied only
        </label>
      </div>
      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-500" /></div>
        ) : entries.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">No access events.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50 text-left text-slate-500">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Via</th>
                <th className="px-3 py-2 font-medium">Clearance</th>
                <th className="px-3 py-2 font-medium">Resource</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-slate-800/30">
                  <td className="px-3 py-2 text-slate-500">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono text-slate-300">{e.action}</td>
                  <td className="px-3 py-2">
                    <span className={cn('rounded px-1.5 py-0.5 text-[10px]', e.via === 'token' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-700/50 text-slate-400')}>
                      {e.via ?? 'session'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{e.clearanceUsed === '2147483647' ? 'granted' : e.clearanceUsed}</td>
                  <td className="px-3 py-2 font-mono text-[10px] text-slate-600">{e.resourceId?.slice(0, 12)}</td>
                  <td className="px-3 py-2">
                    {e.granted ? <span className="text-emerald-400">allowed</span> : <span className="text-red-400">denied</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="flex items-center gap-1 text-[10px] text-slate-600"><Coins size={10} /> Audit retains who/which-token accessed what, for compliance.</p>
    </div>
  )
}
