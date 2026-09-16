import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpServer, maxWaitSeconds } from '../src/http.mjs'
import { TaskStore } from '../src/tasks.mjs'

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

async function withServer(t, { channel = fakeChannel(), tasks = new TaskStore({}) } = {}) {
  const server = createHttpServer({ secret: SECRET, tasks, channel })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => server.close())
  return { port, tasks, channel }
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
  assert.match(JSON.parse(await call(port, 'get_code_status', { task_id })).stalled, /no report from Code since 11 minutes ago/)
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
