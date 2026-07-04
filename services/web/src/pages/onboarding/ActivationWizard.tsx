import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { KeyRound, Loader2, Check, ExternalLink, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

type Step = 'welcome' | 'activate' | 'activating' | 'pulling' | 'done'

interface Props {
  onActivated: () => void
}

export default function ActivationWizard({ onActivated }: Props) {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('welcome')
  const [licenseKey, setLicenseKey] = useState('')
  const [error, setError] = useState('')

  async function handleActivate() {
    if (!licenseKey.trim()) return
    setError('')
    setStep('activating')

    try {
      const res = await fetch('/api/setup/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: licenseKey.trim() }),
      })
      const data = await res.json() as { ok?: boolean; error?: string; fusion_engine_pulling?: boolean }

      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Activation failed')
        setStep('activate')
        return
      }

      localStorage.setItem('gctrl_license_key', licenseKey.trim())
      localStorage.setItem('gctrl_activated', 'true')

      if (data.fusion_engine_pulling) {
        setStep('pulling')
        setTimeout(() => setStep('done'), 4000)
      } else {
        setStep('done')
      }
    } catch (e) {
      setError('Could not reach activation service. Is GCTRL running?')
      setStep('activate')
    }
  }

  useEffect(() => {
    if (step === 'done') {
      onActivated() // unlock the gate immediately
      // Navigate to register after a brief success moment
      const t = setTimeout(() => navigate('/register'), 1800)
      return () => clearTimeout(t)
    }
  }, [step, onActivated, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
      <div className="w-full max-w-md">
        {/* Logo / brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <img src="/gctrl/stacked-color-on-darkbg.svg?v=2" alt="GCTRL" className="h-20 w-auto" />
          <p className="text-sm text-slate-500">Activate your installation</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-xl">

          {/* Welcome */}
          {step === 'welcome' && (
            <div className="space-y-6 text-center">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Welcome to GCTRL</h2>
                <p className="mt-2 text-sm text-slate-400">
                  You need a license key to activate this installation. Get one free at gctrl.tech.
                </p>
              </div>
              <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 text-left space-y-2">
                <p className="text-xs font-medium text-slate-300">How to get your key:</p>
                <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside">
                  <li>Create a free account at gctrl.tech</li>
                  <li>Your license key appears on the dashboard</li>
                  <li>Paste it below to activate</li>
                </ol>
              </div>
              <div className="flex flex-col gap-3">
                <a
                  href="https://gctrl.tech/register"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition-colors"
                >
                  Create free account <ExternalLink size={13} />
                </a>
                <button
                  onClick={() => setStep('activate')}
                  className="text-sm text-slate-400 hover:text-slate-200 transition-colors"
                >
                  I already have a key <ArrowRight size={13} className="inline" />
                </button>
              </div>
            </div>
          )}

          {/* Enter key */}
          {step === 'activate' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Enter License Key</h2>
                <p className="mt-1 text-sm text-slate-400">Found on your dashboard at gctrl.tech</p>
              </div>
              <div>
                <input
                  type="text"
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleActivate()}
                  placeholder="GCTRL-XXXX-XXXX-XXXX-XXXX-XXXX"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 font-mono text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  autoFocus
                />
                {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
              </div>
              <button
                onClick={() => void handleActivate()}
                disabled={!licenseKey.trim()}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors',
                  licenseKey.trim()
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                )}
              >
                <KeyRound size={14} /> Activate
              </button>
              <button
                onClick={() => setStep('welcome')}
                className="w-full text-xs text-slate-500 hover:text-slate-400"
              >
                ← Back
              </button>
            </div>
          )}

          {/* Activating spinner */}
          {step === 'activating' && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <Loader2 size={32} className="animate-spin text-indigo-400" />
              <div>
                <p className="text-sm font-medium text-slate-200">Activating license…</p>
                <p className="text-xs text-slate-500 mt-1">Verifying with activation server</p>
              </div>
            </div>
          )}

          {/* Pulling */}
          {step === 'pulling' && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <Loader2 size={32} className="animate-spin text-emerald-400" />
              <div>
                <p className="text-sm font-medium text-slate-200">Downloading Knowledge Fusion Engine…</p>
                <p className="text-xs text-slate-500 mt-1">This may take a minute. Setting up in background.</p>
              </div>
            </div>
          )}

          {/* Done */}
          {step === 'done' && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <Check size={28} className="text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-emerald-300">Activation successful!</p>
                <p className="text-xs text-slate-500 mt-1">Setting up your account…</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
