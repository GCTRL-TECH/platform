import { useState } from 'react'
import { ChevronDown, ChevronRight, Wrench, CheckCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ToolCall {
  name: string
  args: Record<string, unknown>
  result?: unknown
}

export function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const isDone = toolCall.result !== undefined

  return (
    <div className="my-1 rounded-md border border-slate-700 bg-slate-800/40 text-xs font-mono">
      <button
        onClick={() => setExpanded(p => !p)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/60 transition-colors"
      >
        {isDone
          ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
          : <Loader2 className="h-3.5 w-3.5 text-slate-400 animate-spin shrink-0" />
        }
        <Wrench className="h-3.5 w-3.5 text-blue-400 shrink-0" />
        <span className="font-medium text-slate-200">{toolCall.name}</span>
        <span className={cn("ml-2 rounded px-1.5 py-0.5 text-[10px]", isDone ? "bg-green-500/10 text-green-400" : "bg-amber-500/10 text-amber-400")}>
          {isDone ? 'done' : 'running'}
        </span>
        <span className="ml-auto text-slate-500">
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />
          }
        </span>
      </button>
      {expanded && (
        <div className="border-t border-slate-700 px-3 py-2 space-y-1">
          <div>
            <p className="text-slate-500 mb-1">Input:</p>
            <pre className="whitespace-pre-wrap break-all text-slate-300">{JSON.stringify(toolCall.args, null, 2)}</pre>
          </div>
          {isDone && (
            <div>
              <p className="text-slate-500 mt-2 mb-1">Output:</p>
              <pre className="whitespace-pre-wrap break-all text-green-400">{JSON.stringify(toolCall.result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
