import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  createElement,
  type ReactNode,
} from 'react'
import { getToken, setToken, clearToken, isTokenExpired } from '@/lib/auth'
import { apiGet, apiPost } from '@/lib/api'

export interface PortalUser {
  id: string
  email: string
  role: string
  tier: string
  creditsBalance: number
  emailVerified: boolean
}

export interface PortalLicense {
  id: string
  key: string
  status: string
  tier: string
  lastHeartbeatAt: string | null
  activatedAt: string | null
  createdAt: string
}

interface AuthContextValue {
  user: PortalUser | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => void
}

interface LoginResponse {
  token: string
  user: PortalUser
}

interface RegisterResponse {
  token: string
  user: PortalUser
  license: PortalLicense
}

interface MeResponse {
  user: PortalUser
  licenses: PortalLicense[]
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PortalUser | null>(null)
  // On the client this starts `true` exactly as before (checked via effect
  // below). During SSG/prerendering there is no window/localStorage to check
  // and no effects run during the static render pass, so start `false` there
  // — otherwise every route (including the public landing page) would only
  // ever prerender its loading spinner instead of real content.
  const [isLoading, setIsLoading] = useState(() => typeof window !== 'undefined')

  const fetchMe = useCallback(async (): Promise<PortalUser | null> => {
    try {
      const data = await apiGet<MeResponse>('/v1/me')
      return data.user
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function initialize() {
      const token = getToken()
      if (!token || isTokenExpired(token)) {
        clearToken()
        if (!cancelled) setIsLoading(false)
        return
      }

      const userData = await fetchMe()
      if (!cancelled) {
        if (userData) {
          setUser(userData)
        } else {
          clearToken()
        }
        setIsLoading(false)
      }
    }

    initialize()
    return () => { cancelled = true }
  }, [fetchMe])

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiPost<LoginResponse>('/v1/auth/login', { email, password })
    setToken(data.token)
    setUser(data.user)
  }, [])

  const register = useCallback(async (email: string, password: string) => {
    const data = await apiPost<RegisterResponse>('/v1/auth/register', { email, password })
    setToken(data.token)
    setUser(data.user)
  }, [])

  const logout = useCallback(() => {
    clearToken()
    setUser(null)
  }, [])

  const value: AuthContextValue = {
    user,
    isAuthenticated: !!user,
    isLoading,
    login,
    register,
    logout,
  }

  return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export function useTokenFromStorage(): string | null {
  return getToken()
}
