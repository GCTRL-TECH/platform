import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  createElement,
  type ReactNode,
} from 'react'
import {
  getToken,
  setToken,
  getRefreshToken,
  setRefreshToken,
  clearAuthStorage,
  isTokenExpired,
} from '@/lib/auth'
import { apiGet, apiPost } from '@/lib/api'

export interface User {
  id: string
  email: string
  name: string
  role: 'admin' | 'editor' | 'analyst' | 'viewer'
  clearance: string
  tokensBalance: number
  // Current tiers: free | business | enterprise. Legacy starter/pro kept so
  // existing accounts still type-check until the backend migrates them.
  tier: 'free' | 'business' | 'enterprise' | 'starter' | 'pro'
  emailVerified: boolean
  defaultOntologyId: string | null
}

interface AuthContextValue {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, name: string) => Promise<void>
  logout: () => void
  refreshToken: () => Promise<boolean>
  updateUser: (patch: Partial<User>) => void
}

interface LoginResponse {
  token: string
  refreshToken: string
  user: User
}

interface RefreshResponse {
  token: string
  refreshToken: string
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setTokenState] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchCurrentUser = useCallback(async (): Promise<User | null> => {
    try {
      const data = await apiGet<{ user: User }>('/users/me')
      return data.user
    } catch {
      return null
    }
  }, [])

  const tryRefresh = useCallback(async (): Promise<boolean> => {
    const rt = getRefreshToken()
    if (!rt) return false
    try {
      const data = await apiPost<RefreshResponse>('/auth/refresh', { refreshToken: rt })
      setToken(data.token)
      setRefreshToken(data.refreshToken)
      setTokenState(data.token)
      return true
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function initialize() {
      const storedToken = getToken()

      if (!storedToken) {
        if (!cancelled) setIsLoading(false)
        return
      }

      if (isTokenExpired(storedToken)) {
        const refreshed = await tryRefresh()
        if (!refreshed) {
          clearAuthStorage()
          if (!cancelled) setIsLoading(false)
          return
        }
      } else {
        setTokenState(storedToken)
      }

      const userData = await fetchCurrentUser()
      if (!cancelled) {
        if (userData) {
          setUser(userData)
        } else {
          clearAuthStorage()
          setTokenState(null)
        }
        setIsLoading(false)
      }
    }

    initialize()
    return () => { cancelled = true }
  }, [fetchCurrentUser, tryRefresh])

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiPost<LoginResponse>('/auth/login', { email, password })
    setToken(data.token)
    setRefreshToken(data.refreshToken)
    setTokenState(data.token)
    setUser(data.user)
  }, [])

  const register = useCallback(async (email: string, password: string, name: string) => {
    const data = await apiPost<LoginResponse>('/auth/register', { email, password, name })
    setToken(data.token)
    setRefreshToken(data.refreshToken)
    setTokenState(data.token)
    setUser(data.user)
  }, [])

  const logout = useCallback(() => {
    clearAuthStorage()
    setTokenState(null)
    setUser(null)
  }, [])

  const updateUser = useCallback((patch: Partial<User>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const value: AuthContextValue = {
    user,
    token,
    isAuthenticated: !!user && !!token,
    isLoading,
    login,
    register,
    logout,
    refreshToken: tryRefresh,
    updateUser,
  }

  return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
