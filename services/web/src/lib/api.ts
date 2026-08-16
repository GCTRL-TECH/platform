import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import {
  getToken,
  setToken,
  getRefreshToken,
  setRefreshToken,
  clearAuthStorage,
} from './auth'

const BASE_URL = (import.meta.env as Record<string, string | undefined>)['VITE_API_URL'] || '/api'

export const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
})

// Request interceptor: attach JWT
api.interceptors.request.use(
  (config) => {
    const token = getToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Flag to prevent multiple refresh attempts simultaneously
let isRefreshing = false
let failedQueue: Array<{
  resolve: (value: string) => void
  reject: (reason: unknown) => void
}> = []

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error)
    } else if (token) {
      resolve(token)
    }
  })
  failedQueue = []
}

// Response interceptor: handle 401, try token refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean }

    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then((token) => {
          if (originalRequest.headers) {
            originalRequest.headers['Authorization'] = `Bearer ${token}`
          }
          return api(originalRequest)
        })
      }

      originalRequest._retry = true
      isRefreshing = true

      const refreshToken = getRefreshToken()
      if (!refreshToken) {
        // Only bounce someone who ACTUALLY had a session. A visitor who was never
        // logged in still triggers 401s from the probes that run before any login —
        // ActivationGate calls `/update/agent-status`, which sits behind require_auth.
        // Hard-redirecting there reloads the whole app, which mounts ActivationGate,
        // which probes again: an endless reload loop that looks like the login page
        // flickering. It never showed up in development because ActivationGate skips
        // itself on localhost/.local/192.168.*/10.* (isLocalDev in App.tsx), so the
        // loop only ever appeared under a real hostname.
        const hadSession = !!getToken()
        clearAuthStorage()
        if (hadSession && window.location.pathname !== '/login') {
          window.location.href = '/login'
        }
        return Promise.reject(error)
      }

      try {
        const response = await axios.post(`${BASE_URL}/auth/refresh`, {
          refreshToken,
        })
        const { token: newToken, refreshToken: newRefreshToken } = response.data
        setToken(newToken)
        setRefreshToken(newRefreshToken)
        processQueue(null, newToken)

        if (originalRequest.headers) {
          originalRequest.headers['Authorization'] = `Bearer ${newToken}`
        }
        return api(originalRequest)
      } catch (refreshError) {
        processQueue(refreshError, null)
        clearAuthStorage()
        // Here a session really did exist and its refresh failed, so bouncing to the
        // login form is right — but not when we are already standing on it, which
        // would reload in place forever.
        if (window.location.pathname !== '/login') {
          window.location.href = '/login'
        }
        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }

    return Promise.reject(error)
  }
)

// Typed request helpers
export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response: AxiosResponse<T> = await api.get(url, config)
  return response.data
}

export async function apiPost<T>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig
): Promise<T> {
  const response: AxiosResponse<T> = await api.post(url, data, config)
  return response.data
}

export async function apiPut<T>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig
): Promise<T> {
  const response: AxiosResponse<T> = await api.put(url, data, config)
  return response.data
}

export async function apiDelete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response: AxiosResponse<T> = await api.delete(url, config)
  return response.data
}

export default api
