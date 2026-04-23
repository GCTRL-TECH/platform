import { type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { LicenseBanner } from '@/components/LicenseBanner'
import { usePageTitle } from '@/hooks/usePageTitle'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const title = usePageTitle()
  const location = useLocation()
  const isChatPage = location.pathname.startsWith('/chat')

  return (
    <div className="flex h-screen bg-[#0f172a]">
      <Sidebar collapsed={isChatPage} />
      <div className={`flex flex-1 flex-col overflow-hidden transition-all duration-300 ${isChatPage ? 'ml-16' : 'ml-64'}`}>
        <LicenseBanner />
        {!isChatPage && <Header title={title} />}
        <main className={`flex-1 overflow-hidden ${isChatPage ? '' : 'overflow-y-auto p-6 animate-fade-in'}`}>
          {children}
        </main>
      </div>
    </div>
  )
}
