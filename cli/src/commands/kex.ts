import { Command } from 'commander'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import FormData from 'form-data'
import { createClient, formatError } from '../api'
import { createSpinner } from '../utils/spinner'
import { makeTable } from '../utils/table'

interface KexResult {
  entities?: number
  relations?: number
  nodes?: number
  edges?: number
}

export function registerKex(program: Command): void {
  const kex = program.command('kex').description('Knowledge Extraction (KEX)')

  kex
    .command('extract')
    .description('Extract knowledge from a file, URL, or text')
    .option('-f, --file <path>', 'Path to file (PDF, DOCX, TXT, etc.)')
    .option('-u, --url <url>', 'URL to extract from')
    .option('-t, --text <text>', 'Text to extract from')
    .option('-c, --classification <level>', 'Classification level (PUBLIC|INTERNAL|CONFIDENTIAL|STRICTLY_CONFIDENTIAL)')
    .option('-o, --ontology <id>', 'Ontology ID to use')
    .option('-w, --wait', 'Wait for job to complete')
    .action(async (opts: { file?: string; url?: string; text?: string; classification?: string; ontology?: string; wait?: boolean }) => {
      const client = createClient()
      const spinner = createSpinner('Submitting extraction job...')
      spinner.start()
      try {
        let jobId: string
        if (opts.file) {
          const filePath = path.resolve(opts.file)
          const fd = new FormData()
          fd.append('file', fs.createReadStream(filePath), path.basename(filePath))
          if (opts.ontology) fd.append('ontologyId', opts.ontology)
          if (opts.classification) fd.append('classificationLevelId', opts.classification)
          const { data } = await client.post('/kex/upload', fd, { headers: fd.getHeaders() })
          jobId = (data as { jobId: string }).jobId
        } else if (opts.url ?? opts.text) {
          const { data } = await client.post('/kex/extract', {
            text: opts.url ?? opts.text,
            ontologyId: opts.ontology,
            classificationLevelId: opts.classification,
          })
          jobId = (data as { jobId: string }).jobId
        } else {
          spinner.fail('Provide --file, --url, or --text')
          process.exit(1)
          return
        }
        spinner.succeed(`Job submitted: ${chalk.cyan(jobId)}`)

        if (opts.wait) {
          const waitSpinner = createSpinner('Waiting for completion...')
          waitSpinner.start()
          for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 3000))
            const { data } = await client.get(`/kex/jobs/${jobId}/result`)
            const result = data as { status: string; result?: KexResult }
            if (result.status === 'done' || result.status === 'completed') {
              const r = result.result ?? {}
              waitSpinner.succeed(`Done — ${r.entities ?? r.nodes ?? '?'} entities, ${r.relations ?? r.edges ?? '?'} relations`)
              return
            }
            if (result.status === 'failed') {
              waitSpinner.fail('Job failed')
              process.exit(1)
            }
          }
          waitSpinner.warn('Timeout — job still running. Check status with: gctrl kex jobs')
        }
      } catch (err) {
        spinner.fail(formatError(err))
        process.exit(1)
      }
    })

  kex
    .command('jobs')
    .description('List recent KEX jobs')
    .option('-n, --limit <n>', 'Max results', '10')
    .action(async (opts: { limit: string }) => {
      try {
        const client = createClient()
        const { data } = await client.get(`/kex/jobs?limit=${opts.limit}`)
        const jobs = (data as { jobs: Array<{ id: string; type: string; status: string; createdAt: string }> }).jobs
        const rows = jobs.map(j => [j.id.slice(0, 8), j.type, j.status, new Date(j.createdAt).toLocaleString()])
        console.log(makeTable(['ID', 'Type', 'Status', 'Created'], rows))
      } catch (err) {
        console.error(chalk.red(formatError(err)))
        process.exit(1)
      }
    })
}
