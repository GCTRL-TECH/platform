import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import ActivationWizard from '@/pages/onboarding/ActivationWizard'
import { AppShell } from '@/components/layout/AppShell'
import { LoginPage } from '@/pages/auth/LoginPage'
import { RegisterPage } from '@/pages/auth/RegisterPage'
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '@/pages/auth/ResetPasswordPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { KexPage } from '@/pages/kex/KexPage'
import { KexJobDetail } from '@/pages/kex/KexJobDetail'
import { FusePage } from '@/pages/fuse/FusePage'
import { FuseJobDetail } from '@/pages/fuse/FuseJobDetail'
import { KGListPage } from '@/pages/kg/KGListPage'
import { KGDetailPage } from '@/pages/kg/KGDetailPage'
import { OntologyListPage } from '@/pages/ontologies/OntologyListPage'
import { OntologyDetailPage } from '@/pages/ontologies/OntologyDetailPage'
import { TalkToGraphPage } from '@/pages/rag/TalkToGraphPage'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import TokenDashboard from '@/pages/billing/TokenDashboard'
import AdminPanel from '@/pages/admin/AdminPanel'
import TriggersPage from '@/pages/triggers/TriggersPage'
import OnboardingWizard from '@/pages/onboarding/OnboardingWizard'
import GoogleDrivePage from '@/pages/connectors/GoogleDrivePage'

function ActivationGate({ children }: { children: React.ReactNode }) {
  const [activated, setActivated] = useState<boolean | null>(null)

  const checkActivation = useCallback(() => {
    fetch('http://localhost:7070/status')
      .then((r) => r.json())
      .then((d: { activated?: boolean }) => setActivated(d.activated ?? true))
      .catch(() => setActivated(true)) // If agent unreachable, don't block the app
  }, [])

  useEffect(() => {
    checkActivation()
  }, [checkActivation])

  // Loading state — brief blank screen while we check
  if (activated === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500/30 border-t-indigo-500" />
      </div>
    )
  }

  if (!activated) {
    return <ActivationWizard onActivated={() => setActivated(true)} />
  }

  return <>{children}</>
}

function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f172a]">
        <div className="flex flex-col items-center gap-3">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
          <p className="text-sm text-slate-500">Loading...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  // First-time users: guide through onboarding before reaching any other page
  if (!localStorage.getItem('onboarding_complete') && location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

function PublicRoute() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f172a]">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
      </div>
    )
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />
  }

  return <Outlet />
}


export function App() {
  return (
    <ActivationGate>
      <Routes>
        {/* Public routes */}
        <Route element={<PublicRoute />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Route>

        {/* Protected routes */}
        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/kex" element={<KexPage />} />
          <Route path="/kex/:id" element={<KexJobDetail />} />
          <Route path="/fuse" element={<FusePage />} />
          <Route path="/fuse/:id" element={<FuseJobDetail />} />
          <Route path="/graphs" element={<KGListPage />} />
          <Route path="/graphs/:id" element={<KGDetailPage />} />
          <Route path="/ontologies" element={<OntologyListPage />} />
          <Route path="/ontologies/:id" element={<OntologyDetailPage />} />
          <Route path="/chat" element={<TalkToGraphPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/billing" element={<TokenDashboard />} />
          <Route path="/admin" element={<AdminPanel />} />
          <Route path="/triggers" element={<TriggersPage />} />
          <Route path="/onboarding" element={<OnboardingWizard />} />
          <Route path="/drive" element={<GoogleDrivePage />} />
        </Route>

        {/* Root and catch-all: unauthenticated → /login via ProtectedRoute, authenticated → /dashboard */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </ActivationGate>
  )
}

