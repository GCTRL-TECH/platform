/**
 * EmbedShareDialog — "Share" flow for a graph compilation (Wave 2 embed).
 *
 * Two user-approved embed mechanisms, each its own tab:
 *   1. Private link (token) — mints a read-only, KB-scoped access token
 *      granted ONLY to this one compilation, then builds an
 *      /embed/graph/:id?token=... URL + <iframe> snippet around it. The
 *      secret is shown once, exactly like the Access Control page's token
 *      creation flow.
 *   2. Public link — flips `compilations.embed_public` on for this
 *      compilation (server enforces PUBLIC-only content, no token needed)
 *      and gives a plain /embed/graph/:id URL.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Share2, X, Copy, Check, KeyRound, Globe2, AlertTriangle, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface EmbedShareDialogProps {
  open: boolean
  onClose: () => void
  compilationId: string
  compilationName: string
  embedPublic: boolean
  onEmbedPublicChange: (enabled: boolean) => void
}

type Tab = 'token' | 'public'

function buildUrls(compilationId: string, token?: string, theme?: string) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (theme) params.set('theme', theme)
  const qs = params.toString()
  const url = `${origin}/embed/graph/${compilationId}${qs ? `?${qs}` : ''}`
  const iframe = `<iframe src="${url}" width="800" height="600" style="border:0;border-radius:8px" title="${compilationName_escape(compilationId)}"></iframe>`
  return { url, iframe }
}
// Kept trivial on purpose — the title attribute only needs to not break the
// markup; compilation names are already sanitised at creation.
function compilationName_escape(s: string) { return s }

export function EmbedShareDialog({
  open, onClose, compilationId, compilationName, embedPublic, onEmbedPublicChange,
}: EmbedShareDialogProps) {
  const [tab, setTab] = useState<Tab>('token')
  if (!open) return null

  return createPortal(
    <>
      <div className="fixed inset-0 z-[80] bg-black/60" onClick={onClose} />
      <div className="fixed inset-0 z-[81] flex items-center justify-center p-4">
        <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Share2 size={15} className="text-indigo-400" /> Share “{compilationName}”
            </h2>
            <button onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200">
              <X size={15} />
            </button>
          </div>

          <div className="flex border-b border-slate-800 px-2">
            <button
              onClick={() => setTab('token')}
              className={cn('flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
                tab === 'token' ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-slate-500 hover:text-slate-300')}
            >
              <KeyRound size={12} /> Private link (token)
            </button>
            <button
              onClick={() => setTab('public')}
              className={cn('flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
                tab === 'public' ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-slate-500 hover:text-slate-300')}
            >
              <Globe2 size={12} /> Public link
            </button>
          </div>

          <div className="max-h-[70vh] overflow-y-auto p-4">
            {tab === 'token' ? (
              <TokenTab compilationId={compilationId} compilationName={compilationName} />
            ) : (
              <PublicTab
                compilationId={compilationId}
                compilationName={compilationName}
                embedPublic={embedPublic}
                onEmbedPublicChange={onEmbedPublicChange}
              />
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}

// ─── Tab 1: private link (token) ────────────────────────────────────────────────

function TokenTab({ compilationId, compilationName }: { compilationId: string; compilationName: string }) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [freshToken, setFreshToken] = useState<string | null>(null)
  const [copied, setCopied] = useState<'url' | 'iframe' | null>(null)

  async function createEmbedToken() {
    setCreating(true); setError(null)
    try {
      const { data } = await api.post<{ key: string }>('/users/api-keys', {
        name: `Embed: ${compilationName}`,
        kbScoped: true,
        readOnly: true,
        maxClearanceRank: 0,
        grants: [{ compilationId, grantedRank: null }],
      })
      setFreshToken(data.key)
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to create embed token')
    } finally {
      setCreating(false)
    }
  }

  function copy(which: 'url' | 'iframe', text: string) {
    navigator.clipboard.writeText(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Creates a read-only access token scoped to ONLY this graph, then builds an embed link around it.
        Anyone with the link sees this graph at whatever clearance the token carries — nothing else in your
        account is reachable through it.
      </p>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}

      {!freshToken ? (
        <button onClick={() => void createEmbedToken()} disabled={creating} className="btn-primary">
          {creating ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Create embed link
        </button>
      ) : (
        <TokenResult
          compilationId={compilationId}
          compilationName={compilationName}
          token={freshToken}
          copied={copied}
          onCopy={copy}
        />
      )}

      <p className="text-[10px] text-slate-600">
        The token is shown once — copy it now. You can revoke it any time from Settings → Access Control →
        Access Tokens (look for “Embed: {compilationName}”).
      </p>
    </div>
  )
}

function TokenResult({
  compilationId, token, copied, onCopy,
}: {
  compilationId: string; compilationName: string; token: string
  copied: 'url' | 'iframe' | null
  onCopy: (which: 'url' | 'iframe', text: string) => void
}) {
  const { url, iframe } = buildUrls(compilationId, token)
  return (
    <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
      <p className="text-xs font-medium text-emerald-300">Copy your link now — the token won't be shown again.</p>
      <SnippetRow label="Direct URL" value={url} active={copied === 'url'} onCopy={() => onCopy('url', url)} />
      <SnippetRow label="Iframe snippet" value={iframe} active={copied === 'iframe'} onCopy={() => onCopy('iframe', iframe)} />
    </div>
  )
}

// ─── Tab 2: public link ──────────────────────────────────────────────────────────

function PublicTab({
  compilationId, compilationName, embedPublic, onEmbedPublicChange,
}: {
  compilationId: string; compilationName: string
  embedPublic: boolean
  onEmbedPublicChange: (enabled: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'url' | 'iframe' | null>(null)

  async function toggle(next: boolean) {
    setBusy(true); setError(null)
    try {
      await api.put(`/kg/compilations/${compilationId}`, { embedPublic: next })
      onEmbedPublicChange(next)
    } catch {
      setError('Failed to update public embed setting')
    } finally {
      setBusy(false)
    }
  }

  function copy(which: 'url' | 'iframe', text: string) {
    navigator.clipboard.writeText(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 1500)
  }

  const { url, iframe } = buildUrls(compilationId, undefined)

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span>
          Anyone with this link sees the <span className="font-medium">PUBLIC-classified</span> content of
          “{compilationName}” — no login, no token. Internal/confidential/restricted nodes and edges are never
          served through it, regardless of this graph's own classification.
        </span>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}

      <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 p-3">
        <span className="text-xs font-medium text-slate-200">Public embed link</span>
        <span className="flex items-center gap-2">
          {busy && <Loader2 size={13} className="animate-spin text-slate-500" />}
          <input
            type="checkbox"
            checked={embedPublic}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
        </span>
      </label>

      {embedPublic && (
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
          <SnippetRow label="Direct URL" value={url} active={copied === 'url'} onCopy={() => copy('url', url)} />
          <SnippetRow label="Iframe snippet" value={iframe} active={copied === 'iframe'} onCopy={() => copy('iframe', iframe)} />
        </div>
      )}
    </div>
  )
}

// ─── Shared: a labelled, copyable code snippet ───────────────────────────────────

function SnippetRow({ label, value, active, onCopy }: { label: string; value: string; active: boolean; onCopy: () => void }) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <div className="relative">
        <pre className="max-h-24 overflow-auto rounded bg-slate-950 p-2.5 pr-16 text-[10px] leading-relaxed text-slate-300"><code>{value}</code></pre>
        <button
          onClick={onCopy}
          className="absolute right-1.5 top-1.5 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700"
        >
          {active ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
        </button>
      </div>
    </div>
  )
}
