// Privacy-first analytics loader (self-hosted Umami).
//
// Cookieless by design: Umami sets no cookies and stores no personal data
// (daily-salted hash of IP+UA, raw IP discarded), so no consent banner is required.
// The loader is a no-op unless VITE_UMAMI_WEBSITE_ID is provided at build time, so
// local dev, previews, and tests run with zero tracking and zero network calls.
//
// Pageviews + SPA route changes are auto-tracked by the Umami script. Click goals are
// declared inline via `data-umami-event="..."` attributes on the relevant elements.
// Use track() only for events that aren't a DOM click (e.g. a successful signup).

const env = import.meta.env as Record<string, string | undefined>

const WEBSITE_ID = env['VITE_UMAMI_WEBSITE_ID']?.trim()
const SCRIPT_URL = env['VITE_UMAMI_SCRIPT_URL']?.trim() || 'https://analytics.gctrl.tech/script.js'
// Restrict tracking to the production host so preview/staging traffic is ignored.
const DOMAINS = 'gctrl.tech'

declare global {
  interface Window {
    umami?: {
      track: (
        event?: string | ((props: Record<string, unknown>) => Record<string, unknown>),
        data?: Record<string, unknown>,
      ) => void
    }
  }
}

/** Inject the Umami tracker once, only when a website ID is configured. */
export function initAnalytics(): void {
  if (!WEBSITE_ID) return
  if (typeof document === 'undefined') return
  if (document.querySelector('script[data-website-id]')) return // idempotent

  const s = document.createElement('script')
  s.defer = true
  s.src = SCRIPT_URL
  s.setAttribute('data-website-id', WEBSITE_ID)
  s.setAttribute('data-domains', DOMAINS)
  document.head.appendChild(s)
}

/** Fire a named goal event. Safe no-op if the tracker is absent or blocked. */
export function track(event: string, data?: Record<string, unknown>): void {
  try {
    window.umami?.track(event, data)
  } catch {
    /* analytics must never break the app */
  }
}
