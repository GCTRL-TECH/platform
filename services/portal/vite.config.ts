import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Marketing routes we want search engines / LLM crawlers to see as real
// prerendered HTML. Everything else (auth pages, dashboard, licenses,
// settings, admin) is intentionally excluded — those are behind a login
// and were never meant to be indexed or statically generated.
const PRERENDERED_STATIC_ROUTES = ['/', '/docs', '/use-cases', '/integrations', '/pricing', '/imprint', '/privacy']

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3002,
    proxy: {
      '/v1': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/admin': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  ssgOptions: {
    entry: 'src/main.tsx',
    // /docs/tech-kex -> dist/docs/tech-kex/index.html (matches nginx's
    // existing `try_files $uri $uri/ /index.html` SPA-fallback behavior).
    dirStyle: 'nested',
    // 'prettify' rewrites the DOM in ways that break hydration (see
    // vite-react-ssg README) — keep the raw renderer output.
    formatting: 'none',
    // Explicit allow-list rather than relying on default dynamic-route
    // filtering: only ever prerender the marketing routes above, plus every
    // concrete /docs/:slug path (expanded via that route's getStaticPaths in
    // src/App.tsx). Auth-gated app routes are never included, even if a
    // future route is added there without a getStaticPaths guard.
    includedRoutes: (paths) => {
      const docSlugPaths = paths.filter((p) => /^\/docs\/[^/]+$/.test(p))
      const allow = new Set([...PRERENDERED_STATIC_ROUTES, ...docSlugPaths])
      return paths.filter((p) => allow.has(p))
    },
    // Every prerendered route has its own <Seo> (src/components/Seo.tsx),
    // rendered via react-helmet-async and injected into <head> by
    // vite-react-ssg itself. That injection is additive, not a replace — so
    // without this, each generated page would carry BOTH the real per-route
    // tags AND the static placeholder tags baked into index.html (title,
    // description, canonical, robots, og:*, twitter:*), duplicated. Strip
    // the static ones from the template before each page render so the
    // Helmet-provided tags are the only copy. (index.html's own fallback
    // copies keep serving non-prerendered, auth-gated app routes exactly as
    // they always have — this only affects the 39 prerendered pages.)
    onBeforePageRender: (_route, indexHTML) => {
      return indexHTML
        .split('\n')
        .filter((line) => {
          const t = line.trim()
          return !(
            /^<title>/.test(t) ||
            /^<meta name="description"/.test(t) ||
            /^<meta name="robots"/.test(t) ||
            /^<link rel="canonical"/.test(t) ||
            /^<meta property="og:/.test(t) ||
            /^<meta name="twitter:/.test(t)
          )
        })
        .join('\n')
    },
  },
})
