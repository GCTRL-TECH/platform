import { type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { LicenseBanner } from '@/components/LicenseBanner'
import { usePageTitle } from '@/hooks/usePageTitle'
import { usePublicConfig } from '@/hooks/usePublicConfig'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const title = usePageTitle()
  const location = useLocation()
  const config = usePublicConfig()
  // Build markers so a deploy is verifiable at a glance: `web` is baked into the
  // bundle at build time (VITE_BUILD_VERSION), `api` comes from GET /config/public.
  const webVersion = (import.meta.env as Record<string, string | undefined>).VITE_BUILD_VERSION || 'dev'
  const apiVersion = config.version || '—'
  const isChatPage = location.pathname.startsWith('/chat')
  // The graph workspace is an immersive, full-bleed view like chat: collapse the
  // sidebar and drop the main padding so it fills the viewport.
  const isWorkspace = location.pathname.includes('/workspace')
  const immersive = isChatPage || isWorkspace

  return (
    <div className="flex h-screen bg-[#0f172a]">
      <Sidebar collapsed={immersive} />
      <div className={`flex flex-1 flex-col overflow-hidden transition-all duration-300 ${immersive ? 'ml-16' : 'ml-64'}`}>
        <LicenseBanner />
        {!immersive && <Header title={title} />}
        <main className={`flex-1 overflow-hidden ${immersive ? '' : 'overflow-y-auto p-6 animate-fade-in'}`}>
          {children}
        </main>
      </div>
      {/* Build marker — confirms which deploy is running at a glance. */}
      <div
        className="pointer-events-none fixed bottom-1 right-2 z-50 select-none font-mono text-[9px] leading-none text-slate-600/70"
        title="Running build versions"
      >
        web {webVersion} · api {apiVersion}
      </div>
    </div>
  )
}
