import {
  useState,
  useEffect,
  useRef,
  useMemo,
  memo,
  type KeyboardEvent,
} from 'react'
import { useDropzone } from 'react-dropzone'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  MessageSquare,
  Send,
  Copy,
  Eye,
  Lock,
  Unlock,
  Plus,
  Trash2,
  File,
  Database,
  Bot,
  User,
  BarChart3,
  X,
  Check,
  Key,
  ChevronDown,
  ExternalLink,
  ThumbsUp,
  ThumbsDown,
  FileText,
  Link,
  Globe,
  ChevronRight,
  Mic,
  MicOff,
  ShieldCheck,
} from 'lucide-react'
import { useApiQuery, useApiMutation } from '@/hooks/useApi'
import { usePublicConfig } from '@/hooks/usePublicConfig'
import { useUiMode } from '@/hooks/useUiMode'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { getToken } from '@/lib/auth'
import { pickDefaultChatModel, isValidChatSelection } from '@/lib/models'
import { formatDistanceToNow } from 'date-fns'

/// Safe relative-time formatter. `formatDistanceToNow(new Date(undefined))` throws
/// "Invalid time value" — which the app error boundary turns into a blank screen.
/// Returns '' for missing/invalid timestamps so a bad date never crashes the page.
function timeAgo(value?: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return formatDistanceToNow(d, { addSuffix: true })
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Source {
  name: string
  type: string
  relevance: number
  text?: string
  excerpt?: string
  jobRef?: string
  label?: string
  url?: string
  imageUrl?: string
  entityMentions?: string[]
  chunkId?: string
  // The graph THIS source came from (server-resolved) — so "open in graph" opens
  // the exact graph the node is in, even when chatting across all graphs.
  compilationId?: string
}

interface ChatMessage {
  id: string
  role: 'human' | 'ai'
  content: string
  sources?: Source[]
  cypher?: string
  confidence?: number
  graphTrace?: {
    nodes: Array<{ id: string; name: string; type: string }>
    edges: Array<{ source: string; target: string; type: string }>
  }
  tokensUsed?: number
  model?: string
  imageUrl?: string
  createdAt: string
  feedback?: 'up' | 'down'
  // The graph this answer's evidence came from — so tracing a source opens the
  // correct graph (with the node in it), not a guessed first graph.
  sourceCompilationId?: string
  // Private Memory: present only when this answer's context was routed
  // through a cloud model with the graph's privacy mode set to "cloaked".
  privacy?: { mode: string; cloakedEntities?: number }
}

interface Conversation {
  id: string
  title: string
  // The list endpoint returns `updatedAt`; `createdAt` may be absent.
  updatedAt?: string
  createdAt?: string
  model?: string
  compilationName?: string
}

interface ModelOption {
  provider: string
  model: string
  name: string
  available: boolean
  requiresKey?: boolean
}

interface Compilation {
  id: string
  name: string
  entityCount: number
}

interface RagQueryResponse {
  answer: string
  conversationId?: string
  sources?: Source[]
  cypher?: string
  confidence?: number
  graphTrace?: {
    nodes: Array<{ id: string; name: string; type: string }>
    edges: Array<{ source: string; target: string; type: string }>
  }
  tokensUsed?: number
  model?: string
  privacy?: { mode: string; cloakedEntities?: number }
  sourceCompilationId?: string
}

interface ConversationsResponse {
  conversations: Conversation[]
}

interface ConversationDetailResponse {
  conversation: {
    id: string
    title: string
    messages: ChatMessage[]
  }
}

interface ModelsResponse {
  models: ModelOption[]
}

interface CompilationsResponse {
  compilations: Compilation[]
}

interface KexFromChatResponse {
  jobId: string
  status: string
}

type Mode = 'standard' | 'incognito'
type Depth = 'fast' | 'deep'

// ─── Utility: nano-id ────────────────────────────────────────────────────────

function nanoid(): string {
  return Math.random().toString(36).slice(2, 11)
}

// ─── Utility: simple markdown renderer (no external lib) ─────────────────────

function renderMarkdown(text: string): string {
  let html = text
    // Escape HTML first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre class="my-2 overflow-x-auto rounded-xl bg-slate-950/80 p-3 text-xs text-slate-300 border border-white/5"><code>${code.trim()}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="rounded bg-slate-700 px-1 py-0.5 text-xs text-blue-300">$1</code>')

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>')

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em class="text-slate-200">$1</em>')

  // Tables: detect | col | col | pattern
  html = html.replace(/((\|[^\n]+\|\n?)+)/g, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(Boolean)
    if (rows.length < 2) return tableBlock
    const isSep = (r: string) => /^\|[\s|:-]+\|$/.test(r.trim())
    const parseRow = (r: string) =>
      r
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())

    const headerRow = rows[0]
    const sepRow = rows[1]
    if (!isSep(sepRow)) return tableBlock

    const headers = parseRow(headerRow)
    const dataRows = rows.slice(2)

    const thCells = headers
      .map((h) => `<th class="px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">${h}</th>`)
      .join('')
    const bodyRows = dataRows
      .map((r) => {
        const cells = parseRow(r)
          .map((c) => `<td class="px-3 py-2 text-sm text-slate-300 border-t border-slate-800">${c}</td>`)
          .join('')
        return `<tr>${cells}</tr>`
      })
      .join('')

    return `<div class="my-2 overflow-x-auto rounded-lg border border-slate-700"><table class="w-full"><thead><tr class="bg-slate-800/60">${thCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`
  })

  // Unordered lists
  html = html.replace(/^([ \t]*[-*+] .+(\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const content = line.replace(/^[ \t]*[-*+] /, '')
        return `<li class="ml-4 text-slate-300">${content}</li>`
      })
      .join('')
    return `<ul class="my-1.5 list-disc space-y-0.5 pl-2">${items}</ul>`
  })

  // Ordered lists
  html = html.replace(/^([ \t]*\d+\. .+(\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const content = line.replace(/^[ \t]*\d+\. /, '')
        return `<li class="ml-4 text-slate-300">${content}</li>`
      })
      .join('')
    return `<ol class="my-1.5 list-decimal space-y-0.5 pl-2">${items}</ol>`
  })

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3 class="mt-3 mb-1 text-sm font-semibold text-slate-200">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 class="mt-3 mb-1 text-base font-semibold text-slate-100">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 class="mt-3 mb-1 text-lg font-bold text-slate-100">$1</h1>')

  // Paragraphs: double newline → paragraph break
  html = html.replace(/\n{2,}/g, '</p><p class="mt-2">')

  // Single newlines
  html = html.replace(/\n/g, '<br />')

  return `<p class="leading-relaxed">${html}</p>`
}

// ─── Confidence Badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ score }: { score: number }) {
  if (score >= 0.8) {
    return (
      <span className="badge badge-green gap-1 glow-emerald">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
        High {Math.round(score * 100)}%
      </span>
    )
  }
  if (score >= 0.5) {
    return (
      <span className="badge badge-yellow gap-1 glow-amber">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.8)]" />
        Medium {Math.round(score * 100)}%
      </span>
    )
  }
  return (
    <span className="badge badge-red gap-1 glow-red">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.8)]" />
      Low {Math.round(score * 100)}%
    </span>
  )
}

// ─── Typing Indicator ────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-end gap-3 animate-message-in">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500/20 ring-1 ring-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.2)]">
        <Bot size={14} className="text-blue-400" />
      </div>
      <div className="rounded-2xl rounded-bl-sm bg-white/5 backdrop-blur-sm border border-white/5 px-4 py-3">
        <div className="flex gap-1.5 items-center h-4">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  )
}

// ─── Source Stack (Perplexity-style stacked icons) ────────────────────────────

function getSourceIconEmoji(type: string): string {
  if (type === 'semantic') return '📄'
  if (type === 'graph') return '🔗'
  return '🌐'
}

function SourceStack({
  sources,
  onShowTrace,
}: {
  sources: Source[]
  onShowTrace: () => void
}) {
  const visibleIcons = sources.slice(0, 5)
  return (
    <button
      onClick={onShowTrace}
      className="flex items-center gap-2 mt-2 group"
      title="View sources"
    >
      <div className="flex -space-x-2">
        {visibleIcons.map((s, i) => (
          <div
            key={i}
            className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-slate-900 bg-slate-700 text-[10px] shadow-sm"
            style={{ zIndex: visibleIcons.length - i }}
          >
            {getSourceIconEmoji(s.type)}
          </div>
        ))}
      </div>
      <span className="text-xs text-slate-500 group-hover:text-blue-400 transition-colors flex items-center gap-1">
        {sources.length} Source{sources.length !== 1 ? 's' : ''}
        <ChevronRight size={11} className="opacity-60" />
      </span>
    </button>
  )
}

// ─── Graph SVG Visualization ─────────────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  Person: '#3b82f6',
  Organization: '#8b5cf6',
  Location: '#10b981',
  Concept: '#f59e0b',
  Event: '#ef4444',
  Product: '#06b6d4',
  Document: '#6366f1',
}

function getNodeColor(type: string): string {
  return NODE_COLORS[type] ?? '#64748b'
}

interface GraphNode {
  id: string
  name: string
  type: string
  x: number
  y: number
}

function GraphVisualization({
  nodes,
  edges,
}: {
  nodes: Array<{ id: string; name: string; type: string }>
  edges: Array<{ source: string; target: string; type: string }>
}) {
  // Simple force-like layout: place nodes in a circle
  const W = 280
  const H = 200
  const cx = W / 2
  const cy = H / 2
  const r = Math.min(cx, cy) - 36

  const positioned = useMemo<GraphNode[]>(() => {
    if (nodes.length === 0) return []
    if (nodes.length === 1) {
      return [{ ...nodes[0], x: cx, y: cy }]
    }
    return nodes.map((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2
      return {
        ...n,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
      }
    })
  }, [nodes, cx, cy, r])

  const posMap = useMemo(() => {
    const m: Record<string, { x: number; y: number }> = {}
    positioned.forEach((n) => { m[n.id] = { x: n.x, y: n.y } })
    return m
  }, [positioned])

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-xs text-slate-600">
        No graph data
      </div>
    )
  }

  return (
    <svg width={W} height={H} className="rounded-xl bg-white/[0.03] border border-white/5">
      {/* Edges */}
      {edges.map((e, i) => {
        const s = posMap[e.source]
        const t = posMap[e.target]
        if (!s || !t) return null
        const mx = (s.x + t.x) / 2
        const my = (s.y + t.y) / 2
        return (
          <g key={i}>
            <line
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              stroke="#334155"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
            <text
              x={mx}
              y={my - 3}
              textAnchor="middle"
              fontSize={8}
              fill="#475569"
              className="select-none"
            >
              {e.type}
            </text>
          </g>
        )
      })}
      {/* Nodes */}
      {positioned.map((n) => {
        const color = getNodeColor(n.type)
        const label = n.name.length > 12 ? n.name.slice(0, 11) + '…' : n.name
        return (
          <g key={n.id}>
            <circle
              cx={n.x}
              cy={n.y}
              r={16}
              fill={color + '22'}
              stroke={color}
              strokeWidth={1.5}
            />
            <text
              x={n.x}
              y={n.y + 4}
              textAnchor="middle"
              fontSize={9}
              fontWeight="500"
              fill={color}
              className="select-none"
            >
              {label}
            </text>
            <text
              x={n.x}
              y={n.y + 26}
              textAnchor="middle"
              fontSize={8}
              fill="#64748b"
              className="select-none"
            >
              {n.type}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ─── Right Trace Panel ────────────────────────────────────────────────────────

function TracePanel({
  message,
  onClose,
  onTraceSource,
}: {
  message: ChatMessage
  onClose: () => void
  /** Open the graph viewer focused on this source's entity (trace provenance). */
  onTraceSource: (src: Source, compilationId?: string) => void
}) {
  const [cypherCopied, setCypherCopied] = useState(false)
  const [cypherExpanded, setCypherExpanded] = useState(false)
  // Sources with no recognized entity have no graph node — clicking expands the
  // full cited passage inline instead of opening an unfocused graph.
  const [expandedSrc, setExpandedSrc] = useState<Set<number>>(new Set())
  const { neo4jBrowser } = usePublicConfig()
  const { isExpert } = useUiMode()

  function copyQuery() {
    if (!message.cypher) return
    void navigator.clipboard.writeText(message.cypher)
    setCypherCopied(true)
    setTimeout(() => setCypherCopied(false), 2000)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-blue-400" />
          <span className="text-sm font-semibold text-slate-200">Sources</span>
          {message.sources && message.sources.length > 0 && (
            <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-400">
              {message.sources.length}
            </span>
          )}
        </div>
        <button onClick={onClose} className="btn-ghost h-7 w-7 p-0 hover:bg-white/5">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Confidence */}
        {message.confidence !== undefined && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">Confidence</span>
            <ConfidenceBadge score={message.confidence} />
          </div>
        )}

        {/* Perplexity-style source cards */}
        {message.sources && message.sources.length > 0 && (
          <div>
            <p className="mb-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Sources</p>
            <div className="space-y-2">
              {message.sources.map((src, i) => (
                <div
                  key={i}
                  onClick={() => {
                    // Traceable (has entity nodes) → open the graph focused there.
                    // Otherwise (raw chunk, no entity) → expand the full passage
                    // inline so the citation is readable rather than opening an
                    // unfocused graph of every node.
                    if ((src.entityMentions?.length ?? 0) > 0) {
                      onTraceSource(src, message.sourceCompilationId)
                      return
                    }
                    setExpandedSrc((prev) => {
                      const n = new Set(prev)
                      if (n.has(i)) n.delete(i); else n.add(i)
                      return n
                    })
                  }}
                  role="button"
                  title={(src.entityMentions?.length ?? 0) > 0
                    ? 'Open in the graph viewer to trace where this came from'
                    : 'Read the full cited passage'}
                  className="group cursor-pointer rounded-xl border border-white/5 bg-white/[0.03] p-3 transition-all duration-150 hover:border-blue-500/30 hover:bg-blue-500/5"
                >
                  <div className="flex items-start gap-2.5">
                    {/* Type icon */}
                    <div className={cn(
                      'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                      src.type === 'semantic' ? 'bg-blue-500/15 text-blue-400' :
                      src.type === 'graph' ? 'bg-violet-500/15 text-violet-400' :
                      'bg-emerald-500/15 text-emerald-400'
                    )}>
                      {src.type === 'semantic' ? <FileText size={13} /> :
                       src.type === 'graph' ? <Link size={13} /> :
                       <Globe size={13} />}
                    </div>

                    <div className="min-w-0 flex-1">
                      {/* Name + type badge */}
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="truncate text-xs font-semibold text-slate-200">{src.name}</span>
                        <span className={cn(
                          'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                          src.type === 'semantic' ? 'bg-blue-500/15 text-blue-400' :
                          src.type === 'graph' ? 'bg-violet-500/15 text-violet-400' :
                          'bg-emerald-500/15 text-emerald-400'
                        )}>
                          {src.type}
                        </span>
                      </div>

                      {/* Text excerpt (document chunks) */}
                      {(src.text || src.excerpt) && (
                        <p className={cn('mb-1.5 text-[11px] leading-relaxed text-slate-400', expandedSrc.has(i) ? 'whitespace-pre-wrap' : 'line-clamp-3')}>
                          {src.text || src.excerpt}
                        </p>
                      )}

                      {/* Web URL link */}
                      {src.url && (
                        <a
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mb-1.5 block truncate text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          {src.url}
                        </a>
                      )}

                      {/* Graph entity label */}
                      {src.label && src.type === 'graph' && (
                        <p className="mb-1.5 text-[11px] text-slate-400">
                          <span className="text-slate-600">Label:</span> {src.label}
                        </p>
                      )}

                      {/* Job reference */}
                      {src.jobRef && (
                        <p className="mb-1.5 text-[10px] text-slate-600 font-mono">
                          ref: {src.jobRef}
                        </p>
                      )}

                      {/* Relevance bar */}
                      <div className="flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-800">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all duration-500',
                              src.type === 'semantic' ? 'bg-blue-500' :
                              src.type === 'graph' ? 'bg-violet-500' :
                              'bg-emerald-500'
                            )}
                            style={{ width: `${Math.round(src.relevance * 100)}%` }}
                          />
                        </div>
                        <span className="shrink-0 text-[10px] font-medium text-slate-500">
                          {Math.round((src.relevance ?? 0) * 100)}%
                        </span>
                      </div>

                      {/* Click cue (revealed on hover) */}
                      <p className="mt-1.5 text-[10px] text-blue-400/0 group-hover:text-blue-400/90 transition-colors">
                        {(src.entityMentions?.length ?? 0) > 0
                          ? '→ Open in graph viewer to trace this source'
                          : expandedSrc.has(i)
                          ? '↑ Collapse passage'
                          : '→ Read the full cited passage'}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Graph visualization */}
        {message.graphTrace &&
          (message.graphTrace.nodes.length > 0 || message.graphTrace.edges.length > 0) && (
            <div>
              <p className="mb-2 text-xs font-medium text-slate-500 uppercase tracking-wider">Graph Context</p>
              <GraphVisualization
                nodes={message.graphTrace.nodes}
                edges={message.graphTrace.edges}
              />
              {/* Legend */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Array.from(new Set(message.graphTrace.nodes.map((n) => n.type))).map((type) => (
                  <span key={type} className="flex items-center gap-1 text-[10px] text-slate-500">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: getNodeColor(type) }}
                    />
                    {type}
                  </span>
                ))}
              </div>
            </div>
          )}

        {/* Cypher query — collapsible (Expert only) */}
        {isExpert && message.cypher && (
          <div>
            <button
              onClick={() => setCypherExpanded((v) => !v)}
              className="mb-2 flex w-full items-center justify-between text-xs font-medium text-slate-500 uppercase tracking-wider hover:text-slate-400 transition-colors"
            >
              <span>Cypher Query</span>
              <ChevronRight
                size={13}
                className={cn('transition-transform duration-200', cypherExpanded ? 'rotate-90' : '')}
              />
            </button>
            {cypherExpanded && (
              <div className="animate-fade-in">
                <div className="mb-1.5 flex items-center justify-end gap-1">
                  <button
                    onClick={copyQuery}
                    className="btn-ghost h-6 px-2 text-[10px] gap-1"
                  >
                    {cypherCopied ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                    {cypherCopied ? 'Copied' : 'Copy'}
                  </button>
                  <a
                    href={`${(neo4jBrowser || `http://${window.location.hostname}:7474`).replace(/\/$/, '')}/browser/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-ghost h-6 px-2 text-[10px] gap-1"
                  >
                    <ExternalLink size={10} />
                    Neo4j
                  </a>
                </div>
                <pre className="overflow-x-auto rounded-xl border border-white/5 bg-slate-950/80 backdrop-blur-sm p-3 text-[11px] text-slate-300 leading-relaxed">
                  <code>{message.cypher}</code>
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Token usage */}
        {message.tokensUsed !== undefined && (
          <div className="rounded-xl border border-white/5 bg-white/[0.03] backdrop-blur-sm p-3">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Tokens used</span>
              <span className="font-mono text-slate-400">{message.tokensUsed.toLocaleString()}</span>
            </div>
            {message.model && (
              <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                <span>Model</span>
                <span className="font-mono text-slate-400">{message.model}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Message Component ────────────────────────────────────────────────────────

const MessageItem = memo(function MessageItem({
  message,
  onShowTrace,
  onFeedback,
}: {
  message: ChatMessage
  onShowTrace: (msg: ChatMessage) => void
  onFeedback: (msgId: string, vote: 'up' | 'down') => void
}) {
  const [copied, setCopied] = useState(false)
  const isHuman = message.role === 'human'

  function handleCopy() {
    void navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (isHuman) {
    return (
      <div className="flex items-end justify-end gap-3 animate-message-in">
        <div className="max-w-[72%] rounded-2xl rounded-br-sm bg-blue-500/20 backdrop-blur-sm border border-blue-500/10 px-4 py-2.5 text-sm text-slate-100 shadow-lg shadow-blue-500/5 leading-relaxed">
          {message.content}
          <div className="mt-1 text-right text-[10px] text-slate-600">
            {timeAgo(message.createdAt)}
          </div>
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/10 backdrop-blur-sm">
          <User size={14} className="text-slate-300" />
        </div>
      </div>
    )
  }

  const hasSources = !!(message.sources?.length || message.cypher || message.graphTrace)

  return (
    <div className="group flex items-start gap-3 animate-message-in">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500/20 ring-1 ring-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.15)]">
        <Bot size={14} className="text-blue-400" />
      </div>
      <div className="max-w-[80%] min-w-0">
        {/* Message bubble */}
        <div className="rounded-2xl rounded-tl-sm bg-white/5 backdrop-blur-sm border border-white/5 px-5 py-4 shadow-sm transition-all duration-200 group-hover:border-white/10">
          {/* Image from web search (if available) */}
          {message.imageUrl && (
            <div className="mb-3 overflow-hidden rounded-xl border border-white/10">
              <img
                src={message.imageUrl}
                alt=""
                className="h-32 w-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            </div>
          )}

          {/* Markdown content */}
          <div
            className="prose-sm text-sm text-slate-300 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />

          {/* Perplexity-style source stack — compact single line */}
          {message.sources && message.sources.length > 0 && (
            <div className="mt-3 border-t border-white/5 pt-2.5">
              <SourceStack
                sources={message.sources}
                onShowTrace={() => onShowTrace(message)}
              />
            </div>
          )}
        </div>

        {/* Action row below message */}
        <div className="mt-1.5 flex items-center gap-1 pl-1">
          {/* Confidence pill — subtle */}
          {message.confidence !== undefined && (
            <span className="text-[10px] text-slate-600 tabular-nums">
              {Math.round(message.confidence * 100)}% confident
            </span>
          )}

          {/* Private Memory: this answer's context was cloaked before it left
              the machine (cloud model + graph privacy mode = "cloaked"). */}
          {message.privacy?.mode === 'cloaked' && (
            <span
              className="flex items-center gap-1 text-[10px] text-indigo-400"
              title="Entities and PII were pseudonymized before this request left your machine; the answer shown here has been restored to plain text."
            >
              <ShieldCheck size={10} />
              Cloaked{typeof message.privacy.cloakedEntities === 'number' ? ` · ${message.privacy.cloakedEntities} entities hidden` : ''}
            </span>
          )}

          {/* Timestamp */}
          <span className="text-[10px] text-slate-700">
            {timeAgo(message.createdAt)}
          </span>

          {/* Hover actions */}
          <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            {/* Thumbs up */}
            <button
              onClick={() => onFeedback(message.id, 'up')}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-md transition-all duration-150',
                message.feedback === 'up'
                  ? 'text-emerald-400'
                  : 'text-slate-600 hover:text-emerald-400 hover:bg-white/5'
              )}
              title="Good answer"
            >
              <ThumbsUp size={13} />
            </button>
            {/* Thumbs down */}
            <button
              onClick={() => onFeedback(message.id, 'down')}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-md transition-all duration-150',
                message.feedback === 'down'
                  ? 'text-red-400'
                  : 'text-slate-600 hover:text-red-400 hover:bg-white/5'
              )}
              title="Bad answer"
            >
              <ThumbsDown size={13} />
            </button>

            {/* Copy */}
            <button
              onClick={handleCopy}
              className="flex h-6 w-6 items-center justify-center rounded-md text-slate-600 hover:text-slate-300 hover:bg-white/5 transition-all duration-150"
              title="Copy message"
            >
              {copied ? (
                <Check size={12} className="text-emerald-400" />
              ) : (
                <Copy size={12} />
              )}
            </button>

            {/* Trace / sources */}
            {hasSources && (
              <button
                onClick={() => onShowTrace(message)}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-slate-600 hover:text-blue-400 hover:bg-blue-500/10 transition-all duration-150"
                title="Show sources & trace"
              >
                <Eye size={11} />
                Trace
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

// ─── File Drop Card ───────────────────────────────────────────────────────────

interface DroppedFileCardProps {
  file: File
  compilations: Compilation[]
  onExtract: (compilationId: string) => void
  onCancel: () => void
  isExtracting: boolean
}

function DroppedFileCard({
  file,
  compilations,
  onExtract,
  onCancel,
  isExtracting,
}: DroppedFileCardProps) {
  const [selectedCompilation, setSelectedCompilation] = useState('')

  return (
    <div className="mx-4 mb-3 rounded-xl border border-blue-500/20 bg-blue-500/5 backdrop-blur-sm p-4 animate-slide-up shadow-lg shadow-blue-500/5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 border border-blue-500/20 shadow-[0_0_12px_rgba(59,130,246,0.1)]">
          <File size={16} className="text-blue-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-200">{file.name}</p>
          <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB — Extract knowledge from this file?</p>

          <div className="mt-3 flex items-center gap-2">
            <select
              value={selectedCompilation}
              onChange={(e) => setSelectedCompilation(e.target.value)}
              className="input-field h-8 flex-1 py-0 text-xs"
              disabled={isExtracting}
            >
              <option value="">Select target graph...</option>
              {compilations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.entityCount} entities)
                </option>
              ))}
            </select>
            <button
              onClick={() => onExtract(selectedCompilation)}
              disabled={isExtracting}
              className="btn-primary h-8 px-3 text-xs"
            >
              {isExtracting ? (
                <span className="h-3 w-3 animate-spin rounded-full border border-white border-t-transparent" />
              ) : null}
              Extract
            </button>
            <button
              onClick={onCancel}
              disabled={isExtracting}
              className="btn-ghost h-8 w-8 p-0"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Conversation List Item ───────────────────────────────────────────────────

function ConversationItem({
  conv,
  isActive,
  onSelect,
  onDelete,
}: {
  conv: Conversation
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (confirmDelete) {
      onDelete()
    } else {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
    }
  }

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-1 rounded-lg px-3 py-2.5 transition-all duration-200',
        isActive
          ? 'bg-blue-500/10 border border-blue-500/20 shadow-[0_0_12px_rgba(59,130,246,0.08)]'
          : 'hover:bg-white/5 border border-transparent hover:border-white/5'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={cn(
          'truncate text-xs font-medium leading-snug',
          isActive ? 'text-blue-300' : 'text-slate-300'
        )}>
          {conv.title || 'Untitled conversation'}
        </p>
        <button
          onClick={handleDelete}
          className={cn(
            'shrink-0 rounded p-0.5 transition-all duration-150 opacity-0 group-hover:opacity-100',
            confirmDelete
              ? 'text-red-400 opacity-100'
              : 'text-slate-600 hover:text-red-400'
          )}
          title={confirmDelete ? 'Click again to confirm' : 'Delete conversation'}
        >
          <Trash2 size={11} />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-slate-600">
          {timeAgo(conv.updatedAt ?? conv.createdAt)}
        </span>
        {conv.model && (
          <span className="badge badge-slate text-[9px] px-1 py-0">{conv.model}</span>
        )}
        {conv.compilationName && (
          <span className="badge badge-blue text-[9px] px-1 py-0 max-w-[80px] truncate">{conv.compilationName}</span>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function TalkToGraphPage() {
  // Mode
  const [mode, setMode] = useState<Mode>('standard')
  // Retrieval depth: fast single-pass RAG (default) vs agentic deep multi-hop
  const [depth, setDepth] = useState<Depth>('fast')

  // Conversation state (standard: from API; incognito: local only)
  // Initialize the active conversation from the URL (`/chat?c=<id>`) so hitting
  // Back from the graph viewer (or reloading) restores the thread the user was in
  // instead of dropping them on an empty chat.
  const [searchParams, setSearchParams] = useSearchParams()
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    () => searchParams.get('c')
  )
  const [incognitoMessages, setIncognitoMessages] = useState<ChatMessage[]>([])
  const [standardMessages, setStandardMessages] = useState<ChatMessage[]>([])

  // UI state
  const [isLoading, setIsLoading] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [traceMessage, setTraceMessage] = useState<ChatMessage | null>(null)
  const [droppedFile, setDroppedFile] = useState<File | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [extractionResult, setExtractionResult] = useState<string | null>(null)
  // Per-message feedback. A4: a 👍/👎 adjusts the referenced dossier's TRUST via
  // POST /rag/feedback (down → trust 0, up → raise toward 1). UI state is the
  // instant optimistic part; the API call is best-effort (never blocks the UI).
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 'up' | 'down'>>({})

  function handleFeedback(msgId: string, vote: 'up' | 'down') {
    let isToggleOff = false
    setFeedbackMap((prev) => {
      // Toggle off if same vote
      if (prev[msgId] === vote) {
        isToggleOff = true
        const next = { ...prev }
        delete next[msgId]
        return next
      }
      return { ...prev, [msgId]: vote }
    })
    if (isToggleOff) return

    // Resolve the entity this feedback targets: prefer the answer's graph-trace
    // node (the entity the answer was actually about), else fall back to the
    // longest capitalised run in the preceding question.
    const msgs = mode === 'incognito' ? incognitoMessages : standardMessages
    const idx = msgs.findIndex((m) => m.id === msgId)
    const aiMsg = idx >= 0 ? msgs[idx] : undefined
    let entity: string | undefined = aiMsg?.graphTrace?.nodes?.[0]?.name
    if (!entity) {
      // Walk back to the human turn that prompted this answer.
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].role === 'human') {
          const caps = msgs[i].content.match(/\b([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)*)/g)
          if (caps && caps.length) entity = caps.sort((a, b) => b.length - a.length)[0]
          break
        }
      }
    }

    const BASE_URL =
      (import.meta.env as Record<string, string | undefined>)['VITE_API_URL'] || '/api'
    const token = getToken()
    void fetch(`${BASE_URL}/rag/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messageId: msgId, entity, vote }),
    }).catch(() => {
      /* best-effort: feedback failing never disrupts the chat */
    })
  }

  // Config
  const [selectedCompilation, setSelectedCompilation] = useState('')
  // Remember the last chat model per device so Talk-to-Graph doesn't snap back to
  // the default on every reload/navigation. (The default effect below still
  // repairs a saved model that's no longer valid/available.)
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return localStorage.getItem('gctrl.rag.model') ?? '' } catch { return '' }
  })
  const [apiKey, setApiKey] = useState('')
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const queryClient = useQueryClient()

  // ── Data fetching ──

  const { data: conversationsData } = useApiQuery<ConversationsResponse>(
    ['rag', 'conversations'],
    '/rag/conversations',
    { enabled: mode === 'standard', retry: false }
  )

  const { data: conversationDetail } = useApiQuery<ConversationDetailResponse>(
    ['rag', 'conversations', activeConversationId],
    `/rag/conversations/${activeConversationId}`,
    { enabled: mode === 'standard' && !!activeConversationId, retry: false }
  )

  const { data: modelsData } = useApiQuery<ModelsResponse>(
    ['llm', 'models'],
    '/llm/models',
    { retry: false, staleTime: 60_000 }
  )

  const { data: compilationsData } = useApiQuery<CompilationsResponse>(
    ['kg', 'compilations'],
    '/kg/compilations',
    { retry: false, staleTime: 30_000 }
  )

  const deleteConvMutation = useApiMutation<void, void>(
    `/rag/conversations/${activeConversationId}`,
    'DELETE',
    {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['rag', 'conversations'] })
        setActiveConversationId(null)
        setStandardMessages([])
      },
    }
  )

  // ── Derived ──

  const conversations = conversationsData?.conversations ?? []
  const models = modelsData?.models ?? []
  const compilations = compilationsData?.compilations ?? []

  const navigate = useNavigate()
  // Open the graph viewer to trace a cited source. Target the selected graph (or
  // the first available); pass ALL of the chunk's entity mentions as focus
  // candidates (newline-separated) so the workspace selects the first one that is
  // a real node — `entityMentions[0]` alone is often a generic term (e.g. a
  // language or date) that isn't in the graph, which left the click unselected.
  // Preserve the current conversation in the URL so Back returns to this thread.
  function handleTraceSource(src: Source, answerCompilationId?: string) {
    // Target the graph THIS source came from (server-resolved, per source), then
    // the answer's overall graph, then the KB the user has selected, then a
    // last-resort first graph. Without the per-source id, chatting over "all
    // graphs" opened a guessed first graph that didn't contain the node, so the
    // source was never findable and the detail pane stayed empty.
    const target = src.compilationId || answerCompilationId || selectedCompilation || compilations[0]?.id
    if (!target) { navigate('/graphs'); return }
    const candidates = (src.entityMentions ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 12)
    const focus = candidates.length ? `?focus=${encodeURIComponent(candidates.join('\n'))}` : ''
    navigate(`/graphs/${target}/workspace${focus}`)
  }

  const currentMessages = mode === 'incognito' ? incognitoMessages : standardMessages

  const selectedModelOption = models.find((m) => m.model === selectedModel)

  // Sync conversation detail into standardMessages
  useEffect(() => {
    if (conversationDetail?.conversation?.messages) {
      setStandardMessages(conversationDetail.conversation.messages)
    }
  }, [conversationDetail])

  // Mirror the active conversation into the URL (`?c=<id>`) so Back/refresh and
  // the graph-viewer round-trip return to the same thread. `replace` avoids
  // polluting history with one entry per message.
  useEffect(() => {
    if (mode !== 'standard') return
    const current = searchParams.get('c')
    if (activeConversationId && current !== activeConversationId) {
      setSearchParams((p) => { const n = new URLSearchParams(p); n.set('c', activeConversationId); return n }, { replace: true })
    } else if (!activeConversationId && current) {
      setSearchParams((p) => { const n = new URLSearchParams(p); n.delete('c'); return n }, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, mode])

  // Default model when data arrives — prefer a known-good chat model, and
  // repair any stale/invalid (e.g. embedding) selection so chat never breaks.
  useEffect(() => {
    if (models.length === 0) return
    if (!selectedModel || !isValidChatSelection(selectedModel, models)) {
      const def = pickDefaultChatModel(models)
      if (def) setSelectedModel(def)
    }
  }, [models, selectedModel])

  // Persist the chosen model (per device) so it's remembered next time.
  useEffect(() => {
    try {
      if (selectedModel) localStorage.setItem('gctrl.rag.model', selectedModel)
    } catch { /* ignore */ }
  }, [selectedModel])

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [currentMessages, isLoading])

  // Clear incognito on mode switch to incognito
  useEffect(() => {
    if (mode === 'incognito') {
      setIncognitoMessages([])
      setActiveConversationId(null)
    }
  }, [mode])

  // ── Actions ──

  function startNewChat() {
    setActiveConversationId(null)
    setStandardMessages([])
    setIncognitoMessages([])
    setTraceMessage(null)
    setDroppedFile(null)
    setExtractionResult(null)
    textareaRef.current?.focus()
  }

  function handleSelectConversation(id: string) {
    setActiveConversationId(id)
    setTraceMessage(null)
    setDroppedFile(null)
    setExtractionResult(null)
  }

  function handleDeleteConversation(id: string) {
    if (id === activeConversationId) {
      deleteConvMutation.mutate({})
    } else {
      void queryClient.invalidateQueries({ queryKey: ['rag', 'conversations'] })
    }
  }

  // Auto-resize textarea
  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInputValue(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }

  // Voice dictation using Web Speech API (free, real-time, works in Chrome/Edge)
  const recognitionRef = useRef<unknown>(null)

  function startDictation() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const W = window as any
    const SpeechRecognition = W.SpeechRecognition || W.webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Speech recognition not available. Use Chrome or Edge.')
      return
    }

    if (isRecording) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (recognitionRef.current as any)?.stop?.()
      setIsRecording(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognitionRef.current = recognition
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'

    let finalTranscript = inputValue

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        if (r?.[0]) {
          if (r.isFinal) {
            finalTranscript += r[0].transcript + ' '
            setInputValue(finalTranscript)
          } else {
            interim += r[0].transcript
          }
        }
      }
      if (interim) setInputValue(finalTranscript + interim)
    }

    recognition.onend = () => setIsRecording(false)
    recognition.onerror = () => setIsRecording(false)

    recognition.start()
    setIsRecording(true)
  }

  async function handleSend() {
    const message = inputValue.trim()
    if (!message || isLoading) return

    setInputValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'human',
      content: message,
      createdAt: new Date().toISOString(),
    }

    if (mode === 'incognito') {
      setIncognitoMessages((prev) => [...prev, userMsg])
    } else {
      setStandardMessages((prev) => [...prev, userMsg])
    }

    setIsLoading(true)

    try {
      const body: Record<string, unknown> = {
        message,
        mode,
        agentic: depth === 'deep',
        ...(selectedCompilation ? { compilationId: selectedCompilation } : {}),
        ...(activeConversationId && mode === 'standard' ? { conversationId: activeConversationId } : {}),
        llmConfig: {
          provider: selectedModelOption?.provider || 'ollama',
          model: selectedModel || 'llama3.2',
          ...(apiKey ? { apiKey } : {}),
        },
        // Pass prior incognito context (GDPR: never persisted server-side)
        ...(mode === 'incognito' && incognitoMessages.length > 0
          ? { context: incognitoMessages.map((m) => ({ role: m.role, content: m.content })) }
          : {}),
      }

      const BASE_URL =
        (import.meta.env as Record<string, string | undefined>)['VITE_API_URL'] || '/api'
      const token = getToken()

      const res = await fetch(`${BASE_URL}/rag/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        // Prefer the server's own message (e.g. the Private Memory local-only
        // refusal) so it renders cleanly instead of a generic connectivity error.
        let apiError: string | undefined
        try {
          const errBody = (await res.json()) as { error?: string }
          apiError = typeof errBody?.error === 'string' ? errBody.error : undefined
        } catch { /* body wasn't JSON */ }
        throw new Error(apiError ?? `HTTP ${res.status}`)
      }

      const data = (await res.json()) as RagQueryResponse

      // The API returns chunk sources as { text, score, source, chunkId,
      // entityMentions }. Map them onto the Source shape the UI renders
      // (relevance ← score, a readable name, etc.) so cards aren't blank.
      const mappedSources: Source[] = (
        (data.sources ?? []) as unknown as Array<Record<string, unknown>>
      ).map((s) => {
        const mentions = Array.isArray(s.entityMentions) ? (s.entityMentions as string[]) : []
        const score = typeof s.score === 'number' ? (s.score as number) : (s.relevance as number) ?? 0
        return {
          name: (s.source as string) || mentions[0] || 'Knowledge chunk',
          type: (s.type as string) || 'semantic',
          relevance: score,
          text: (s.text as string) ?? (s.excerpt as string),
          entityMentions: mentions,
          chunkId: s.chunkId as string | undefined,
          compilationId: (s.compilationId as string | undefined) || undefined,
        }
      })

      // The API returns graphTrace as an ARRAY of {from,relation,to}; the UI
      // renders {nodes,edges}. Normalize so the trace panel never crashes (the
      // old code did `.nodes.length` on an array → white screen).
      const normalizeGraphTrace = (raw: unknown): ChatMessage['graphTrace'] => {
        if (!raw) return undefined
        if (Array.isArray(raw)) {
          const nodeMap = new Map<string, { id: string; name: string; type: string }>()
          const edges: Array<{ source: string; target: string; type: string }> = []
          for (const t of raw as Array<{ from?: string; relation?: string; to?: string }>) {
            if (!t.from || !t.to) continue
            if (!nodeMap.has(t.from)) nodeMap.set(t.from, { id: t.from, name: t.from, type: 'entity' })
            if (!nodeMap.has(t.to)) nodeMap.set(t.to, { id: t.to, name: t.to, type: 'entity' })
            edges.push({ source: t.from, target: t.to, type: t.relation ?? '' })
          }
          return { nodes: [...nodeMap.values()], edges }
        }
        const o = raw as { nodes?: unknown; edges?: unknown }
        if (Array.isArray(o.nodes) && Array.isArray(o.edges)) return raw as ChatMessage['graphTrace']
        return undefined
      }

      const aiMsg: ChatMessage = {
        id: nanoid(),
        role: 'ai',
        content: data.answer,
        sources: mappedSources,
        cypher: data.cypher,
        confidence: data.confidence,
        graphTrace: normalizeGraphTrace(data.graphTrace as unknown),
        tokensUsed: data.tokensUsed,
        model: data.model,
        imageUrl: (data as unknown as Record<string, unknown>).imageUrl as string | undefined,
        privacy: data.privacy,
        sourceCompilationId: data.sourceCompilationId,
        createdAt: new Date().toISOString(),
      }

      if (mode === 'incognito') {
        setIncognitoMessages((prev) => [...prev, aiMsg])
      } else {
        setStandardMessages((prev) => [...prev, aiMsg])
        if (data.conversationId && !activeConversationId) {
          setActiveConversationId(data.conversationId)
          void queryClient.invalidateQueries({ queryKey: ['rag', 'conversations'] })
        }
      }
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Unknown error'
      // A message with no "HTTP <code>" prefix came from the server's own JSON
      // `error` field (e.g. the Private Memory local-only refusal) — render it
      // as-is instead of wrapping it in the generic connectivity apology.
      const isServerMessage = !/^HTTP \d/.test(rawMsg)
      const errMsg: ChatMessage = {
        id: nanoid(),
        role: 'ai',
        content: isServerMessage
          ? rawMsg
          : `Sorry, I encountered an error while querying the knowledge graph. Please check that the API server is running and try again.\n\n\`${rawMsg}\``,
        createdAt: new Date().toISOString(),
      }
      if (mode === 'incognito') {
        setIncognitoMessages((prev) => [...prev, errMsg])
      } else {
        setStandardMessages((prev) => [...prev, errMsg])
      }
    } finally {
      setIsLoading(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // File drop
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    noClick: true,
    noKeyboard: true,
    onDrop: (files) => {
      if (files[0]) {
        setDroppedFile(files[0])
        setExtractionResult(null)
      }
    },
  })

  function handleFileButtonClick() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf,.docx,.txt,.csv'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        setDroppedFile(file)
        setExtractionResult(null)
      }
    }
    input.click()
  }

  async function handleExtractFile(compilationId: string) {
    if (!droppedFile) return
    setIsExtracting(true)

    try {
      const formData = new FormData()
      formData.append('file', droppedFile)
      if (compilationId) formData.append('compilationId', compilationId)

      const BASE_URL =
        (import.meta.env as Record<string, string | undefined>)['VITE_API_URL'] || '/api'
      const token = getToken()

      const res = await fetch(`${BASE_URL}/rag/kex-from-chat`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as KexFromChatResponse

      setExtractionResult(`Extraction started — Job ID: ${data.jobId}`)
      setDroppedFile(null)

      // Add a system message to the chat
      const sysMsg: ChatMessage = {
        id: nanoid(),
        role: 'ai',
        content: `Extraction job started for **${droppedFile.name}**. Job ID: \`${data.jobId}\`. The knowledge graph will be updated once processing completes. You can monitor progress in the KEX module.`,
        createdAt: new Date().toISOString(),
      }
      if (mode === 'incognito') {
        setIncognitoMessages((prev) => [...prev, sysMsg])
      } else {
        setStandardMessages((prev) => [...prev, sysMsg])
      }
    } catch (err) {
      setExtractionResult(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsExtracting(false)
    }
  }

  // ── Render ──

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0f1e]">
      {/* Subtle gradient mesh background (shared layer) */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-32 left-1/4 h-96 w-96 rounded-full bg-blue-600/5 blur-3xl" />
        <div className="absolute bottom-0 right-1/3 h-80 w-80 rounded-full bg-violet-600/5 blur-3xl" />
      </div>

      {/* ── Left Sidebar — free floating with rounded edges ── */}
      <div className="relative z-10 flex w-60 shrink-0 flex-col m-3 mr-0 rounded-2xl border border-white/10 bg-slate-950/70 backdrop-blur-xl shadow-2xl overflow-hidden">
        {/* Mode toggle */}
        <div className="border-b border-white/5 p-3">
          <div className="flex rounded-xl border border-white/5 bg-slate-900/60 p-0.5">
            <button
              onClick={() => setMode('standard')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-all duration-200',
                mode === 'standard'
                  ? 'bg-white/10 text-slate-100 shadow-sm backdrop-blur-sm'
                  : 'text-slate-500 hover:text-slate-400'
              )}
            >
              <Unlock size={11} />
              Standard
            </button>
            <button
              onClick={() => setMode('incognito')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-all duration-200',
                mode === 'incognito'
                  ? 'bg-white/10 text-slate-100 shadow-sm backdrop-blur-sm'
                  : 'text-slate-500 hover:text-slate-400'
              )}
            >
              <Lock size={11} />
              Incognito
            </button>
          </div>
          {mode === 'incognito' && (
            <div className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 animate-fade-in">
              <Lock size={9} className="text-amber-400 shrink-0" />
              <p className="text-[10px] text-amber-400/80 leading-snug">
                No history saved. GDPR compliant.
              </p>
            </div>
          )}
        </div>

        {/* New Chat button */}
        <div className="p-3">
          <button
            onClick={startNewChat}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/5 bg-white/5 py-1.5 text-xs font-medium text-slate-400 backdrop-blur-sm transition-all duration-200 hover:bg-white/10 hover:text-slate-200 hover:border-white/10"
          >
            <Plus size={13} />
            New Chat
          </button>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {mode === 'incognito' ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/5 bg-white/5 backdrop-blur-sm">
                <Lock size={16} className="text-slate-600" />
              </div>
              <p className="text-xs text-slate-600">No history in Incognito mode</p>
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/5 bg-white/5 backdrop-blur-sm">
                <MessageSquare size={16} className="text-slate-600" />
              </div>
              <p className="text-xs text-slate-600">No conversations yet</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {conversations.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
                  isActive={conv.id === activeConversationId}
                  onSelect={() => handleSelectConversation(conv.id)}
                  onDelete={() => handleDeleteConversation(conv.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Main Chat Area ── */}
      <div
        className="relative z-10 flex flex-1 flex-col overflow-hidden"
        {...getRootProps()}
      >
        <input {...getInputProps()} />

        {/* Drag overlay */}
        {isDragActive && (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-blue-500/60 bg-blue-500/5 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/10 backdrop-blur-sm">
                <File size={28} className="text-blue-400" />
              </div>
              <p className="text-sm font-medium text-blue-400">Drop to extract knowledge</p>
            </div>
          </div>
        )}

        {/* Messages — flex-1 so it fills remaining space and scrolls */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {currentMessages.length === 0 && !isLoading ? (
            /* ── Empty state ── */
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center animate-fade-in">
              {/* GCTRL logo mark */}
              <div className="relative flex h-20 w-20 items-center justify-center">
                <div className="absolute inset-0 rounded-2xl border border-blue-500/20 bg-blue-500/5 backdrop-blur-sm rotate-[10deg] scale-95" />
                <div className="absolute inset-0 rounded-2xl border border-blue-500/10 bg-blue-500/5 backdrop-blur-sm -rotate-[5deg]" />
                <div className="relative flex h-full w-full items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/10 backdrop-blur-sm glow-blue">
                  <MessageSquare size={32} className="text-blue-400" />
                </div>
              </div>

              <div>
                <h2 className="text-xl font-semibold text-slate-100">Ask anything about your knowledge graphs</h2>
                <p className="mt-2 max-w-xs text-sm text-slate-500 leading-relaxed">
                  Natural language queries over your Neo4j graphs. Sources cited, reasoning shown.
                </p>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6">
              {currentMessages.map((msg) => (
                <MessageItem
                  key={msg.id}
                  message={{ ...msg, feedback: feedbackMap[msg.id] }}
                  onShowTrace={(m) => setTraceMessage(traceMessage?.id === m.id ? null : m)}
                  onFeedback={handleFeedback}
                />
              ))}
              {isLoading && <TypingIndicator />}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Dropped file card */}
        {droppedFile && (
          <DroppedFileCard
            file={droppedFile}
            compilations={compilations}
            onExtract={handleExtractFile}
            onCancel={() => setDroppedFile(null)}
            isExtracting={isExtracting}
          />
        )}

        {/* Extraction result notification */}
        {extractionResult && !droppedFile && (
          <div className="mx-4 mb-3 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 backdrop-blur-sm px-4 py-2 animate-slide-up">
            <Check size={14} className="text-emerald-400 shrink-0" />
            <p className="text-xs text-emerald-400">{extractionResult}</p>
            <button
              onClick={() => setExtractionResult(null)}
              className="ml-auto text-slate-600 hover:text-slate-400 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* ── Input area — free floating, always at bottom ── */}
        <div className="shrink-0 px-6 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            {/* Unified prompt bar container */}
            <div className="rounded-2xl border border-slate-700/40 bg-slate-900/90 backdrop-blur-xl shadow-xl shadow-black/20 transition-all duration-200 hover:border-slate-600/50 focus-within:border-blue-500/30">
              {/* Input row */}
              <div className="flex items-end gap-3 px-4 pt-4 pb-3">
                {/* File upload icon — vertically centered with textarea */}
                <button
                  onClick={handleFileButtonClick}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-500 transition-all duration-150 hover:border-white/20 hover:bg-white/10 hover:text-slate-300"
                  title="Upload file for extraction"
                >
                  <File size={16} />
                </button>

                {/* Mic button for voice dictation */}
                <button
                  onClick={startDictation}
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-all duration-150',
                    isRecording
                      ? 'border-red-500/50 bg-red-500/20 text-red-400 animate-pulse'
                      : 'border-white/10 bg-white/5 text-slate-500 hover:border-white/20 hover:bg-white/10 hover:text-slate-300'
                  )}
                  title={isRecording ? 'Stop dictation' : 'Start voice dictation'}
                >
                  {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
                </button>

                {/* Textarea */}
                <textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder={isRecording ? 'Listening...' : 'Ask about your knowledge graphs...'}
                  rows={2}
                  className="max-h-40 min-h-[3rem] flex-1 resize-none bg-transparent text-sm text-slate-200 placeholder-slate-500 focus:outline-none leading-relaxed py-1.5"
                />

                {/* Send button */}
                <button
                  onClick={() => void handleSend()}
                  disabled={!inputValue.trim() || isLoading}
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all duration-200',
                    inputValue.trim() && !isLoading
                      ? 'bg-blue-500 text-white hover:bg-blue-400 shadow-lg shadow-blue-500/20'
                      : 'bg-white/5 text-slate-600 cursor-not-allowed border border-white/5'
                  )}
                  title="Send (Enter)"
                >
                  {isLoading ? (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border border-slate-500 border-t-blue-400" />
                  ) : (
                    <Send size={14} />
                  )}
                </button>
              </div>

              {/* Selectors row — inside the prompt bar, below textarea, subtle/dark */}
              <div className="flex items-center gap-2 flex-wrap border-t border-white/5 px-4 py-2">
              {/* Compilation selector */}
              <div className="relative flex items-center">
                <Database size={12} className="absolute left-2.5 text-slate-600 pointer-events-none z-10" />
                <select
                  value={selectedCompilation}
                  onChange={(e) => setSelectedCompilation(e.target.value)}
                  className="w-auto min-w-[130px] rounded-md border border-slate-700/50 bg-slate-950/60 px-2.5 py-1 pl-7 pr-6 text-[11px] text-slate-200 focus:border-slate-600 focus:outline-none transition-all hover:border-slate-600 hover:text-white cursor-pointer"
                  style={{ colorScheme: 'dark' }}
                >
                  <option value="">All Graphs</option>
                  {compilations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.entityCount} entities)
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-3 text-slate-400 pointer-events-none" />
              </div>

              {/* Model selector */}
              <div className="relative flex items-center">
                <Bot size={12} className="absolute left-2.5 text-slate-600 pointer-events-none z-10" />
                <select
                  value={selectedModel}
                  onChange={(e) => {
                    setSelectedModel(e.target.value)
                    const opt = models.find((m) => m.model === e.target.value)
                    if (opt?.requiresKey) setShowApiKeyInput(true)
                    else setShowApiKeyInput(false)
                  }}
                  className="w-auto min-w-[130px] rounded-md border border-slate-700/50 bg-slate-950/60 px-2.5 py-1 pl-7 pr-6 text-[11px] text-slate-200 focus:border-slate-600 focus:outline-none transition-all hover:border-slate-600 hover:text-white cursor-pointer"
                  style={{ colorScheme: 'dark' }}
                >
                  <option value="">Select model...</option>
                  {models.map((m) => (
                    <option key={m.model} value={m.model} disabled={!m.available}>
                      {m.name} {!m.available ? '(unavailable)' : ''} {m.requiresKey ? '(key)' : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown size={10} className="absolute right-2 text-slate-500 pointer-events-none" />
              </div>

              {/* Fast / Deep depth toggle */}
              <div
                className="flex items-center rounded-md border border-slate-700/50 bg-slate-950/60 p-0.5"
                title="Deep uses the agent for multi-hop reasoning (slower, better answers)"
              >
                <button
                  onClick={() => setDepth('fast')}
                  className={cn(
                    'rounded px-2.5 py-1 text-[11px] font-medium transition-all duration-150',
                    depth === 'fast'
                      ? 'bg-white/10 text-slate-100 shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
                  )}
                >
                  Fast
                </button>
                <button
                  onClick={() => setDepth('deep')}
                  className={cn(
                    'rounded px-2.5 py-1 text-[11px] font-medium transition-all duration-150',
                    depth === 'deep'
                      ? 'bg-blue-500/20 text-blue-300 shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
                  )}
                >
                  Deep
                </button>
              </div>

              {/* Depth hint */}
              <span className="text-[10px] text-slate-600">
                {depth === 'deep'
                  ? 'Deep uses the agent for multi-hop reasoning (slower, better answers)'
                  : ''}
              </span>

              {/* API key toggle for cloud models */}
              {selectedModelOption?.requiresKey && (
                <button
                  onClick={() => setShowApiKeyInput((v) => !v)}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full border transition-all duration-200',
                    showApiKeyInput
                      ? 'border-blue-500/40 bg-blue-500/10 text-blue-400'
                      : 'border-white/10 bg-white/5 text-slate-500 hover:border-white/[0.15] hover:text-slate-400'
                  )}
                  title="Set API key"
                >
                  <Key size={11} />
                </button>
              )}

              {/* Incognito badge */}
              {mode === 'incognito' && (
                <div className="ml-auto flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/5 px-2.5 py-1">
                  <Lock size={9} className="text-amber-400" />
                  <span className="text-[10px] text-amber-400">Incognito</span>
                </div>
              )}
              {/* API key inline */}
              {showApiKeyInput && selectedModelOption?.requiresKey && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="password"
                    placeholder={`${selectedModelOption.provider} key...`}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="h-7 w-36 rounded-full border border-white/10 bg-white/5 px-3 text-xs text-slate-200 placeholder-slate-600 focus:border-blue-500/40 focus:outline-none transition-all"
                  />
                  <button
                    onClick={() => setShowApiKeyInput(false)}
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-white/5 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    <X size={10} />
                  </button>
                </div>
              )}

              {/* Incognito / mode indicator */}
              <span className="ml-auto text-[10px] text-slate-600">
                {mode === 'incognito' ? '🔒 Incognito' : ''}
              </span>
            </div>
            {/* End of prompt bar container */}
            </div>

            <p className="mt-1.5 text-center text-[10px] text-slate-600">
              {mode === 'incognito'
                ? 'No conversations stored — GDPR compliant'
                : 'Conversations saved to your account'}
            </p>
          </div>
        </div>
      </div>

      {/* ── Right Trace Panel ── */}
      {traceMessage && (
        <div className="relative z-10 w-[300px] shrink-0 border-l border-white/5 bg-slate-950/80 backdrop-blur-xl animate-slide-in-right overflow-hidden flex flex-col">
          <TracePanel
            message={traceMessage}
            onClose={() => setTraceMessage(null)}
            onTraceSource={handleTraceSource}
          />
        </div>
      )}
    </div>
  )
}

