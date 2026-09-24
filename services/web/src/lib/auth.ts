import { UI_MODE_KEY } from '@/hooks/useUiMode'

const TOKEN_KEY = 'GCTRL_token'
const REFRESH_TOKEN_KEY = 'GCTRL_refresh_token'

export interface TokenPayload {
  sub: string
  email: string
  role: string
  clearance: string
  exp: number
  iat?: number
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function removeToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function setRefreshToken(token: string): void {
  localStorage.setItem(REFRESH_TOKEN_KEY, token)
}

export function removeRefreshToken(): void {
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

export function decodeToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(decoded) as TokenPayload
  } catch {
    return null
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = decodeToken(token)
  if (!payload) return true
  const nowInSeconds = Math.floor(Date.now() / 1000)
  return payload.exp < nowInSeconds
}

export function clearAuthStorage(): void {
  removeToken()
  removeRefreshToken()
  // The Easy/Expert mode is a PERSONAL preference, not device state: leaving it
  // behind on logout hands it to whoever signs in next on a shared machine.
  // try/catch mirrors useUiMode — storage access may throw (private mode, policy).
  try { localStorage.removeItem(UI_MODE_KEY) } catch { /* non-persistent env */ }
}

