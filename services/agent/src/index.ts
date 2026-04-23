import { readFileSync } from 'fs';
import { licenseCache } from './license.js';
import { computeFingerprint } from './fingerprint.js';
import { startHeartbeatLoop, runHeartbeat } from './heartbeat.js';
import { startLocalServer } from './server.js';

const JWT_PATH = process.env.GCTRL_LICENSE_JWT_PATH ?? '/app/config/license.jwt';

async function main() {
  console.log('gctrl-agent starting...');

  const loaded = await licenseCache.loadFromDisk();
  if (!loaded) {
    console.error('ERROR: No valid license JWT found at', JWT_PATH);
    console.error('Run: curl -fsSL https://gctrl.tech/install | bash');
    process.exit(1);
  }

  const fp = await computeFingerprint();
  if (licenseCache.getFingerprint() !== fp) {
    console.error('ERROR: Hardware fingerprint mismatch. Contact support or reassign seat at gctrl.tech/dashboard');
    process.exit(1);
  }

  startLocalServer(7070);

  const getToken = () => readFileSync(JWT_PATH, 'utf8').trim();
  await runHeartbeat(getToken());
  startHeartbeatLoop(getToken);

  console.log(`gctrl-agent ready | tier=${licenseCache.getTier()} | balance=${licenseCache.getBalance()}`);
}

main().catch(err => { console.error(err); process.exit(1); });
