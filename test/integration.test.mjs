import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(__dirname, '..', 'bin', 'voice-code-bridge.mjs')

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function makeLineReader(child) {
  const rl = readline.createInterface({ input: child.stdout, terminal: false })
  const waiters = []
  const buffered = []
  rl.on('line', (line) => {
    const msg = JSON.parse(line)
    if (waiters.length) waiters.shift()(msg)
    else buffered.push(msg)
  })
  return {
    // Resolves with the next line matching predicate (searching buffered first).
    next(predicate, timeoutMs = 8000) {
      const idx = buffered.findIndex(predicate)
      if (idx !== -1) {
        const [msg] = buffered.splice(idx, 1)
        return Promise.resolve(msg)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for stdout line')), timeoutMs)
        const check = (msg) => {
          if (predicate(msg)) {
            clearTimeout(timer)
            resolve(msg)
          } else {
            waiters.push(check)
          }
        }
        waiters.push(check)
      })
    },
  }
}

async function postRpc(port, secret, msg) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  })
  return res.json()
}

test('full loop: stdio channel + http voice endpoint', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vcb-home-'))
  const port = await freePort()

  const child = spawn(process.execPath, [BIN], {
    env: { ...process.env, VCB_HOME: home, VCB_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))
  t.after(() => child.kill())

  const lines = makeLineReader(child)
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')

  // Wait for the config file (written before the http server starts listening).
  const configPath = path.join(home, 'config.json')
  const configDeadline = Date.now() + 8000
  while (!fs.existsSync(configPath)) {
    if (Date.now() > configDeadline) throw new Error('config.json never appeared')
    await new Promise((r) => setTimeout(r, 20))
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

  // Wait for the http endpoint to come up before hitting it.
  await new Promise((resolve, reject) => {
    const started = Date.now()
    const tryConnect = () => {
      const sock = net.createConnection(port, '127.0.0.1')
      sock.on('connect', () => {
        sock.end()
        resolve()
      })
      sock.on('error', () => {
        if (Date.now() - started > 8000) reject(new Error('http server never came up'))
        else setTimeout(tryConnect, 50)
      })
    }
    tryConnect()
  })

  // Act as Claude Code: initialize the stdio channel.
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const initReply = await lines.next((m) => m.id === 1)
  assert.equal(initReply.result.serverInfo.name, 'voice-code-bridge')
  assert.deepEqual(initReply.result.capabilities.experimental['claude/channel'], {})
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  // Voice mode sends an instruction over HTTP.
  const sendResult = await postRpc(port, config.secret, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'send_to_code', arguments: { instruction: 'fix the failing test' } },
  })
  const taskIdMatch = sendResult.result.content[0].text.match(/task_id (\S+)\.?$/)
  assert.ok(taskIdMatch, `expected a task_id in ${sendResult.result.content[0].text}`)
  const taskId = taskIdMatch[1].replace(/\.$/, '')

  // The channel notification should appear on the child's stdout with task_id meta.
  const channelEvent = await lines.next((m) => m.method === 'notifications/claude/channel' && m.params?.meta?.task_id === taskId)
  assert.equal(channelEvent.params.meta.kind, 'new')

  // "Claude Code" reports progress and completion via the report tool.
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'report', arguments: { task_id: taskId, status: 'done', summary: 'Fixed it, tests pass now.' } },
  })
  await lines.next((m) => m.id === 3)

  const resultResult = await postRpc(port, config.secret, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'get_code_result', arguments: { task_id: taskId, wait_seconds: 1 } },
  })
  assert.equal(resultResult.result.content[0].text, 'Fixed it, tests pass now.')

  // Permission relay: Claude Code notifies of a pending prompt.
  send({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'abcde', tool_name: 'Bash', description: 'run npm test', input_preview: 'npm test' },
  })

  await new Promise((resolve) => setTimeout(resolve, 100))
  const statusResult = await postRpc(port, config.secret, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_code_status', arguments: { task_id: taskId } },
  })
  const status = JSON.parse(statusResult.result.content[0].text)
  assert.equal(status.status, 'needs_approval')
  assert.equal(status.request_id, 'abcde')

  const answerResult = await postRpc(port, config.secret, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'answer_code_permission', arguments: { request_id: 'abcde', decision: 'allow' } },
  })
  assert.match(answerResult.result.content[0].text, /allow/)

  const verdict = await lines.next((m) => m.method === 'notifications/claude/channel/permission')
  assert.equal(verdict.params.request_id, 'abcde')
  assert.equal(verdict.params.behavior, 'allow')
})
