/**
 * AgentPage — full-page terminal for the GCTRL Pi agent.
 *
 * Reuses the shared `useAgent()` SSE session (so it stays in sync with the
 * floating PiConsole) and the `ToolCallCard` renderer. Adds a model picker
 * (local Ollama + connected cloud, from GET /llm/models) and a header showing
 * the clearance/identity the agent runs under — the logged-in user's. Every
 * GCTRL operation the agent performs is governed by that token's clearance:
 * an admin gets full control; a scoped token only acts within its grants.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Terminal, Send, Trash2, Loader2, ShieldCheck, Cpu, Brain } from 'lucide-react'
import { useAgent, FULL_ACCESS_RANK } from '@/components/agent/AgentProvider'
import { ToolCallCard } from '@/components/agent/ToolCallCard'
import { useApiQuery } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { pickDefaultChatModel, isValidChatSelection } from '@/lib/models'
import { cn } from '@/lib/utils'

interface LlmModelOption {
  provider: string
  model: string
  name: string
  available: boolean
  requiresKey?: boolean
}
interface LlmModelsResponse { models: LlmModelOption[] }
interface LlmProviderState { provider: string; connected: boolean; defaultModel?: string | null }
interface LlmProvidersResponse { providers: LlmProviderState[] }
interface ClassificationLevel { id: string; name: string; display_name: string; rank: number; is_active?: boolean }

const SUGGESTIONS = [
  'List all my knowledge graphs',
  'Read the graph for my first compilation and summarize it',
  'Find a wrong relationship and correct it',
  'List my extraction jobs and their status',
]

export function AgentPage() {
  const {
    messages,
    isStreaming,
    sendMessage,
    clearMessages,
    llmProvider,
    setLlmProvider,
    llmModel,
    setLlmModel,
    overrideClearanceRank,
    setOverrideClearanceRank,
  } = useAgent()
  const { user } = useAuth()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'

  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: modelsData } = useApiQuery<LlmModelsResponse>(
    ['llm', 'models'],
    '/llm/models',
    { retry: false, staleTime: 60_000 },
  )
  const models = modelsData?.models ?? []

  const { data: providersData, isLoading: providersLoading } = useApiQuery<LlmProvidersResponse>(
    ['llm', 'providers'],
    '/llm/providers',
    { retry: false, staleTime: 60_000 },
  )
  const hasProvider = (providersData?.providers ?? []).some((p) => p.connected)
  const hasModel = models.some((m) => m.available !== false)
  const noLlmConnected = !providersLoading && !hasProvider && !hasModel

  // Group models for the picker: local Ollama, Ollama Cloud (ollama.com via key),
  // and other cloud providers (OpenAI/Anthropic/OpenRouter).
  const { localModels, ollamaCloudModels, cloudModels } = useMemo(() => {
    const local = models.filter((m) => m.provider === 'ollama')
    const ollamaCloud = models.filter((m) => m.provider === 'ollama_cloud')
    const cloud = models.filter((m) => m.provider !== 'ollama' && m.provider !== 'ollama_cloud')
    return { localModels: local, ollamaCloudModels: ollamaCloud, cloudModels: cloud }
  }, [models])

  // ── Per-session clearance the agent runs at ──────────────────────────────────
  // The onboard CTO agent (admin) defaults to FULL access and can be downgraded;
  // a non-admin is capped at their own stored clearance (downgrade only).
  const { data: levelsData } = useApiQuery<{ levels: ClassificationLevel[] }>(
    ['classification', 'levels'],
    '/classification/levels',
    { retry: false, staleTime: 300_000 },
  )
  const levels = useMemo(
    () => [...(levelsData?.levels ?? [])].filter((l) => l.is_active !== false).sort((a, b) => a.rank - b.rank),
    [levelsData],
  )
  const storedRank = useMemo(
    () => levels.find((l) => l.name === user?.clearance)?.rank ?? 100,
    [levels, user],
  )
  const clearanceOptions = useMemo(() => {
    const opts = levels
      .filter((l) => isAdmin || l.rank <= storedRank) // non-admin: no escalation
      .map((l) => ({ value: l.rank, label: l.display_name || l.name }))
    if (isAdmin) opts.push({ value: FULL_ACCESS_RANK, label: 'Full access (all data)' })
    return opts
  }, [levels, isAdmin, storedRank])

  // Seed the default once levels load: admin → full access; others → stored rank.
  useEffect(() => {
    if (overrideClearanceRank != null || levels.length === 0) return
    setOverrideClearanceRank(isAdmin ? FULL_ACCESS_RANK : storedRank)
  }, [levels, isAdmin, storedRank, overrideClearanceRank, setOverrideClearanceRank])

  const effectiveClearanceLabel =
    overrideClearanceRank === FULL_ACCESS_RANK
      ? 'FULL'
      : clearanceOptions.find((o) => o.value === overrideClearanceRank)?.label
        ?? user?.clearance ?? '—'

  // Default/repair the model: prefer the user's configured provider default (e.g.
  // a working cloud model) over the "biggest local" heuristic, so the agent never
  // lands on a local model that crashes the Ollama runner on this machine.
  useEffect(() => {
    if (models.length === 0) return
    if (!isValidChatSelection(llmModel, models)) {
      const configured = (providersData?.providers ?? [])
        .find((p) => p.connected && p.defaultModel)?.defaultModel
      const def = pickDefaultChatModel(models, configured)
      if (def && def !== llmModel) {
        const match = models.find((m) => m.model === def)
        if (match && match.provider !== llmProvider) setLlmProvider(match.provider)
        setLlmModel(def)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, providersData])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const submit = () => {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    void sendMessage(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
          <Terminal className="h-5 w-5 text-blue-400" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-slate-100">GCTRL Agent · Pi</h1>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <ShieldCheck className="h-3 w-3 text-emerald-500" />
            Running as <span className="text-slate-300">{user?.email ?? 'you'}</span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-400">
              {user?.role ?? 'user'}
            </span>
            <span className="text-slate-600">·</span>
            clearance <span className={cn('text-slate-300', effectiveClearanceLabel === 'FULL' && 'text-emerald-300')}>{effectiveClearanceLabel}</span>
            {isAdmin && overrideClearanceRank !== FULL_ACCESS_RANK && (
              <span className="text-amber-500/70">(downgraded)</span>
            )}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Clearance picker — admin defaults to full access, downgradable */}
          {clearanceOptions.length > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1" title="Clearance the agent operates at this session">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              <select
                value={overrideClearanceRank ?? ''}
                onChange={(e) => setOverrideClearanceRank(Number(e.target.value))}
                className="bg-transparent text-xs text-slate-200 focus:outline-none"
                style={{ colorScheme: 'dark' }}
              >
                {clearanceOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
          {/* Model picker */}
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1">
            <Cpu className="h-3.5 w-3.5 text-slate-500" />
            <select
              value={`${llmProvider}:${llmModel}`}
              onChange={(e) => {
                const [provider, ...rest] = e.target.value.split(':')
                setLlmProvider(provider)
                setLlmModel(rest.join(':'))
              }}
              className="bg-transparent text-xs text-slate-200 focus:outline-none"
              // Native <option> popup must render dark — without color-scheme the
              // list shows white-on-white (light text on the browser's white menu).
              style={{ colorScheme: 'dark' }}
            >
              {!models.some((m) => m.provider === llmProvider && m.model === llmModel) && (
                <option value={`${llmProvider}:${llmModel}`}>{llmProvider} · {llmModel}</option>
              )}
              {localModels.length > 0 && (
                <optgroup label="Local (Ollama)">
                  {localModels.map((m) => (
                    <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`} disabled={!m.available}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {ollamaCloudModels.length > 0 && (
                <optgroup label="Ollama Cloud">
                  {ollamaCloudModels.map((m) => (
                    <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`} disabled={!m.available}>
                      {m.model}
                    </option>
                  ))}
                </optgroup>
              )}
              {cloudModels.length > 0 && (
                <optgroup label="Cloud">
                  {cloudModels.map((m) => (
                    <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`} disabled={!m.available}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <button
            onClick={clearMessages}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
            title="Clear conversation"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </header>

      {noLlmConnected ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10">
            <Brain className="h-7 w-7 text-blue-400" />
          </div>
          <p className="mt-4 text-sm font-semibold text-slate-100">Connect an LLM to start</p>
          <p className="mt-1.5 max-w-md text-xs text-slate-400">
            The agent needs a language model. Connect a cloud provider or run locally with Ollama —
            local and <code>:cloud</code> Ollama models both appear in the picker once connected.
          </p>
          <button
            onClick={() => navigate('/settings?tab=models')}
            className="mt-4 flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            <Brain className="h-4 w-4" /> Open AI Model settings
          </button>
        </div>
      ) : (
        <>
          {/* Terminal body */}
          <div className="flex-1 overflow-y-auto bg-slate-950/40 px-5 py-4 font-mono text-sm">
            {messages.length === 0 ? (
              <div className="mx-auto max-w-2xl py-10 text-center">
                <Terminal className="mx-auto mb-3 h-10 w-10 text-slate-700" />
                <p className="mb-1 text-sm text-slate-300">GCTRL Pi terminal</p>
                <p className="mb-5 text-xs text-slate-500">
                  Full control over KEX, FUSE, graphs, ontologies and vector chunks — governed by your
                  clearance. Ask in natural language; every action runs as a transparent tool call.
                </p>
                <div className="flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => void sendMessage(s)}
                      className="rounded-lg border border-slate-800 px-3 py-2 text-left text-xs text-slate-400 transition-colors hover:border-slate-700 hover:bg-slate-800/50 hover:text-slate-200"
                    >
                      <span className="mr-2 text-blue-500">$</span>{s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-4">
                {messages.map((msg) => (
                  <div key={msg.id} className="space-y-1.5">
                    {msg.role === 'user' ? (
                      <div className="flex gap-2">
                        <span className="select-none text-emerald-500">$</span>
                        <span className="whitespace-pre-wrap text-slate-200">{msg.content}</span>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <span className="select-none text-blue-500">λ</span>
                        <div className="min-w-0 flex-1">
                          {msg.content ? (
                            <div className="whitespace-pre-wrap font-sans text-slate-100">{msg.content}</div>
                          ) : msg.isStreaming && (!msg.toolCalls || msg.toolCalls.length === 0) ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                          ) : null}
                          {msg.toolCalls && msg.toolCalls.length > 0 && (
                            <div className="mt-1">
                              {msg.toolCalls.map((tc, i) => (
                                <ToolCallCard key={i} toolCall={tc} />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-slate-800 px-5 py-3">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask Pi to extract, query, fuse, edit graphs, correct facts… (Enter to send, Shift+Enter for newline)"
                rows={1}
                disabled={isStreaming}
                className="max-h-40 flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40 disabled:opacity-50"
              />
              <button
                onClick={submit}
                disabled={!input.trim() || isStreaming}
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-40',
                )}
                aria-label="Send"
              >
                {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
