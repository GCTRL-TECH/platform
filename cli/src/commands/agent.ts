import { Command } from 'commander'
import chalk from 'chalk'
import readline from 'readline'
import { getApiUrl, getApiKey } from '../config'

interface LlmModelEntry {
  provider: string
  model: string
  name: string
  available?: boolean
}

/** Fetch the models the backend can address (local Ollama + connected cloud). */
async function fetchModels(apiUrl: string, apiKey?: string): Promise<LlmModelEntry[]> {
  try {
    const resp = await fetch(`${apiUrl}/api/llm/models`, {
      headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
    })
    if (!resp.ok) return []
    const data = (await resp.json()) as { models?: LlmModelEntry[] }
    return data.models ?? []
  } catch {
    return []
  }
}

/** The server-side default model for the agent purpose (Cookbook pref). */
async function fetchAgentDefault(apiUrl: string, apiKey?: string): Promise<string | null> {
  try {
    const resp = await fetch(`${apiUrl}/api/llm/model-prefs`, {
      headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { agentModel?: string | null }
    return data.agentModel?.trim() || null
  } catch {
    return null
  }
}

/**
 * Launches the interactive GCTRL agent (Pi) REPL that streams from the
 * Pi Console via POST /api/agent/chat (SSE). Shared by both `gctrl agent`
 * and the bare `gctrl` default action.
 *
 * Model selection: with no override the server resolves the user's Cookbook
 * "agent" pref (shown at startup). `/models` lists what the backend can
 * address; `/model <name>` pins one for this session (provider is derived
 * from the list so cloud models are routed correctly); `/model default`
 * returns to the server default.
 */
export async function runAgentRepl(initialModel?: string): Promise<void> {
  console.log(chalk.blue('GCTRL agent') + chalk.dim(' (Pi) — type your message, Ctrl+C to exit'))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const apiUrl = getApiUrl()
  const apiKey = getApiKey()

  // Session model override — undefined means "server default (Cookbook pref)".
  let model: string | undefined
  let provider: string | undefined

  const [models, serverDefault] = await Promise.all([
    fetchModels(apiUrl, apiKey),
    fetchAgentDefault(apiUrl, apiKey),
  ])

  const pickByName = (name: string): LlmModelEntry | undefined =>
    models.find((m) => m.model === name && m.available !== false) ??
    models.find((m) => `${m.provider}:${m.model}` === name && m.available !== false)

  if (initialModel) {
    const entry = pickByName(initialModel)
    if (entry) {
      model = entry.model
      provider = entry.provider
    } else {
      // Unknown to the list (e.g. not-yet-pulled tag) — send as-is, local Ollama.
      model = initialModel
    }
  }

  const activeLabel = () =>
    model
      ? `${model}${provider && provider !== 'ollama' ? chalk.dim(` (${provider})`) : ''}`
      : serverDefault
        ? `${serverDefault}${chalk.dim(' (default)')}`
        : chalk.dim('server default')

  console.log(chalk.dim('Model: ') + activeLabel() + chalk.dim('  ·  /models to list, /model <name> to switch'))

  return new Promise<void>((resolve) => {
    rl.on('close', () => resolve())

    const handleCommand = (input: string): boolean => {
      if (input === '/models') {
        if (models.length === 0) {
          console.log(chalk.yellow('No models reported by the backend — is it running?'))
          return true
        }
        for (const m of models) {
          const current = m.model === (model ?? serverDefault)
          const marker = current ? chalk.green('●') : chalk.dim('○')
          const avail = m.available === false ? chalk.red(' (unavailable)') : ''
          console.log(`  ${marker} ${m.model}${m.provider !== 'ollama' ? chalk.dim(` · ${m.provider}`) : ''}${avail}`)
        }
        return true
      }
      if (input.startsWith('/model')) {
        const arg = input.slice('/model'.length).trim()
        if (!arg) {
          console.log(chalk.dim('Active model: ') + activeLabel())
        } else if (arg === 'default') {
          model = undefined
          provider = undefined
          console.log(chalk.dim('Back to server default: ') + activeLabel())
        } else {
          const entry = pickByName(arg)
          if (entry) {
            model = entry.model
            provider = entry.provider
            console.log(chalk.dim('Switched to ') + activeLabel())
          } else {
            console.log(chalk.yellow(`'${arg}' is not in /models — sending it as an Ollama tag anyway.`))
            model = arg
            provider = undefined
          }
        }
        return true
      }
      return false
    }

    const askNext = () => {
        rl.question(chalk.cyan('> '), async (message) => {
          if (!message.trim()) { askNext(); return }
          if (handleCommand(message.trim())) { askNext(); return }
          process.stdout.write(chalk.dim('Assistant: '))
          try {
            // Use native fetch (Node 18+) for SSE streaming
            const resp = await fetch(`${apiUrl}/api/agent/chat`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
              },
              body: JSON.stringify({
                message,
                ...(model ? { llmModel: model } : {}),
                ...(provider ? { llmProvider: provider } : {}),
              }),
            })
            if (!resp.ok || !resp.body) {
              console.error(chalk.red('\nFailed to connect to agent'))
              askNext(); return
            }
            const reader = resp.body.getReader()
            const decoder = new TextDecoder()
            let buf = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += decoder.decode(value, { stream: true })
              const lines = buf.split('\n')
              buf = lines.pop() ?? ''
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue
                try {
                  const event = JSON.parse(line.slice(6)) as {
                    type: string
                    content?: string
                    message?: string
                    name?: string
                  }
                  if (event.type === 'token' && event.content) process.stdout.write(event.content)
                  // Tool activity: without this the terminal just sits silent
                  // while the agent works, which reads as a hang.
                  if (event.type === 'tool_call' && event.name) {
                    process.stdout.write(chalk.dim(`\n⚙ ${event.name}… `))
                  }
                  // Surface LLM/tool errors — swallowing them left the REPL
                  // printing an empty "Assistant:" line with no explanation.
                  if (event.type === 'error') {
                    process.stdout.write(chalk.red(`\n${event.message ?? 'Unknown agent error'}\n`))
                  }
                  if (event.type === 'done') { process.stdout.write('\n'); break }
                } catch { /* ignore parse errors */ }
              }
            }
          } catch (err) {
            console.error(chalk.red('\nError: ' + String(err)))
          }
          askNext()
        })
    }
    askNext()
  })
}

export function registerAgent(program: Command): void {
  program
    .command('agent')
    .description('Open interactive GCTRL agent REPL (streams from Pi Console)')
    .option('-m, --model <name>', 'model to chat with (see /models in the REPL)')
    .action(async (opts: { model?: string }) => {
      await runAgentRepl(opts.model)
    })
}
