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
import { AdminPage } from '@/pages/AdminPage'

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
      </Route>

      <Route element={<AdminRoute />}>
        <Route path="/admin" element={<AdminPage />} />
      </Route>

      <Route path="/" element={<LandingRoute />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
