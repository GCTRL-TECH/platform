import { Router } from 'express'
import http from 'http'
import fs from 'fs'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router()

const GCTRL_IMAGES = [
  'ghcr.io/gctrl-tech/agent:latest',
  'ghcr.io/gctrl-tech/kex:latest',
  'ghcr.io/gctrl-tech/fuse:latest',
  'ghcr.io/gctrl-tech/fusion-engine:latest',
  'ghcr.io/gctrl-tech/api:latest',
  'ghcr.io/gctrl-tech/web:latest',
]

// Restart order: everything before the API itself, then API last (restarts the responder)
const RESTART_ORDER = [
  'gctrl-agent',
  'gctrl-resolver',
  'gctrl-fuse',
  'gctrl-kex',
  'gctrl-web',
  'gctrl-api',
]

function dockerSocketRequest(opts: {
  path: string
  method?: string
  onData?: (chunk: string) => void
}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: {
          // Empty JSON object → Docker daemon uses its stored credential store
          'X-Registry-Auth': Buffer.from('{}').toString('base64'),
        },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => opts.onData?.(chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function hasDockerSocket(): boolean {
  try {
    fs.accessSync('/var/run/docker.sock')
    return true
  } catch {
    return false
  }
}

// GET /api/update — current version info (reads from agent)
router.get('/', requireAuth, async (_req, res) => {
  try {
    const agentRes = await fetch('http://localhost:7070/status', { signal: AbortSignal.timeout(3000) })
    const status = await agentRes.json() as Record<string, unknown>
    res.json({
      updateAvailable: status['updateAvailable'] ?? false,
      updateRequired: status['updateRequired'] ?? false,
      latestVersion: status['latestVersion'] ?? null,
      canAutoUpdate: hasDockerSocket(),
    })
  } catch {
    res.json({ updateAvailable: false, updateRequired: false, latestVersion: null, canAutoUpdate: false })
  }
})

// POST /api/update — pull latest images and restart containers (admin only)
// Streams progress via Server-Sent Events
router.post('/', requireAuth, requireRole('admin'), async (_req, res) => {
  if (!hasDockerSocket()) {
    res.status(503).json({
      error: 'Docker socket not accessible.',
      manualCommand: 'curl -fsSL https://gctrl.tech/update | bash',
    })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (event: string, data: Record<string, unknown>) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  try {
    // ── Pull images ──────────────────────────────────────────────────────────
    for (const image of GCTRL_IMAGES) {
      send('progress', { step: 'pull', image, message: `Pulling ${image}…` })

      const [repo, tag] = image.split(':')
      await dockerSocketRequest({
        path: `/v1.41/images/create?fromImage=${encodeURIComponent(repo!)}&tag=${tag ?? 'latest'}`,
        method: 'POST',
        onData: (chunk) => {
          chunk.split('\n').filter(Boolean).forEach((line) => {
            try {
              const obj = JSON.parse(line) as Record<string, unknown>
              if (obj['error']) throw new Error(String(obj['error']))
              const msg = String(obj['status'] ?? obj['progress'] ?? '').trim()
              if (msg) send('progress', { step: 'pull', image, message: msg })
            } catch (e: any) {
              if (e.message && !e.message.startsWith('Unexpect')) {
                throw e
              }
            }
          })
        },
      })

      send('progress', { step: 'pulled', image, message: `✓ ${image}` })
    }

    // ── Restart containers ───────────────────────────────────────────────────
    for (const name of RESTART_ORDER) {
      send('progress', { step: 'restart', container: name, message: `Restarting ${name}…` })

      await dockerSocketRequest({
        path: `/v1.41/containers/${name}/restart?t=5`,
        method: 'POST',
      })

      if (name !== 'gctrl-api') {
        send('progress', { step: 'restarted', container: name, message: `✓ ${name}` })
      }
    }

    send('done', { message: 'Update complete. GCTRL is restarting…' })
  } catch (err: any) {
    send('error', { message: err.message ?? 'Update failed' })
  }

  res.end()
})

export default router
