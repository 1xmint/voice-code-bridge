// In-memory task store, backed by an append-only JSONL log on disk.
// Tracks the state machine voice mode and Claude Code negotiate through the
// bridge: queued -> working -> (needs_approval) -> done|failed|cancelled.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const STATUSES = ['queued', 'working', 'needs_approval', 'needs_input', 'done', 'failed', 'cancelled']

function newTaskId() {
  return crypto.randomBytes(4).toString('hex')
}

export class TaskStore {
  constructor({ jsonlPath } = {}) {
    this.jsonlPath = jsonlPath
    this.tasks = new Map() // task_id -> task
    this.order = [] // task_ids in creation order
    this.idempotency = new Map() // request_id -> task_id
    this.events = new EventEmitter()
    this.events.setMaxListeners(0)
  }

  _append(record) {
    if (!this.jsonlPath) return
    try {
      fs.appendFileSync(this.jsonlPath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
    } catch {
      // best-effort logging only; never let disk trouble break the task flow
    }
  }

  // Creates a new task, or (for a follow-up) reuses task_id. Deduplicates on
  // request_id: a repeat request_id returns the original task_id untouched.
  createTask({ instruction, context, task_id, request_id } = {}) {
    if (request_id && this.idempotency.has(request_id)) {
      const existingId = this.idempotency.get(request_id)
      return { task_id: existingId, task: this.tasks.get(existingId), duplicate: true }
    }

    const kind = task_id && this.tasks.has(task_id) ? 'followup' : 'new'
    const id = kind === 'followup' ? task_id : newTaskId()
    const now = new Date().toISOString()

    let task = this.tasks.get(id)
    if (!task) {
      task = {
        task_id: id,
        status: 'queued',
        instruction,
        context: context || null,
        created_at: now,
        updated_at: now,
        reports: [],
        pendingPermission: null,
      }
      this.tasks.set(id, task)
      this.order.push(id)
    } else {
      task.instruction = instruction
      task.context = context || task.context
      // A follow-up to a task Code is still working on must not flip it back
      // to "queued": the session keeps working and voice would hear it as
      // stuck. Mark the follow-up unacknowledged instead; the next report
      // clears it. Finished or waiting tasks do go back to queued.
      if (!['working', 'needs_approval'].includes(task.status)) task.status = 'queued'
      task.followup_pending_since = now
      task.updated_at = now
    }

    if (request_id) this.idempotency.set(request_id, id)
    this._append({ event: 'task_created', task_id: id, kind, instruction, context })
    this.events.emit('update', id)
    return { task_id: id, task, duplicate: false, kind }
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null
  }

  getLatestTaskId() {
    return this.order.length ? this.order[this.order.length - 1] : null
  }

  // Most recent task still in flight, or the latest task overall if none.
  getActiveTaskId() {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const t = this.tasks.get(this.order[i])
      if (t && !['done', 'failed', 'cancelled'].includes(t.status)) return t.task_id
    }
    return this.getLatestTaskId()
  }

  listRecent(limit = 20) {
    return this.order
      .slice(-limit)
      .reverse()
      .map((id) => this.tasks.get(id))
  }

  // Called from the Code (stdio) side via the `report` tool.
  // needs_input stays distinct from needs_approval: a question for the user
  // has no request_id, so the voice side must answer it with send_to_code.
  report({ task_id, status, summary, now, next }) {
    if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`)
    const task = this.tasks.get(task_id)
    if (!task) throw new Error(`unknown task_id: ${task_id}`)
    task.status = status
    task.updated_at = new Date().toISOString()
    task.last_report_at = task.updated_at
    delete task.followup_pending_since
    const entry = { at: task.updated_at, status, summary }
    if (now) entry.now = now
    if (next) entry.next = next
    task.reports.push(entry)
    this._append({ event: 'report', ...entry, task_id })
    this.events.emit('update', task_id)
    return task
  }

  setPermissionRequest(taskId, request) {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.pendingPermission = request
    task.priorStatus = task.status
    task.status = 'needs_approval'
    task.updated_at = new Date().toISOString()
    this._append({ event: 'permission_request', task_id: taskId, request_id: request.request_id })
    this.events.emit('update', taskId)
  }

  clearPermissionRequest(taskId, behavior) {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.pendingPermission = null
    task.status = task.priorStatus || 'working'
    task.updated_at = new Date().toISOString()
    this._append({ event: 'permission_verdict', task_id: taskId, behavior })
    this.events.emit('update', taskId)
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.status = 'cancelled'
    task.updated_at = new Date().toISOString()
    this._append({ event: 'cancelled', task_id: taskId })
    this.events.emit('update', taskId)
    return task
  }

  // Resolves as soon as `task_id` (or, if omitted, any task) receives a new
  // report or reaches a terminal state, or after timeoutMs elapses.
  waitForUpdate(taskId, timeoutMs) {
    return new Promise((resolve) => {
      let done = false
      const finish = (taskIdUpdated) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.events.off('update', onUpdate)
        resolve(taskIdUpdated ? this.tasks.get(taskIdUpdated) : null)
      }
      const onUpdate = (updatedId) => {
        if (!taskId || updatedId === taskId) finish(updatedId)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      this.events.on('update', onUpdate)
    })
  }
}
