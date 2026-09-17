#!/usr/bin/env node
// The doorway: the small, rarely changing process Claude Code launches. It
// holds Code's stdio line and the public port, and runs the real bridge (the
// worker) as a child it can restart. Code never sees a restart, so worker
// changes load through the reload_worker tool instead of /mcp.
//
// Why a copy of the code per start: rollback. If new code fails to come up,
// the previous copy still exists and is started again. Reloading straight from
// the checkout would leave nothing to fall back to.
import { fork } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { getPaths, getPort } from '../src/config.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const paths = getPaths()
const BOOT_MS = Number(process.env.VCB_BOOT_MS) || 10_000
const WAIT_MS = 5_000 // how long an HTTP call waits for a restarting worker before 503
const log = (s) => { try { fs.appendFileSync(paths.logPath, `${new Date().toISOString()} [doorway] ${s}\n`) } catch {} }
const toCode = (text) => process.stdout.write(text)

const RELOAD_TOOL = {
  name: 'reload_worker',
  description: 'Restart the voice-code-bridge worker on the current code in the repo, without dropping the connection. Rolls back to the previous code if the new code fails to start.',
  inputSchema: { type: 'object', properties: {} },
}

let worker = null // { child, port, dir }
let lastGoodDir = null
let initLine = null // Code's initialize request, replayed to each new worker
let reloading = false
let stopping = false
const queue = [] // lines from Code waiting for a worker
const inflight = new Map() // request id -> raw line, replayed if the worker dies
const listIds = new Set() // tools/list ids whose reply gets reload_worker added
const readyWaiters = []

function snapshot() {
  const dir = path.join(paths.home, 'workers', String(Date.now()))
  for (const sub of ['bin', 'src']) fs.cpSync(path.join(REPO, sub), path.join(dir, sub), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), fs.readFileSync(path.join(REPO, 'package.json')))
  return dir
}

function prune() {
  const root = path.join(paths.home, 'workers')
  const keep = new Set([worker?.dir, lastGoodDir].filter(Boolean).map((d) => path.basename(d)))
  for (const name of fs.readdirSync(root)) if (!keep.has(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true })
}

function startWorker(dir, { keepPending }) {
  return new Promise((resolve, reject) => {
    // Never detached, output kept off Code's line, IPC for everything.
    const child = fork(path.join(dir, 'bin', 'voice-code-bridge.mjs'), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: { ...process.env, VCB_WORKER: '1', VCB_KEEP_PENDING: keepPending ? '1' : '' },
    })
    child.stdout.on('data', (d) => log(`worker stdout: ${String(d).trim()}`))
    child.stderr.on('data', (d) => log(`worker stderr: ${String(d).trim()}`))
    const timer = setTimeout(() => { child.kill(); reject(new Error(`worker not ready within ${BOOT_MS}ms`)) }, BOOT_MS)
    child.on('message', function onReady(m) {
      if (m?.t !== 'ready') return
      clearTimeout(timer)
      child.off('message', onReady)
      resolve({ child, port: m.port, dir })
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`worker exited while starting (code ${code})`)) })
  })
}

function attach(w, { announce }) {
  worker = w
  w.child.on('message', (m) => {
    if (m?.t !== 'out') return
    let msg = null
    try { msg = JSON.parse(m.text) } catch {}
    if (msg && msg.id !== undefined) {
      if (String(msg.id).startsWith('doorway-')) return // reply to a replayed initialize
      inflight.delete(msg.id)
      if (listIds.delete(msg.id) && msg.result?.tools) {
        msg.result.tools.push(RELOAD_TOOL)
        return toCode(JSON.stringify(msg) + '\n')
      }
    }
    toCode(m.text) // unchanged bytes
  })
  w.child.once('exit', (code) => {
    if (worker !== w) return
    worker = null
    log(`worker exited (code ${code}); ${inflight.size} request(s) will be resent`)
    for (const line of inflight.values()) queue.unshift(line)
    inflight.clear()
    if (!reloading && !stopping) retry(w.dir)
  })
  if (announce && initLine) {
    const init = JSON.parse(initLine)
    w.child.send({ t: 'in', text: JSON.stringify({ ...init, id: `doorway-${Date.now()}` }) + '\n' })
    w.child.send({ t: 'in', text: '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' })
  }
  if (announce) toCode('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n')
  while (worker === w && queue.length) send(queue.shift())
  while (readyWaiters.length) readyWaiters.shift()()
}

function send(line) {
  if (!worker) return queue.push(line)
  let msg = null
  try { msg = JSON.parse(line) } catch {}
  if (msg?.id !== undefined) inflight.set(msg.id, line)
  worker.child.send({ t: 'in', text: line + '\n' })
}

// Starts code from dir, falling back to the last copy that worked.
async function restart(dir) {
  try {
    attach(await startWorker(dir, { keepPending: true }), { announce: true })
    lastGoodDir = dir
    return { ok: true }
  } catch (e) {
    if (!lastGoodDir || lastGoodDir === dir) throw e
    log(`new worker failed (${e.message}); rolling back`)
    attach(await startWorker(lastGoodDir, { keepPending: true }), { announce: true })
    return { ok: false, rolled_back: true, error: e.message }
  }
}

function retry(dir) {
  restart(dir).catch((e) => {
    log(`restart failed: ${e.message}; trying again in 2s`)
    if (!stopping && !worker) setTimeout(() => retry(lastGoodDir || dir), 2000)
  })
}

async function reload() {
  if (reloading) return { ok: false, error: 'a reload is already running' }
  reloading = true
  const started = Date.now()
  try {
    const dir = snapshot()
    const old = worker
    worker = null
    if (old) {
      const gone = new Promise((r) => old.child.once('exit', r))
      old.child.kill()
      await gone
      for (const line of inflight.values()) queue.unshift(line)
      inflight.clear()
    }
    const result = await restart(dir)
    try { prune() } catch {}
    return { ...result, pid: worker?.child.pid, gap_ms: Date.now() - started }
  } catch (e) {
    return { ok: false, error: e.message, gap_ms: Date.now() - started }
  } finally {
    reloading = false
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg = null
  try { msg = JSON.parse(line) } catch {}
  if (msg?.method === 'initialize') initLine = line
  if (msg?.method === 'tools/list') listIds.add(msg.id)
  if (msg?.method === 'tools/call' && msg.params?.name === 'reload_worker') {
    const r = await reload()
    log(`reload_worker: ${JSON.stringify(r)}`)
    return toCode(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(r) }], isError: !r.ok } }) + '\n')
  }
  send(line)
})

function shutdown(why) {
  stopping = true
  log(`exiting: ${why}`)
  try { worker?.child.kill() } catch {}
  process.exit(0)
}
rl.on('close', () => shutdown('Code closed the line'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// The port stays open for the doorway's whole life and forwards to the
// worker's private port. With no worker, callers get 503, and the gate hook
// treats that as "ask", never "allow".
if (process.env.VCB_ACTIVE === '1') {
  const port = getPort()
  const server = http.createServer(async (req, res) => {
    if (!worker) await new Promise((r) => { readyWaiters.push(r); setTimeout(r, WAIT_MS) })
    if (!worker) return res.writeHead(503).end()
    const up = http.request({ host: '127.0.0.1', port: worker.port, path: req.url, method: req.method, headers: req.headers }, (wr) => {
      res.writeHead(wr.statusCode, wr.headers)
      wr.pipe(res)
    })
    up.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end() })
    req.pipe(up)
  })
  // An old bridge from before a reconnect can keep the port for a while; keep trying.
  server.on('error', (e) => {
    log(`port ${port} unavailable: ${e.code || e.message}; retrying in 2s`)
    setTimeout(() => server.listen(port, '127.0.0.1'), 2000)
  })
  server.listen(port, '127.0.0.1', () => log(`holding 127.0.0.1:${port}`))
}

const first = snapshot()
startWorker(first, { keepPending: false }).then(
  (w) => { lastGoodDir = first; attach(w, { announce: false }); try { prune() } catch {} ; log('first worker ready') },
  (e) => { log(`first worker failed: ${e.message}`); process.exit(1) },
)
