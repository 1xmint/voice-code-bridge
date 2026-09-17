// End-to-end tests for the "deny now, approve later" project-gate flow:
// hooks/project-gate.mjs's checkGate talking to the real bridge HTTP server,
// approvals via answer_code_permission (voice) and hooks/approve-hook.mjs
// (typed "approve <id>"), and the resulting audit trail in decisions.jsonl.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHttpServer } from '../src/http.mjs'
import { TaskStore } from '../src/tasks.mjs'
import { DecisionLog } from '../src/decisions.mjs'
import { checkGate } from '../hooks/project-gate.mjs'
import { handleUserPromptSubmit, matchApprove } from '../hooks/approve-hook.mjs'

const SECRET = 'gate-approval-secret'

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fakeChannel() {
  return { notices: [], sendGateApprovedNotice(n) { this.notices.push(n) } }
}

async function withServer(t) {
  const tasks = new TaskStore({})
  const decisionsPath = path.join(tempDir('vcb-gate-dec-'), 'decisions.jsonl')
  const decisions = new DecisionLog({ jsonlPath: decisionsPath })
  const channel = fakeChannel()
  const server = createHttpServer({ secret: SECRET, tasks, channel, decisions })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => server.close())
  return { port, tasks, decisions, decisionsPath, channel }
}

async function callTool(port, name, args) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp/${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  return (await res.json()).result
}

function readDecisions(decisionsPath) {
  if (!fs.existsSync(decisionsPath)) return []
  return fs.readFileSync(decisionsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('deny + id on first try', async (t) => {
  const { port } = await withServer(t)
  const result = await checkGate({ secret: SECRET, port, command: 'flyctl deploy --app x', repo: '/repo', agent: 'main' })
  assert.equal(result.allow, false)
  assert.ok(result.id)
})

test('voice approve issues a pass: rerun allowed once, second rerun denied', async (t) => {
  const { port, decisions, decisionsPath } = await withServer(t)
  const command = 'flyctl deploy --app x'
  const first = await checkGate({ secret: SECRET, port, command, repo: '/repo', agent: 'main' })
  assert.equal(first.allow, false)

  const answered = await callTool(port, 'answer_code_permission', { request_id: first.id, decision: 'allow' })
  assert.equal(answered.isError, undefined)

  const second = await checkGate({ secret: SECRET, port, command, repo: '/repo', agent: 'main' })
  assert.equal(second.allow, true)

  const third = await checkGate({ secret: SECRET, port, command, repo: '/repo', agent: 'main' })
  assert.equal(third.allow, false)
  assert.ok(third.id) // re-registers a fresh gate for the next approval

  const logged = readDecisions(decisionsPath)
  assert.ok(logged.some((d) => d.category === 'gate_pass_issued'))
  assert.ok(logged.some((d) => d.category === 'gate_pass_used'))
})

test('a different command is denied even with an approved gate id still around', async (t) => {
  const { port } = await withServer(t)
  const approvedCommand = 'flyctl deploy --app x'
  const otherCommand = 'flyctl deploy --app y'
  const first = await checkGate({ secret: SECRET, port, command: approvedCommand, repo: '/repo', agent: 'main' })
  await callTool(port, 'answer_code_permission', { request_id: first.id, decision: 'allow' })

  const otherResult = await checkGate({ secret: SECRET, port, command: otherCommand, repo: '/repo', agent: 'main' })
  assert.equal(otherResult.allow, false)

  const rerun = await checkGate({ secret: SECRET, port, command: approvedCommand, repo: '/repo', agent: 'main' })
  assert.equal(rerun.allow, true)
})

test('typed "approve <id>" hook path issues a pass, same as voice', async (t) => {
  const { port } = await withServer(t)
  const home = tempDir('vcb-gate-home-')
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ secret: SECRET }))
  const savedHome = process.env.VCB_HOME
  const savedPort = process.env.VCB_PORT
  process.env.VCB_HOME = home
  process.env.VCB_PORT = String(port)
  try {
    const command = 'wrangler deploy'
    const first = await checkGate({ secret: SECRET, port, command, repo: '/repo', agent: 'main' })
    assert.ok(first.id)
    assert.equal(matchApprove(`approve ${first.id}`), first.id)
    assert.equal(matchApprove(`yes ${first.id}`), first.id)
    assert.equal(matchApprove('not an approval'), null)
    await handleUserPromptSubmit({ prompt: `approve ${first.id}` })
    const second = await checkGate({ secret: SECRET, port, command, repo: '/repo', agent: 'main' })
    assert.equal(second.allow, true)
  } finally {
    if (savedHome === undefined) delete process.env.VCB_HOME
    else process.env.VCB_HOME = savedHome
    if (savedPort === undefined) delete process.env.VCB_PORT
    else process.env.VCB_PORT = savedPort
  }
})

test('typed approve-hook path fails safe when the bridge is unreachable', async () => {
  const home = tempDir('vcb-gate-home-down-')
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ secret: SECRET }))
  const savedHome = process.env.VCB_HOME
  const savedPort = process.env.VCB_PORT
  process.env.VCB_HOME = home
  process.env.VCB_PORT = '1'
  try {
    // Must not throw, even though nothing is listening on port 1.
    await handleUserPromptSubmit({ prompt: 'approve deadbeef' })
  } finally {
    if (savedHome === undefined) delete process.env.VCB_HOME
    else process.env.VCB_HOME = savedHome
    if (savedPort === undefined) delete process.env.VCB_PORT
    else process.env.VCB_PORT = savedPort
  }
})

test('unknown or already-answered id gets a plain notice, not an error', async (t) => {
  const { port } = await withServer(t)
  const result = await callTool(port, 'answer_code_permission', { request_id: 'no-such-id', decision: 'allow' })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /Already answered or no longer pending/)
})

test('voice deny does not issue a pass', async (t) => {
  const { port } = await withServer(t)
  const command = 'flyctl deploy --app z'
  const first = await checkGate({ secret: SECRET, port, command, repo: '/repo', agent: 'main' })
  await callTool(port, 'answer_code_permission', { request_id: first.id, decision: 'deny' })
  const retry = await checkGate({ secret: SECRET, port, command, repo: '/repo', agent: 'main' })
  assert.equal(retry.allow, false)
})
