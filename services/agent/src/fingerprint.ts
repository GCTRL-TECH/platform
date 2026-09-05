import si from 'systeminformation';
import { createHash } from 'crypto';

// Memoized for the process lifetime: systeminformation reports the CURRENT cpu
// speed (frequency scaling) and an unstable disk enumeration on some hosts (CI
// runners included), so two calls seconds apart could hash differently and flip
// the license seat binding mid-run. A machine's fingerprint must not change
// while the agent is running; the formula itself is left untouched so existing
// installs keep the fingerprint they were activated with.
let cached: Promise<string> | null = null;

export function computeFingerprint(): Promise<string> {
  if (!cached) {
    cached = computeFingerprintUncached().catch((err) => {
      cached = null; // never cache a failure
      throw err;
    });
  }
  return cached;
}

async function computeFingerprintUncached(): Promise<string> {
  const [cpu, disk, net] = await Promise.all([
    si.cpu(),
    si.diskLayout(),
    si.networkInterfaces(),
  ]);

  const cpuId = cpu.manufacturer + cpu.brand + cpu.speed;
  const diskId = (disk[0]?.serialNum ?? disk[0]?.name ?? 'unknown');
  // Pick the lexicographically SMALLEST eligible MAC, not the first-enumerated
  // one: systeminformation's interface order is not stable across calls, so on
  // multi-interface machines "first non-internal" could flip between runs —
  // changing the fingerprint and silently resetting the license seat binding.
  const macAddr = Array.isArray(net)
    ? (net
        .filter((n: any) => !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
        .map((n: any) => String(n.mac).toLowerCase())
        .sort()[0] ?? 'unknown')
    : 'unknown';

  return createHash('sha256')
    .update(`${cpuId}::${diskId}::${macAddr}`)
    .digest('hex');
}
