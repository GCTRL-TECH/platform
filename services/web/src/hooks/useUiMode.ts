import { useSyncExternalStore } from 'react'

/**
 * Easy/Expert UI mode — a single global preference persisted in localStorage.
 *
 * Easy mode shows only the user-centric core flow (ingest → classify → grant
 * access → explore/ask). Expert mode reveals advanced surfaces (ontologies,
 * triggers, webhooks, SSO/SCIM, infrastructure). Backed by useSyncExternalStore
 * so every component re-renders together when the mode toggles.
 */

export type UiMode = 'easy' | 'expert'
const KEY = 'gctrl_ui_mode'
const listeners = new Set<() => void>()

function get(): UiMode {
  return (localStorage.getItem(KEY) as UiMode) || 'easy'
}
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function setUiMode(mode: UiMode) {
  localStorage.setItem(KEY, mode)
  listeners.forEach((cb) => cb())
}

export function useUiMode(): { mode: UiMode; isExpert: boolean; setMode: (m: UiMode) => void } {
  const mode = useSyncExternalStore(subscribe, get, () => 'easy' as UiMode)
  return { mode, isExpert: mode === 'expert', setMode: setUiMode }
}
