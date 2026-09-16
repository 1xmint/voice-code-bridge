#!/usr/bin/env node
// Entry point: one process that is both a Claude Code channel (stdio) and
// the public-facing HTTP MCP endpoint for Claude voice mode.
import fs from 'node:fs'
import { loadConfig, getPaths, getPort } from '../src/config.mjs'
import { TaskStore } from '../src/tasks.mjs'
import { DecisionLog } from '../src/decisions.mjs'
import { Channel } from '../src/channel.mjs'
import { createHttpServer } from '../src/http.mjs'

function makeLogger(logPath) {
  return (line) => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // ignore logging failures
    }
  }
}

async function main() {
  const [, , subcommand] = process.argv
  const paths = getPaths()
  const config = loadConfig(paths.home)

  if (subcommand === 'print-url') {
    const port = getPort()
    console.log(`http://localhost:${port}/mcp/${config.secret}`)
    console.log(`(secret stored at ${config.configPath})`)
    return
  }

  const log = makeLogger(paths.logPath)
  const tasks = new TaskStore({ jsonlPath: paths.tasksJsonlPath })
  const restored = tasks.load()
  log(`bridge started; restored ${restored} task(s) from disk`)
  const decisions = new DecisionLog({ jsonlPath: paths.decisionsJsonlPath })
  const channel = new Channel({ tasks, log, relaysPath: paths.relaysJsonlPath })
  const server = createHttpServer({ secret: config.secret, tasks, channel, decisions, log, eventsPath: paths.eventsJsonlPath, relaysPath: paths.relaysJsonlPath })
  const port = getPort()

  // The bridge is registered for every Claude Code session, but only the
  // session launched by scripts/start.ps1 (VCB_ACTIVE=1) should own the
  // public endpoint. Other sessions stay a quiet stdio server.
  if (process.env.VCB_ACTIVE !== '1') {
    log('VCB_ACTIVE is not 1: HTTP endpoint not started in this session')
  } else {
    server.on('error', (e) => {
      log(`http endpoint failed to start on port ${port}: ${e.code || e.message}`)
      process.stderr.write(`voice-code-bridge: port ${port} unavailable (${e.code || e.message}); is another bridge session running?\n`)
    })
    server.listen(port, '127.0.0.1', () => {
      log(`http mcp endpoint listening on 127.0.0.1:${port}`)
    })
  }

  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

main().catch((e) => {
  process.stderr.write(`voice-code-bridge fatal: ${e.stack || e.message}\n`)
  process.exit(1)
})
