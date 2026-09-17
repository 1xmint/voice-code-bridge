// Builds a live agent tree from the raw hook-event log written by
// scripts/agent-tree-hook.mjs (running inside Claude Code, one process per
// session/subagent, appending to events.jsonl).
//
// Why hooks and not transcripts: SubagentStart/SubagentStop and
// PreToolUse/PostToolUse fire synchronously, in real time, and already carry
// `agent_id` + `agent_type` (Claude Code assigns these; we don't invent
// them). Session transcripts (~/.claude/projects/<proj>/<session>.jsonl and
// its subagents/agent-<id>.jsonl siblings) are the only place a subagent's
// human-readable `description` lives, but they are written by the CLI on its
// own schedule and provide no "this tool call started 40s ago" signal short
// of tailing and diffing. So: hooks are the source of truth for identity,
// current step and timing; a transcript sidecar file (agent-<id>.meta.json,
// written once at spawn) is read best-effort, purely to enrich the node with
// the description Claude Code gave that subagent.
import fs from 'node:fs'

const DEFAULT_MAX_LINES = 5000
const LOG_TAIL = 5
const BLOCKED_NOTIFICATIONS = new Set(['agent_needs_input', 'permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'])

// A short, spoken-friendly line for buildAgentTree's `waiting_on_terminal`:
// the gate hook no longer forwards a generic PermissionRequest passthrough
// (see hooks/project-gate.mjs), so this Notification-based notice is now the
// only signal that Claude Code is sitting at a prompt in the terminal.
const NOTIFICATION_MESSAGES = {
  agent_needs_input: 'Claude Code is waiting for your input.',
  permission_prompt: 'Claude Code is waiting on a permission prompt.',
  elicitation_dialog: 'Claude Code is waiting on a dialog.',
  elicitation_url_dialog: 'Claude Code is waiting on a dialog.',
}

function describeNotification(notificationType) {
  return NOTIFICATION_MESSAGES[notificationType] || `Claude Code is waiting at the terminal (${notificationType || 'a notification'}).`
}

function readTail(filePath, maxLines) {
  if (!filePath || !fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  const tail = maxLines ? lines.slice(-maxLines) : lines
  const out = []
  for (const line of tail) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // a torn last line from a concurrent write; skip it
    }
  }
  return out
}

// A short, speakable-ish preview of a tool call's argument, for the rolling
// log and `current_tool_input`. Never dumps a whole tool_input object.
export function shortToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null
  const preferred = ['command', 'file_path', 'path', 'description', 'pattern', 'prompt', 'query', 'url']
  for (const key of preferred) {
    if (typeof toolInput[key] === 'string' && toolInput[key]) return truncate(toolInput[key], 80)
  }
  return null
}

export function truncate(value, n) {
  if (value === null || value === undefined) return null
  const s = String(value)
  return s.length > n ? `${s.slice(0, n)}…` : s
}

// Derives the on-disk subagent meta.json path from a hook's transcript_path,
// when that path is the subagent's own transcript
// (.../<session>/subagents/agent-<id>.jsonl -> same dir, .meta.json). Returns
// null when the shape doesn't match (e.g. transcript_path is the parent
// session's own file) rather than guessing a path.
export function metaPathFor(event) {
  const tp = event.transcript_path
  if (!tp || !event.agent_id || typeof tp !== 'string') return null
  if (!tp.endsWith('.jsonl') || !tp.includes('subagents')) return null
  return `${tp.slice(0, -'.jsonl'.length)}.meta.json`
}

function readDescription(event, cache, readFile) {
  const metaPath = metaPathFor(event)
  if (!metaPath) return null
  if (cache.has(metaPath)) return cache.get(metaPath)
  let description = null
  try {
    const meta = JSON.parse(readFile(metaPath, 'utf8'))
    description = meta.description || null
  } catch {
    // not written yet, or unreadable: no description, not an error
  }
  cache.set(metaPath, description)
  return description
}

function describeEvent(event) {
  switch (event.event) {
    case 'SubagentStart':
      return `start ${event.agent_type || ''}`.trim()
    case 'SubagentStop':
      return 'stop'
    case 'PreToolUse':
      return `tool ${event.tool_name || '?'}${shortToolInput(event.tool_input) ? ` ${shortToolInput(event.tool_input)}` : ''}`
    case 'PostToolUse':
      return `done ${event.tool_name || '?'}`
    case 'PostToolUseFailure':
      return `failed ${event.tool_name || '?'}`
    case 'Notification':
      return `notify ${event.notification_type || ''}`.trim()
    case 'Stop':
      return 'stop'
    default:
      return event.event || 'event'
  }
}

function newNode(sessionId, agentId, event) {
  return {
    agent_id: agentId || null,
    agent_type: agentId ? event.agent_type || 'subagent' : 'main',
    session_id: sessionId,
    cwd: event.cwd || null,
    description: null,
    current_tool: null,
    current_tool_input: null,
    step_started_at: null,
    last_activity_at: null,
    state: 'running',
    blocked_reason: null,
    last_message: null,
    log: [],
  }
}

function applyEvent(node, event, descCache, readFile) {
  node.last_activity_at = event.at
  if (event.cwd) node.cwd = event.cwd
  const stamp = (event.at || '').slice(11, 19) || '?'
  node.log.push(`${stamp} ${describeEvent(event)}`)
  if (node.log.length > LOG_TAIL) node.log.shift()

  switch (event.event) {
    case 'SubagentStart':
      node.description = readDescription(event, descCache, readFile) || node.description
      node.state = 'running'
      break
    case 'PreToolUse':
      node.current_tool = event.tool_name || null
      node.current_tool_input = shortToolInput(event.tool_input)
      node.step_started_at = event.at
      node.state = 'running'
      break
    case 'PostToolUse':
    case 'PostToolUseFailure':
      node.current_tool = null
      node.current_tool_input = null
      node.step_started_at = null
      if (node.state !== 'done') node.state = 'running'
      break
    case 'Notification':
      if (BLOCKED_NOTIFICATIONS.has(event.notification_type)) {
        node.state = 'blocked'
        node.blocked_reason = event.notification_type
      }
      break
    case 'SubagentStop':
    case 'Stop':
      node.state = 'done'
      node.current_tool = null
      node.current_tool_input = null
      node.step_started_at = null
      node.last_message = truncate(event.last_assistant_message, 200)
      break
    default:
      break
  }
}

function summarize(node, now) {
  return {
    agent_id: node.agent_id,
    agent_type: node.agent_type,
    session_id: node.session_id,
    cwd: node.cwd,
    description: node.description,
    current_tool: node.current_tool,
    current_tool_input: node.current_tool_input,
    time_on_step_s: node.step_started_at ? Math.max(0, Math.round((now - Date.parse(node.step_started_at)) / 1000)) : null,
    last_activity_s: node.last_activity_at ? Math.max(0, Math.round((now - Date.parse(node.last_activity_at)) / 1000)) : null,
    state: node.state,
    blocked_reason: node.blocked_reason,
    last_message: node.last_message,
    log: node.log,
  }
}

// Reads events.jsonl (or `lines`, for tests) and returns one entry per
// session: `{ session_id, cwd, main, subagents, waiting_on }`, each agent
// summarized with current tool, time on that step, last activity, state and
// a short rolling log. Cheap: bounded read of the tail, one pass to build
// nodes, one pass to summarize.
export function buildAgentTree({ eventsPath, lines, now = Date.now(), maxLines = DEFAULT_MAX_LINES, readFile = fs.readFileSync } = {}) {
  const events = lines || readTail(eventsPath, maxLines)
  const sessions = new Map()
  const descCache = new Map()

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const sessionId = event.session_id || 'unknown'
    let session = sessions.get(sessionId)
    if (!session) {
      session = { session_id: sessionId, cwd: event.cwd || null, nodes: new Map(), order: [], lastEventType: null, lastEventAt: null, lastNotificationType: null, lastToolAt: null }
      sessions.set(sessionId, session)
    }
    if (event.cwd) session.cwd = event.cwd
    session.lastEventType = event.event
    session.lastEventAt = event.at
    if (event.event === 'Notification') session.lastNotificationType = event.notification_type
    if (event.event === 'PreToolUse' || event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') session.lastToolAt = event.at
    const key = event.agent_id || '__main__'
    let node = session.nodes.get(key)
    if (!node) {
      node = newNode(sessionId, event.agent_id, event)
      session.nodes.set(key, node)
      session.order.push(key)
    }
    applyEvent(node, event, descCache, readFile)
  }

  const tree = []
  for (const session of sessions.values()) {
    const nodes = session.order.map((k) => session.nodes.get(k))
    const main = nodes.find((n) => !n.agent_id) || null
    const subagents = nodes.filter((n) => n.agent_id)
    const waitingOn = subagents.filter((n) => n.state === 'running' || n.state === 'blocked').map((n) => n.agent_id)
    // Non-blocking notice: the latest event in this session was a
    // Notification (Claude Code showing a prompt / waiting for input) and
    // it's newer than the session's last PreToolUse/PostToolUse, i.e.
    // nothing has run since. Doesn't change `state` -- this is a hint, not
    // a status.
    const waitingOnTerminal =
      session.lastEventType === 'Notification' && (!session.lastToolAt || session.lastEventAt > session.lastToolAt)
        ? describeNotification(session.lastNotificationType)
        : null
    tree.push({
      session_id: session.session_id,
      cwd: session.cwd,
      main: main ? summarize(main, now) : null,
      subagents: subagents.map((n) => summarize(n, now)),
      waiting_on: waitingOn.length ? waitingOn : null,
      waiting_on_terminal: waitingOnTerminal,
    })
  }
  return tree
}
