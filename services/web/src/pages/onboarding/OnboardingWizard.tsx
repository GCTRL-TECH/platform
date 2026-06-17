import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Zap,
  Upload,
  Database,
  MessageSquare,
  ChevronRight,
  Check,
  Plug,
  Globe,
  ArrowRight,
  Brain,
  Server,
  Loader2,
  KeyRound,
  Copy,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

const STEPS = [
  { id: 'welcome', title: 'Welcome', icon: Zap },
  { id: 'model', title: 'Connect AI', icon: Brain },
  { id: 'license', title: 'Activate', icon: KeyRound },
  { id: 'connect', title: 'Connect Agent', icon: Plug },
  { id: 'source', title: 'Add a Source', icon: Upload },
  { id: 'extract', title: 'First Extraction', icon: Database },
  { id: 'chat', title: 'Talk to Your Data', icon: MessageSquare },
]

type StepId = 'welcome' | 'model' | 'license' | 'connect' | 'source' | 'extract' | 'chat'

export default function OnboardingWizard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [currentStep, setCurrentStep] = useState<StepId>('welcome')
  const [sampleText, setSampleText] = useState(
    'GCTRL is a structured data platform for AI. It extracts knowledge from documents, merges graphs, and lets you talk to your data with GDPR-compliant RAG.'
  )
  const [extracting, setExtracting] = useState(false)
  const [extracted, setExtracted] = useState(false)
  const [_jobId, setJobId] = useState<string | null>(null)

  // ── License activation (step 3) ──────────────────────────────────────
  const [licenseKey, setLicenseKey] = useState('')
  const [activating, setActivating] = useState(false)
  const [activated, setActivated] = useState(false)
  const [activateError, setActivateError] = useState('')

  // ── Full-access token + MCP (step 4) ─────────────────────────────────
  const [generatingToken, setGeneratingToken] = useState(false)
  const [agentToken, setAgentToken] = useState('')
  const [tokenError, setTokenError] = useState('')
  const [copied, setCopied] = useState('')

  const mcpConfig = JSON.stringify({
    mcpServers: {
      gctrl: {
        type: 'http',
        url: `${window.location.origin}/api/agent/mcp`,
        headers: { Authorization: `ApiKey ${agentToken || '<your-token>'}` },
      },
    },
  }, null, 2)

  function copy(text: string, what: string) {
    void navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(''), 2000)
  }

  async function handleActivate() {
    if (!licenseKey.trim()) return
    setActivating(true)
    setActivateError('')
    try {
      const { data } = await api.post('/setup/activate', { license_key: licenseKey.trim() })
      if (data?.ok === false) {
        setActivateError(data.error ?? 'Activation failed — check the key.')
      } else {
        setActivated(true)
        try { localStorage.setItem('gctrl_activated', 'true') } catch { /* ignore */ }
      }
    } catch {
      setActivateError('Activation failed — check the key and that the license agent is running.')
    } finally {
      setActivating(false)
    }
  }

  async function handleGenerateToken() {
    setGeneratingToken(true)
    setTokenError('')
    try {
      const { data } = await api.post('/users/api-keys', {
        name: 'Full Access (MCP)',
        maxClearanceRank: 1000,
        kbScoped: false,
      })
      setAgentToken(data.key as string)
    } catch {
      setTokenError('Could not create token.')
    } finally {
      setGeneratingToken(false)
    }
  }

  // ── LLM connection gate ──────────────────────────────────────────────
  // GCTRL is agent-first: the user must connect at least one LLM provider
  // before continuing past the "Connect AI" step.
  const [llmConnected, setLlmConnected] = useState<boolean | null>(null)
  const [checkingLlm, setCheckingLlm] = useState(false)
  const [connectingOllama, setConnectingOllama] = useState(false)

  const checkLlm = useCallback(async () => {
    setCheckingLlm(true)
    try {
      // Connected if any provider reports connected, OR any model is returned.
      const [provRes, modelRes] = await Promise.allSettled([
        api.get('/llm/providers'),
        api.get('/llm/models'),
      ])
      let connected = false
      if (provRes.status === 'fulfilled') {
        const providers = (provRes.value.data?.providers ?? []) as Array<{ connected?: boolean }>
        connected = providers.some((p) => p.connected)
      }
      if (!connected && modelRes.status === 'fulfilled') {
        const models = (modelRes.value.data?.models ?? []) as Array<{ available?: boolean }>
        connected = models.some((m) => m.available !== false)
      }
      setLlmConnected(connected)
    } catch {
      setLlmConnected(false)
    } finally {
      setCheckingLlm(false)
    }
  }, [])

  // Re-check whenever the model step regains focus (e.g. returning from
  // Settings) and on initial mount of that step.
  useEffect(() => {
    if (currentStep !== 'model') return
    void checkLlm()
    const onFocus = () => { void checkLlm() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [currentStep, checkLlm])

  async function handleUseOllama() {
    setConnectingOllama(true)
    try {
      await api.put('/llm/providers', { provider: 'ollama' })
      await checkLlm()
    } catch {
      setLlmConnected(false)
    } finally {
      setConnectingOllama(false)
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.id === currentStep)

  async function handleExtract() {
    setExtracting(true)
    try {
      const { data } = await api.post('/kex/extract', { text: sampleText, discoveryMode: 'discover' })
      setJobId(data.jobId)
      setExtracted(true)
    } catch { /* ignore */ }
    finally { setExtracting(false) }
  }

  function handleComplete() {
    // Mark onboarding as done in localStorage
    localStorage.setItem('onboarding_complete', 'true')
    navigate('/dashboard')
  }

  function handleSkip() {
    // User opted out of the guided tour. Honor that — they can re-trigger it
    // from Settings if they ever want it back.
    localStorage.setItem('onboarding_complete', 'true')
    localStorage.setItem('onboarding_skipped', 'true')
    navigate('/dashboard')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
      <div className="w-full max-w-2xl">
        {/* Skip link (top-right) */}
        <div className="mb-4 flex justify-end">
          <button
            onClick={handleSkip}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            type="button"
          >
            Skip onboarding →
          </button>
        </div>

        {/* Progress */}
        <div className="mb-8 flex items-center justify-center gap-2">
          {STEPS.map((step, i) => (
            <div key={step.id} className="flex items-center gap-2">
              <div className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all',
                i < stepIndex ? 'bg-emerald-500 text-white' :
                i === stepIndex ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-500'
              )}>
                {i < stepIndex ? <Check size={14} /> : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn('h-0.5 w-8', i < stepIndex ? 'bg-emerald-500' : 'bg-slate-800')} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 backdrop-blur-xl shadow-2xl">

          {/* ── Welcome ────────────────────────────────── */}
          {currentStep === 'welcome' && (
            <div className="text-center space-y-6">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10">
                <Zap size={32} className="text-indigo-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-100">Welcome to GCTRL{user?.name ? `, ${user.name}` : ''}!</h1>
                <p className="mt-2 text-sm text-slate-400">
                  Drop any data. Get structured knowledge. Let's set up your first knowledge extraction in under 2 minutes.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-4 pt-4">
                {[
                  { icon: Upload, title: 'Extract', desc: 'Upload documents, connect sources' },
                  { icon: Database, title: 'Build Graphs', desc: 'Structured knowledge, auto-fused' },
                  { icon: MessageSquare, title: 'Ask Questions', desc: 'RAG chat with your data' },
                ].map((f) => (
                  <div key={f.title} className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-center">
                    <f.icon size={20} className="mx-auto text-slate-400" />
                    <p className="mt-2 text-xs font-medium text-slate-200">{f.title}</p>
                    <p className="mt-1 text-[10px] text-slate-500">{f.desc}</p>
                  </div>
                ))}
              </div>
              <button onClick={() => setCurrentStep('model')} className="btn-primary mx-auto">
                Get Started <ArrowRight size={14} />
              </button>
            </div>
          )}

          {/* ── Connect AI Model ───────────────────────── */}
          {currentStep === 'model' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10">
                  <Brain size={32} className="text-indigo-400" />
                </div>
                <h2 className="mt-4 text-xl font-bold text-slate-100">Connect Your AI Model</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
                  GCTRL runs on an LLM — connect one to use extraction chat, Talk-to-Graph,
                  and the in-app agent. Pick a cloud provider or run locally with Ollama.
                </p>
              </div>

              <div className="space-y-3">
                <button
                  onClick={() => {
                    // Deep-link to the AI Models settings tab. Mark onboarding
                    // continuable — the gate re-checks on window focus / return.
                    navigate('/settings?tab=models')
                  }}
                  className="btn-primary w-full justify-center"
                >
                  <Brain size={14} /> Open AI Model settings
                </button>

                <button
                  onClick={() => void handleUseOllama()}
                  disabled={connectingOllama}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
                >
                  {connectingOllama ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
                  Use local Ollama
                </button>
                <p className="text-center text-[11px] text-slate-500">
                  In AI Model settings you can pick the embedding / extraction / wiki models and
                  install the recommended local ones (e.g. nomic-embed-text) with one click.
                </p>
                <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-amber-400/80">
                  <Zap size={11} /> For GPU speed, run Ollama <strong>natively</strong> and point GCTRL at it in Settings → Infrastructure (Docker Ollama is CPU-only).
                </p>
              </div>

              {/* Connection status / gate hint */}
              <div className="flex items-center justify-center gap-2 text-xs">
                {checkingLlm ? (
                  <span className="flex items-center gap-1.5 text-slate-500">
                    <Loader2 size={12} className="animate-spin" /> Checking connection…
                  </span>
                ) : llmConnected ? (
                  <span className="flex items-center gap-1.5 text-emerald-400">
                    <Check size={12} /> AI model connected
                  </span>
                ) : (
                  <span className="text-slate-500">No model connected yet</span>
                )}
              </div>

              <div className="flex items-center justify-between pt-2">
                <button onClick={() => setCurrentStep('welcome')} className="text-xs text-slate-500 hover:text-slate-300">Back</button>
                <div className="flex items-center gap-4">
                  <button
                    onClick={handleSkip}
                    className="text-xs text-slate-500 hover:text-slate-300"
                  >
                    Skip for now
                  </button>
                  <button
                    onClick={() => setCurrentStep('license')}
                    disabled={!llmConnected}
                    className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Continue <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── License activation ─────────────────────── */}
          {currentStep === 'license' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10">
                  <KeyRound size={32} className="text-indigo-400" />
                </div>
                <h2 className="mt-4 text-xl font-bold text-slate-100">Activate Your License</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
                  Register at <a href="https://gctrl.tech" target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300">gctrl.tech</a> to get your license key, then paste it here.
                  Activation is hardware-bound and unlocks the tuned resolution profile — your data never leaves the machine.
                </p>
              </div>

              {activated ? (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-center">
                  <Check size={24} className="mx-auto text-emerald-400" />
                  <p className="mt-2 text-sm font-medium text-emerald-300">License activated</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      value={licenseKey}
                      onChange={(e) => setLicenseKey(e.target.value)}
                      placeholder="GCTRL-XXXX-XXXX-XXXX-XXXX-XXXX"
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                    />
                    <button
                      onClick={() => void handleActivate()}
                      disabled={activating || !licenseKey.trim()}
                      className="btn-primary disabled:opacity-50"
                    >
                      {activating ? <Loader2 size={14} className="animate-spin" /> : 'Activate'}
                    </button>
                  </div>
                  {activateError && <p className="text-[11px] text-red-400">{activateError}</p>}
                  <p className="text-[11px] text-slate-500">
                    No key yet? You can skip — the platform runs on safe generic defaults until activated.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button onClick={() => setCurrentStep('model')} className="text-xs text-slate-500 hover:text-slate-300">Back</button>
                <div className="flex items-center gap-4">
                  <button onClick={() => setCurrentStep('connect')} className="text-xs text-slate-500 hover:text-slate-300">Skip for now</button>
                  <button onClick={() => setCurrentStep('connect')} className="btn-primary">
                    Continue <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Connect an agent (token + MCP) ─────────── */}
          {currentStep === 'connect' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10">
                  <Plug size={32} className="text-indigo-400" />
                </div>
                <h2 className="mt-4 text-xl font-bold text-slate-100">Connect Your Agent</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
                  Generate a full-access token and drop the MCP config into Claude Code, Codex, Cursor —
                  your agent gets durable, access-controlled memory over GCTRL.
                </p>
              </div>

              {!agentToken ? (
                <button
                  onClick={() => void handleGenerateToken()}
                  disabled={generatingToken}
                  className="btn-primary w-full justify-center disabled:opacity-50"
                >
                  {generatingToken ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                  Generate full-access token
                </button>
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="mb-1 text-[11px] text-slate-500">Your token (shown once — copy it now):</p>
                    <div className="flex gap-2">
                      <code className="flex-1 truncate rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-cyan-300">{agentToken}</code>
                      <button onClick={() => copy(agentToken, 'token')} className="rounded-lg border border-slate-700 bg-slate-800 px-3 text-slate-300 hover:bg-slate-700">
                        {copied === 'token' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] text-slate-500">MCP config (Claude Code / Codex / Cursor):</p>
                    <div className="relative">
                      <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-300"><code>{mcpConfig}</code></pre>
                      <button onClick={() => copy(mcpConfig, 'config')} className="absolute right-2 top-2 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700">
                        {copied === 'config' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] text-amber-400/80">
                    For a remote agent, enable the MCP-over-HTTP gateway in Settings → Agent and make sure port :4000 is reachable.
                  </p>
                </div>
              )}
              {tokenError && <p className="text-[11px] text-red-400">{tokenError}</p>}

              <div className="flex items-center justify-between pt-2">
                <button onClick={() => setCurrentStep('license')} className="text-xs text-slate-500 hover:text-slate-300">Back</button>
                <div className="flex items-center gap-4">
                  <button onClick={() => setCurrentStep('source')} className="text-xs text-slate-500 hover:text-slate-300">Skip for now</button>
                  <button onClick={() => setCurrentStep('source')} className="btn-primary">
                    Continue <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Source ─────────────────────────────────── */}
          {currentStep === 'source' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold text-slate-100">Choose Your First Source</h2>
                <p className="mt-1 text-sm text-slate-400">Where does your knowledge live?</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { icon: Upload, label: 'Upload Files', desc: 'PDF, DOCX, XLSX, images...', action: () => { setCurrentStep('extract') } },
                  { icon: Globe, label: 'Paste Text', desc: 'Quick start with any text', action: () => { setCurrentStep('extract') } },
                  { icon: Plug, label: 'Google Drive', desc: 'Connect your workspace', action: () => { navigate('/settings'); localStorage.setItem('onboarding_complete', 'true') } },
                  { icon: Globe, label: 'Crawl Website', desc: 'Extract from any URL', action: () => { setCurrentStep('extract') } },
                ].map((opt) => (
                  <button key={opt.label} onClick={opt.action}
                    className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-left hover:border-slate-700 hover:bg-slate-800/60 transition-all">
                    <opt.icon size={20} className="text-slate-400" />
                    <div>
                      <p className="text-sm font-medium text-slate-200">{opt.label}</p>
                      <p className="text-[10px] text-slate-500">{opt.desc}</p>
                    </div>
                    <ChevronRight size={14} className="ml-auto text-slate-600" />
                  </button>
                ))}
              </div>
              <div className="flex justify-between pt-2">
                <button onClick={() => setCurrentStep('connect')} className="text-xs text-slate-500 hover:text-slate-300">Back</button>
                <button onClick={() => setCurrentStep('extract')} className="text-xs text-indigo-400 hover:text-indigo-300">Skip — use sample text</button>
              </div>
            </div>
          )}

          {/* ── Extract ───────────────────────────────── */}
          {currentStep === 'extract' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold text-slate-100">Your First Extraction</h2>
                <p className="mt-1 text-sm text-slate-400">
                  {extracted
                    ? 'Extraction submitted! Entities are being discovered and a knowledge graph is being built.'
                    : 'Edit the text below or paste your own, then hit Extract.'}
                </p>
              </div>
              {!extracted ? (
                <>
                  <textarea
                    value={sampleText}
                    onChange={(e) => setSampleText(e.target.value)}
                    rows={5}
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none resize-none"
                    placeholder="Paste any text here..."
                  />
                  <button onClick={() => void handleExtract()} disabled={extracting || !sampleText.trim()} className="btn-primary w-full justify-center">
                    {extracting ? 'Extracting...' : <><Zap size={14} /> Extract Knowledge</>}
                  </button>
                </>
              ) : (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-center">
                  <Check size={24} className="mx-auto text-emerald-400" />
                  <p className="mt-2 text-sm font-medium text-emerald-300">Knowledge extraction started!</p>
                  <p className="mt-1 text-xs text-slate-500">Entities are being discovered. This takes a few seconds.</p>
                </div>
              )}
              <div className="flex justify-between pt-2">
                <button onClick={() => setCurrentStep('source')} className="text-xs text-slate-500 hover:text-slate-300">Back</button>
                <button onClick={() => setCurrentStep('chat')} className="text-xs text-indigo-400 hover:text-indigo-300">
                  {extracted ? 'Continue' : 'Skip'}
                </button>
              </div>
            </div>
          )}

          {/* ── Chat ──────────────────────────────────── */}
          {currentStep === 'chat' && (
            <div className="space-y-6 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
                <Check size={32} className="text-emerald-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-100">You're All Set!</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Your first knowledge extraction is processing. Once complete, you can ask questions about it using Talk to Graph.
                </p>
              </div>
              <div className="space-y-3 pt-4">
                <button onClick={() => { handleComplete(); navigate('/chat') }} className="btn-primary w-full justify-center">
                  <MessageSquare size={14} /> Talk to Your Data
                </button>
                <button onClick={() => { handleComplete(); navigate('/kex') }} className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-700 transition-colors">
                  Extract More Knowledge
                </button>
                <button onClick={handleComplete} className="text-xs text-slate-500 hover:text-slate-300">
                  Go to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

