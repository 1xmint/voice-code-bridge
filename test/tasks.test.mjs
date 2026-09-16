import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../src/tasks.mjs'

test('createTask assigns a task_id and defaults to queued', () => {
  const tasks = new TaskStore({})
  const { task_id, task, kind } = tasks.createTask({ instruction: 'do a thing' })
  assert.ok(task_id)
  assert.equal(kind, 'new')
  assert.equal(task.status, 'queued')
})

test('duplicate request_id returns the original task without creating a new one', () => {
  const tasks = new TaskStore({})
  const first = tasks.createTask({ instruction: 'a', request_id: 'req-1' })
  const second = tasks.createTask({ instruction: 'a different instruction', request_id: 'req-1' })
  assert.equal(second.task_id, first.task_id)
  assert.equal(second.duplicate, true)
  assert.equal(tasks.getTask(first.task_id).instruction, 'a')
})

test('follow-up with an existing task_id reuses it and marks kind followup', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'first' })
  const followup = tasks.createTask({ instruction: 'second', task_id })
  assert.equal(followup.task_id, task_id)
  assert.equal(followup.kind, 'followup')
  assert.equal(tasks.getTask(task_id).instruction, 'second')
})

test('report transitions status and records the summary', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'looking into it' })
  assert.equal(tasks.getTask(task_id).status, 'working')
  tasks.report({ task_id, status: 'done', summary: 'all fixed' })
  const task = tasks.getTask(task_id)
  assert.equal(task.status, 'done')
  assert.equal(task.reports.at(-1).summary, 'all fixed')
})

test('report with needs_input stays needs_input, keeps now/next', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'needs_input', summary: 'which file?', now: 'reading', next: 'editing' })
  assert.equal(tasks.getTask(task_id).status, 'needs_input')
  assert.equal(tasks.getTask(task_id).reports.at(-1).next, 'editing')
})

test('permission request/verdict round trip restores prior status', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'working', summary: 'on it' })
  tasks.setPermissionRequest(task_id, { request_id: 'abcde', tool_name: 'Bash', description: 'run tests' })
  assert.equal(tasks.getTask(task_id).status, 'needs_approval')
  tasks.clearPermissionRequest(task_id, 'allow')
  assert.equal(tasks.getTask(task_id).status, 'working')
  assert.equal(tasks.getTask(task_id).pendingPermission, null)
})

test('waitForUpdate resolves as soon as a report arrives', async () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  const waiter = tasks.waitForUpdate(task_id, 5000)
  setTimeout(() => tasks.report({ task_id, status: 'done', summary: 'finished' }), 20)
  const updated = await waiter
  assert.equal(updated.task_id, task_id)
  assert.equal(updated.status, 'done')
})

test('waitForUpdate times out and resolves null when nothing happens', async () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  const result = await tasks.waitForUpdate(task_id, 30)
  assert.equal(result, null)
})

test('getActiveTaskId prefers the most recent non-terminal task', () => {
  const tasks = new TaskStore({})
  const a = tasks.createTask({ instruction: 'a' })
  const b = tasks.createTask({ instruction: 'b' })
  tasks.report({ task_id: b.task_id, status: 'done', summary: 'done' })
  assert.equal(tasks.getActiveTaskId(), a.task_id)
})

test('recordActivity updates last_activity_at with a rolling activity log', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  const before = tasks.getTask(task_id).last_activity_at
  tasks.recordActivity(task_id, { source: 'tool', detail: 'Bash: ls' })
  const task = tasks.getTask(task_id)
  assert.ok(task.last_activity_at >= before)
  assert.equal(task.activity.at(-1).source, 'tool')
  assert.equal(task.activity.at(-1).detail, 'Bash: ls')
})

test('report() also records activity and acknowledges pending follow-ups', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'first' })
  tasks.report({ task_id, status: 'working', summary: 'on it' })
  tasks.createTask({ instruction: 'follow up 1', task_id })
  tasks.createTask({ instruction: 'follow up 2', task_id })
  let task = tasks.getTask(task_id)
  assert.equal(task.pendingFollowups.length, 2)
  assert.equal(task.pendingFollowups.every((f) => !f.acknowledged), true)
  tasks.report({ task_id, status: 'working', summary: 'got both' })
  task = tasks.getTask(task_id)
  assert.equal(task.pendingFollowups.every((f) => f.acknowledged), true)
  assert.equal(task.activity.at(-1).source, 'report')
})

test('setSessionState only accepts known states and defaults to null (unknown)', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  assert.equal(tasks.getTask(task_id).session_state, null)
  tasks.setSessionState(task_id, 'awaiting_input')
  assert.equal(tasks.getTask(task_id).session_state, 'awaiting_input')
  assert.throws(() => tasks.setSessionState(task_id, 'napping'))
})

test('registerGate/answerGate: independent of a task pendingPermission slot, supports several at once', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  const g1 = tasks.registerGate({ request_id: 'g1', kind: 'hold', tool_name: 'Bash', command: 'git push --force', repo: '/r', agent: 'main', task_id })
  const g2 = tasks.registerGate({ request_id: 'g2', kind: 'ask', tool_name: 'Bash', command: 'npm publish', repo: '/r', agent: 'sub-1', task_id })
  assert.equal(tasks.listPendingGates().length, 2)
  tasks.answerGate('g1', 'deny')
  assert.equal(tasks.listPendingGates().length, 1)
  assert.equal(tasks.getGate('g1').status, 'deny')
  assert.equal(tasks.getGate('g2').status, 'pending')
  assert.equal(tasks.answerGate('unknown-id', 'allow'), null)
})
