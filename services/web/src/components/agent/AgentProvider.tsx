import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react'
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
}

const AgentContext = createContext<AgentContextValue | null>(null)

export function AgentProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [llmProvider, setLlmProvider] = useState<string>('ollama')
  const [llmModel, setLlmModel] = useState('llama3.2')
  const sessionId = useRef<string>(crypto.randomUUID())

  const sendMessage = useCallback(async (text: string) => {
    if (isStreaming) return

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
                  ? { ...m, content: `Error: ${event.message ?? 'Unknown error'}`, isStreaming: false }
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
  }, [isStreaming, llmProvider, llmModel])

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
