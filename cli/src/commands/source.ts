import { Command } from 'commander'
import chalk from 'chalk'
import { createClient, formatError } from '../api'
import { makeTable } from '../utils/table'

export function registerSource(program: Command): void {
  const source = program.command('source').description('Manage data sources / connectors')

  source
    .command('list')
    .description('List connected sources')
    .action(async () => {
      try {
        const client = createClient()
        const { data } = await client.get('/connectors')
        const connectors = (data as { connectors: Array<{ id: string; provider: string; providerEmail?: string; is_active: boolean }> }).connectors
        const rows = connectors.map(c => [c.id.slice(0, 8), c.provider, c.providerEmail ?? '-', c.is_active ? 'active' : 'inactive'])
        console.log(makeTable(['ID', 'Provider', 'Email', 'Status'], rows))
      } catch (err) {
        console.error(chalk.red(formatError(err)))
        process.exit(1)
      }
    })
}
