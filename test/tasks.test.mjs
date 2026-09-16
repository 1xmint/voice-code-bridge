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

test('report with needs_input maps to needs_approval status', () => {
  const tasks = new TaskStore({})
  const { task_id } = tasks.createTask({ instruction: 'x' })
  tasks.report({ task_id, status: 'needs_input', summary: 'which file?' })
  assert.equal(tasks.getTask(task_id).status, 'needs_approval')
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
