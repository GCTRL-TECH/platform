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
  const macAddr = Array.isArray(net)
    ? (net.find((n: any) => !n.internal && n.mac !== '00:00:00:00:00:00')?.mac ?? 'unknown')
    : 'unknown';

  return createHash('sha256')
    .update(`${cpuId}::${diskId}::${macAddr}`)
    .digest('hex');
}
