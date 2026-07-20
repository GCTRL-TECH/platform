import si from 'systeminformation';
import { createHash } from 'crypto';

export async function computeFingerprint(): Promise<string> {
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
