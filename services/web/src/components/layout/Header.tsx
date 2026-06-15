import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, ArrowUpCircle, CheckCircle2 } from 'lucide-react'
import { UpdateModal, useLicenseStatus } from '@/components/LicenseBanner'
import { cn } from '@/lib/utils'

interface HeaderProps {
  title: string
}

/**
 * A single message-center notification. Today the only type is `update`, but the
 * panel renders a list so future alerts (license, quota, …) can be appended
 * without restructuring the UI.
 */
interface Notification {
  id: string
  type: 'update'
  /** `required` updates get stronger amber styling and a stronger CTA. */
  severity: 'info' | 'required'
  title: string
  subtitle?: string
  actionLabel: string
  onAction: () => void
}

export function Header({ title }: HeaderProps) {
  const [open, setOpen] = useState(false)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Single source of truth: the agent `/status` endpoint (same source the
  // LicenseBanner uses). We retired the separate `/api/update/check` header poll.
  const { status } = useLicenseStatus()

  const updateAvailable = status?.updateAvailable === true
  const updateRequired = status?.updateRequired === true

  const notifications = useMemo<Notification[]>(() => {
    const items: Notification[] = []
    if (status && (updateAvailable || updateRequired)) {
      items.push({
        id: 'update',
        type: 'update',
        severity: updateRequired ? 'required' : 'info',
        title: `New version available — v${status.latestVersion}`,
        subtitle: status.currentVersion ? `You're on v${status.currentVersion}` : undefined,
        actionLabel: 'Update now',
        onAction: () => {
          setOpen(false)
          setShowUpdateModal(true)
        },
      })
    }
    return items
  }, [status, updateAvailable, updateRequired])

  const hasActionable = notifications.length > 0

  // Close popover on outside click
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6 backdrop-blur-sm">
      {/* Page title */}
      <h1 className="text-lg font-semibold text-slate-100">{title}</h1>

      {/* Right section */}
      <div className="flex items-center gap-3">
        {/* Message center */}
        <div className="relative" ref={popoverRef}>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label="Notifications"
            className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
          >
            <Bell size={16} />
            {/* Unread dot only when there's an actionable notification */}
            {hasActionable && (
              <span
                className={cn(
                  'absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full',
                  updateRequired ? 'bg-amber-500' : 'bg-blue-500',
                )}
              />
            )}
          </button>

          {open && (
            <div className="absolute right-0 z-50 mt-2 w-80 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
              <div className="border-b border-slate-800 px-4 py-3">
                <p className="text-sm font-semibold text-slate-200">Notifications</p>
              </div>

              <div className="max-h-96 overflow-y-auto">
                {hasActionable ? (
                  <ul className="divide-y divide-slate-800">
                    {notifications.map((n) => (
                      <li key={n.id} className="px-4 py-3">
                        <div className="flex gap-3">
                          <ArrowUpCircle
                            size={18}
                            className={cn(
                              'mt-0.5 shrink-0',
                              n.severity === 'required' ? 'text-amber-400' : 'text-blue-400',
                            )}
                          />
                          <div className="min-w-0 flex-1 space-y-2">
                            <div>
                              <p
                                className={cn(
                                  'text-sm font-medium',
                                  n.severity === 'required' ? 'text-amber-300' : 'text-slate-200',
                                )}
                              >
                                {n.title}
                              </p>
                              {n.subtitle && (
                                <p className="text-xs text-slate-500">{n.subtitle}</p>
                              )}
                              {n.severity === 'required' && (
                                <p className="mt-1 text-xs text-amber-400/80">
                                  Required — operations are blocked until updated.
                                </p>
                              )}
                            </div>
                            <button
                              onClick={n.onAction}
                              className={cn(
                                'flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors',
                                n.severity === 'required'
                                  ? 'bg-amber-600 hover:bg-amber-500'
                                  : 'bg-blue-600 hover:bg-blue-500',
                              )}
                            >
                              <ArrowUpCircle size={14} />
                              {n.actionLabel}
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                    <CheckCircle2 size={22} className="text-emerald-500/80" />
                    <p className="text-sm text-slate-300">You're all caught up</p>
                    {status?.currentVersion && (
                      <p className="text-xs text-slate-500">Running v{status.currentVersion}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showUpdateModal && (
        <UpdateModal onClose={() => setShowUpdateModal(false)} />
      )}
    </header>
  )
}
