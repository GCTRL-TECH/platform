import { Command } from 'commander'
import chalk from 'chalk'
import { createClient, formatError } from '../api'
import { makeTable } from '../utils/table'

export function registerClassify(program: Command): void {
  const classify = program.command('classify').description('Manage data classification levels')

  classify
    .command('levels')
    .description('List all classification levels')
    .action(async () => {
      try {
        const client = createClient()
        const { data } = await client.get('/classification/levels')
        const levels = (data as { levels: Array<{ name: string; display_name: string; rank: number; is_system: boolean }> }).levels
        const rows = levels.map(l => [l.name, l.display_name, String(l.rank), l.is_system ? 'system' : 'custom'])
        console.log(makeTable(['Name', 'Display Name', 'Rank', 'Type'], rows))
      } catch (err) {
        console.error(chalk.red(formatError(err)))
        process.exit(1)
      }
    })
}
