import axios from 'axios'
import { getApiUrl, getApiKey } from './config'

export function createClient() {
  const apiKey = getApiKey()
  return axios.create({
    baseURL: getApiUrl() + '/api',
    headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
    timeout: 30000,
  })
}

export function formatError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as Record<string, unknown> | undefined
    return (data?.error as string | undefined) ?? err.message
  }
  return String(err)
}
