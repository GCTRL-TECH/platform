import { lazy, StrictMode, Suspense } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import type { RouteRecord } from 'vite-react-ssg'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
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
import { ALL_PAGES } from '@/pages/docs/registry'
// Marketing content pages are lazy-loaded so react-markdown + doc content stay
// out of the main (landing) bundle.
const DocsPage = lazy(() => import('@/pages/docs/DocsPage').then((m) => ({ default: m.DocsPage })))
const UseCasesPage = lazy(() => import('@/pages/UseCasesPage').then((m) => ({ default: m.UseCasesPage })))
const IntegrationsPage = lazy(() => import('@/pages/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })))
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

// Query client + auth context used to live in main.tsx wrapping <BrowserRouter>.
// vite-react-ssg builds its own router directly from the `routes` data below
// (no <BrowserRouter> element to wrap), so the same provider nesting now
// lives in this root layout route instead - one root route wrapping every
// other route via <Outlet/>, functionally identical to the old JSX tree.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      retry: (failureCount, error) => {
        const status = (error as { response?: { status?: number } })?.response?.status
        if (status === 401 || status === 403 || status === 404) return false
        return failureCount < 2
      },
    },
    mutations: { retry: false },
  },
})

function RootLayout() {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}

export const routes: RouteRecord[] = [
  {
    element: <RootLayout />,
    children: [
      {
        element: <PublicRoute />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/register', element: <RegisterPage /> },
          { path: '/forgot-password', element: <ForgotPasswordPage /> },
        ],
      },

      {
        element: <ProtectedRoute />,
        children: [
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/licenses', element: <LicensesPage /> },
          { path: '/licenses/:id', element: <LicenseDetailPage /> },
          { path: '/settings', element: <SettingsPage /> },
        ],
      },

      {
        element: <AdminRoute />,
        children: [{ path: '/admin', element: <AdminPage /> }],
      },

      { path: '/', element: <LandingRoute /> },

      // Public marketing pages - viewable regardless of auth. Prerendered by
      // vite-react-ssg (see vite.config.ts ssgOptions.includedRoutes).
      { path: '/docs', element: <DocsPage /> },
      {
        path: '/docs/:slug',
        element: <DocsPage />,
        // Tells vite-react-ssg every concrete doc URL to prerender.
        getStaticPaths: () => ALL_PAGES.map((p) => `/docs/${p.slug}`),
      },
      { path: '/use-cases', element: <UseCasesPage /> },
      { path: '/integrations', element: <IntegrationsPage /> },
      { path: '/pricing', element: <PricingPage /> },
      { path: '/imprint', element: <ImprintPage /> },
      { path: '/privacy', element: <PrivacyPolicyPage /> },

      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
]

export default routes
