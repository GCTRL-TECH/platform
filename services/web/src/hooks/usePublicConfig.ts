import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/lib/api'

/**
 * Shape returned by `GET /api/config/public` — the single source of truth for
 * every user-visible endpoint URL the UI displays. Changing the published port
 * + `FRONTEND_URL` in `.env`/compose updates all of these automatically; the UI
 * never hardcodes a `host:port`.
 */
export interface PublicConfig {
  /** Canonical external origin the browser uses, e.g. `http://localhost:3001`. */
  apiOrigin: string
  /** `${apiOrigin}/api`. */
  apiBase: string
  /** MCP-over-HTTP base shown in the MCP/n8n setup tabs. */
  mcpEndpoint: string
  /** Remote MCP gateway endpoint (Agent tab). */
  agentGatewayEndpoint: string
  /** Neo4j Browser URL. Empty => derive from the browser host + :7474. */
  neo4jBrowser: string
  /** Agent health/license URL. Empty => derive from the browser host + :7070. */
  agentHealth: string
  /** Running server version. */
  version: string
  /** True only on a brand-new install with no users — drives first-run setup. */
  setupRequired: boolean
}

/**
 * Fallback computed purely from `window.location.origin`, used when the API call
 * has not resolved yet or fails — so every displayed URL still reflects the real
 * served origin (never a stale `localhost:4000`).
 */
export function fallbackPublicConfig(): PublicConfig {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost'
  const hostname =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : 'localhost'
  return {
    apiOrigin: origin,
    apiBase: `${origin}/api`,
    mcpEndpoint: `${origin}/api`,
    agentGatewayEndpoint: `${origin}/api/agent/mcp`,
    neo4jBrowser: `http://${hostname}:7474`,
    agentHealth: `http://${hostname}:7070`,
    version: '',
    // Conservative default: assume the install is already configured so we never
    // flash the setup screen before the real config resolves.
    setupRequired: false,
  }
}

/**
 * Cached fetch of the public config. Falls back to an origin-derived config so
 * the UI works even if the call fails. Long cache: this rarely changes within a
 * session.
 */
export function usePublicConfig(): PublicConfig {
  const fallback = fallbackPublicConfig()

  const { data } = useQuery<PublicConfig, Error>({
    queryKey: ['public-config'],
    queryFn: () => apiGet<PublicConfig>('/config/public'),
    staleTime: 60 * 60 * 1000, // 1h
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  })

  if (!data) return fallback

  // Server returns empty strings for neo4jBrowser/agentHealth when it wants the
  // frontend to derive them from the browser host. Merge with the fallback so
  // those slots are always populated.
  return {
    apiOrigin: data.apiOrigin || fallback.apiOrigin,
    apiBase: data.apiBase || fallback.apiBase,
    mcpEndpoint: data.mcpEndpoint || fallback.mcpEndpoint,
    agentGatewayEndpoint: data.agentGatewayEndpoint || fallback.agentGatewayEndpoint,
    neo4jBrowser: data.neo4jBrowser || fallback.neo4jBrowser,
    agentHealth: data.agentHealth || fallback.agentHealth,
    version: data.version || fallback.version,
    setupRequired: data.setupRequired ?? fallback.setupRequired,
  }
}

/**
 * First-run setup detection. Returns whether the install needs an initial admin
 * account created, plus a loading flag so the UI doesn't flash a setup screen
 * before the real config resolves.
 *
 * `setupRequired` is only trusted once the query has actually resolved from the
 * server — while loading (or on error) it reports `false` so configured installs
 * are never bounced into setup.
 */
export function useSetupRequired(): { setupRequired: boolean; isLoading: boolean } {
  const { data, isLoading, isError } = useQuery<PublicConfig, Error>({
    queryKey: ['public-config'],
    queryFn: () => apiGet<PublicConfig>('/config/public'),
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  })

  return {
    setupRequired: !isLoading && !isError ? (data?.setupRequired ?? false) : false,
    isLoading,
  }
}
