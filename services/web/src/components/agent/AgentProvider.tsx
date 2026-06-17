import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { getToken } from '@/lib/auth'

interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result?: unknown }>
  isStreaming?: boolean
}

interface AgentContextValue {
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
  messages: AgentMessage[]
  isStreaming: boolean
  sendMessage: (text: string) => Promise<void>
  clearMessages: () => void
  llmProvider: string
  setLlmProvider: (p: string) => void
  llmModel: string
  setLlmModel: (m: string) => void
  // Per-session clearance the agent operates at (a classification rank, or
  // FULL_ACCESS_RANK for "full access"). null = use the server default
  // (admins → full access). Sent on each chat request.
  overrideClearanceRank: number | null
  setOverrideClearanceRank: (r: number | null) => void
}

// i32::MAX — the backend's "full access" sentinel (must fit in an i32, so NOT
// Number.MAX_SAFE_INTEGER).
export const FULL_ACCESS_RANK = 2147483647

const AgentContext = createContext<AgentContextValue | null>(null)

// Persist the chosen agent model across reloads/navigation (per device). The
// backend honors the model sent on each request; this just stops the widget from
// snapping back to the llama3.2 default every time.
const LS_PROVIDER = 'gctrl.agent.llmProvider'
const LS_MODEL = 'gctrl.agent.llmModel'
function lsGet(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key)
    return v && v.trim() ? v : fallback
  } catch {
    return fallback
  }
}

// Turn a raw LLM transport error into a useful hint. A local Ollama model that
// crashes the runner ("signal arrived during cgo execution" / "runner process
// has terminated", usually a 500) means *that model* can't run on this machine —
// guide the user to switch models rather than showing a wall of stack text.
function humanizeAgentError(raw: string): string {
  const r = raw.toLowerCase()
  if (
    r.includes('cgo execution') ||
    r.includes('runner process has terminated') ||
    (r.includes('500') && r.includes('llm error'))
  ) {
    return 'This model failed to run on your machine (the local Ollama runner crashed). Pick a different model from the selector (top-right) — a cloud model usually works.'
  }
  return raw
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [llmProvider, setLlmProviderState] = useState<string>(() => lsGet(LS_PROVIDER, 'ollama'))
  const [llmModel, setLlmModelState] = useState(() => lsGet(LS_MODEL, 'llama3.2'))
  const setLlmProvider = useCallback((p: string) => {
    setLlmProviderState(p)
    try { localStorage.setItem(LS_PROVIDER, p) } catch { /* ignore */ }
  }, [])
  const setLlmModel = useCallback((m: string) => {
    setLlmModelState(m)
    try { localStorage.setItem(LS_MODEL, m) } catch { /* ignore */ }
  }, [])
  // null until the Agent page decides the default (admin → full access).
  const [overrideClearanceRank, setOverrideClearanceRank] = useState<number | null>(null)
  const sessionId = useRef<string>(crypto.randomUUID())
  // Mirror of `messages` for reading the running thread inside sendMessage without
  // a stale closure — Pi is server-stateless, so we replay this history each turn.
  const messagesRef = useRef<AgentMessage[]>([])
  useEffect(() => { messagesRef.current = messages }, [messages])

  const sendMessage = useCallback(async (text: string) => {
    if (isStreaming) return

    // Capture the PRIOR turns (working memory) before we append this turn, so the
    // agent keeps cross-turn context. Text-only, last 8 turns, bounded length.
    const history = messagesRef.current
      .filter((m) => m.content.trim().length > 0)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }))

    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    }
    const assistantMsgId = crypto.randomUUID()
    const assistantMsg: AgentMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      toolCalls: [],
      isStreaming: true,
    }

    setMessages(prev => [...prev, userMsg, assistantMsg])
    setIsStreaming(true)

    try {
      const token = getToken()
      const baseUrl = (import.meta.env as Record<string, string | undefined>)['VITE_API_URL'] ?? window.location.origin
      const response = await fetch(`${baseUrl}/api/agent/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: text,
          sessionId: sessionId.current,
          llmProvider,
          llmModel,
          history,
          ...(overrideClearanceRank != null ? { overrideClearanceRank } : {}),
        }),
      })

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      // Buffer partial SSE frames across reads. A single network chunk can split a
      // `data: {...}` line mid-JSON — common for LARGE events like a search_chunks
      // or list_extractions tool_result. Without buffering, the partial line fails
      // to parse and the event is lost, so its tool card stays stuck on "running".
      // We keep the trailing incomplete segment and only parse complete lines.
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // The last element is an incomplete line (no trailing newline yet) — retain it.
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trimEnd()
          if (!trimmed.startsWith('data: ')) continue
          try {
            const event = JSON.parse(trimmed.slice(6)) as {
              type: string
              content?: string
              name?: string
              args?: Record<string, unknown>
              result?: unknown
              message?: string
            }

            if (event.type === 'token') {
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? { ...m, content: m.content + (event.content ?? '') }
                  : m
              ))
            } else if (event.type === 'tool_call') {
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), { name: event.name ?? '', args: event.args ?? {} }] }
                  : m
              ))
            } else if (event.type === 'tool_result') {
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      toolCalls: (m.toolCalls ?? []).map(tc =>
                        tc.name === event.name && tc.result === undefined
                          ? { ...tc, result: event.result }
                          : tc
                      ),
                    }
                  : m
              ))
            } else if (event.type === 'done') {
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, isStreaming: false } : m
              ))
            } else if (event.type === 'error') {
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                  ? { ...m, content: humanizeAgentError(event.message ?? 'Unknown error'), isStreaming: false }
                  : m
              ))
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId
          ? { ...m, content: `Failed to connect to agent: ${String(err)}`, isStreaming: false }
          : m
      ))
    } finally {
      setIsStreaming(false)
    }
  }, [isStreaming, llmProvider, llmModel, overrideClearanceRank])

  return (
    <AgentContext.Provider value={{
      isOpen,
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
      toggle: () => setIsOpen(p => !p),
      messages,
      isStreaming,
      sendMessage,
      clearMessages: () => {
        setMessages([])
        sessionId.current = crypto.randomUUID()
      },
      llmProvider,
      setLlmProvider,
      llmModel,
      setLlmModel,
      overrideClearanceRank,
      setOverrideClearanceRank,
    }}>
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used inside AgentProvider')
  return ctx
}
