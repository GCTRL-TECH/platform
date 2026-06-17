import { useState } from 'react'
import { Cpu, Copy, Check, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Shown when GCTRL can't reach Ollama. The most common cause: the user runs
 * Ollama NATIVELY (for GPU) but it listens on localhost only, so the Dockerised
 * GCTRL stack can't reach it. This guides them through the one host-side step
 * (expose Ollama on 0.0.0.0) per OS — GCTRL handles the rest (it auto-routes
 * localhost → host.docker.internal). We can't run this for them: it's a host
 * change on a service GCTRL doesn't own, and letting a container do it would be a
 * security hole.
 */

const LINUX = `sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\\n' | \\
  sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama`

const MACOS = `launchctl setenv OLLAMA_HOST "0.0.0.0:11434"
# then quit and reopen the Ollama app (menu bar)`

const WINDOWS = `setx OLLAMA_HOST "0.0.0.0:11434"
# then quit Ollama from the system tray and reopen it`

const OS_TABS: { id: string; label: string; cmd: string }[] = [
  { id: 'linux', label: 'Linux', cmd: LINUX },
  { id: 'macos', label: 'macOS', cmd: MACOS },
  { id: 'windows', label: 'Windows', cmd: WINDOWS },
]

export function NativeOllamaGuide({
  ollamaBase,
  onRetest,
}: {
  ollamaBase?: string | null
  onRetest?: () => void
}) {
  const [os, setOs] = useState('linux')
  const [copied, setCopied] = useState(false)
  const tab = OS_TABS.find((t) => t.id === os) ?? OS_TABS[0]!

  const copy = () => {
    void navigator.clipboard.writeText(tab.cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-4">
      <div className="flex items-center gap-2">
        <Cpu size={15} className="text-amber-400" />
        <span className="text-sm font-medium text-amber-200">Use your GPU — connect native Ollama</span>
      </div>
      <p className="mt-1.5 text-xs text-slate-400">
        GCTRL can't reach an Ollama at <code className="rounded bg-slate-800 px-1 text-slate-300">{ollamaBase || 'your configured base'}</code>.
        If you run Ollama <strong>natively</strong> (for GPU speed), it most likely listens on{' '}
        <code className="rounded bg-slate-800 px-1 text-slate-300">localhost</code> only — so the GCTRL
        containers can't reach it. Expose it on all interfaces (one-time):
      </p>

      <div className="mt-3 flex gap-1">
        {OS_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setOs(t.id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
              os === t.id ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="relative mt-2">
        <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-300"><code>{tab.cmd}</code></pre>
        <button
          onClick={copy}
          className="absolute right-2 top-2 flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700"
        >
          {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        Then set the base URL above to <code className="rounded bg-slate-800 px-1 text-slate-300">http://localhost:11434</code>{' '}
        — GCTRL routes it to your host automatically — and test again.
      </p>
      {onRetest && (
        <button
          onClick={onRetest}
          className="mt-2 flex items-center gap-1.5 rounded-md bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/30"
        >
          <RefreshCw size={12} /> Test connection again
        </button>
      )}
    </div>
  )
}
