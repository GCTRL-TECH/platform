import { useLocation } from 'react-router-dom'

const TITLE_MAP: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/kex': 'KEX — Knowledge Extraction',
  '/fuse': 'FUSE — Knowledge Fusion',
  '/graphs': 'Knowledge Graphs',
  '/chat': 'Talk to Graph',
  '/settings': 'Settings',
}

export function usePageTitle(): string {
  const location = useLocation()
  const path = '/' + location.pathname.split('/')[1]

  if (location.pathname.match(/^\/kex\/[^/]+$/)) {
    return 'Extraction Job'
  }

  return TITLE_MAP[path] ?? 'GCTRL'
}

