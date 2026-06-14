import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, AlertCircle, Check, X, ShieldCheck, Rocket } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

interface PasswordRule {
  label: string
  test: (pw: string) => boolean
}

const PASSWORD_RULES: PasswordRule[] = [
  { label: 'At least 8 characters', test: (pw) => pw.length >= 8 },
  { label: 'Contains uppercase letter', test: (pw) => /[A-Z]/.test(pw) },
  { label: 'Contains a number', test: (pw) => /\d/.test(pw) },
]

function PasswordStrength({ password }: { password: string }) {
  if (!password) return null
  const passed = PASSWORD_RULES.filter((r) => r.test(password)).length
  const strengthLabel = ['Weak', 'Fair', 'Good', 'Strong'][passed] ?? 'Strong'
  const strengthColor = ['bg-red-500', 'bg-amber-500', 'bg-yellow-400', 'bg-emerald-500'][passed] ?? 'bg-emerald-500'

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-1">
        {PASSWORD_RULES.map((_, i) => (
          <div
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-300',
              i < passed ? strengthColor : 'bg-slate-700'
            )}
          />
        ))}
      </div>
      <p className={cn('text-xs', passed >= 3 ? 'text-emerald-400' : 'text-slate-500')}>
        {strengthLabel} password
      </p>
      <ul className="space-y-1">
        {PASSWORD_RULES.map((rule) => {
          const ok = rule.test(password)
          return (
            <li key={rule.label} className={cn('flex items-center gap-1.5 text-xs', ok ? 'text-emerald-400' : 'text-slate-500')}>
              {ok ? <Check size={12} /> : <X size={12} />}
              {rule.label}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * First-run setup screen — shown ONLY when the install has no users yet
 * (`/api/config/public` → `setupRequired: true`). It creates the very first
 * account, which the API promotes to the `admin` role automatically.
 *
 * On success `register()` auto-logs the operator in (token + user are set), so
 * `PublicRoute`/`ProtectedRoute` immediately route them past `/setup` and the
 * onboarding wizard's `onboarding_complete` gate carries them into LLM setup.
 */
export default function FirstRunSetup() {
  const { register } = useAuth()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const passwordValid = PASSWORD_RULES.every((r) => r.test(password))
  const confirmMatch = password === confirm && confirm !== ''

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!passwordValid || !confirmMatch) return

    setIsLoading(true)
    setError(null)

    try {
      // First user → API assigns the admin role. register() also auto-logs in.
      await register(email, password, name)
      // Make sure the freshly-created admin lands in onboarding (LLM setup),
      // not a stale dashboard. ProtectedRoute redirects to /onboarding while
      // `onboarding_complete` is unset, but navigate explicitly to be safe.
      navigate('/onboarding', { replace: true })
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Setup failed. Please try again.'
      setError(msg)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f172a] px-4 py-12">
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(#3b82f6 1px, transparent 1px), linear-gradient(90deg, #3b82f6 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <div className="relative w-full max-w-sm animate-slide-up">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="/gctrl/stacked-color-on-darkbg.svg" alt="GCTRL" className="h-20 w-auto" />
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-sm">
          <div className="mb-6 flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 ring-1 ring-indigo-500/30">
              <ShieldCheck size={18} className="text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Welcome to Ground Control</h2>
              <p className="mt-1 text-xs text-slate-400">
                This is a fresh install. Create your administrator account to get started — you'll
                connect an AI model next.
              </p>
            </div>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="label">Your name</label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-field"
                placeholder="Jane Smith"
                required
                autoFocus
              />
            </div>

            <div>
              <label htmlFor="email" className="label">Admin email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-field"
                placeholder="admin@company.com"
                required
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="password" className="label">Password</label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-field pr-10"
                  placeholder="••••••••"
                  required
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {password && <PasswordStrength password={password} />}
            </div>

            <div>
              <label htmlFor="confirm" className="label">Confirm password</label>
              <input
                id="confirm"
                type={showPassword ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={cn(
                  'input-field',
                  confirm && !confirmMatch && 'border-red-500/50 focus:ring-red-500'
                )}
                placeholder="••••••••"
                required
                autoComplete="new-password"
              />
              {confirm && !confirmMatch && (
                <p className="mt-1 text-xs text-red-400">Passwords do not match</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoading || !passwordValid || !confirmMatch || !name || !email}
              className="btn-primary w-full justify-center"
            >
              {isLoading ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Creating admin account...
                </>
              ) : (
                <>
                  <Rocket size={15} /> Create admin & continue
                </>
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-600">
          The first account created becomes the administrator.
        </p>
      </div>
    </div>
  )
}
