#!/usr/bin/env node
// Entry point: one process that is both a Claude Code channel (stdio) and
// the public-facing HTTP MCP endpoint for Claude voice mode.
import fs from 'node:fs'
import { loadConfig, getPaths, getPort } from '../src/config.mjs'
import { TaskStore } from '../src/tasks.mjs'
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
  const channel = new Channel({ tasks, log })
  const server = createHttpServer({ secret: config.secret, tasks, channel, log })
  const port = getPort()

  server.listen(port, '127.0.0.1', () => {
    log(`http mcp endpoint listening on 127.0.0.1:${port}`)
  })

  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

main().catch((e) => {
  process.stderr.write(`voice-code-bridge fatal: ${e.stack || e.message}\n`)
  process.exit(1)
})
