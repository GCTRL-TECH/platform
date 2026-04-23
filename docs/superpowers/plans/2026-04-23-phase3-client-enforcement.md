# Phase 3: Client Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `gctrl-agent` sidecar service and integrate credit enforcement into KEX, FUSE, and Talk services so the local GCTRL stack enforces license validity and credit limits without sending any document data to the server.

**Architecture:** `gctrl-agent` is a Node.js service compiled to a single binary (via `pkg`). It owns the license JWT, validates it locally on every job check, batches usage reports, runs the 6h heartbeat, and handles update signaling. KEX, FUSE, and Talk call `gctrl-agent` over a local HTTP socket (127.0.0.1:7070) before starting any job — agent returns allow/deny instantly from cached JWT state. No remote call happens on the hot path.

**Tech Stack:** Node.js 20, TypeScript, `pkg` (binary bundler), `systeminformation` (hardware fingerprint), Express (local socket), jose (JWT verify), existing Python services (KEX, FUSE), existing TypeScript API service

**Prerequisite:** Phase 2 complete — `api.gctrl.tech` running, RS256 public key available.

---

## File Map

```
services/
  agent/
    src/
      index.ts              — Entry point, starts local HTTP server
      license.ts            — Load, verify, cache license JWT from .env
      fingerprint.ts        — Compute hardware fingerprint
      heartbeat.ts          — 6h heartbeat loop
      usageQueue.ts         — Local usage buffer, 15min batch report
      updateManager.ts      — Check update_required/update_available, trigger pull
      server.ts             — Local HTTP server: /check, /report, /status
    Dockerfile
    package.json
    tsconfig.json

  kex/src/
    middleware/
      license_check.py      — Called before every extraction job

  fuse/src/
    middleware/
      license_check.py      — Called before every fusion job

  api/src/
    middleware/
      licenseGate.ts        — Checks agent /check before proxying requests
```

---

### Task 1: Hardware Fingerprint Utility

**Files:**
- Create: `services/agent/src/fingerprint.ts`

- [ ] **Step 1: Write failing test**

```typescript
// services/agent/src/__tests__/fingerprint.test.ts
import { computeFingerprint } from '../fingerprint.js';

test('fingerprint returns 64-char hex string', async () => {
  const fp = await computeFingerprint();
  expect(fp).toMatch(/^[a-f0-9]{64}$/);
});

test('fingerprint is deterministic across calls', async () => {
  const fp1 = await computeFingerprint();
  const fp2 = await computeFingerprint();
  expect(fp1).toBe(fp2);
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd services/agent && npm test -- --testPathPattern=fingerprint
```
Expected: FAIL — `computeFingerprint` not defined.

- [ ] **Step 3: Implement fingerprint**

```typescript
// services/agent/src/fingerprint.ts
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
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npm test -- --testPathPattern=fingerprint
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/fingerprint.ts services/agent/src/__tests__/fingerprint.test.ts
git commit -m "feat(agent): hardware fingerprint utility"
```

---

### Task 2: License JWT Cache

**Files:**
- Create: `services/agent/src/license.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// services/agent/src/__tests__/license.test.ts
import { LicenseCache } from '../license.js';

const VALID_JWT = process.env.TEST_LICENSE_JWT ?? 'mock';

test('canSpend returns false when balance is 0 on free tier', () => {
  const cache = new LicenseCache();
  cache.setFromClaims({ tier: 'free', creditsBalance: 0, overdraftLimit: 0 } as any);
  expect(cache.canSpend(1)).toBe(false);
});

test('canSpend returns true when balance is positive', () => {
  const cache = new LicenseCache();
  cache.setFromClaims({ tier: 'pro', creditsBalance: 500, overdraftLimit: -10000 } as any);
  expect(cache.canSpend(100)).toBe(true);
});

test('canSpend allows overdraft for paid tiers', () => {
  const cache = new LicenseCache();
  cache.setFromClaims({ tier: 'starter', creditsBalance: -4000, overdraftLimit: -5000 } as any);
  expect(cache.canSpend(500)).toBe(true);  // -4000 - 500 = -4500 > -5000
  expect(cache.canSpend(1500)).toBe(false); // -4000 - 1500 = -5500 < -5000
});
```

- [ ] **Step 2: Run test — verify fails**

```bash
npm test -- --testPathPattern=license
```
Expected: FAIL — `LicenseCache` not defined.

- [ ] **Step 3: Implement LicenseCache**

```typescript
// services/agent/src/license.ts
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { importSPKI, jwtVerify } from 'jose';
import type { LicenseJWTClaims } from '../../license-api/src/lib/jwt.js';

const JWT_PATH = process.env.GCTRL_LICENSE_JWT_PATH ?? '/app/config/license.jwt';
const PUBLIC_KEY_PEM = process.env.GCTRL_LICENSE_PUBLIC_KEY!;

export class LicenseCache {
  private claims: LicenseJWTClaims | null = null;

  setFromClaims(claims: LicenseJWTClaims) {
    this.claims = claims;
  }

  async loadFromDisk(): Promise<boolean> {
    if (!existsSync(JWT_PATH)) return false;
    const token = readFileSync(JWT_PATH, 'utf8').trim();
    return this.loadFromToken(token);
  }

  async loadFromToken(token: string): Promise<boolean> {
    try {
      const key = await importSPKI(PUBLIC_KEY_PEM, 'RS256');
      const { payload } = await jwtVerify(token, key, { issuer: 'api.gctrl.tech' });
      this.claims = payload as unknown as LicenseJWTClaims;
      writeFileSync(JWT_PATH, token, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  isValid(): boolean {
    if (!this.claims) return false;
    // JWT expiry already checked by jwtVerify; claims being set means it passed
    return true;
  }

  getTier(): string { return this.claims?.tier ?? 'free'; }
  getBalance(): number { return this.claims?.creditsBalance ?? 0; }
  getOverdraftLimit(): number { return this.claims?.overdraftLimit ?? 0; }
  getFingerprint(): string { return this.claims?.hardwareFingerprint ?? ''; }
  isUpdateRequired(): boolean { return this.claims?.updateRequired ?? false; }
  isUpdateAvailable(): boolean { return this.claims?.updateAvailable ?? false; }
  getLatestVersion(): string { return this.claims?.latestVersion ?? ''; }

  canSpend(credits: number): boolean {
    if (!this.claims) return false;
    const afterSpend = this.claims.creditsBalance - credits;
    return afterSpend >= this.claims.overdraftLimit;
  }

  deductLocal(credits: number) {
    if (this.claims) this.claims.creditsBalance -= credits;
  }
}

export const licenseCache = new LicenseCache();
```

- [ ] **Step 4: Run test — verify passes**

```bash
npm test -- --testPathPattern=license
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/license.ts services/agent/src/__tests__/license.test.ts
git commit -m "feat(agent): license JWT cache with canSpend + overdraft logic"
```

---

### Task 3: Usage Queue (Batch Reporter)

**Files:**
- Create: `services/agent/src/usageQueue.ts`

- [ ] **Step 1: Write failing test**

```typescript
// services/agent/src/__tests__/usageQueue.test.ts
import { UsageQueue } from '../usageQueue.js';

test('enqueue accumulates records', () => {
  const q = new UsageQueue();
  q.enqueue({ action: 'kex_extract', chars_processed: 1000, credits_spent: 25 });
  q.enqueue({ action: 'fuse_merge', chars_processed: 0, credits_spent: 10 });
  expect(q.size()).toBe(2);
});

test('flush returns and clears queue', () => {
  const q = new UsageQueue();
  q.enqueue({ action: 'kex_extract', chars_processed: 1000, credits_spent: 25 });
  const flushed = q.flush();
  expect(flushed).toHaveLength(1);
  expect(q.size()).toBe(0);
});
```

- [ ] **Step 2: Run test — verify fails**

```bash
npm test -- --testPathPattern=usageQueue
```

- [ ] **Step 3: Implement UsageQueue**

```typescript
// services/agent/src/usageQueue.ts
export interface UsageRecord {
  action: string;
  chars_processed: number;
  credits_spent: number;
  timestamp?: string;
}

export class UsageQueue {
  private queue: UsageRecord[] = [];

  enqueue(record: Omit<UsageRecord, 'timestamp'>) {
    this.queue.push({ ...record, timestamp: new Date().toISOString() });
  }

  flush(): UsageRecord[] {
    const records = [...this.queue];
    this.queue = [];
    return records;
  }

  size(): number { return this.queue.length; }
}

export const usageQueue = new UsageQueue();
```

- [ ] **Step 4: Run test — verify passes**

```bash
npm test -- --testPathPattern=usageQueue
```

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/usageQueue.ts services/agent/src/__tests__/usageQueue.test.ts
git commit -m "feat(agent): usage queue for batched credit reporting"
```

---

### Task 4: Heartbeat Loop

**Files:**
- Create: `services/agent/src/heartbeat.ts`

- [ ] **Step 1: Implement heartbeat**

```typescript
// services/agent/src/heartbeat.ts
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
      // Re-enqueue records if heartbeat failed
      records.forEach(r => usageQueue.enqueue(r));
      return null;
    }

    const data = await res.json();
    await licenseCache.loadFromToken(data.license_jwt);
    return data.license_jwt;
  } catch {
    records.forEach(r => usageQueue.enqueue(r));
    return null;
  }
}

export function startHeartbeatLoop(getToken: () => string) {
  // Report usage every 15 min
  setInterval(async () => {
    if (usageQueue.size() > 0) await runHeartbeat(getToken());
  }, REPORT_INTERVAL_MS);

  // Renew JWT every 6h
  setInterval(async () => {
    await runHeartbeat(getToken());
  }, HEARTBEAT_INTERVAL_MS);
}
```

- [ ] **Step 2: Commit**

```bash
git add services/agent/src/heartbeat.ts
git commit -m "feat(agent): heartbeat loop — 6h JWT renewal + 15min usage reporting"
```

---

### Task 5: Local HTTP Server (Check Endpoint)

**Files:**
- Create: `services/agent/src/server.ts`
- Create: `services/agent/src/index.ts`

- [ ] **Step 1: Write local server**

```typescript
// services/agent/src/server.ts
import express from 'express';
import { licenseCache } from './license.js';
import { usageQueue } from './usageQueue.js';
import { CREDIT_COSTS, calculateCredits } from './credits.js';

const app = express();
app.use(express.json());

// Called by KEX/FUSE/Talk BEFORE starting a job
app.post('/check', (req, res) => {
  const { action, chars } = req.body;

  if (!licenseCache.isValid()) {
    return res.status(403).json({ allowed: false, reason: 'License invalid or expired' });
  }

  if (licenseCache.isUpdateRequired()) {
    return res.status(403).json({ allowed: false, reason: 'Required update pending. Run: curl -fsSL https://gctrl.tech/update | bash' });
  }

  const credits = calculateCredits(action, chars ?? 0);
  if (!licenseCache.canSpend(credits)) {
    return res.status(402).json({ allowed: false, reason: 'Insufficient credits', balance: licenseCache.getBalance() });
  }

  // Deduct locally (will be reconciled on next heartbeat)
  licenseCache.deductLocal(credits);

  res.json({ allowed: true, credits_spent: credits, balance: licenseCache.getBalance() });
});

// Called by services AFTER a job completes (records actual usage)
app.post('/report', (req, res) => {
  const { action, chars_processed, credits_spent } = req.body;
  usageQueue.enqueue({ action, chars_processed, credits_spent });
  res.json({ ok: true });
});

// Status endpoint — used by UI banner
app.get('/status', (_, res) => {
  res.json({
    valid: licenseCache.isValid(),
    tier: licenseCache.getTier(),
    balance: licenseCache.getBalance(),
    updateAvailable: licenseCache.isUpdateAvailable(),
    updateRequired: licenseCache.isUpdateRequired(),
    latestVersion: licenseCache.getLatestVersion(),
  });
});

export function startLocalServer(port = 7070) {
  app.listen(port, '127.0.0.1', () => {
    console.log(`gctrl-agent local server on 127.0.0.1:${port}`);
  });
}
```

- [ ] **Step 2: Write entry point**

```typescript
// services/agent/src/index.ts
import { licenseCache } from './license.js';
import { computeFingerprint } from './fingerprint.js';
import { startHeartbeatLoop, runHeartbeat } from './heartbeat.js';
import { startLocalServer } from './server.js';
import { readFileSync } from 'fs';

const JWT_PATH = process.env.GCTRL_LICENSE_JWT_PATH ?? '/app/config/license.jwt';

async function main() {
  console.log('gctrl-agent starting...');

  // Load cached JWT from disk
  const loaded = await licenseCache.loadFromDisk();
  if (!loaded) {
    console.error('ERROR: No valid license JWT found at', JWT_PATH);
    console.error('Run: curl -fsSL https://gctrl.tech/install | bash');
    process.exit(1);
  }

  // Verify hardware fingerprint matches
  const fp = await computeFingerprint();
  if (licenseCache.getFingerprint() !== fp) {
    console.error('ERROR: Hardware fingerprint mismatch. Contact support or reassign seat at gctrl.tech/dashboard');
    process.exit(1);
  }

  // Start local check server
  startLocalServer(7070);

  // Start heartbeat — immediate first run, then on schedule
  const getToken = () => readFileSync(JWT_PATH, 'utf8').trim();
  await runHeartbeat(getToken());
  startHeartbeatLoop(getToken);

  console.log(`gctrl-agent ready | tier=${licenseCache.getTier()} | balance=${licenseCache.getBalance()}`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Write Dockerfile**

```dockerfile
# services/agent/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npx pkg dist/index.js --target node20-linux-x64 --output gctrl-agent

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/gctrl-agent ./gctrl-agent
VOLUME /app/config
EXPOSE 7070
CMD ["./gctrl-agent"]
```

- [ ] **Step 4: Commit**

```bash
git add services/agent/
git commit -m "feat(agent): local HTTP server + entry point + Dockerfile"
```

---

### Task 6: Credit Check in KEX (Python)

**Files:**
- Create: `services/kex/src/middleware/license_check.py`
- Modify: `services/kex/src/main.py`

- [ ] **Step 1: Write license check middleware**

```python
# services/kex/src/middleware/license_check.py
import httpx
import math

AGENT_URL = "http://gctrl-agent:7070"

def check_credits(action: str, chars: int) -> dict:
    """
    Call gctrl-agent before starting a job.
    Returns {"allowed": True, "credits_spent": N} or raises PermissionError.
    """
    try:
        resp = httpx.post(
            f"{AGENT_URL}/check",
            json={"action": action, "chars": chars},
            timeout=3.0,
        )
        data = resp.json()
        if not data.get("allowed"):
            raise PermissionError(data.get("reason", "Credits check failed"))
        return data
    except httpx.ConnectError:
        # Agent unreachable — fail open with warning (grace period)
        import logging
        logging.warning("gctrl-agent unreachable — operating in grace mode")
        return {"allowed": True, "credits_spent": 0}

def report_usage(action: str, chars_processed: int, credits_spent: int) -> None:
    """Report actual usage after job completes."""
    try:
        httpx.post(
            f"{AGENT_URL}/report",
            json={"action": action, "chars_processed": chars_processed, "credits_spent": credits_spent},
            timeout=3.0,
        )
    except Exception:
        pass  # Best-effort reporting
```

- [ ] **Step 2: Integrate into KEX extraction endpoint**

In `services/kex/src/main.py`, find the extraction job handler and wrap with credit check:

```python
# In the POST /extract handler, before starting pipeline:
from middleware.license_check import check_credits, report_usage

# Count characters of all input text
total_chars = sum(len(doc.get("text", "")) for doc in request_data.documents)
action = "kex_extract"  # or "kex_ner" if NER-only mode

check_result = check_credits(action, total_chars)  # raises PermissionError if denied

# ... run extraction pipeline ...

# After pipeline completes:
report_usage(action, total_chars, check_result["credits_spent"])
```

- [ ] **Step 3: Handle PermissionError in FastAPI**

```python
# In main.py, add exception handler:
from fastapi import HTTPException
from fastapi.responses import JSONResponse

@app.exception_handler(PermissionError)
async def permission_error_handler(request, exc):
    return JSONResponse(status_code=402, content={"error": str(exc), "code": "INSUFFICIENT_CREDITS"})
```

- [ ] **Step 4: Write failing integration test**

```python
# services/kex/tests/test_license_check.py
from unittest.mock import patch
from middleware.license_check import check_credits

def test_check_credits_raises_on_denial():
    with patch("httpx.post") as mock_post:
        mock_post.return_value.json.return_value = {"allowed": False, "reason": "No credits"}
        mock_post.return_value.status_code = 402
        try:
            check_credits("kex_extract", 1000)
            assert False, "Should have raised"
        except PermissionError as e:
            assert "No credits" in str(e)

def test_check_credits_passes_when_allowed():
    with patch("httpx.post") as mock_post:
        mock_post.return_value.json.return_value = {"allowed": True, "credits_spent": 25}
        result = check_credits("kex_extract", 1000)
        assert result["credits_spent"] == 25
```

- [ ] **Step 5: Run tests**

```bash
cd services/kex && python -m pytest tests/test_license_check.py -v
```
Expected: 2 tests pass.

- [ ] **Step 6: Apply same pattern to FUSE service**

Create `services/fuse/src/middleware/license_check.py` (identical file).

In `services/fuse/src/main.py`, wrap fusion job handler:
```python
from middleware.license_check import check_credits, report_usage
check_credits("fuse_merge", 0)  # flat fee, chars=0
# ... run fusion ...
report_usage("fuse_merge", 0, 10)
```

- [ ] **Step 7: Commit**

```bash
git add services/kex/src/middleware/ services/fuse/src/middleware/
git add services/kex/src/main.py services/fuse/src/main.py
git add services/kex/tests/test_license_check.py
git commit -m "feat(kex,fuse): credit check middleware — calls gctrl-agent before every job"
```

---

### Task 7: Add gctrl-agent to Customer Docker Compose

**Files:**
- Modify: `docker-compose.yml` (customer-side, in GCTRL/GCTRL/)

- [ ] **Step 1: Add agent service to docker-compose.yml**

```yaml
  gctrl-agent:
    image: ghcr.io/gctrl/agent:latest
    container_name: gctrl-agent
    restart: unless-stopped
    ports:
      - "127.0.0.1:7070:7070"
    volumes:
      - ./config:/app/config:ro
    environment:
      - GCTRL_LICENSE_JWT_PATH=/app/config/license.jwt
      - GCTRL_LICENSE_PUBLIC_KEY=${GCTRL_LICENSE_PUBLIC_KEY}
      - GCTRL_API_URL=https://api.gctrl.tech
    networks:
      - gctrl
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:7070/status"]
      interval: 30s
      timeout: 5s
      retries: 3
```

Also make kex and fuse depend on gctrl-agent being healthy:
```yaml
  gctrl-kex:
    depends_on:
      gctrl-agent:
        condition: service_healthy
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add gctrl-agent sidecar to customer docker-compose"
```

---

### Task 8: UI Banner for License Status

**Files:**
- Modify: `services/web/src/components/LicenseBanner.tsx`

- [ ] **Step 1: Create banner component**

```typescript
// services/web/src/components/LicenseBanner.tsx
import { useEffect, useState } from 'react';

interface AgentStatus {
  valid: boolean;
  tier: string;
  balance: number;
  updateAvailable: boolean;
  updateRequired: boolean;
  latestVersion: string;
}

export function LicenseBanner() {
  const [status, setStatus] = useState<AgentStatus | null>(null);

  useEffect(() => {
    fetch('http://localhost:7070/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!status) return null;

  if (status.updateRequired) return (
    <div className="bg-red-600 text-white px-4 py-2 text-sm text-center">
      ⚠️ Required update available (v{status.latestVersion}).
      Run: <code className="bg-red-800 px-1 rounded">curl -fsSL https://gctrl.tech/update | bash</code>
    </div>
  );

  if (status.updateAvailable) return (
    <div className="bg-yellow-500 text-black px-4 py-2 text-sm text-center">
      Update available (v{status.latestVersion}).
      <button className="ml-2 underline" onClick={() => fetch('/api/update', { method: 'POST' })}>
        Update now
      </button>
    </div>
  );

  if (status.balance <= 0 && status.tier === 'free') return (
    <div className="bg-orange-500 text-white px-4 py-2 text-sm text-center">
      Credits exhausted.{' '}
      <a href="https://gctrl.tech/billing" className="underline" target="_blank">Top up at gctrl.tech</a>
    </div>
  );

  return null;
}
```

- [ ] **Step 2: Add to app layout**

In `services/web/src/app/layout.tsx`, import and render `<LicenseBanner />` at the top of the body.

- [ ] **Step 3: Commit**

```bash
git add services/web/src/components/LicenseBanner.tsx services/web/src/app/layout.tsx
git commit -m "feat(web): license status banner — shows update/credit warnings from gctrl-agent"
```

