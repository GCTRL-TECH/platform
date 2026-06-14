import { readFileSync } from 'fs';
import { signTuningJWT } from './jwt.js';

/**
 * Server-side store for the canonical, versioned FUSE entity-resolution tuning
 * profile — the tuned recipe that was REMOVED from the public repo. It lives only
 * here (a private, gitignored deploy asset at LICENSE_TUNING_PROFILE_PATH) and is
 * delivered to licensed agents over the heartbeat, signed with the license key.
 *
 * Shape on disk: { version: number, profile: {...} }.
 */
export interface TuningAsset {
  version: number;
  profile: Record<string, unknown>;
}

let _cache: TuningAsset | null | undefined;

function path(): string {
  return process.env.LICENSE_TUNING_PROFILE_PATH || './config/tuning-profile.json';
}

/** Load (and cache) the canonical tuning asset. Returns null when absent/unreadable
 *  so the heartbeat simply omits tuning and agents stay on generic defaults. */
export function loadTuningAsset(): TuningAsset | null {
  if (_cache !== undefined) return _cache;
  try {
    const raw = JSON.parse(readFileSync(path(), 'utf8'));
    if (raw && typeof raw.version === 'number' && raw.profile && typeof raw.profile === 'object') {
      _cache = { version: raw.version, profile: raw.profile };
    } else {
      _cache = null;
    }
  } catch {
    _cache = null;
  }
  return _cache;
}

/**
 * Build the heartbeat `tuning` delta for an agent reporting `agentVersion`.
 * Returns a signed `{ version, jws }` ONLY when the stored profile is newer than
 * what the agent has (or the agent has none) — so steady state carries zero extra
 * bytes. Returns null when there's nothing to send (no asset, or agent up to date).
 */
export async function tuningDeltaFor(agentVersion: number | null | undefined): Promise<{ version: number; jws: string } | null> {
  const asset = loadTuningAsset();
  if (!asset) return null;
  const have = typeof agentVersion === 'number' ? agentVersion : -1;
  if (asset.version <= have) return null; // up to date → send nothing
  const jws = await signTuningJWT(asset.profile, asset.version);
  return { version: asset.version, jws };
}
