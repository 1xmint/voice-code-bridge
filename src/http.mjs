// Public-facing HTTP MCP endpoint used by Claude voice mode. Stateless
// Streamable-HTTP JSON responses, same shape proven against real voice mode
// in docs/.proven-test-server.mjs. Only POST /mcp/<secret> is served, plus
// POST /gate/<secret> for the (not-yet-installed) project-gate and
// permission-bridge hooks to register and poll held/asked actions.
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { DecisionLog } from './decisions.mjs'
import { PassStore, hashCommand } from './passes.mjs'
import { buildAgentTree } from './events.mjs'
import { logRelay, listRelays } from './relays.mjs'

const MAX_BODY_BYTES = 1_000_000

// Voice mode gives up on a tool call after roughly 30 seconds: a 30 second
// wait_then_reply finished on the server and through the tunnel, yet the app
// reported "MCP tool call failed"; a 3 second one worked. Every long-poll must
// answer well inside that, leaving room for tunnel latency.
export function maxWaitSeconds() {
  const n = Number(process.env.VCB_MAX_WAIT_SECONDS)
  return process.env.VCB_MAX_WAIT_SECONDS && Number.isFinite(n) && n >= 0 ? n : 20
}
const SERVER_INFO = { name: 'voice-code-bridge', version: '0.1.0' }

// Sent back on initialize so the voice client knows its delegation boundary.
// Full policy in this repo's DELEGATION.md.
const DELEGATION_NOTE = "You are the user's delegate for this Claude Code session, steering toward their vision. Decide merges (including to main, once tests pass and the change matches the agreed plan) and routine technical choices on your own. Ask the user first before launching a token, spending funds or signing transactions, posting from the X account, deploying to a live server, or any change of project direction. Before approving new tooling or outside services, check what the user already has; ask if unsure. Log every decision you make for the user, with its reason, using log_decision. See DELEGATION.md."

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) {
    // still do a comparison of equal length to avoid a fast-fail timing tell
    crypto.timingSafeEqual(bufA, bufA)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

function speakableAge(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} seconds ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  return `${h} hour${h === 1 ? '' : 's'} ago`
}

// needs_approval/needs_input: waiting on the user, the user is the blocker.
// classifier_outage: Claude Code's own auto-mode classifier is temporarily
// unavailable; Code is paused for a known, reported reason, not silently.
// Neither is ever second-guessed by the idle/stalled timers below.
const WAITING = ['needs_approval', 'needs_input', 'classifier_outage']
const TERMINAL = ['done', 'failed', 'cancelled', 'stale']

// A task must never read as "working" on the strength of a stale claim
// alone. No activity for VCB_IDLE_MINUTES: report idle. Longer
// (VCB_STALL_MINUTES): report stalled, with the reason.
function idleMinutes() {
  const n = Number(process.env.VCB_IDLE_MINUTES)
  return process.env.VCB_IDLE_MINUTES && Number.isFinite(n) && n > 0 ? n : 5
}

function stallMinutes() {
  const n = Number(process.env.VCB_STALL_MINUTES)
  return process.env.VCB_STALL_MINUTES && Number.isFinite(n) && n > 0 ? n : 10
}

// Liveness for a task that claims to still be in flight. `since` is the
// most specific signal available: an unacknowledged follow-up, then the
// last recorded activity (a report today; a tool/output event from a hook,
// once wired up), then the task's creation time. Returns tier: null | 'idle'
// | 'stalled', and a spoken-friendly reason for the tier (or null).
function liveness(task) {
  if (WAITING.includes(task.status) || TERMINAL.includes(task.status)) return { tier: null, reason: null }
  const since = task.followup_pending_since || task.last_activity_at || task.last_report_at || task.created_at
  const ageMs = Date.now() - new Date(since).getTime()
  if (ageMs >= stallMinutes() * 60_000) {
    let reason
    if (task.followup_pending_since) reason = `Possibly stalled: a follow-up was sent ${speakableAge(since)} and Code has not acknowledged it.`
    else if (!task.last_report_at) reason = `Possibly stalled: Code has not acknowledged this task, sent ${speakableAge(since)}.`
    else reason = `Possibly stalled: no report from Code since ${speakableAge(since)}.`
    return { tier: 'stalled', reason }
  }
  if (ageMs >= idleMinutes() * 60_000) {
    const reason = task.followup_pending_since
      ? `Idle: a follow-up was sent ${speakableAge(since)} and Code has not acknowledged it yet.`
      : `Idle: no activity from Code in ${speakableAge(since)}.`
    return { tier: 'idle', reason }
  }
  return { tier: null, reason: null }
}

function resolveTaskId(tasks, args) {
  if (args?.task_id) return args.task_id
  if (args?.name) return tasks.findByName(args.name)?.task_id || null
  return undefined
}

// Every pending follow-up for a task: when it was sent, its text, and
// whether Code has acknowledged it (with a report) yet.
function followupQueue(task) {
  return (task.pendingFollowups || []).map((f) => ({ sent_at: f.sent_at, text: f.text, acknowledged: !!f.acknowledged }))
}

function pendingGatesFor(tasks, task) {
  return tasks
    .listPendingGates()
    .filter((g) => g.task_id === task.task_id)
    .map((g) => ({ request_id: g.request_id, kind: g.kind, tool_name: g.tool_name, command: g.command, repo: g.repo, agent: g.agent, description: g.description }))
}

// Compact agent tree for status: the session this bridge serves (its cwd
// matches) and every helper still running or blocked, so voice sees what Code
// is doing without a separate call. Full detail stays in agent_tree.
function agentsSummary(eventsPath) {
  if (!eventsPath) return null
  let tree
  try {
    tree = buildAgentTree({ eventsPath })
  } catch {
    return null
  }
  if (!tree?.length) return null
  const brief = (a) => ({
    who: a.agent_type === 'main' ? 'main session' : a.description || a.agent_type,
    state: a.state,
    step: a.current_tool ? `${a.current_tool}: ${a.current_tool_input || ''}`.slice(0, 120) : null,
    time_on_step_s: a.time_on_step_s,
    last_activity_s: a.last_activity_s,
    ...(a.blocked_reason ? { blocked: a.blocked_reason } : {}),
  })
  const recent = tree.filter((s) => s.main && s.main.last_activity_s < 3600)
  if (!recent.length) return null
  return recent.map((s) => ({
    main: brief(s.main),
    helpers: (s.subagents || []).filter((a) => a.state !== 'done').map(brief),
    // Non-blocking: Claude Code showed a prompt / is waiting for input and
    // nothing has run since. Doesn't affect main.state.
    ...(s.waiting_on_terminal ? { waiting_on_terminal: s.waiting_on_terminal } : {}),
  }))
}

function describeStatus(tasks, task) {
  if (!task) return null
  const live = liveness(task)
  const base = {
    task_id: task.task_id,
    status: live.tier && task.status === 'working' ? live.tier : task.status,
    ...(task.restart_note ? { restart_note: task.restart_note } : {}),
    updated_at: task.updated_at,
    age: speakableAge(task.updated_at),
  }
  if (base.status !== task.status) base.raw_status = task.status
  if (task.name) base.name = task.name
  base.session = path.basename(process.cwd())
  // Raw session state (idle / running_tool / awaiting_input) only if a hook
  // has ever set it explicitly. Never guessed from timers.
  if (task.session_state) base.session_state = task.session_state
  if (live.tier === 'stalled') base.stalled = live.reason
  if (live.tier === 'idle') base.idle = live.reason
  if (task.last_report_at) base.last_report = speakableAge(task.last_report_at)
  if (task.followup_pending_since) {
    base.followup_pending = `A follow-up was sent ${speakableAge(task.followup_pending_since)} and Code has not acknowledged it yet.`
  }
  // Only follow-ups Code has not acknowledged: the full history made status
  // too long to read aloud.
  const unread = followupQueue(task).filter((f) => !f.acknowledged)
  if (unread.length) {
    base.pending_followups = unread
    base.unread_followups = unread.length
  }
  const gates = pendingGatesFor(tasks, task)
  if (gates.length) base.pending_gates = gates
  if (task.reports.length > 1) {
    base.recent = task.reports.slice(-4, -1).map((r) => `${speakableAge(r.at)}: ${r.summary}`)
  }
  const last = task.reports[task.reports.length - 1]
  if (last) {
    base.latest = last.summary
    if (last.now) base.now = last.now
    if (last.next) base.next = last.next
    if (last.detail) base.detail = last.detail
  }
  if (task.status === 'needs_approval' && task.pendingPermission) {
    const p = task.pendingPermission
    base.request_id = p.request_id
    base.approval = `Claude wants to use ${p.tool_name}: ${p.description}`
    if (p.input_preview) base.approval_details = p.input_preview
  }
  const action = actionFor(tasks, task)
  if (action) base.action = action
  return base
}

// One spoken sentence saying exactly what the user must do, or null.
function actionFor(tasks, task) {
  if (task.status === 'needs_approval' && task.pendingPermission) {
    const p = task.pendingPermission
    return `Code needs permission to use ${p.tool_name}: ${p.description}. Ask the user yes or no, then call answer_code_permission with request_id ${p.request_id}.`
  }
  if (task.status === 'needs_input') {
    const q = latestReportText(task) || 'Code has a question.'
    return `Code is waiting on the user: ${q} Relay their answer with send_to_code using task_id ${task.task_id}.`
  }
  if (task.status === 'classifier_outage') {
    const q = latestReportText(task) || "Claude's permission classifier is temporarily unavailable."
    return `Code is paused, not stalled: ${q} No action needed yet; check back shortly.`
  }
  const gate = pendingGatesFor(tasks, task)[0]
  if (gate) {
    const what = gate.description || gate.command || `use ${gate.tool_name}`
    const label = gate.kind === 'hold' ? 'a gated action' : 'permission'
    return `Code is holding on ${label} in ${gate.repo || 'its repo'}: ${what}. Ask the user yes or no, then call answer_code_permission with request_id ${gate.request_id}.`
  }
  return null
}

// Prepended to every tool reply so a waiting task is heard whatever voice asks.
function attentionBanner(tasks, exceptTaskId) {
  const waiting = tasks.listRecent(20).filter((t) => t && t.task_id !== exceptTaskId && actionFor(tasks, t))
  if (!waiting.length) return ''
  return 'ATTENTION: ' + waiting.map((t) => actionFor(tasks, t)).join(' ') + '\n\n'
}

function narrate(task) {
  const last = task.reports[task.reports.length - 1]
  if (!last) return `Code is still working: ${task.status}.`
  const parts = [last.summary]
  if (last.now) parts.push(`Now: ${last.now}`)
  if (last.next) parts.push(`Next: ${last.next}`)
  return parts.join(' ')
}

function latestReportText(task) {
  if (!task) return null
  const last = task.reports[task.reports.length - 1]
  return last ? last.summary : null
}

// One line summarizing a logged decision, for embedding in a compact reply.
function decisionSummary(d) {
  if (!d) return null
  return d.reason ? `${d.decision} (${d.reason})` : d.decision
}

function lastDecisionFor(decisions, task) {
  if (!decisions) return null
  let d = task.task_id ? decisions.lastForTask(task.task_id) : null
  if (!d && task.name) d = decisions.listRecent({ name: task.name, limit: 1 })[0] || null
  return d
}

// Compact per-task snapshot for status_all: enough to speak in one sentence,
// not the full detail get_code_status gives for a single task.
function describeStatusAll(task, decisions) {
  const out = { task_id: task.task_id, status: task.status, session: path.basename(process.cwd()) }
  if (task.name) out.name = task.name
  if (task.restart_note) out.restart_note = task.restart_note
  const summary = latestReportText(task)
  if (summary) out.summary = summary
  if (task.last_report_at) out.last_report_age = speakableAge(task.last_report_at)
  const live = liveness(task)
  if (live.tier === "stalled") {
    out.stalled = true
    out.stalled_reason = live.reason
  } else if (live.tier === "idle") {
    out.idle = true
    out.idle_reason = live.reason
  }
  if (task.status === 'needs_input') {
    out.question = latestReportText(task) || 'Code has a question.'
  }
  const decision = lastDecisionFor(decisions, task)
  if (decision) out.last_decision = decisionSummary(decision)
  return out
}

function toolsList() {
  return [
    {
      name: 'send_to_code',
      description:
        'Send an instruction to the user\'s live Claude Code session running on their computer, and get back a task_id. Use this when the user asks to send something to Code, have Code do something, or continue a task Code is already working on (pass the existing task_id to follow up). The work happens in the background; use get_code_status or get_code_result afterward to check on it.',
      inputSchema: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'What Code should do, in plain language' },
          context: { type: 'string', description: 'Optional summary of the voice conversation so far, for context' },
          task_id: { type: 'string', description: 'Optional: an existing task_id to follow up on or modify, instead of starting a new task' },
          request_id: { type: 'string', description: 'Optional idempotency key; resending the same request_id returns the original task without resending it' },
          name: { type: 'string', description: 'Optional short spoken name for the task, like "realorrug". Sending again with a name already in use (and no task_id) follows up on that task.' },
        },
        required: ['instruction'],
      },
    },
    {
      name: 'get_code_status',
      description:
        'Check the status of a task sent to Code (queued, working, idle, stalled, needs_approval, needs_input, classifier_outage, done, failed, or cancelled) without waiting. "idle"/"stalled" mean Code has gone quiet despite claiming to work -- status is never reported as "working" on trust alone. A task needing the user carries an "action" field saying exactly what to ask and which tool to answer with. Also lists every pending follow-up, its acknowledgement, and the raw session state if known. Omit task_id to check the most recent task, or to list recent tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional: which task to check. Defaults to the most recent.' },
          name: { type: 'string', description: 'Optional: the task\'s spoken name, instead of task_id.' },
        },
      },
    },
    {
      name: 'get_code_result',
      description: 'Wait briefly for Code to finish or make progress on a task, then return its latest spoken report. Returns at once, with the exact question or approval to relay, if Code is waiting on the user. Use this when the user is waiting to hear back, e.g. "what did Code find" or "is it done yet".',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional: which task. Defaults to the most recent.' },
          name: { type: 'string', description: 'Optional: the task\'s spoken name, instead of task_id.' },
          wait_seconds: { type: 'number', description: 'How long to wait for a new update, up to 20 seconds. Default 15.' },
        },
      },
    },
    {
      name: 'answer_code_permission',
      description: 'Approve or deny a pending permission request from Code, or a held action from the project-gate/permission-bridge hooks (both shown as "needs approval" or in pending_gates). Use when the user says yes/no, allow/deny, approve/reject to something Code wants to do.',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'The request_id from the pending approval or held action' },
          decision: { type: 'string', enum: ['allow', 'deny'] },
        },
        required: ['request_id', 'decision'],
      },
    },
    {
      name: 'cancel_code_task',
      description: 'Tell Code to stop working on a task. Use when the user says to stop, cancel, or never mind about something Code is doing.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'The task to cancel' } },
        required: ['task_id'],
      },
    },
    {
      name: 'agent_tree',
      description:
        'See every agent Claude Code is running right now, in one call: for each session, the main agent and every sub-agent it spawned, each with its assigned goal, current tool or command, how long it has been on that step, when it last did anything, its state (running, blocked, waiting, or done), a short recent-action log, and what each parent is waiting on. Use this when the user asks what Code (or its sub-agents) is doing, whether something is stuck, or wants the whole picture instead of just "working".',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_relays',
      description:
        'List recent messages relayed between voice and Code: instructions sent, progress reports, permission requests and verdicts, cancels. Filterable by task_id. Use when the user asks what was sent or said, or wants a history of a task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional: only relays for this task' },
          limit: { type: 'number', description: 'Max relays to return, default 20' },
        },
      },
    },
    {
      name: 'timing_probe',
      description: 'Diagnostic only. Waits the given number of seconds, then replies with the word "lighthouse". Use ONLY when the user explicitly asks for the timing probe or timing test; never for real work.',
      inputSchema: {
        type: 'object',
        properties: { seconds: { type: 'number', description: 'How long to wait, 0 to 95' } },
        required: ['seconds'],
      },
    },
    {
      name: 'log_decision',
      description:
        'Record a decision made on the user\'s behalf while delegated (see DELEGATION.md) -- log every decision made for the user, with its reason. Attach it to a task with task_id or name when one applies.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional: the task this decision belongs to' },
          name: { type: 'string', description: 'Optional: the task\'s spoken name, instead of task_id' },
          decision: { type: 'string', description: 'What was decided, in plain language' },
          reason: { type: 'string', description: 'Optional: why' },
          category: { type: 'string', description: 'Optional short label, e.g. pre-approved, retry, equivalent-approaches' },
        },
        required: ['decision'],
      },
    },
    {
      name: 'list_decisions',
      description: 'Read back recently logged decisions, optionally filtered to one task by task_id or name. Use to answer "what did you decide" or "why did you do that".',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional: only decisions for this task' },
          name: { type: 'string', description: 'Optional: only decisions for the task with this spoken name' },
          limit: { type: 'number', description: 'Max number of decisions to return. Default 20.' },
        },
      },
    },
    {
      name: 'status_all',
      description:
        'One compact snapshot of every task Code is tracking: name/id, status, session, spoken summary, age of the last report, a stalled flag and reason when one applies, the pending question for a task waiting on the user, and the last logged decision. Use for "what\'s going on" across everything, not just one task.',
      inputSchema: { type: 'object', properties: {} },
    },
  ]
}

function text(t) {
  return { content: [{ type: 'text', text: t }] }
}

async function callTool(name, args, { tasks, channel, decisions, passes, eventsPath, relaysPath }) {
  switch (name) {
    case 'send_to_code': {
      if (!channel || !channel.ready) {
        return { ...text('Code is not connected right now. Open the terminal running Claude Code with the voice bridge channel enabled, then try again.'), isError: true }
      }
      const { instruction, context, task_id, request_id, name } = args || {}
      if (!instruction || !String(instruction).trim()) {
        return { ...text('I need an instruction to send to Code.'), isError: true }
      }
      const { task_id: id, kind, duplicate, task } = tasks.createTask({ instruction, context, task_id, request_id, name })
      if (!duplicate) {
        const nameAttr = task?.name ? ` name="${task.name.replace(/["<>]/g, '')}"` : ''
        const parts = [`<channel source="voice-code-bridge" task_id="${id}" kind="${kind}"${nameAttr}>`]
        if (context) parts.push(`Voice conversation context: ${context}`)
        parts.push(instruction)
        channel.sendTaskEvent({ task_id: id, kind, content: parts.join('\n') })
        logRelay(relaysPath, { from: 'voice', to: 'code', kind: 'instruction', content: instruction, task_id: id })
      }
      return text(`Sent to Code. task_id ${id}.`)
    }
    case 'get_code_status': {
      const task_id = resolveTaskId(tasks, args)
      if (task_id !== undefined) {
        const status = task_id && describeStatus(tasks, tasks.getTask(task_id))
        if (!status) return { ...text(`No task ${args.task_id ? `with id ${args.task_id}` : `named ${args.name}`}.`), isError: true }
        const agents = agentsSummary(eventsPath)
        if (agents) status.agents = agents
        return text(JSON.stringify(status))
      }
      const recent = tasks.listRecent(20).filter((t) => t.status !== 'stale').slice(0, 5).map((t) => describeStatus(tasks, t))
      if (recent.length === 0) return text('No tasks sent to Code yet.')
      const agents = agentsSummary(eventsPath)
      return text(JSON.stringify(agents ? { agents, tasks: recent } : recent))
    }
    case 'get_code_result': {
      const resolved = resolveTaskId(tasks, args)
      if (resolved === null) return { ...text(`No task named ${args.name}.`), isError: true }
      const id = resolved || tasks.getActiveTaskId()
      if (!id) return text('No tasks sent to Code yet.')
      let task = tasks.getTask(id)
      if (!task) return { ...text(`No task with id ${id}.`), isError: true }
      // `|| 15` used to turn an explicit 0 into a 15 second wait.
      const raw = args?.wait_seconds
      const requested = raw == null || raw === '' ? 15 : Number(raw)
      const waitSeconds = Math.min(Math.max(Number.isFinite(requested) ? requested : 15, 0), maxWaitSeconds())
      // Waiting on the user or finished: answer at once, never long-poll.
      if (!WAITING.includes(task.status) && !TERMINAL.includes(task.status) && waitSeconds > 0) {
        const before = task.reports.length
        const beforeStatus = task.status
        await tasks.waitForUpdate(id, waitSeconds * 1000)
        task = tasks.getTask(id) || task
        if (task.reports.length === before && task.status === beforeStatus) {
          const last = task.reports[task.reports.length - 1]
          const live = liveness(task)
          const reply = last ? `No change yet. ${narrate(task)}` : `Code is still working: ${task.status}.`
          return text(live.reason ? `${reply} ${live.reason}` : reply)
        }
      }
      if (actionFor(tasks, task)) return text(actionFor(tasks, task))
      if (task.status === 'cancelled') return text('That task was cancelled.')
      return text(narrate(task))
    }
    case 'answer_code_permission': {
      const { request_id, decision } = args || {}
      if (!request_id || !['allow', 'deny'].includes(decision)) {
        return { ...text('I need a request_id and a decision of allow or deny.'), isError: true }
      }
      const owner = tasks.listRecent(50).find((t) => t.pendingPermission?.request_id === request_id)
      if (owner) {
        channel.sendPermissionVerdict(request_id, decision)
        tasks.clearPermissionRequest(owner.task_id, decision)
        logRelay(relaysPath, { from: 'voice', to: 'code', kind: 'permission_verdict', content: decision, task_id: owner.task_id })
        return text(`Sent ${decision}.`)
      }
      const gate = tasks.getGate(request_id)
      if (gate && gate.status === 'pending') {
        tasks.answerGate(request_id, decision)
        logRelay(relaysPath, { from: 'voice', to: 'code', kind: 'gate_verdict', content: decision, task_id: gate.task_id })
        if (decision === 'allow') {
          const hash = hashCommand(gate.command, gate.repo)
          const pass = passes.issue({ hash, gate_id: gate.request_id, approver: 'voice' })
          decisions.log({ decision: 'gate pass issued', reason: `gate ${gate.request_id} hash ${hash} approver ${pass.approver}`, category: 'gate_pass_issued' })
          channel?.sendGateApprovedNotice?.({ id: gate.request_id, command: gate.command })
        }
        return text(`Sent ${decision}.`)
      }
      return text('Already answered or no longer pending.')
    }
    case 'cancel_code_task': {
      const { task_id } = args || {}
      const task = tasks.cancel(task_id)
      if (!task) return { ...text(`No task with id ${task_id}.`), isError: true }
      channel?.sendCancelEvent({ task_id })
      logRelay(relaysPath, { from: 'voice', to: 'code', kind: 'cancel', content: 'cancelled', task_id })
      return text(`Cancelled task ${task_id}.`)
    }
    case 'agent_tree': {
      const tree = buildAgentTree({ eventsPath })
      if (tree.length === 0) return text('No agent activity recorded yet. The agent-tree hook may not be configured; see README.')
      return text(JSON.stringify(tree))
    }
    case 'list_relays': {
      const relays = listRelays(relaysPath, { task_id: args?.task_id, limit: args?.limit })
      if (relays.length === 0) return text('No relays recorded yet.')
      return text(JSON.stringify(relays))
    }
    case 'timing_probe': {
      // Kept under Cloudflare's 100 s origin limit so a quick tunnel doesn't confound the result.
      const seconds = Math.min(Math.max(Number(args?.seconds) || 0, 0), 95)
      await new Promise((r) => setTimeout(r, seconds * 1000))
      return text(`Waited ${seconds} seconds. The word is lighthouse.`)
    }
    case 'log_decision': {
      const { task_id, name, decision, reason, category } = args || {}
      if (!decision || !String(decision).trim()) {
        return { ...text('I need a decision to log.'), isError: true }
      }
      const resolvedId = task_id || tasks.findByName(name)?.task_id || null
      const record = decisions.log({ task_id: resolvedId, name, decision, reason, category })
      return text(`Logged: ${record.decision}.`)
    }
    case 'list_decisions': {
      const { task_id, name, limit } = args || {}
      const list = decisions.listRecent({ task_id, name, limit: limit ? Number(limit) : undefined })
      if (!list.length) return text('No decisions logged yet.')
      return text(JSON.stringify(list))
    }
    case 'status_all': {
      const list = tasks.listAll().filter((t) => t.status !== 'stale').map((t) => describeStatusAll(t, decisions))
      if (!list.length) return text(`No tasks yet. Bridge started at ${tasks.startedAt}.`)
      return text(JSON.stringify(list))
    }
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

async function handleRpc(msg, ctx) {
  const { id, method, params } = msg
  if (id === undefined) return null // notification, no response
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  switch (method) {
    case 'server/discover':
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: DELEGATION_NOTE,
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: toolsList() })
    case 'tools/call': {
      try {
        const started = Date.now()
        const result = await callTool(params.name, params.arguments, ctx)
        ctx.log?.(`tools/call ${params.name} ${Date.now() - started}ms${result.isError ? ' isError' : ''}`)
        const banner = attentionBanner(ctx.tasks, params.arguments?.task_id)
        const skipsBanner = ['get_code_status', 'status_all', 'list_decisions', 'log_decision']
        if (banner && !skipsBanner.includes(params.name) && result.content?.[0]?.type === 'text') {
          result.content[0].text = banner + result.content[0].text
        }
        return ok(result)
      } catch (e) {
        return ok({ content: [{ type: 'text', text: String(e.message) }], isError: true })
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
}

// Reads the latest type:'user' entry's message text out of a Claude Code
// transcript JSONL file (~/.claude/projects/<proj>/<session>.jsonl or a
// subagent sidecar). Returns null on any read/parse failure or if there's no
// user entry -- callers must treat that as "no proof", never as a pass.
function latestUserMessageText(transcriptPath) {
  let content
  try {
    content = fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return null
  }
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a torn last line from a concurrent write
    }
    if (entry.type !== 'user') continue
    const content_ = entry.message?.content
    if (typeof content_ === 'string') return content_
    if (Array.isArray(content_)) {
      const text = content_
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
      return text || null
    }
    return null
  }
  return null
}

// Proof-of-user-prompt required for a gate 'approve': the id must actually
// appear in the prompt text, and that exact prompt must be the latest real
// user message in the named transcript -- not just claimed by whoever POSTed
// this request. Fails closed: any missing piece (no id/prompt/transcript, a
// transcript that doesn't parse, no user entry, a mismatched prompt) is
// rejected, never approved. This is what stops a bare
// `curl -d '{"action":"approve",...}'` from self-approving a held command:
// there's no real transcript with that exact prompt as its latest user turn.
export function verifyApprovalProof({ id, prompt, transcriptPath }) {
  if (!id || !prompt || !transcriptPath) return false
  if (!String(prompt).includes(id)) return false
  const latest = latestUserMessageText(transcriptPath)
  if (latest === null) return false
  return latest.trim() === String(prompt).trim()
}

// POST /gate/<secret> body: { action: 'check'|'approve', ... }. Used by
// hooks/project-gate.mjs (PreToolUse, action 'check') and
// hooks/approve-hook.mjs (UserPromptSubmit, action 'approve'), which run as
// short-lived child processes. Never exposed as an MCP tool: voice mode
// answers gates through the existing answer_code_permission tool by
// request_id, same as any other pending approval.
async function handleGateRequest(body, tasks, log, passes, decisions, channel) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { statusCode: 400, body: null }
  }
  const { action } = parsed || {}
  // action 'check': the deny-now-approve-later gate check from
  // hooks/project-gate.mjs's PreToolUse hook. Consumes a matching pass if
  // one exists (one use only); otherwise registers the command as a pending
  // gate for later approval and reports its id back to the hook.
  if (action === 'check') {
    const { command, repo, agent } = parsed
    const hash = hashCommand(command, repo)
    const pass = passes.consume(hash)
    if (pass) {
      decisions.log({ decision: 'gate pass used', reason: `gate ${pass.gate_id} hash ${hash} approver ${pass.approver}`, category: 'gate_pass_used' })
      log?.(`gate pass used hash=${hash.slice(0, 8)} gate=${pass.gate_id}`)
      return { statusCode: 200, body: { allow: true } }
    }
    const gate = tasks.registerGate({ command, repo, agent, kind: 'hold', description: parsed.description })
    log?.(`gate registered ${gate.request_id} repo=${gate.repo} agent=${gate.agent}`)
    return { statusCode: 200, body: { allow: false, id: gate.request_id } }
  }
  // action 'approve': a typed "approve <id>"/"yes <id>" reply, forwarded by
  // hooks/approve-hook.mjs (UserPromptSubmit). Same effect as answering
  // 'allow' through answer_code_permission, just from a typed prompt instead
  // of voice -- except this is the one path reachable by a bare HTTP POST
  // (curl, a script, ...), so it requires proof of a real user prompt: see
  // verifyApprovalProof. Without that, this would let the agent itself
  // self-approve any held command with a single curl call.
  if (action === 'approve') {
    const { id, approver, prompt, transcript_path } = parsed
    if (!verifyApprovalProof({ id, prompt, transcriptPath: transcript_path })) {
      log?.(`gate approve rejected for ${id}: no matching user prompt in transcript`)
      return { statusCode: 200, body: { ok: false } }
    }
    const gate = tasks.getGate(id)
    if (!gate || gate.status !== 'pending') return { statusCode: 200, body: { ok: false } }
    const hash = hashCommand(gate.command, gate.repo)
    const pass = passes.issue({ hash, gate_id: gate.request_id, approver: approver || 'user' })
    tasks.answerGate(gate.request_id, 'allow')
    decisions.log({ decision: 'gate pass issued', reason: `gate ${gate.request_id} hash ${hash} approver ${pass.approver}`, category: 'gate_pass_issued' })
    channel?.sendGateApprovedNotice?.({ id: gate.request_id, command: gate.command })
    return { statusCode: 200, body: { ok: true } }
  }
  return { statusCode: 400, body: { error: `unknown action ${action}` } }
}

export function createHttpServer({ secret, tasks, channel, decisions, passes, log = () => {}, eventsPath, relaysPath }) {
  const mcpPrefix = '/mcp/'
  const gatePrefix = '/gate/'
  // Callers that don't care about persistence (most tests) can omit
  // decisions entirely; log_decision/list_decisions/status_all still work,
  // just in memory for the life of this server.
  decisions = decisions || new DecisionLog({})
  // Same rationale as decisions above: most tests don't care about passes,
  // so a caller that omits one gets an in-memory-only store for the life of
  // this server.
  passes = passes || new PassStore()

  return http.createServer(async (req, res) => {
    const url = req.url || ''
    const isMcp = url.startsWith(mcpPrefix)
    const isGate = url.startsWith(gatePrefix)
    const providedSecret = isMcp ? url.slice(mcpPrefix.length) : isGate ? url.slice(gatePrefix.length) : ''
    if (req.method !== 'POST' || !(isMcp || isGate) || !constantTimeEqual(providedSecret, secret)) {
      res.writeHead(404).end()
      return
    }

    let body = ''
    let tooLarge = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true
        break
      }
    }
    if (tooLarge) {
      res.writeHead(413).end()
      return
    }

    if (isGate) {
      const { statusCode, body: replyBody } = await handleGateRequest(body, tasks, log, passes, decisions, channel)
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(replyBody === null ? '' : JSON.stringify(replyBody))
      return
    }

    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }

    const batch = Array.isArray(parsed)
    const messages = batch ? parsed : [parsed]

    // Record when a caller hangs up before we answer, so client time limits are measured, not guessed.
    const calls = messages.filter((m) => m?.method === 'tools/call').map((m) => m.params?.name).join(',')
    if (calls) {
      const started = Date.now()
      let answered = false
      res.on('finish', () => { answered = true })
      res.on('close', () => {
        const secs = ((Date.now() - started) / 1000).toFixed(1)
        log(answered ? `tools/call ${calls} delivered at ${secs}s` : `tools/call ${calls} CALLER HUNG UP after ${secs}s, before the answer`)
      })
    }

    let replies
    try {
      replies = (await Promise.all(messages.map((m) => handleRpc(m, { tasks, channel, decisions, passes, log, eventsPath, relaysPath })))).filter(Boolean)
    } catch (e) {
      log(`http rpc error: ${e.stack || e.message}`)
      res.writeHead(500).end()
      return
    }

    if (replies.length === 0) {
      res.writeHead(202).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(batch ? replies : replies[0]))
  })
}