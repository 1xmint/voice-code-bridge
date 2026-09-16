// Public-facing HTTP MCP endpoint used by Claude voice mode. Stateless
// Streamable-HTTP JSON responses, same shape proven against real voice mode
// in docs/.proven-test-server.mjs. Only POST /mcp/<secret> is served.
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'

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

const WAITING = ['needs_approval', 'needs_input']
const TERMINAL = ['done', 'failed', 'cancelled']

function stallMinutes() {
  const n = Number(process.env.VCB_STALL_MINUTES)
  return process.env.VCB_STALL_MINUTES && Number.isFinite(n) && n > 0 ? n : 10
}

// A spoken note when an in-flight task has gone quiet for too long, or null.
// Tasks waiting on the user are not stalled: the user is the blocker.
function stallNote(task) {
  if (WAITING.includes(task.status) || TERMINAL.includes(task.status)) return null
  const since = task.followup_pending_since || task.last_report_at || task.created_at
  if (Date.now() - new Date(since).getTime() < stallMinutes() * 60_000) return null
  if (task.followup_pending_since) return `Possibly stalled: a follow-up was sent ${speakableAge(since)} and Code has not acknowledged it.`
  if (!task.last_report_at) return `Possibly stalled: Code has not acknowledged this task, sent ${speakableAge(since)}.`
  return `Possibly stalled: no report from Code since ${speakableAge(since)}.`
}

function resolveTaskId(tasks, args) {
  if (args?.task_id) return args.task_id
  if (args?.name) return tasks.findByName(args.name)?.task_id || null
  return undefined
}

function describeStatus(task) {
  if (!task) return null
  const base = { task_id: task.task_id, status: task.status, updated_at: task.updated_at, age: speakableAge(task.updated_at) }
  if (task.name) base.name = task.name
  base.session = path.basename(process.cwd())
  const stall = stallNote(task)
  if (stall) base.stalled = stall
  if (task.last_report_at) base.last_report = speakableAge(task.last_report_at)
  if (task.followup_pending_since) {
    base.followup_pending = `A follow-up was sent ${speakableAge(task.followup_pending_since)} and Code has not acknowledged it yet.`
  }
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
  const action = actionFor(task)
  if (action) base.action = action
  return base
}

// One spoken sentence saying exactly what the user must do, or null.
function actionFor(task) {
  if (task.status === 'needs_approval' && task.pendingPermission) {
    const p = task.pendingPermission
    return `Code needs permission to use ${p.tool_name}: ${p.description}. Ask the user yes or no, then call answer_code_permission with request_id ${p.request_id}.`
  }
  if (task.status === 'needs_input') {
    const q = latestReportText(task) || 'Code has a question.'
    return `Code is waiting on the user: ${q} Relay their answer with send_to_code using task_id ${task.task_id}.`
  }
  return null
}

// Prepended to every tool reply so a waiting task is heard whatever voice asks.
function attentionBanner(tasks, exceptTaskId) {
  const waiting = tasks.listRecent(20).filter((t) => t && t.task_id !== exceptTaskId && actionFor(t))
  if (!waiting.length) return ''
  return 'ATTENTION: ' + waiting.map(actionFor).join(' ') + '\n\n'
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
      description: 'Check the status of a task sent to Code (queued, working, needs_approval, needs_input, done, failed, or cancelled) without waiting. A task needing the user carries an \"action\" field saying exactly what to ask and which tool to answer with. Omit task_id to check the most recent task, or to list recent tasks.',
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
      description: 'Approve or deny a pending permission request from Code (shown as "needs approval" in status). Use when the user says yes/no, allow/deny, approve/reject to something Code wants to do.',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'The request_id from the pending approval' },
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
  ]
}

function text(t) {
  return { content: [{ type: 'text', text: t }] }
}

async function callTool(name, args, { tasks, channel }) {
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
      }
      return text(`Sent to Code. task_id ${id}.`)
    }
    case 'get_code_status': {
      const task_id = resolveTaskId(tasks, args)
      if (task_id !== undefined) {
        const status = task_id && describeStatus(tasks.getTask(task_id))
        if (!status) return { ...text(`No task ${args.task_id ? `with id ${args.task_id}` : `named ${args.name}`}.`), isError: true }
        return text(JSON.stringify(status))
      }
      const recent = tasks.listRecent(5).map(describeStatus)
      if (recent.length === 0) return text('No tasks sent to Code yet.')
      return text(JSON.stringify(recent))
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
          const stall = stallNote(task)
          const reply = last ? `No change yet. ${narrate(task)}` : `Code is still working: ${task.status}.`
          return text(stall ? `${reply} ${stall}` : reply)
        }
      }
      if (actionFor(task)) return text(actionFor(task))
      if (task.status === 'cancelled') return text('That task was cancelled.')
      return text(narrate(task))
    }
    case 'answer_code_permission': {
      const { request_id, decision } = args || {}
      if (!request_id || !['allow', 'deny'].includes(decision)) {
        return { ...text('I need a request_id and a decision of allow or deny.'), isError: true }
      }
      const owner = tasks.listRecent(50).find((t) => t.pendingPermission?.request_id === request_id)
      if (!owner) return { ...text('No pending approval with that id. It may have already been answered.'), isError: true }
      channel.sendPermissionVerdict(request_id, decision)
      tasks.clearPermissionRequest(owner.task_id, decision)
      return text(`Sent ${decision}.`)
    }
    case 'cancel_code_task': {
      const { task_id } = args || {}
      const task = tasks.cancel(task_id)
      if (!task) return { ...text(`No task with id ${task_id}.`), isError: true }
      channel?.sendCancelEvent({ task_id })
      return text(`Cancelled task ${task_id}.`)
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
        if (banner && params.name !== 'get_code_status' && result.content?.[0]?.type === 'text') {
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

export function createHttpServer({ secret, tasks, channel, log = () => {} }) {
  const prefix = '/mcp/'

  return http.createServer(async (req, res) => {
    const url = req.url || ''
    const provided = url.startsWith(prefix) ? url.slice(prefix.length) : ''
    if (req.method !== 'POST' || !url.startsWith(prefix) || !constantTimeEqual(provided, secret)) {
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

    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }

    const batch = Array.isArray(parsed)
    const messages = batch ? parsed : [parsed]
    let replies
    try {
      replies = (await Promise.all(messages.map((m) => handleRpc(m, { tasks, channel, log })))).filter(Boolean)
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
