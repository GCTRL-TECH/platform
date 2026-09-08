/**
 * Version helpers, kept free of React/DOM so they are trivially testable.
 *
 * Background: `GET /api/update/agent-status` proxies the license agent's own
 * `/status`. Its `currentVersion` is the version the AGENT last recorded for this
 * instance, not the version the platform is actually running - after a manual
 * update the two drift apart ("0.1.267" vs a running "0.1.278") and the agent
 * keeps advertising an update. The running platform version comes from
 * `GET /config/public` (`version`), so update prompts must compare against THAT.
 */

/** Parse "v0.1.278", "0.1.278-rc1" or "0.1" into numeric components. `null` if unparseable. */
export function parseVersion(raw: string | null | undefined): number[] | null {
  if (!raw) return null
  const core = raw.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? ''
  if (core === '') return null
  const parts = core.split('.')
  const nums: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    nums.push(Number(p))
  }
  return nums
}

/**
 * Numeric semver comparison: negative if a < b, 0 if equal, positive if a > b.
 * Missing components count as 0 ("0.1" == "0.1.0"). Returns `null` when either
 * side cannot be parsed - callers decide how to degrade.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** True only when `latest` is strictly newer than `current` (0.1.278 > 0.1.267, never a string compare). */
export function isNewerVersion(latest: string | null | undefined, current: string | null | undefined): boolean {
  const cmp = compareVersions(latest, current)
  return cmp !== null && cmp > 0
}

export interface AgentUpdateFlags {
  latestVersion?: string | null
  updateAvailable?: boolean
  updateRequired?: boolean
}

export interface UpdateState {
  updateAvailable: boolean
  updateRequired: boolean
}

/**
 * Decide whether to show an update prompt.
 *
 * - When the running platform version is known, the agent's flags are only
 *   honoured if `latestVersion` is semver-newer than the platform. An agent
 *   that is behind on its own bookkeeping can no longer trigger a false prompt.
 * - When the platform version is unknown (config not loaded / unparseable),
 *   fall back to the agent's flags as before.
 */
export function resolveUpdateState(
  agent: AgentUpdateFlags | null | undefined,
  platformVersion: string | null | undefined,
): UpdateState {
  if (!agent) return { updateAvailable: false, updateRequired: false }
  const available = agent.updateAvailable === true
  const required = agent.updateRequired === true
  const cmp = compareVersions(agent.latestVersion, platformVersion)
  if (cmp === null) return { updateAvailable: available || required, updateRequired: required }
  const newer = cmp > 0
  return {
    updateAvailable: newer && (available || required),
    updateRequired: newer && required,
  }
}
