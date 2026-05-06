import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { apiPost } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

export function SettingsPage() {
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      apiPost('/v1/auth/change-password', data),
    onSuccess: () => {
      setSuccess(true)
      setError('')
      setCurrent('')
      setNext('')
      setConfirm('')
      setTimeout(() => setSuccess(false), 4000)
    },
    onError: (err: any) => {
      setError(err?.response?.data?.error ?? err?.message ?? 'Failed to change password')
    },
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (next !== confirm) { setError('New passwords do not match'); return }
    if (next.length < 8) { setError('New password must be at least 8 characters'); return }
    mutation.mutate({ currentPassword: current, newPassword: next })
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">Manage your account</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Account info */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Account</h2>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-slate-500 mb-1">Email</p>
              <p className="text-sm text-slate-200">{user?.email}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Role</p>
              <p className="text-sm text-slate-200 capitalize">{user?.role}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Tier</p>
              <p className="text-sm text-slate-200 capitalize">{user?.tier}</p>
            </div>
          </div>
        </div>

        {/* Change password */}
        <div className="card">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-4">Change Password</h2>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">Current password</label>
              <input
                type="password"
                className="input-field"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div>
              <label className="label">New password</label>
              <input
                type="password"
                className="input-field"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <div>
              <label className="label">Confirm new password</label>
              <input
                type="password"
                className="input-field"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}
            {success && (
              <p className="text-sm text-emerald-400">Password changed successfully.</p>
            )}

            <button
              type="submit"
              className="btn-primary w-full"
              disabled={mutation.isPending || !current || !next || !confirm}
            >
              {mutation.isPending ? 'Saving…' : 'Update password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
