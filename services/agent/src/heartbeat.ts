import { licenseCache } from './license.js';
import { usageQueue } from './usageQueue.js';

const API_BASE = process.env.GCTRL_API_URL ?? 'https://api.gctrl.tech';
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REPORT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export async function runHeartbeat(jwtToken: string): Promise<string | null> {
  const records = usageQueue.flush();
  try {
    const res = await fetch(`${API_BASE}/v1/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({ usage_report: records }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      records.forEach(r => usageQueue.enqueue(r));
      return null;
    }

    const data = await res.json() as { license_jwt: string };
    await licenseCache.loadFromToken(data.license_jwt);
    return data.license_jwt;
  } catch {
    records.forEach(r => usageQueue.enqueue(r));
    return null;
  }
}

export function startHeartbeatLoop(getToken: () => string) {
  setInterval(async () => {
    if (usageQueue.size() > 0) await runHeartbeat(getToken());
  }, REPORT_INTERVAL_MS);

  setInterval(async () => {
    await runHeartbeat(getToken());
  }, HEARTBEAT_INTERVAL_MS);
}
