import { Command } from 'commander'
import chalk from 'chalk'
import readline from 'readline'
import { getApiUrl, getApiKey } from '../config'

/**
 * Launches the interactive GCTRL agent (Pi) REPL that streams from the
 * Pi Console via POST /api/agent/chat (SSE). Shared by both `gctrl agent`
 * and the bare `gctrl` default action.
 */
export async function runAgentRepl(): Promise<void> {
  console.log(chalk.blue('GCTRL agent') + chalk.dim(' (Pi) — type your message, Ctrl+C to exit'))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const apiUrl = getApiUrl()
  const apiKey = getApiKey()

  return new Promise<void>((resolve) => {
    rl.on('close', () => resolve())

    const askNext = () => {
        rl.question(chalk.cyan('> '), async (message) => {
          if (!message.trim()) { askNext(); return }
          process.stdout.write(chalk.dim('Assistant: '))
          try {
            // Use native fetch (Node 18+) for SSE streaming
            const resp = await fetch(`${apiUrl}/api/agent/chat`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
              },
              body: JSON.stringify({ message }),
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
                  const event = JSON.parse(line.slice(6)) as { type: string; content?: string }
                  if (event.type === 'token' && event.content) process.stdout.write(event.content)
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
    .action(async () => {
      await runAgentRepl()
    })
}
