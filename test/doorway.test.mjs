import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { holdForDecision } from '../hooks/project-gate.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// A private copy of the code, so a test can break it without touching the repo.
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcb-door-code-'))
  for (const sub of ['bin', 'src']) fs.cpSync(path.join(REPO, sub), path.join(dir, sub), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'))
  return dir
}

// Starts a process the way Claude Code does, and reads its line raw.
async function launch(t, script) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vcb-door-home-'))
  const port = await freePort()
  const child = spawn(process.execPath, [script], { env: { ...process.env, VCB_HOME: home, VCB_PORT: String(port), VCB_ACTIVE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const raw = []
  const waiters = []
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    raw.push(line)
    for (const w of [...waiters]) w()
  })
  const next = async (pred, ms = 10_000) => {
    const deadline = Date.now() + ms
    let seen = 0
    for (;;) {
      for (; seen < raw.length; seen++) {
        const line = raw[seen]
        if (pred(JSON.parse(line))) { raw.splice(seen, 1); return { line, msg: JSON.parse(line) } }
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for a line')
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50) })
      waiters.length = 0
    }
  }
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
  let secret
  for (const deadline = Date.now() + 8000; ; await sleep(30)) {
    try { secret = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).secret; break } catch {}
    if (Date.now() > deadline) throw new Error('no config')
  }
  const rpc = async (msg) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/${secret}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
    return res.json()
  }
  const call = async (name, args) => (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result.content[0].text
  for (const deadline = Date.now() + 8000; ; await sleep(50)) {
    try { await rpc({ jsonrpc: '2.0', id: 0, method: 'ping' }); break } catch {}
    if (Date.now() > deadline) throw new Error('http never came up')
  }
  return { child, home, port, secret, next, send, rpc, call }
}

async function handshake(p) {
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const init = await p.next((m) => m.id === 1)
  p.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  p.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const list = await p.next((m) => m.id === 2)
  return { init, list }
}

const reloadCall = (p, id) => {
  p.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'reload_worker', arguments: {} } })
  return p.next((m) => m.id === id, 20_000).then(({ msg }) => JSON.parse(msg.result.content[0].text))
}

test('Code sees the same handshake and the same push bytes through the doorway as from the bridge today', async (t) => {
  const code = copyRepo()
  const direct = await launch(t, path.join(code, 'bin', 'voice-code-bridge.mjs'))
  const door = await launch(t, path.join(code, 'bin', 'doorway.mjs'))
  const a = await handshake(direct)
  const b = await handshake(door)
  assert.equal(b.init.line, a.init.line)
  assert.deepEqual(b.list.msg.result.tools.map((x) => x.name), [...a.list.msg.result.tools.map((x) => x.name), 'reload_worker'])

  const pushA = (await direct.call('send_to_code', { instruction: 'hello' })).match(/task_id (\w+)/)[1]
  const pushB = (await door.call('send_to_code', { instruction: 'hello' })).match(/task_id (\w+)/)[1]
  const lineA = (await direct.next((m) => m.method === 'notifications/claude/channel')).line
  const lineB = (await door.next((m) => m.method === 'notifications/claude/channel')).line
  assert.equal(lineB.replaceAll(pushB, 'ID'), lineA.replaceAll(pushA, 'ID'))
})

test('reload_worker swaps the worker without dropping Code, announces the tool change, and keeps an open permission prompt answerable', async (t) => {
  const door = await launch(t, path.join(copyRepo(), 'bin', 'doorway.mjs'))
  await handshake(door)
  const taskId = (await door.call('send_to_code', { instruction: 'do it' })).match(/task_id (\w+)/)[1]
  await door.next((m) => m.method === 'notifications/claude/channel')
  door.send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'perm1', tool_name: 'Bash', description: 'run tests', input_preview: 'npm test' } })
  await sleep(200)

  const r = await reloadCall(door, 50)
  assert.equal(r.ok, true)
  await door.next((m) => m.method === 'notifications/tools/list_changed')

  const status = JSON.parse(await door.call('get_code_status', { task_id: taskId }))
  assert.equal(status.request_id, 'perm1')
  await door.call('answer_code_permission', { request_id: 'perm1', decision: 'allow' })
  const verdict = await door.next((m) => m.method === 'notifications/claude/channel/permission')
  assert.equal(verdict.msg.params.behavior, 'allow')

  // Code's tools still work on the new worker.
  door.send({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'report', arguments: { task_id: taskId, status: 'done', summary: 'ok' } } })
  const rep = await door.next((m) => m.id === 51)
  assert.equal(rep.msg.result.content[0].text, 'ok')
})

test('broken new code rolls back to the last copy that worked', async (t) => {
  const code = copyRepo()
  const door = await launch(t, path.join(code, 'bin', 'doorway.mjs'))
  await handshake(door)
  fs.appendFileSync(path.join(code, 'src', 'http.mjs'), '\nthis is not javascript\n')
  const r = await reloadCall(door, 60)
  assert.equal(r.ok, false)
  assert.equal(r.rolled_back, true)
  assert.match(await door.call('send_to_code', { instruction: 'still there?' }), /task_id/)
})

test('with the doorway up and no worker, the gate hook falls back to ask, never allow', async (t) => {
  const code = copyRepo()
  const door = await launch(t, path.join(code, 'bin', 'doorway.mjs'))
  await handshake(door)
  const { pid } = await reloadCall(door, 70)
  // Make every restart fail, then kill the worker.
  fs.rmSync(path.join(door.home, 'workers'), { recursive: true, force: true })
  process.kill(pid)
  await sleep(300)
  const decision = await holdForDecision({ secret: door.secret, port: door.port, payload: { kind: 'bash', command: 'git push' }, timeoutMs: 2000, pollMs: 200 })
  assert.equal(decision, 'ask')
})
