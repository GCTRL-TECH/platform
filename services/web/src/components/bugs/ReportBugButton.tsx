import { useEffect, useState, type FormEvent } from 'react'
import { Bug, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { usePublicConfig } from '@/hooks/usePublicConfig'
import { reportBug } from '@/lib/bugs'
import { cn } from '@/lib/utils'

/**
 * Global "Report bug" entry point for every signed-in user. Lives in the header
 * so it is reachable from any page. The modal takes a title and a description
 * (required) and captures page URL, user agent and the running GCTRL version
 * automatically. Admins triage the reports on the Admin > Bugs board.
 */
export function ReportBugButton() {
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(t)
  }, [toast])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Report a bug"
        aria-label="Report a bug"
        className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
      >
        <Bug size={15} />
        <span className="hidden sm:inline">Report bug</span>
      </button>

      {open && (
        <ReportBugModal
          onClose={() => setOpen(false)}
          onReported={() => {
            setOpen(false)
            setToast({ kind: 'success', message: 'Thanks - bug reported.' })
          }}
          onFailed={(message) => setToast({ kind: 'error', message })}
        />
      )}

      {toast && (
        <div
          role="status"
          className={cn(
            'fixed bottom-6 right-6 z-[60] flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm shadow-2xl animate-slide-up',
            toast.kind === 'success'
              ? 'border-emerald-500/30 bg-slate-900 text-emerald-300'
              : 'border-red-500/30 bg-slate-900 text-red-300',
          )}
        >
          {toast.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          {toast.message}
        </div>
      )}
    </>
  )
}

function ReportBugModal({
  onClose,
  onReported,
  onFailed,
}: {
  onClose: () => void
  onReported: () => void
  onFailed: (message: string) => void
}) {
  const config = usePublicConfig()
  const webVersion = (import.meta.env as Record<string, string | undefined>).VITE_BUILD_VERSION || 'dev'
  const version = config.version || webVersion
  const pageUrl = typeof window !== 'undefined' ? window.location.href : ''
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && !submitting

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await reportBug({
        title: title.trim(),
        description: description.trim(),
        pageUrl,
        userAgent,
        version,
      })
      onReported()
    } catch {
      const message = 'Could not send the report. Please try again.'
      setError(message)
      onFailed(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !submitting && onClose()} />

      <form
        onSubmit={handleSubmit}
        className="relative z-10 w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl animate-slide-up"
      >
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          aria-label="Close"
          className="absolute right-4 top-4 text-slate-500 transition-colors hover:text-slate-300"
        >
          <X size={18} />
        </button>

        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
            <Bug size={20} className="text-amber-400" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-100">Report a bug</h3>
            <p className="mt-1 text-sm text-slate-400">
              Tell us what went wrong. Page, browser and version are attached automatically.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="bug-title" className="label">Title</label>
            <input
              id="bug-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input-field"
              placeholder="Short summary"
              maxLength={200}
              autoFocus
              required
            />
          </div>
          <div>
            <label htmlFor="bug-description" className="label">Description</label>
            <textarea
              id="bug-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input-field min-h-[120px] resize-y"
              placeholder="What did you do, what did you expect, what happened instead?"
              required
            />
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-500">
            <dt className="text-slate-600">Page</dt>
            <dd className="truncate font-mono" title={pageUrl}>{pageUrl}</dd>
            <dt className="text-slate-600">Version</dt>
            <dd className="font-mono">v{version}</dd>
            <dt className="text-slate-600">Browser</dt>
            <dd className="truncate" title={userAgent}>{userAgent}</dd>
          </dl>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={!canSubmit} className="btn-primary">
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Bug size={14} />}
            Send report
          </button>
        </div>
      </form>
    </div>
  )
}
