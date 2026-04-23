# GCTRL SaaS Platform — Design Spec
**Date:** 2026-04-23  
**Status:** Approved  
**Project:** Ground Control (GCTRL) — formerly GCTRL

---

## 1. Vision

Turn the local-first GCTRL knowledge graph platform into a commercial SaaS product. Processing stays on the customer's machine (DSGVO-compliant). The central server at `gctrl.tech` handles only licensing, token metering, and billing — it never sees customer data.

---

## 2. Architecture Overview

Three completely isolated layers:

### Layer 1 — Control Plane (VPS: gctrl.tech)
- `gctrl.tech` — Marketing website + customer portal (Next.js)
- `api.gctrl.tech` — License & Token API (Node.js/Express)
- Traefik reverse proxy with automatic Let's Encrypt SSL (pre-installed)
- PostgreSQL: users, licenses, token balances, usage logs
- Redis: session cache, rate limiting
- Stripe: subscription billing + webhooks
- **Never receives customer document content — only numeric usage metrics**

### Layer 2 — Distribution Layer (GitHub Container Registry)
- Private registry at `ghcr.io/gctrl/`
- Pre-built, obfuscated Docker images
- Pull access gated behind a short-lived registry token
- Registry token issued by License API only after successful license activation
- No valid license = no `docker pull` = no deployment possible

### Layer 3 — Data Plane (Customer's machine)
- Full GCTRL stack runs locally: KEX, FUSE, Neo4j, Qdrant, Ollama, LIMES, PostgreSQL, Redis
- New `gctrl-agent` sidecar service handles all communication with Control Plane
- All document processing, entity extraction, graph operations remain on-premise
- Only anonymous usage metrics leave the machine

---

## 3. License Enforcement

### License Key Lifecycle
1. Customer purchases plan on `gctrl.tech` via Stripe
2. License key generated: `GCTRL-XXXX-XXXX-XXXX-XXXX` (UUID v4 + HMAC signature)
3. `curl install` prompts for license key
4. Installer POSTs `{ license_key, hardware_fingerprint }` to `api.gctrl.tech/v1/activate`
5. Server responds with `{ registry_token (24h), license_jwt (7d), tier, credits_balance }`
6. Installer uses registry token to pull images, writes license JWT to `.env`
7. `gctrl-agent` renews license JWT every 6h via heartbeat

### Hardware Fingerprint
- SHA256 of: CPU model + first disk serial + primary MAC address
- Computed locally, sent only at activation and renewal
- Prevents license sharing between machines
- Enterprise tier: multiple seats configurable via customer portal
- All paid tiers: license seat reassignment available via customer portal self-service (for hardware changes, VM migrations) — max 2 reassignments per 30 days to prevent abuse

### Tamper Resistance
- License JWT signed with RS256 (private key only on VPS) — unforgeable
- JWT payload includes hardware fingerprint — non-transferable
- `gctrl-agent` is an obfuscated binary — logic not readable
- Images from private registry with short-lived tokens — no unlicensed pull
- On cancellation: JWT flagged as revoked server-side → renewal fails → 72h grace period → services stop restarting

### Grace Period & Overdraft
- License JWT valid for 7 days; renewed every 6h via heartbeat
- If server unreachable: cached JWT continues working for up to 72h
- During grace period: token consumption continues, tracked as negative balance (overdraft)
- Overdraft limit: −5,000 credits (Starter), −10,000 credits (Pro), not allowed on Free
- Overdraft settled on next top-up or next billing cycle — charged first before new credits apply
- After 72h without renewal: services refuse to start (JWT expired)

---

## 4. Token Model & Tiers

### Credit Definition
**1 credit = 1,000 input characters**

| Operation | Credits per 1,000 chars |
|-----------|------------------------|
| KEX — NER only | 1 |
| KEX — Text to Knowledge Graph | 25 |
| FUSE — Entity Merge Job | 10 (flat per job) |
| Talk — RAG Query | 5 (flat per query) |

### Subscription Tiers

| Tier | Price | Credits/Month | Overage Rate | Rate Limit |
|------|-------|---------------|--------------|------------|
| Free | €0 | 3,000 | not available | 1 req/s |
| Starter | €29/mo | 25,000 | €0.002/credit | 3 req/s |
| Pro | €79/mo | 100,000 | €0.001/credit | 10 req/s |
| Enterprise | Custom | Unlimited | Custom | Unlimited |

- Credits are monthly (reset on billing date) — non-expiring top-up packs available as add-on
- Free tier: hard stop at 0 credits, no overdraft
- Starter/Pro: overdraft allowed up to tier limit
- `gctrl-agent` enforces limits locally on every job start, no round-trip needed (balance cached in signed JWT)

### What the Server Never Sees
Only this shape of data reaches the server:
```json
{ "user_id": "uuid", "action": "kex_extract", "chars": 4200, "credits_spent": 105, "timestamp": "..." }
```
No document content, no entities, no graph data, no personal information beyond the account email used at signup.

---

## 5. GCTRL Agent (gctrl-agent)

New lightweight sidecar service added to the customer's Docker Compose stack.

**Responsibilities:**
- On startup: validate local license JWT (RS256 signature + expiry + hardware fingerprint)
- Every 6h: heartbeat to `api.gctrl.tech/v1/heartbeat` → refresh JWT + sync credit balance
- Before each job: check local credit balance (from cached JWT claims) → allow or reject
- After each job: record usage locally → batch-report to server every 15 minutes
- On grace period entry: log warning, show UI banner, continue operating

**Update Management:**
- Every 6h heartbeat response from server includes `{ latest_version, update_available, update_required, changelog_url }`
- `update_required: true` → breaking change or security fix — agent blocks job execution after 48h warning period and forces update
- `update_available: true` → optional update — UI banner shown, user can trigger manually
- Auto-update: `gctrl-agent` pulls new images via `docker compose pull && docker compose up -d` and restarts services with zero data loss
- Update channel configurable: `stable` (default) or `edge` (opt-in for beta builds)
- Rollback: previous image digest stored locally, `gctrl rollback` reverts to last known good state

**Implementation:** Node.js, compiled to single binary via `pkg`, obfuscated with javascript-obfuscator before packaging into Docker image.

---

## 6. Code Protection

### Python Services (KEX, FUSE)
- **PyArmor** obfuscation: source compiled to encrypted `.pyc` + PyArmor runtime
- Source files removed from Docker images — only compiled artifacts present
- Build step runs in GitHub Actions, source never leaves private repo

### Node/TypeScript Services (API, Agent, Web)
- **javascript-obfuscator** with control-flow flattening + string encryption
- TypeScript compiled first, then obfuscated output packaged into image

### What Cannot Be Fully Hidden
- Docker Compose structure (intentionally public — needed for installer)
- HTTP API shapes (discoverable via network inspection)
- The fact that LIMES, Neo4j, Qdrant, Ollama are used (visible in compose file)
- Core business logic (KEX extraction pipeline, FUSE merger) is protected

---

## 7. LIMES License Compliance

LIMES (used by FUSE service for entity linking) is AGPL-3.0 licensed.

**Compliance posture:** LIMES runs as a completely separate Docker container, communicating with FUSE only via HTTP REST. This is the "separate service" model — FUSE is not a derivative work of LIMES. GCTRL does not modify LIMES source code.

**Requirements:**
- LIMES source remains publicly available (already on GitHub: AKSW/LIMES)
- LIMES container ships unmodified
- Documentation must include LIMES AGPL-3.0 license notice
- If LIMES is ever modified, modified source must be published

---

## 8. Installer

### Installation
```bash
curl -fsSL https://gctrl.tech/install | bash
```

**Flow:**
1. Check prerequisites: Docker, Docker Compose, curl, openssl (install prompts if missing)
2. Prompt: `Enter your GCTRL License Key: GCTRL-XXXX-XXXX-XXXX-XXXX`
3. Compute hardware fingerprint locally
4. POST to `api.gctrl.tech/v1/activate` → receive registry token + license JWT
5. `docker login ghcr.io` with registry token
6. Create `~/gctrl/` with generated `docker-compose.yml` + `.env`
7. `docker compose pull && docker compose up -d`
8. Wait for health checks
9. Output: `✅ GCTRL running at http://localhost:3001 | Tier: Pro | Balance: 100,000 credits`

### Update
```bash
curl -fsSL https://gctrl.tech/update | bash
```

### Uninstall
```bash
curl -fsSL https://gctrl.tech/uninstall | bash
```
Stops containers, removes images, **preserves `~/gctrl/data/`** (customer data stays). Deactivates license on server (can be reactivated on new machine).

---

## 9. VPS Infrastructure

**Server:** Hostinger KVM 4 — 4 CPU, 16GB RAM, 200GB disk, Ubuntu 24.04
**IP:** 72.61.189.78 | **Domain:** gctrl.tech

### Services on VPS
```yaml
gctrl-web:    Next.js (marketing, login, dashboard, billing portal)
gctrl-api:    License API, Token API, Stripe webhooks
gctrl-db:     PostgreSQL
gctrl-redis:  Redis
traefik:      Already installed — handles SSL + routing
```

### Domain Routing (Traefik)
```
gctrl.tech          → gctrl-web  (marketing + customer portal)
api.gctrl.tech      → gctrl-api  (license/token API)
admin.gctrl.tech    → gctrl-web  (admin dashboard, role-gated)
```

---

## 10. CI/CD Pipeline

### Repositories
- `gctrl/platform` — private, all source code
- `gctrl/deploy` — public, only installer scripts + compose templates

### GitHub Actions Build Pipeline
```
Push to main →
  1. Build KEX (Python) → PyArmor obfuscate → Docker image → push ghcr.io/gctrl/kex
  2. Build FUSE (Python) → PyArmor obfuscate → Docker image → push ghcr.io/gctrl/fuse
  3. Build API (TypeScript) → compile → js-obfuscate → Docker image → push ghcr.io/gctrl/api
  4. Build Agent (Node) → compile → js-obfuscate → pkg binary → Docker image → push ghcr.io/gctrl/agent
  5. Build Web (Next.js) → Docker image → push ghcr.io/gctrl/web
  6. SSH to VPS → docker compose pull && docker compose up -d (license server update)
  7. Update installer scripts in gctrl/deploy repo
```

---

## 11. Email Infrastructure

### Strategy
Transactional emails via **Resend** (resend.com) — best deliverability, simple API, free tier covers 3,000 emails/month. Self-hosting a mail server on the VPS is avoided (spam blacklist risk, complex maintenance).

Sending domain: `mail.gctrl.tech`  
From address: `no-reply@gctrl.tech` / `support@gctrl.tech`

### Required DNS Records (to be added to gctrl.tech)
```
# MX — receives replies to support@gctrl.tech (via Hostinger Email or Resend inbound)
MX  @   mail.hostinger.com   priority 10

# SPF — authorizes Resend to send on behalf of gctrl.tech
TXT @   "v=spf1 include:_spf.resend.com ~all"

# DKIM — Resend provides, added as CNAME
CNAME resend._domainkey   [provided by Resend after domain verification]

# DMARC — prevents spoofing, reports to admin
TXT _dmarc   "v=DMARC1; p=quarantine; rua=mailto:dmarc@gctrl.tech"

# Fix: root domain → VPS (currently wrong: 2.57.91.91 → should be 72.61.189.78)
A   @   72.61.189.78
A   api   72.61.189.78
A   admin   72.61.189.78
```

### Email Templates Required

| Trigger | Subject | Content |
|---------|---------|---------|
| Signup | Welcome to GCTRL | Confirm email + getting started link |
| Email verification | Verify your email | Confirmation link (expires 24h) |
| Password reset | Reset your password | Reset link (expires 1h) |
| License key issued | Your GCTRL License Key | Key + install command |
| Subscription confirmed | Subscription activated | Plan details + invoice link |
| Invoice | Invoice #XXXX | PDF attachment via Stripe |
| Low credits warning | Credits running low | Balance + top-up link (at 10% remaining) |
| Credits exhausted | Credits exhausted | Top-up link + current overdraft |
| Update available | GCTRL update available | Changelog + update command |
| Update required | Action required: GCTRL update | Deadline + update command |
| License expiring | Subscription renews in 3 days | Renewal date + manage billing link |
| License cancelled | Subscription cancelled | Grace period end date + reactivation link |

### VPS Mail Container (for inbound support emails)
```yaml
gctrl-mail:   Stalwart Mail or simple Postfix — receives support@gctrl.tech
              forwards to fabio@5monti.com
```
Alternative: Hostinger Email hosting for `support@gctrl.tech` (already available with domain).

---

## 12. Admin Dashboard (admin.gctrl.tech)

Internal-only panel for platform administration. Accessible only to accounts with `role: admin` (starting with fabio@5monti.com).

### User Management
- List all users: email, tier, signup date, last heartbeat, hardware fingerprint
- Manually upgrade/downgrade tier
- Suspend or ban accounts (JWT immediately revoked server-side)
- Impersonate user (read-only view of their dashboard) for support

### License Management
- View all active licenses: key, user, activation date, machine fingerprint, status
- Manually revoke or reactivate a license
- Issue complimentary licenses (demo, partnerships, internal use)
- Force seat reassignment (override the 2/30d self-service limit)
- Extend grace period manually (for support cases)

### Token & Credit Management
- View any user's credit balance and usage history
- Manually top-up credits (e.g. compensation, bug bounty, trials)
- Deduct credits (e.g. corrections)
- Set custom overdraft limits per account
- Export usage report as CSV (for invoicing Enterprise customers)

### Update Management
- Set current stable/edge version per service
- Toggle `update_required` flag globally or per user
- Write changelog that appears in client UI banner
- Staged rollouts: push update to % of users (e.g. 10% → 50% → 100%)

### Analytics (no customer data — only metrics)
- Active installs over time
- Credits consumed per day/week/month (total + per tier)
- Top actions (KEX vs FUSE vs Talk)
- Churn indicators: users approaching 0 balance, inactive > 30d

### Technical
- Separate route prefix: `api.gctrl.tech/admin/...`
- Auth: admin JWT with short expiry (1h), re-auth required for destructive actions
- All admin actions written to immutable audit log (who did what, when)
- No direct DB access — all via API endpoints (audit trail guaranteed)

---

## 12. Implementation Phases

### Phase 1 — Foundation
- Rename GCTRL → GCTRL (58 files, RENAME-PLAN.md already prepared)
- Remove LIMES from own codebase (use as unmodified external container)
- Set up VPS: configure Traefik, deploy PostgreSQL + Redis

### Phase 2 — License Server
- Build `gctrl-api`: activation, heartbeat, token reporting, Stripe webhooks
- Database schema: users, licenses, token_usage, subscriptions
- Build `gctrl-web`: marketing page, login, dashboard, billing portal

### Phase 3 — Client Enforcement
- Build `gctrl-agent` sidecar
- Integrate credit checks into KEX, FUSE, Talk services
- Hardware fingerprinting utility

### Phase 4 — Code Protection & Distribution
- Set up GitHub Container Registry (private)
- Integrate PyArmor + javascript-obfuscator into build pipeline
- GitHub Actions CI/CD pipeline

### Phase 5 — Installer & Polish
- Write installer/update/uninstall scripts
- Host scripts at gctrl.tech/install
- End-to-end test: fresh machine → install → activate → use → billing

---

## 12. DSGVO Compliance Summary

| Data Type | Where processed | Reaches server? |
|-----------|----------------|-----------------|
| Documents | Customer machine | Never |
| Entities / Triples | Customer machine | Never |
| Knowledge Graphs | Customer machine | Never |
| Usage counts (chars, credits) | Anonymized metric | Yes (no content) |
| Account email | Customer portal | Yes (required for billing) |
| Hardware fingerprint | Hashed, opaque | Yes (license binding only) |

Processing basis: Art. 6(1)(b) DSGVO — contract fulfillment (license + billing).
No special categories of data (Art. 9) processed on server.
No cross-border transfers outside EU (Hostinger EU datacenter).

