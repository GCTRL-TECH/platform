import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  description: string
  confirmText?: string
  confirmPhrase: string
  onConfirm: () => void
  onCancel: () => void
  isDeleting?: boolean
}

export function ConfirmDeleteModal({
  open,
  title,
  description,
  confirmText = 'Delete',
  confirmPhrase,
  onConfirm,
  onCancel,
  isDeleting = false,
}: Props) {
  const [input, setInput] = useState('')

  if (!open) return null

  const confirmed = input.trim().toLowerCase() === confirmPhrase.toLowerCase()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-red-500/20 bg-slate-900 p-6 shadow-2xl animate-slide-up">
        <button
          onClick={onCancel}
          className="absolute right-4 top-4 text-slate-500 hover:text-slate-300 transition-colors"
        >
          <X size={18} />
        </button>

        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-red-500/10">
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-100">{title}</h3>
            <p className="mt-1 text-sm text-slate-400">{description}</p>
          </div>
        </div>

        <div className="mt-5">
          <label className="label">
            Type <span className="font-mono text-red-400">{confirmPhrase}</span> to confirm
          </label>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="input-field"
            placeholder={confirmPhrase}
            autoFocus
          />
        </div>

        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onCancel} className="btn-secondary" disabled={isDeleting}>
            Cancel
          </button>
          <button
            onClick={() => {
              if (confirmed) {
                onConfirm()
                setInput('')
              }
            }}
            disabled={!confirmed || isDeleting}
            className="flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isDeleting ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Deleting...
              </>
            ) : (
              confirmText
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
