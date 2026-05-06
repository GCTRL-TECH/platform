import { Router } from 'express'
import net from 'net'
import { config } from '../config.js'
import { pool } from '../models/db.js'
import { getDriver } from '../services/neo4j.js'

const router = Router()

function probeTcp(host: string, port: number, timeoutMs = 2000): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => { socket.destroy(); resolve(Date.now() - start) })
    socket.on('timeout', () => { socket.destroy(); resolve(null) })
    socket.on('error', () => { socket.destroy(); resolve(null) })
  })
}

async function probeHttp(url: string, timeoutMs = 3000): Promise<number | null> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status < 500) return Date.now() - start
    return null
  } catch {
    return null
  }
}

router.get('/status', async (_req, res) => {
  const qdrantUrl = process.env['QDRANT_URL'] ?? 'http://localhost:6333'
  const ollamaBase = process.env['OLLAMA_BASE'] ?? 'http://localhost:11434'

  const [neo4j, qdrant, ollama, postgres, redis] = await Promise.all([
    // Neo4j — use existing driver
    (async () => {
      const start = Date.now()
      try {
        await getDriver().verifyConnectivity()
        return { connected: true, latencyMs: Date.now() - start }
      } catch {
        return { connected: false, latencyMs: null }
      }
    })(),

    // Qdrant — HTTP health
    probeHttp(`${qdrantUrl}/`).then((ms) => ({ connected: ms !== null, latencyMs: ms })),

    // Ollama — HTTP health
    probeHttp(`${ollamaBase}/`).then((ms) => ({ connected: ms !== null, latencyMs: ms })),

    // Postgres — connection pool ping
    (async () => {
      const start = Date.now()
      try {
        const client = await pool.connect()
        await client.query('SELECT 1')
        client.release()
        return { connected: true, latencyMs: Date.now() - start }
      } catch {
        return { connected: false, latencyMs: null }
      }
    })(),

    // Redis — TCP probe
    (() => {
      try {
        const u = new URL(config.redisUrl.replace(/^redis:\/\//, 'http://'))
        const port = parseInt(u.port || '6379', 10)
        return probeTcp(u.hostname || 'localhost', port).then((ms) => ({
          connected: ms !== null,
          latencyMs: ms,
        }))
      } catch {
        return Promise.resolve({ connected: false, latencyMs: null })
      }
    })(),
  ])

  res.json({
    services: {
      neo4j:    { ...neo4j,    url: config.neo4j.uri },
      qdrant:   { ...qdrant,   url: qdrantUrl },
      ollama:   { ...ollama,   url: ollamaBase },
      postgres: { ...postgres, url: '(configured)' },
      redis:    { ...redis,    url: '(configured)' },
    },
  })
})

export default router
