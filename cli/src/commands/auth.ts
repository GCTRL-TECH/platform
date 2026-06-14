import { Command } from 'commander'
import chalk from 'chalk'
import readline from 'readline'
import { readConfig, writeConfig } from '../config'
import { createClient, formatError } from '../api'

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('Manage GCTRL authentication')

  auth
    .command('login')
    .description('Log in with email + password and save API key')
    .option('--url <url>', 'GCTRL API URL (default: http://localhost:3001)')
    .action(async (opts: { url?: string }) => {
      if (opts.url) writeConfig({ apiUrl: opts.url })
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const question = (q: string) => new Promise<string>(r => rl.question(q, r))
      const email = await question('Email: ')
      const password = await question('Password: ')
      rl.close()
      try {
        const client = createClient()
        const { data } = await client.post('/auth/login', { email, password })
        const token = (data as { token?: string }).token
        if (token) {
          writeConfig({ email, apiKey: token })
          console.log(chalk.green('✓ Logged in as ' + email))
        }
      } catch (err) {
        console.error(chalk.red('Login failed: ' + formatError(err)))
        process.exit(1)
      }
    })

  auth
    .command('status')
    .description('Show current auth status')
    .action(() => {
      const cfg = readConfig()
      if (cfg.apiKey) {
        console.log(chalk.green(`Logged in as ${cfg.email ?? 'unknown'}`))
        console.log(chalk.dim(`API: ${cfg.apiUrl}`))
      } else {
        console.log(chalk.yellow('Not logged in. Run: gctrl auth login'))
      }
    })

  auth
    .command('logout')
    .description('Clear saved credentials')
    .action(() => {
      writeConfig({ apiKey: undefined, email: undefined })
      console.log(chalk.green('Logged out.'))
    })
}
