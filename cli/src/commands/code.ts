import { Command } from 'commander'
import chalk from 'chalk'
import path from 'path'
import { indexRepo } from '@gctrl/code-indexer'
import { createClient, formatError } from '../api'
import { createSpinner } from '../utils/spinner'

type Method = 'GET' | 'POST' | 'DELETE'

export function registerCode(program: Command): void {
  const code = program.command('code').description('Codebase KBs - index a repository into a CODE knowledge base')

  code
    .command('index <path>')
    .description('Index (or incrementally re-index) a local repository')
    .option('-k, --kb <compilationId>', 'Target CODE compilation (omit to create one)')
    .option('--full', 'Re-upload every file')
    .option('-c, --classification <levelId>', 'Classification level UUID')
    .action(async (repoPath: string, opts: { kb?: string; full?: boolean; classification?: string }) => {
      const client = createClient()
      const spinner = createSpinner('Indexing...')
      spinner.start()
      try {
        const request = async (method: Method, p: string, body?: unknown) => {
          const { data } = await client.request({ method, url: p, data: body, timeout: 120000 })
          return data
        }
        const s = await indexRepo({
          repoPath: path.resolve(repoPath), compilationId: opts.kb, full: opts.full, classificationLevelId: opts.classification,
          request, onProgress: (m) => { spinner.text = m },
        })
        spinner.succeed(`${s.repo}: ${s.filesChanged}/${s.filesTotal} files uploaded, ${s.symbols} symbols, ${s.edges} edges, ${s.chunks} chunks -> KB ${chalk.cyan(s.compilationId)}`)
        if (s.warnings.length) console.log(chalk.yellow('Warnings: ' + s.warnings.join('; ')))
      } catch (err) {
        spinner.fail(formatError(err))
        process.exit(1)
      }
    })

  code
    .command('status <compilationId>')
    .description('Show what the server knows about a Codebase KB (manifest summary)')
    .action(async (cid: string) => {
      const client = createClient()
      try {
        const { data } = await client.get(`/kex/code/manifest?compilationId=${encodeURIComponent(cid)}`)
        const m = data as { repo?: string; commit?: string | null; files?: Record<string, string> }
        const n = Object.keys(m.files ?? {}).length
        console.log(`${chalk.bold(m.repo ?? '?')} @ ${m.commit ?? 'no commit'} - ${n} indexed files`)
      } catch (err) {
        console.error(chalk.red(formatError(err)))
        process.exit(1)
      }
    })
}
