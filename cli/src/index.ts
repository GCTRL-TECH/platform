#!/usr/bin/env node
import { Command } from 'commander'
import { registerAuth } from './commands/auth'
import { registerKex } from './commands/kex'
import { registerGraph } from './commands/graph'
import { registerSource } from './commands/source'
import { registerAgent, runAgentRepl } from './commands/agent'
import { registerClassify } from './commands/classify'

const program = new Command()
  .name('gctrl')
  .description('GCTRL Ground Control — Knowledge Graph CLI')
  .version('0.1.0')

registerAuth(program)
registerKex(program)
registerGraph(program)
registerSource(program)
registerAgent(program)
registerClassify(program)

// Bare `gctrl` (no subcommand) launches the GCTRL agent (Pi) REPL.
program.action(async () => {
  await runAgentRepl()
})

program.parseAsync(process.argv)
