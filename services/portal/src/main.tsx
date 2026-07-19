import { ViteReactSSG } from 'vite-react-ssg'
import { routes } from './App'
import { initAnalytics } from '@/lib/analytics'
import '@/styles/globals.css'

// ViteReactSSG builds the router (createBrowserRouter) itself from `routes`
// and - when this module runs in a browser, in dev *and* in the production
// bundle - self-mounts/hydrates the app onto #root. It also prerenders every
// route returned by ssgOptions.includedRoutes (vite.config.ts) at build time.
// QueryClientProvider/AuthProvider/HelmetProvider have moved into App.tsx's
// RootLayout route + ViteReactSSG's own internal HelmetProvider wrap.
export const createRoot = ViteReactSSG(
  { routes },
  ({ isClient }) => {
    // Cookieless, privacy-first analytics. No-op unless VITE_UMAMI_WEBSITE_ID
    // is set, and only ever runs client-side (never during the SSG build).
    if (isClient) initAnalytics()
  },
)
