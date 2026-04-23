import { useEffect, useState } from 'react'

interface AgentStatus {
  valid: boolean
  tier: string
  balance: number
  updateAvailable: boolean
  updateRequired: boolean
  latestVersion: string
}

export function LicenseBanner() {
  const [status, setStatus] = useState<AgentStatus | null>(null)

  useEffect(() => {
    fetch('http://localhost:7070/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  if (!status) return null

  if (status.updateRequired) return (
    <div className="bg-red-600 text-white px-4 py-2 text-sm text-center">
      Required update available (v{status.latestVersion}).
      Run: <code className="bg-red-800 px-1 rounded">curl -fsSL https://gctrl.tech/update | bash</code>
    </div>
  )

  if (status.updateAvailable) return (
    <div className="bg-yellow-500 text-black px-4 py-2 text-sm text-center">
      Update available (v{status.latestVersion}).{' '}
      <button className="underline" onClick={() => fetch('/api/update', { method: 'POST' })}>
        Update now
      </button>
    </div>
  )

  if (status.balance <= 0 && status.tier === 'free') return (
    <div className="bg-orange-500 text-white px-4 py-2 text-sm text-center">
      Credits exhausted.{' '}
      <a href="https://gctrl.tech/billing" className="underline" target="_blank" rel="noreferrer">
        Top up at gctrl.tech
      </a>
    </div>
  )

  return null
}
