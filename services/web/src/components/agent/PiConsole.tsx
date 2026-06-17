import { useRef, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, X, Trash2, Send, Settings, Loader2, Brain } from 'lucide-react'
import { useAgent } from './AgentProvider'
import { ToolCallCard } from './ToolCallCard'
import { useApiQuery } from '@/hooks/useApi'
import { cn } from '@/lib/utils'
import { pickDefaultChatModel, isValidChatSelection } from '@/lib/models'

interface LlmModelOption {
  provider: string
  model: string
  name: string
  available: boolean
  requiresKey?: boolean
}
interface LlmModelsResponse {
  models: LlmModelOption[]
}
interface LlmProviderState {
  provider: string
  connected: boolean
  defaultModel?: string | null
}
interface LlmProvidersResponse {
  providers: LlmProviderState[]
}

export function PiConsole() {
  const {
    isOpen,
    close,
    toggle,
    messages,
    isStreaming,
    sendMessage,
    clearMessages,
    llmProvider,
    setLlmProvider,
    llmModel,
    setLlmModel,
  } = useAgent()

  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Available models (Ollama + connected cloud providers) from the backend.
  // Only fetch while the panel is open to avoid unnecessary calls.
  const { data: modelsData } = useApiQuery<LlmModelsResponse>(
    ['llm', 'models'],
    '/llm/models',
    { retry: false, staleTime: 60_000, enabled: isOpen }
  )
  const models = modelsData?.models ?? []

  // Connected providers — drives the agent-first "connect an LLM" nudge.
  const { data: providersData, isLoading: providersLoading } = useApiQuery<LlmProvidersResponse>(
    ['llm', 'providers'],
    '/llm/providers',
    { retry: false, staleTime: 60_000, enabled: isOpen }
  )

  // Repair the selected model once the list loads: if it's empty, an embedding
  // model, or no longer in the (embedding-filtered) list, pick a known-good chat
  // model so the widget never sits on a non-working default.
  useEffect(() => {
    if (models.length === 0) return
    if (llmProvider === 'ollama' && !isValidChatSelection(llmModel, models)) {
      // Prefer the user's configured provider default (e.g. a working cloud model)
      // over the "biggest local" heuristic, which can pick a model that crashes.
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
  const hasProvider = (providersData?.providers ?? []).some((p) => p.connected)
  const hasModel = models.some((m) => m.available !== false)
  // First-run nudge: render a connect card instead of the chat input when no
  // provider AND no model is available. Wait for the queries to settle so we
  // don't flash the nudge before data loads.
  const noLlmConnected = !providersLoading && !hasProvider && !hasModel

  // Scroll to bottom on new messages
  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isOpen])

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    void sendMessage(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const text = input.trim()
      if (!text || isStreaming) return
      setInput('')
      void sendMessage(text)
    }
  }

  return (
    <>
      {/* Floating action button */}
      <button
        onClick={toggle}
        className={cn(
          'fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all duration-200',
          'bg-blue-600 text-white hover:bg-blue-500',
          isOpen && 'ring-2 ring-blue-400 ring-offset-2 ring-offset-slate-950'
        )}
        title="Open GCTRL Agent"
        aria-label="Toggle agent console"
      >
        <Bot className="h-5 w-5" />
      </button>

      {/* Panel */}
      {isOpen && (
        <div className="fixed bottom-20 right-6 z-50 flex w-96 max-h-[70vh] flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-slate-700 px-4 py-3 shrink-0">
            <Bot className="h-4 w-4 text-blue-400" />
            <span className="font-semibold text-sm text-slate-100">GCTRL Agent</span>
            <span className={cn(
              'ml-1 rounded-full px-2 py-0.5 text-xs',
              llmProvider === 'ollama'
                ? 'bg-green-500/20 text-green-400'
                : 'bg-purple-500/20 text-purple-400'
            )}>
              {llmProvider === 'ollama' ? 'Local' : 'Cloud'}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => setShowSettings(p => !p)}
                className={cn(
                  'rounded p-1 transition-colors',
                  showSettings
                    ? 'bg-slate-700 text-slate-200'
                    : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
                )}
                title="Settings"
                aria-label="Toggle settings"
              >
                <Settings className="h-4 w-4" />
              </button>
              <button
                onClick={clearMessages}
                className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
                title="Clear conversation"
                aria-label="Clear conversation"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                onClick={close}
                className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
                title="Close"
                aria-label="Close panel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Settings panel */}
          {showSettings && (
            <div className="border-b border-slate-700 bg-slate-800/50 px-4 py-3 space-y-2 text-sm shrink-0">
              <div className="flex items-center gap-2">
                <label className="text-slate-400 w-20 text-xs">Model</label>
                <select
                  value={`${llmProvider}:${llmModel}`}
                  onChange={e => {
                    const [provider, ...rest] = e.target.value.split(':')
                    setLlmProvider(provider)
                    setLlmModel(rest.join(':'))
                  }}
                  className="flex-1 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  // Render the native dropdown popup dark — without this the
                  // <option> list shows white-on-white on Windows/Chrome.
                  style={{ colorScheme: 'dark' }}
                >
                  {/* Keep the current selection visible even before models load. */}
                  {!models.some(m => m.provider === llmProvider && m.model === llmModel) && (
                    <option value={`${llmProvider}:${llmModel}`}>{llmProvider} · {llmModel}</option>
                  )}
                  {models.map(m => (
                    <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`} disabled={!m.available}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-slate-500">
                {llmProvider === 'ollama'
                  ? 'Runs locally via Ollama — GDPR-safe, no data leaves your network.'
                  : `Uses ${llmProvider} — connect your key in Settings → AI Models.`}
              </p>
            </div>
          )}

          {/* First-run nudge: no LLM connected */}
          {noLlmConnected ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10">
                <Brain className="h-7 w-7 text-blue-400" />
              </div>
              <p className="mt-4 text-sm font-semibold text-slate-100">Connect an LLM to start</p>
              <p className="mt-1.5 text-xs text-slate-400">
                The GCTRL agent needs a language model. Connect a cloud provider or run locally with Ollama.
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
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-8 text-center">
                <Bot className="h-10 w-10 text-slate-600 mb-3" />
                <p className="text-sm text-slate-400 mb-4">
                  Ask me to extract knowledge, query graphs, fuse data, or manage your sources.
                </p>
                <div className="flex flex-col gap-1.5 w-full">
                  {[
                    'List all my knowledge graphs',
                    'Check my token balance',
                    'What sources are connected?',
                  ].map(suggestion => (
                    <button
                      key={suggestion}
                      onClick={() => void sendMessage(suggestion)}
                      className="text-xs text-left rounded-lg border border-slate-700 px-3 py-2 hover:bg-slate-800 hover:border-slate-600 transition-colors text-slate-400 hover:text-slate-200"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.id}
                  className={cn(
                    'flex flex-col gap-1',
                    msg.role === 'user' ? 'items-end' : 'items-start'
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                      msg.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-100'
                    )}
                  >
                    {msg.content
                      ? msg.content
                      : msg.isStreaming
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                        : null}
                  </div>
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="w-full max-w-full">
                      {msg.toolCalls.map((tc, i) => (
                        <ToolCallCard key={i} toolCall={tc} />
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={handleSubmit}
            className="border-t border-slate-700 px-3 py-3 flex gap-2 shrink-0"
          >
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the agent..."
              disabled={isStreaming}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || isStreaming}
              className="rounded-lg bg-blue-600 px-3 py-2 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
              aria-label="Send message"
            >
              {isStreaming
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Send className="h-4 w-4" />
              }
            </button>
          </form>
          </>
          )}
        </div>
      )}
    </>
  )
}
