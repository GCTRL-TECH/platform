import { Command } from 'commander'
import chalk from 'chalk'
import { createClient, formatError } from '../api'
import { makeTable } from '../utils/table'

export function registerGraph(program: Command): void {
  const graph = program.command('graph').description('Manage knowledge graphs')

  graph
    .command('list')
    .description('List knowledge graph compilations')
    .option('-n, --limit <n>', 'Max results', '20')
    .action(async (opts: { limit: string }) => {
      try {
        const client = createClient()
        const { data } = await client.get(`/kg/compilations?limit=${opts.limit}`)
        const comps = (data as { compilations: Array<{ id: string; name: string; nodeCount: number; edgeCount: number }> }).compilations
        const rows = comps.map(c => [c.id.slice(0, 8), c.name, String(c.nodeCount), String(c.edgeCount)])
        console.log(makeTable(['ID', 'Name', 'Nodes', 'Edges'], rows))
      } catch (err) {
        console.error(chalk.red(formatError(err)))
        process.exit(1)
      }
    })

  graph
    .command('get <id>')
    .description('Get details of a knowledge graph')
    .action(async (id: string) => {
      try {
        const client = createClient()
        const { data } = await client.get(`/kg/compilations/${id}`)
        console.log(JSON.stringify(data, null, 2))
      } catch (err) {
        console.error(chalk.red(formatError(err)))
        process.exit(1)
      }
    })
}
