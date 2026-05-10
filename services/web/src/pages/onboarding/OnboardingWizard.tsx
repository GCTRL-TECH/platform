import { useState } from 'react'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

const STEPS = [
  { id: 'welcome', title: 'Welcome', icon: Zap },
  { id: 'source', title: 'Add a Source', icon: Upload },
  { id: 'extract', title: 'First Extraction', icon: Database },
  { id: 'chat', title: 'Talk to Your Data', icon: MessageSquare },
]

type StepId = 'welcome' | 'source' | 'extract' | 'chat'

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
              <button onClick={() => setCurrentStep('source')} className="btn-primary mx-auto">
                Get Started <ArrowRight size={14} />
              </button>
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
                <button onClick={() => setCurrentStep('welcome')} className="text-xs text-slate-500 hover:text-slate-300">Back</button>
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

