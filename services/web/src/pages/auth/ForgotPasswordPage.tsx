import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Hexagon, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react'
import { apiPost } from '@/lib/api'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email) return

    setIsLoading(true)
    setError(null)

    try {
      await apiPost('/auth/forgot-password', { email })
      setSuccess(true)
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Failed to send reset link. Please try again.'
      setError(msg)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f172a] px-4">
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(#3b82f6 1px, transparent 1px), linear-gradient(90deg, #3b82f6 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <div className="relative w-full max-w-sm animate-slide-up">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500 shadow-lg shadow-blue-500/25">
            <Hexagon size={24} className="text-white" fill="white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-100">GCTRL</h1>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-sm">
          {success ? (
            <div className="flex flex-col items-center gap-4 py-2 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/30">
                <CheckCircle2 size={28} className="text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Check your email</h2>
                <p className="mt-2 text-sm text-slate-500">
                  We sent a password reset link to{' '}
                  <span className="text-slate-300">{email}</span>.
                </p>
              </div>
              <Link to="/login" className="btn-ghost mt-2 text-slate-400">
                <ArrowLeft size={15} />
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-slate-100">Reset your password</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Enter your email and we'll send you a reset link.
                </p>
              </div>

              {error && (
                <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="label">Email address</label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input-field"
                    placeholder="you@company.com"
                    required
                    autoFocus
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading || !email}
                  className="btn-primary w-full"
                >
                  {isLoading ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      Sending...
                    </>
                  ) : (
                    'Send reset link'
                  )}
                </button>
              </form>
            </>
          )}
        </div>

        <div className="mt-6 text-center">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
          >
            <ArrowLeft size={14} />
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  )
}

