import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHttpServer, maxWaitSeconds } from '../src/http.mjs'
import { TaskStore } from '../src/tasks.mjs'
import { DecisionLog } from '../src/decisions.mjs'

function tempDecisionLog() {
  return new DecisionLog({ jsonlPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcb-http-decisions-')), 'decisions.jsonl') })
}

const SECRET = 'test-secret-value'

function fakeChannel() {
  return {
    ready: true,
    sent: [],
    sendTaskEvent(e) {
      this.sent.push(e)
    },
    sendCancelEvent() {},
    sendPermissionVerdict() {},
  }
}

function tempPath(name) {
  return path.join(os.tmpdir(), `vcb-http-test-${process.pid}-${Math.random().toString(36).slice(2)}-${name}`)
}

async function withServer(t, { channel = fakeChannel(), tasks = new TaskStore({}), decisions = new DecisionLog({}), eventsPath, relaysPath } = {}) {
  const server = createHttpServer({ secret: SECRET, tasks, channel, decisions, eventsPath, relaysPath: relaysPath || tempPath('relays.jsonl') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => server.close())
  return { port, tasks, channel, decisions }
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

test('404 without the secret', async (t) => {
  const { port } = await withServer(t)
  const res = await post(port, '/mcp/', { jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.equal(res.status, 404)
})

test('404 with the wrong secret', async (t) => {
  const { port } = await withServer(t)
  const res = await post(port, '/mcp/wrong-secret', { jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.equal(res.status, 404)
})

test('server/discover returns method not found', async (t) => {
  const { port } = await withServer(t)
  const res = await post(port, `/mcp/${SECRET}`, { jsonrpc: '2.0', id: 1, method: 'server/discover' })
  const json = await res.json()
  assert.equal(json.error.code, -32601)
})

test('initialize responds with server info', async (t) => {
  const { port } = await withServer(t)
  const res = await post(port, `/mcp/${SECRET}`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const json = await res.json()
  assert.equal(json.result.serverInfo.name, 'voice-code-bridge')
  assert.match(json.result.instructions, /DELEGATION.md/)
})

test('tools/list includes send_to_code', async (t) => {
  const { port } = await withServer(t)
  const res = await post(port, `/mcp/${SECRET}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const json = await res.json()
  const names = json.result.tools.map((t) => t.name)
  assert.ok(names.includes('send_to_code'))
  assert.ok(names.includes('get_code_status'))
  assert.ok(names.includes('get_code_result'))
  assert.ok(names.includes('answer_code_permission'))
  assert.ok(names.includes('cancel_code_task'))
})

test('send_to_code pushes a channel event and returns a task_id', async (t) => {
  const { port, channel } = await withServer(t)
  const res = await post(port, `/mcp/${SECRET}`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'send_to_code', arguments: { instruction: 'run the tests' } },
  })
  const json = await res.json()
  assert.match(json.result.content[0].text, /task_id/)
  assert.equal(channel.sent.length, 1)
  assert.equal(channel.sent[0].kind, 'new')
})

test('send_to_code returns an error when the stdio channel is not ready', async (t) => {
  const channel = fakeChannel()
  channel.ready = false
  const { port } = await withServer(t, { channel })
  const res = await post(port, `/mcp/${SECRET}`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'send_to_code', arguments: { instruction: 'run the tests' } },
  })
  const json = await res.json()
  assert.equal(json.result.isError, true)
})

async function call(port, name, args) {
  const res = await post(port, `/mcp/${SECRET}`, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })
  return (await res.json()).result.content[0].text
}

test('needs_input: result returns the question at once, other replies carry a banner', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'needs_input', summary: 'Approve Funnel in your browser?', now: 'enabling funnel' })
  const started = Date.now()
  const result = await call(port, 'get_code_result', { task_id, wait_seconds: 20 })
  assert.ok(Date.now() - started < 2000)
  assert.match(result, /Approve Funnel in your browser\?/)
  assert.match(result, /send_to_code/)
  const status = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(status.status, 'needs_input')
  assert.equal(status.now, 'enabling funnel')
  const other = tasks.createTask({ instruction: 'y' }).task_id
  assert.match(await call(port, 'get_code_result', { task_id: other, wait_seconds: 0 }), /^ATTENTION: .*Approve Funnel/)
})

test('permission request: status and result expose request_id and prompt text', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.setPermissionRequest(task_id, { request_id: 'abcde', tool_name: 'Bash', description: 'Turn on Tailscale Funnel', input_preview: 'tailscale funnel --bg 8790' })
  const status = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(status.request_id, 'abcde')
  assert.equal(status.approval_details, 'tailscale funnel --bg 8790')
  assert.match(await call(port, 'get_code_result', { task_id }), /Turn on Tailscale Funnel.*request_id abcde/)
})

test('follow-up to a working task stays working and is flagged until Code reports', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'Started.' })
  tasks.createTask({ instruction: 'also do y', task_id })
  let status = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(status.status, 'working')
  assert.match(status.followup_pending, /not acknowledged/)
  tasks.report({ task_id, status: 'working', summary: 'Got the follow-up.' })
  status = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(status.followup_pending, undefined)
  assert.equal(status.recent.length, 1)
  assert.ok(status.session)
  assert.ok(status.last_report)
})

test('follow-up to a finished task goes back to queued', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'done', summary: 'Done.' })
  tasks.createTask({ instruction: 'more', task_id })
  assert.equal(tasks.getTask(task_id).status, 'queued')
})

test('get_code_result: wait_seconds 0 answers at once', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  const started = Date.now()
  assert.match(await call(port, 'get_code_result', { task_id, wait_seconds: 0 }), /still working/)
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`)
})

test('get_code_result: held open until Code reports done', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'Working.' })
  setTimeout(() => tasks.report({ task_id, status: 'done', summary: 'All finished.' }), 300)
  const started = Date.now()
  assert.equal(await call(port, 'get_code_result', { task_id, wait_seconds: 10 }), 'All finished.')
  assert.ok(Date.now() - started < 3000)
})

test('get_code_result: held open until Code asks a question', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  setTimeout(() => tasks.report({ task_id, status: 'needs_input', summary: 'Merge it?' }), 300)
  assert.match(await call(port, 'get_code_result', { task_id, wait_seconds: 10 }), /Merge it\?.*send_to_code/)
})

test('get_code_result: never waits past the time budget', async (t) => {
  const prev = process.env.VCB_MAX_WAIT_SECONDS
  process.env.VCB_MAX_WAIT_SECONDS = '1'
  t.after(() => {
    if (prev === undefined) delete process.env.VCB_MAX_WAIT_SECONDS
    else process.env.VCB_MAX_WAIT_SECONDS = prev
  })
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'Working.' })
  const started = Date.now()
  assert.match(await call(port, 'get_code_result', { task_id, wait_seconds: 600 }), /^No change yet\. Working\./)
  const took = Date.now() - started
  assert.ok(took >= 900 && took < 3000, `took ${took}ms`)
})

test('named tasks: send by name, follow up by name, check by name', async (t) => {
  const { port, tasks, channel } = await withServer(t)
  await call(port, 'send_to_code', { instruction: 'look at realorrug', name: 'Realorrug' })
  assert.match(channel.sent[0].content, /name="Realorrug"/)
  const id = channel.sent[0].task_id
  await call(port, 'send_to_code', { instruction: 'and run its tests', name: 'realorrug' })
  assert.equal(channel.sent[1].task_id, id)
  assert.equal(channel.sent[1].kind, 'followup')
  tasks.report({ task_id: id, status: 'done', summary: 'Tests pass.', detail: 'ran 42 tests in 3 files' })
  const status = JSON.parse(await call(port, 'get_code_status', { name: 'realorrug' }))
  assert.equal(status.task_id, id)
  assert.equal(status.detail, 'ran 42 tests in 3 files')
  assert.equal(await call(port, 'get_code_result', { name: 'realorrug' }), 'Tests pass.')
  assert.match(await call(port, 'get_code_status', { name: 'nope' }), /No task named nope/)
})

test('stall detection names the reason once a task goes quiet', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'Working.' })
  assert.equal(JSON.parse(await call(port, 'get_code_status', { task_id })).stalled, undefined)
  tasks.getTask(task_id).last_report_at = new Date(Date.now() - 11 * 60_000).toISOString()
  tasks.getTask(task_id).last_activity_at = tasks.getTask(task_id).last_report_at
  assert.match(JSON.parse(await call(port, 'get_code_status', { task_id })).stalled, /no report from Code since 11 minutes ago/)
  {
    const s = JSON.parse(await call(port, 'get_code_status', { task_id }))
    assert.equal(s.status, 'stalled')
    assert.equal(s.raw_status, 'working')
  }
  tasks.createTask({ instruction: 'more', task_id })
  tasks.getTask(task_id).followup_pending_since = new Date(Date.now() - 12 * 60_000).toISOString()
  assert.match(JSON.parse(await call(port, 'get_code_status', { task_id })).stalled, /follow-up was sent 12 minutes ago/)
  tasks.report({ task_id, status: 'needs_input', summary: 'Which one?' })
  tasks.getTask(task_id).last_report_at = new Date(Date.now() - 60 * 60_000).toISOString()
  assert.equal(JSON.parse(await call(port, 'get_code_status', { task_id })).stalled, undefined)
})

test('default time budget stays well under the voice client limit', () => {
  const prev = process.env.VCB_MAX_WAIT_SECONDS
  delete process.env.VCB_MAX_WAIT_SECONDS
  try {
    assert.ok(maxWaitSeconds() <= 20)
  } finally {
    if (prev !== undefined) process.env.VCB_MAX_WAIT_SECONDS = prev
  }
})

test('tools/list includes log_decision, list_decisions, status_all', async (t) => {
  const { port } = await withServer(t)
  const res = await post(port, `/mcp/${SECRET}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const json = await res.json()
  const names = json.result.tools.map((tool) => tool.name)
  assert.ok(names.includes('log_decision'))
  assert.ok(names.includes('list_decisions'))
  assert.ok(names.includes('status_all'))
})

test('log_decision requires a decision and persists it against a task_id', async (t) => {
  const { port, decisions } = await withServer(t, { decisions: tempDecisionLog() })
  const missing = JSON.parse('{}')
  const err = await post(port, `/mcp/${SECRET}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_decision', arguments: missing } })
  assert.equal((await err.json()).result.isError, true)
  const reply = await call(port, 'log_decision', { task_id: 'abc', decision: 'used the existing helper', reason: 'no need to duplicate it', category: 'equivalent-approaches' })
  assert.match(reply, /used the existing helper/)
  const recent = decisions.listRecent({ task_id: 'abc' })
  assert.equal(recent.length, 1)
  assert.equal(recent[0].reason, 'no need to duplicate it')
})

test('log_decision resolves a task_id from name when only name is given', async (t) => {
  const { port, tasks, decisions } = await withServer(t, { decisions: tempDecisionLog() })
  const { task_id } = tasks.createTask({ instruction: 'x', name: 'realorrug' })
  await call(port, 'log_decision', { name: 'realorrug', decision: 'retried once' })
  assert.equal(decisions.lastForTask(task_id).decision, 'retried once')
})

test('list_decisions filters by task_id and returns newest first', async (t) => {
  const { port } = await withServer(t, { decisions: tempDecisionLog() })
  await call(port, 'log_decision', { task_id: 'a', decision: 'one' })
  await call(port, 'log_decision', { task_id: 'b', decision: 'two' })
  await call(port, 'log_decision', { task_id: 'a', decision: 'three' })
  const list = JSON.parse(await call(port, 'list_decisions', { task_id: 'a' }))
  assert.equal(list.length, 2)
  assert.equal(list[0].decision, 'three')
})

test('list_decisions says so when there are none yet', async (t) => {
  const { port } = await withServer(t)
  assert.match(await call(port, 'list_decisions', {}), /No decisions logged yet/)
})

test('status_all summarizes every task compactly, including stall and last decision', async (t) => {
  const { port, tasks } = await withServer(t, { decisions: tempDecisionLog() })
  const a = tasks.createTask({ instruction: 'x', name: 'alpha' }).task_id
  tasks.report({ task_id: a, status: 'working', summary: 'Working on alpha.' })
  await call(port, 'log_decision', { task_id: a, decision: 'skipped the extra check', reason: 'covered by an existing test' })
  const b = tasks.createTask({ instruction: 'y', name: 'beta' }).task_id
  tasks.report({ task_id: b, status: 'needs_input', summary: 'Which branch?' })

  const list = JSON.parse(await call(port, 'status_all', {}))
  assert.equal(list.length, 2)
  const alpha = list.find((t) => t.task_id === a)
  assert.equal(alpha.name, 'alpha')
  assert.equal(alpha.summary, 'Working on alpha.')
  assert.equal(alpha.stalled, undefined)
  assert.match(alpha.last_decision, /skipped the extra check.*covered by an existing test/)
  const beta = list.find((t) => t.task_id === b)
  assert.equal(beta.question, 'Which branch?')
})

test('status_all returns a plain message when there are no tasks', async (t) => {
  const { port } = await withServer(t)
  assert.match(await call(port, 'status_all', {}), /No tasks yet/)
})

test('tools/list includes agent_tree and list_relays', async (t) => {
  const { port } = await withServer(t)
  const res = await post(port, `/mcp/${SECRET}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const json = await res.json()
  const names = json.result.tools.map((tt) => tt.name)
  assert.ok(names.includes('agent_tree'))
  assert.ok(names.includes('list_relays'))
})

test('agent_tree with no events file says nothing recorded yet', async (t) => {
  const { port } = await withServer(t, { eventsPath: tempPath('no-such-events.jsonl') })
  const res = await post(port, `/mcp/${SECRET}`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'agent_tree', arguments: {} },
  })
  const json = await res.json()
  assert.match(json.result.content[0].text, /No agent activity recorded/)
})

test('agent_tree reflects a fixture events.jsonl', async (t) => {
  const eventsPath = tempPath('events.jsonl')
  fs.writeFileSync(
    eventsPath,
    [
      JSON.stringify({ at: new Date().toISOString(), event: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'general-purpose' }),
      JSON.stringify({ at: new Date().toISOString(), event: 'PreToolUse', session_id: 's1', agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    ].join('\n') + '\n'
  )
  const { port } = await withServer(t, { eventsPath })
  const res = await post(port, `/mcp/${SECRET}`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'agent_tree', arguments: {} },
  })
  const json = await res.json()
  const tree = JSON.parse(json.result.content[0].text)
  assert.equal(tree[0].subagents[0].agent_id, 'a1')
  assert.equal(tree[0].subagents[0].current_tool, 'Bash')
  fs.rmSync(eventsPath)
})

test('send_to_code logs a relay, visible via list_relays', async (t) => {
  const relaysPath = tempPath('relays.jsonl')
  const { port } = await withServer(t, { relaysPath })
  await post(port, `/mcp/${SECRET}`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'send_to_code', arguments: { instruction: 'run the tests' } },
  })
  const res = await post(port, `/mcp/${SECRET}`, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_relays', arguments: {} },
  })
  const json = await res.json()
  const relays = JSON.parse(json.result.content[0].text)
  assert.equal(relays.length, 1)
  assert.equal(relays[0].kind, 'instruction')
  assert.equal(relays[0].preview, 'run the tests')
  fs.rmSync(relaysPath)
})

test('list_relays with nothing recorded says so', async (t) => {
  const { port } = await withServer(t, { relaysPath: tempPath('empty-relays.jsonl') })
  const res = await post(port, `/mcp/${SECRET}`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_relays', arguments: {} },
  })
  const json = await res.json()
  assert.match(json.result.content[0].text, /No relays recorded/)
})

test('idle tier fires before stalled, and never overrides a waiting/terminal status', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'Working.' })
  tasks.getTask(task_id).last_report_at = new Date(Date.now() - 6 * 60_000).toISOString()
  tasks.getTask(task_id).last_activity_at = tasks.getTask(task_id).last_report_at
  const s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.status, 'idle')
  assert.equal(s.raw_status, 'working')
  assert.match(s.idle, /no activity from Code in 6 minutes ago/)
  assert.equal(s.stalled, undefined)

  const other = tasks.createTask({ instruction: 'y' }).task_id
  tasks.report({ task_id: other, status: 'needs_input', summary: 'Which file?' })
  tasks.getTask(other).last_report_at = new Date(Date.now() - 60 * 60_000).toISOString()
  const s2 = JSON.parse(await call(port, 'get_code_status', { task_id: other }))
  assert.equal(s2.status, 'needs_input')
  assert.equal(s2.idle, undefined)
})

test('recordActivity keeps a task off the idle/stalled tiers without a report', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'Working.' })
  tasks.getTask(task_id).last_report_at = new Date(Date.now() - 20 * 60_000).toISOString()
  // A hook-reported tool event (no report call) is fresh activity.
  tasks.recordActivity(task_id, { source: 'tool', detail: 'Bash: npm test' })
  const s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.status, 'working')
  assert.equal(s.stalled, undefined)
  assert.equal(s.idle, undefined)
})

test('queue visibility: only unacknowledged follow-ups are listed, with an unread count', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'first' })
  tasks.report({ task_id, status: 'working', summary: 'Started.' })
  tasks.createTask({ instruction: 'also do y', task_id })
  tasks.createTask({ instruction: 'and z', task_id })
  let s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.pending_followups.length, 2)
  assert.equal(s.pending_followups[0].text, 'also do y')
  assert.equal(s.pending_followups[0].acknowledged, false)
  assert.equal(s.unread_followups, 2)
  tasks.report({ task_id, status: 'working', summary: 'Got both.' })
  s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.unread_followups, undefined)
  assert.equal(s.pending_followups, undefined)
})

test('session_state is absent unless a hook has set it explicitly, never inferred', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  let s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.session_state, undefined)
  tasks.setSessionState(task_id, 'running_tool')
  s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.session_state, 'running_tool')
})

test('classifier_outage is distinct from a stall and from a real denial', async (t) => {
  const { port, tasks } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'classifier_outage', summary: "Claude's permission classifier is temporarily unavailable." })
  tasks.getTask(task_id).last_report_at = new Date(Date.now() - 60 * 60_000).toISOString()
  const s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.status, 'classifier_outage')
  assert.equal(s.stalled, undefined)
  assert.equal(s.idle, undefined)
  assert.match(await call(port, 'get_code_result', { task_id, wait_seconds: 0 }), /temporarily unavailable/)
})

test('project-gate holds and auto-mode fallback asks surface in status with full detail, answered by request_id', async (t) => {
  const { port, tasks, channel } = await withServer(t)
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'Working.' })
  const gate = tasks.registerGate({
    request_id: 'gate-1',
    kind: 'hold',
    tool_name: 'Bash',
    command: 'git push --force origin main',
    description: 'a force-push or history rewrite: git push --force origin main',
    repo: '/repo/path',
    agent: 'main',
    task_id,
  })
  assert.equal(gate.status, 'pending')
  const s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.pending_gates.length, 1)
  assert.equal(s.pending_gates[0].request_id, 'gate-1')
  assert.equal(s.pending_gates[0].repo, '/repo/path')
  assert.match(s.action, /force-push or history rewrite/)
  assert.match(await call(port, 'get_code_result', { task_id, wait_seconds: 0 }), /answer_code_permission with request_id gate-1/)

  const answered = await call(port, 'answer_code_permission', { request_id: 'gate-1', decision: 'deny' })
  assert.match(answered, /Sent deny/)
  assert.equal(tasks.getGate('gate-1').status, 'deny')
  const after = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(after.pending_gates, undefined)

  // Unknown/already-answered request_id gets a plain non-error notice,
  // never an error and never a silent allow.
  const res = await post(port, `/mcp/${SECRET}`, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'answer_code_permission', arguments: { request_id: 'gate-1', decision: 'allow' } },
  })
  const json = await res.json()
  assert.equal(json.result.isError, undefined)
  assert.match(json.result.content[0].text, /Already answered or no longer pending/)
})

test('gate endpoint 404s without the right secret', async (t) => {
  const { port } = await withServer(t)
  const res = await post(port, '/gate/wrong-secret', { action: 'check' })
  assert.equal(res.status, 404)
})

test('gate endpoint: register and poll are no longer served (removed, unused)', async (t) => {
  const { port } = await withServer(t)
  const reg = await post(port, `/gate/${SECRET}`, { action: 'register', kind: 'ask', tool_name: 'Bash', command: 'npm test', repo: '/repo', agent: 'sub-1' })
  assert.equal(reg.status, 400)
  assert.deepEqual(await reg.json(), { error: 'unknown action register' })
  const poll = await post(port, `/gate/${SECRET}`, { action: 'poll', request_id: 'whatever' })
  assert.equal(poll.status, 400)
  assert.deepEqual(await poll.json(), { error: 'unknown action poll' })
})

test('get_code_status includes running helpers from the agent tree', async (t) => {
  const eventsPath = tempPath('events.jsonl')
  const now = new Date().toISOString()
  const ev = (o) => JSON.stringify({ at: now, session_id: 's1', cwd: 'C:/x', ...o })
  fs.writeFileSync(eventsPath, [
    ev({ event: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    ev({ event: 'SubagentStart', agent_id: 'a1', agent_type: 'orch-debugger' }),
    ev({ event: 'PreToolUse', agent_id: 'a1', agent_type: 'orch-debugger', tool_name: 'Read', tool_input: { file_path: 'x.mjs' } }),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10))
  t.after(() => fs.rmSync(eventsPath, { force: true }))
  const { port, tasks } = await withServer(t, { eventsPath })
  const { task_id } = tasks.createTask({ instruction: 'x' })
  const s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.agents.length, 1)
  assert.equal(s.agents[0].helpers.length, 1)
  assert.equal(s.agents[0].helpers[0].who, 'orch-debugger')
  assert.match(s.agents[0].helpers[0].step, /^Read/)
})

test('get_code_status surfaces a waiting_on_terminal notice when the last event was a Notification', async (t) => {
  const eventsPath = tempPath('events.jsonl')
  const t0 = new Date()
  const at = (offsetSeconds) => new Date(t0.getTime() + offsetSeconds * 1000).toISOString()
  const ev = (o) => JSON.stringify({ session_id: 's1', cwd: 'C:/x', ...o })
  fs.writeFileSync(eventsPath, [
    ev({ at: at(0), event: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    ev({ at: at(1), event: 'PostToolUse', tool_name: 'Bash' }),
    ev({ at: at(2), event: 'Notification', notification_type: 'permission_prompt' }),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10))
  t.after(() => fs.rmSync(eventsPath, { force: true }))
  const { port, tasks } = await withServer(t, { eventsPath })
  const { task_id } = tasks.createTask({ instruction: 'x' })
  const s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.match(s.agents[0].waiting_on_terminal, /permission prompt/)
})

test('get_code_status has no waiting_on_terminal notice once a tool has run after the notification', async (t) => {
  const eventsPath = tempPath('events.jsonl')
  const t0 = new Date()
  const at = (offsetSeconds) => new Date(t0.getTime() + offsetSeconds * 1000).toISOString()
  const ev = (o) => JSON.stringify({ session_id: 's1', cwd: 'C:/x', ...o })
  fs.writeFileSync(eventsPath, [
    ev({ at: at(0), event: 'Notification', notification_type: 'permission_prompt' }),
    ev({ at: at(1), event: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    ev({ at: at(2), event: 'PostToolUse', tool_name: 'Bash' }),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10))
  t.after(() => fs.rmSync(eventsPath, { force: true }))
  const { port, tasks } = await withServer(t, { eventsPath })
  const { task_id } = tasks.createTask({ instruction: 'x' })
  const s = JSON.parse(await call(port, 'get_code_status', { task_id }))
  assert.equal(s.agents[0].waiting_on_terminal, undefined)
})
