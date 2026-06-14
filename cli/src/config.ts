import fs from 'fs'
import path from 'path'
import os from 'os'

const CONFIG_DIR = path.join(os.homedir(), '.gctrl')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

interface Config {
  apiUrl: string
  apiKey?: string
  email?: string
}

export function readConfig(): Config {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    return JSON.parse(raw) as Config
  } catch {
    return { apiUrl: 'http://localhost:3001' }
  }
}

export function writeConfig(config: Partial<Config>): void {
  const current = readConfig()
  const merged = { ...current, ...config }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2))
}

export function getApiUrl(): string {
  return process.env.GCTRL_API_URL ?? readConfig().apiUrl
}

export function getApiKey(): string | undefined {
  return process.env.GCTRL_API_KEY ?? readConfig().apiKey
}
