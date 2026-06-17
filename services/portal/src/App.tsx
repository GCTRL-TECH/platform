import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { AppShell } from '@/components/layout/AppShell'
import { LandingPage } from '@/pages/LandingPage'
import { LoginPage } from '@/pages/auth/LoginPage'
import { RegisterPage } from '@/pages/auth/RegisterPage'
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { LicensesPage } from '@/pages/LicensesPage'
import { LicenseDetailPage } from '@/pages/LicenseDetailPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { AdminPage } from '@/pages/AdminPage'
// Marketing content pages are lazy-loaded so react-markdown + doc content stay
// out of the main (landing) bundle.
const DocsPage = lazy(() => import('@/pages/docs/DocsPage').then((m) => ({ default: m.DocsPage })))
const UseCasesPage = lazy(() => import('@/pages/UseCasesPage').then((m) => ({ default: m.UseCasesPage })))
const PricingPage = lazy(() => import('@/pages/PricingPage').then((m) => ({ default: m.PricingPage })))
const ImprintPage = lazy(() => import('@/pages/legal/LegalPages').then((m) => ({ default: m.ImprintPage })))
const PrivacyPolicyPage = lazy(() => import('@/pages/legal/LegalPages').then((m) => ({ default: m.PrivacyPolicyPage })))

function Spinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-[#0f172a]">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
    </div>
  )
}

function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) return <Spinner />
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <AppShell><Outlet /></AppShell>
}

function AdminRoute() {
  const { user, isLoading } = useAuth()
  if (isLoading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/dashboard" replace />
  return <AppShell><Outlet /></AppShell>
}

function PublicRoute() {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) return <Spinner />
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  return <Outlet />
}

function LandingRoute() {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) return <div className="flex min-h-screen items-center justify-center bg-[#020617]"><span className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500/30 border-t-indigo-500" /></div>
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  return <LandingPage />
}

export function App() {
  return (
    <Suspense fallback={<Spinner />}>
    <Routes>
      <Route element={<PublicRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/licenses" element={<LicensesPage />} />
        <Route path="/licenses/:id" element={<LicenseDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      <Route element={<AdminRoute />}>
        <Route path="/admin" element={<AdminPage />} />
      </Route>

      <Route path="/" element={<LandingRoute />} />

      {/* Public marketing pages — viewable regardless of auth */}
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/docs/:slug" element={<DocsPage />} />
      <Route path="/use-cases" element={<UseCasesPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/imprint" element={<ImprintPage />} />
      <Route path="/privacy" element={<PrivacyPolicyPage />} />

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </Suspense>
  )
}
