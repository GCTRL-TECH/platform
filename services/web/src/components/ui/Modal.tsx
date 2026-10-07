import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  size?: keyof typeof SIZES
  children: ReactNode
  footer?: ReactNode
}

/**
 * Portal-based modal. Rendered into document.body so ancestors with
 * backdrop-filter / transform (which re-anchor `fixed`) cannot clip it.
 */
export function Modal({ open, onClose, title, size = 'md', children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <>
      <div className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="pointer-events-none fixed inset-0 z-[81] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          className={cn(
            'pointer-events-auto flex max-h-[90vh] w-full flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl',
            SIZES[size],
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
            <h2 className="min-w-0 truncate text-sm font-semibold text-slate-100">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-800 px-5 py-3">{footer}</div>}
        </div>
      </div>
    </>,
    document.body,
  )
}
