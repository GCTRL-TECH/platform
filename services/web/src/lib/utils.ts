import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Base URL of the gctrl-agent license/health service (`:7070`).
 *
 * Derived from the browser's own hostname so it tracks the served origin (no
 * hardcoded `localhost:7070`). Overridable at build time via `VITE_AGENT_URL`.
 * Used in non-render fetch callbacks where the async `usePublicConfig()` hook
 * cannot run; the hook exposes the same value as `agentHealth` for components.
 */
export function agentHealthUrl(): string {
  const override = (import.meta.env as Record<string, string | undefined>)['VITE_AGENT_URL']
  if (override) return override.replace(/\/$/, '')
  const hostname =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : 'localhost'
  return `http://${hostname}:7070`
}
