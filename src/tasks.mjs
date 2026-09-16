// In-memory task store, backed by an append-only JSONL log on disk.
// Tracks the state machine voice mode and Claude Code negotiate through the
// bridge: queued -> working -> (needs_approval) -> done|failed|cancelled.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

// classifier_outage: Claude Code's auto-mode permission classifier is
// temporarily unavailable, so Code is paused waiting to retry. Kept distinct
// from a real deny (which just returns the task to its prior status) so it
// never reads as a silent stall in status.
const STATUSES = ['queued', 'working', 'needs_approval', 'needs_input', 'classifier_outage', 'done', 'failed', 'cancelled']

// Raw session state, set only from an explicit signal (a hook event, once
// wired up on feat/agent-tree) -- never inferred from timers or guesses.
const SESSION_STATES = ['idle', 'running_tool', 'awaiting_input']

function newTaskId() {
  return crypto.randomBytes(4).toString('hex')
}

export class TaskStore {
  constructor({ jsonlPath } = {}) {
    this.jsonlPath = jsonlPath
    this.tasks = new Map() // task_id -> task
    this.order = [] // task_ids in creation order
    this.idempotency = new Map() // request_id -> task_id
    // Held/asked actions from the project-gate and permission-bridge hooks,
    // keyed by request_id. Independent of tasks.pendingPermission (a single
    // slot per task) so more than one hold can be outstanding at once.
    this.gates = new Map()
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
  createTask({ instruction, context, task_id, request_id, name } = {}) {
    if (request_id && this.idempotency.has(request_id)) {
      const existingId = this.idempotency.get(request_id)
      return { task_id: existingId, task: this.tasks.get(existingId), duplicate: true }
    }
    // A known name with no task_id continues that task ("check realorrug").
    if (!task_id && name) task_id = this.findByName(name)?.task_id

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
        last_activity_at: now,
        session_state: null,
        reports: [],
        activity: [],
        pendingFollowups: [],
        pendingPermission: null,
      }
      if (name) task.name = String(name).trim()
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
      task.pendingFollowups = task.pendingFollowups || []
      task.pendingFollowups.push({ sent_at: now, text: instruction, acknowledged: false })
      task.updated_at = now
    }

    if (request_id) this.idempotency.set(request_id, id)
    this._append({ event: 'task_created', task_id: id, kind, name: task.name, instruction, context })
    this.events.emit('update', id)
    return { task_id: id, task, duplicate: false, kind }
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null
  }

  // Most recent task whose name matches, ignoring case and extra spaces.
  findByName(name) {
    const key = String(name || '').trim().toLowerCase()
    if (!key) return null
    for (let i = this.order.length - 1; i >= 0; i--) {
      const t = this.tasks.get(this.order[i])
      if (t?.name && t.name.toLowerCase() === key) return t
    }
    return null
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

  // Every task this process currently knows about, newest first. There is no
  // archiving yet -- tasks live for the process lifetime -- so this is the
  // full set.
  listAll() {
    return this.order.slice().reverse().map((id) => this.tasks.get(id))
  }

  // Records that *something* happened on a task: a report, or (once hooked
  // up on feat/agent-tree) a tool call or tool output event. This is the
  // seam liveness checks read from -- report() calls it today; a future
  // PreToolUse/PostToolUse hook can call it directly with source: 'tool'
  // without going through report() at all.
  recordActivity(taskId, { source = 'report', detail, at } = {}) {
    const task = this.tasks.get(taskId)
    if (!task) return
    const ts = at || new Date().toISOString()
    task.last_activity_at = ts
    task.activity = task.activity || []
    task.activity.push({ at: ts, source, detail })
    if (task.activity.length > 20) task.activity.shift()
    this._append({ event: 'activity', task_id: taskId, source, detail })
  }

  // Sets the raw session state from an explicit signal only (never a guess).
  // state must be one of SESSION_STATES, or null to go back to unknown.
  setSessionState(taskId, state) {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (state !== null && !SESSION_STATES.includes(state)) throw new Error(`invalid session_state: ${state}`)
    task.session_state = state
    task.updated_at = new Date().toISOString()
    this._append({ event: 'session_state', task_id: taskId, state })
    this.events.emit('update', taskId)
  }

  // Called from the Code (stdio) side via the `report` tool.
  // needs_input stays distinct from needs_approval: a question for the user
  // has no request_id, so the voice side must answer it with send_to_code.
  report({ task_id, status, summary, now, next, detail }) {
    if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`)
    const task = this.tasks.get(task_id)
    if (!task) throw new Error(`unknown task_id: ${task_id}`)
    task.status = status
    task.updated_at = new Date().toISOString()
    task.last_report_at = task.updated_at
    delete task.followup_pending_since
    for (const f of task.pendingFollowups || []) {
      if (!f.acknowledged) {
        f.acknowledged = true
        f.acknowledged_at = task.updated_at
      }
    }
    const entry = { at: task.updated_at, status, summary }
    if (now) entry.now = now
    if (next) entry.next = next
    if (detail) entry.detail = detail
    task.reports.push(entry)
    this._append({ event: 'report', ...entry, task_id })
    this.recordActivity(task_id, { source: 'report', detail: summary, at: task.updated_at })
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

  // Registers a held or ask-through action from a PreToolUse/PermissionRequest
  // hook: kind 'hold' for a project-gate block (deploys, spending/signing,
  // public posting, force-push/history-rewrite) that always waits for a human
  // answer; kind 'ask' for an auto-mode fallback prompt passed through so
  // voice can see and answer it. Independent of a single task's
  // pendingPermission slot so more than one can be outstanding at once.
  registerGate({ request_id, tool_name, description, input_preview, repo, agent, command, kind, task_id } = {}) {
    const id = request_id || newTaskId()
    const gate = {
      request_id: id,
      tool_name: tool_name || null,
      description: description || null,
      input_preview: input_preview || null,
      repo: repo || null,
      agent: agent || null,
      command: command || null,
      kind: kind === 'ask' ? 'ask' : 'hold',
      status: 'pending',
      task_id: task_id || this.getActiveTaskId() || null,
      created_at: new Date().toISOString(),
    }
    this.gates.set(id, gate)
    this._append({ event: 'gate_registered', request_id: id, tool_name: gate.tool_name, kind: gate.kind, repo: gate.repo, agent: gate.agent, command: gate.command })
    this.events.emit('update', gate.task_id)
    return gate
  }

  getGate(requestId) {
    return this.gates.get(requestId) || null
  }

  listPendingGates() {
    return [...this.gates.values()].filter((g) => g.status === 'pending')
  }

  // decision is 'allow' or 'deny'. Returns the updated gate, or null if
  // request_id is unknown (already answered, expired, or never registered).
  answerGate(requestId, decision) {
    const gate = this.gates.get(requestId)
    if (!gate) return null
    gate.status = decision
    gate.answered_at = new Date().toISOString()
    this._append({ event: 'gate_answered', request_id: requestId, decision })
    this.events.emit('update', gate.task_id)
    return gate
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