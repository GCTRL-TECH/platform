import { useEffect, useRef, useState } from 'react'
import { Bell, RefreshCw } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/lib/api'
import { UpdateModal } from '@/components/LicenseBanner'

interface HeaderProps {
  title: string
}

interface UpdateCheck {
  current: string
  latest: string
  updateAvailable: boolean
}

export function Header({ title }: HeaderProps) {
  const [open, setOpen] = useState(false)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  const { data, isError, isLoading } = useQuery<UpdateCheck>({
    queryKey: ['update', 'check'],
    queryFn: () => apiGet<UpdateCheck>('/update/check'),
    refetchInterval: 60 * 60 * 1000, // hourly
    refetchOnWindowFocus: false,
    staleTime: 55 * 60 * 1000,
    retry: false,
  })

  // A failed update check means "we couldn't confirm a newer version" — treat that
  // as up-to-date rather than surfacing a scary error. Only an explicit
  // updateAvailable:true response lights the badge.
  const updateAvailable = data?.updateAvailable === true

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
        {/* Notification bell */}
        <div className="relative" ref={popoverRef}>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label="Notifications"
            className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
          >
            <Bell size={16} />
            {/* Dot lights only when a new version is available */}
            {updateAvailable && (
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-blue-500" />
            )}
          </button>

          {open && (
            <div className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
              <div className="border-b border-slate-800 px-4 py-3">
                <p className="text-sm font-semibold text-slate-200">Notifications</p>
              </div>

              <div className="px-4 py-3">
                {updateAvailable ? (
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium text-blue-400">New version available</p>
                      <p className="text-xs text-slate-400">
                        v{data?.latest}
                        {data?.current && (
                          <span className="text-slate-600"> (current v{data.current})</span>
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setOpen(false)
                        setShowUpdateModal(true)
                      }}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
                    >
                      <RefreshCw size={14} />
                      Update now
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-sm text-slate-300">
                      {isLoading ? 'Checking for updates…' : "You're up to date"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {data?.current
                        ? `You're on v${data.current} — up to date.`
                        : isLoading
                          ? 'Checking for updates…'
                          : isError
                            ? 'No new version available.'
                            : 'No new version available.'}
                    </p>
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
