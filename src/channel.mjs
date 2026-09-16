// Hand-rolled MCP-over-stdio channel server. No dependencies: newline
// delimited JSON-RPC on stdin/stdout. stdout carries protocol only; use
// log() (stderr) for anything else.
import readline from 'node:readline'

const SERVER_INFO = { name: 'voice-code-bridge', version: '0.1.0' }

const INSTRUCTIONS = [
  'Tasks arrive as <channel source="voice-code-bridge" task_id="..." kind="new|followup">',
  'from the user speaking to Claude in Claude voice mode (the phone app), relayed through',
  'this bridge. Treat the channel content as the instruction: do the work with your normal',
  'tools. Call the report tool with status "working" for notable progress, and with',
  '"done" or "failed" when finished. If you need the user to decide something before you',
  'can continue, call report with status "needs_input" and a short question in summary.',
  'Summaries are read aloud by voice mode: keep them short, plain spoken language, no code',
  'blocks, no file paths or diffs, no markdown.',
  'When a task or follow-up arrives, call report with "working" right away, even if the work',
  'must wait behind something else (say what it waits on), so voice never sees it as unacknowledged.',
  'Always pass the task_id from the channel tag the report is about, not the latest one.',
].join(' ')

function toolsList() {
  return [
    {
      name: 'report',
      description:
        'Report progress or a result back to the user in Claude voice mode for a task that arrived over the voice-code-bridge channel. Call with "working" for notable progress, "done" when finished successfully, "failed" if you could not complete it, or "needs_input" if you need the user to decide something. summary is read aloud: short, plain, no code.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task_id from the <channel> tag this report is for' },
          status: { type: 'string', enum: ['working', 'done', 'failed', 'needs_input'] },
          summary: { type: 'string', description: 'Short, speakable summary. No code blocks or file dumps. For needs_input, the exact question the user must answer.' },
          now: { type: 'string', description: 'Optional: what you are doing right now, one short spoken sentence.' },
          next: { type: 'string', description: 'Optional: what you will do next, one short spoken sentence.' },
        },
        required: ['task_id', 'status', 'summary'],
      },
    },
  ]
}

// Claude Code doesn't (yet) speak the newest protocol revision for channel
// servers. Version strings are YYYY-MM-DD, so plain string comparison works:
// echo the client's version when it's no newer than 2025-11-25, else offer
// the older revision we know Claude Code's channel host understands.
export function negotiateProtocolVersion(clientVersion) {
  if (typeof clientVersion === 'string' && clientVersion <= '2025-11-25') return clientVersion
  return '2025-06-18'
}

export class Channel {
  constructor({ tasks, input = process.stdin, output = process.stdout, log = () => {} } = {}) {
    this.tasks = tasks
    this.output = output
    this.log = log
    this.ready = false
    this._rl = readline.createInterface({ input, terminal: false })
    this._rl.on('line', (line) => this._onLine(line))
  }

  _write(obj) {
    this.output.write(JSON.stringify(obj) + '\n')
  }

  _onLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch (e) {
      this.log(`bad json from stdin: ${e.message}`)
      return
    }
    this._handle(msg).catch((e) => this.log(`stdio handler error: ${e.stack || e.message}`))
  }

  async _handle(msg) {
    const { id, method, params } = msg
    const isNotification = id === undefined

    if (method === 'notifications/claude/channel/permission_request') {
      const { request_id, tool_name, description, input_preview } = params || {}
      const taskId = this.tasks.getActiveTaskId()
      if (taskId) {
        this.tasks.setPermissionRequest(taskId, { request_id, tool_name, description, input_preview })
      } else {
        this.log(`permission_request ${request_id} with no active task to attach it to`)
      }
      return
    }
    if (method === 'notifications/initialized') {
      this.ready = true
      return
    }
    if (isNotification) return // unknown notification, ignore

    switch (method) {
      case 'initialize':
        this.ready = true
        this._write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
            capabilities: {
              experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
              tools: {},
            },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        })
        return
      case 'server/discover':
        this._write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
        return
      case 'ping':
        this._write({ jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        this._write({ jsonrpc: '2.0', id, result: { tools: toolsList() } })
        return
      case 'tools/call':
        return this._callTool(id, params)
      default:
        this._write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  }

  async _callTool(id, params) {
    try {
      if (params?.name === 'report') {
        const { task_id, status, summary, now, next } = params.arguments || {}
        this.tasks.report({ task_id, status, summary, now, next })
        this._write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } })
        return
      }
      throw new Error(`unknown tool: ${params?.name}`)
    } catch (e) {
      this._write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message) }], isError: true } })
    }
  }

  // Pushes a task (new or follow-up) into the Claude Code session.
  sendTaskEvent({ task_id, kind, content }) {
    this._write({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content, meta: { task_id, kind } },
    })
  }

  sendCancelEvent({ task_id }) {
    this._write({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content: `The user cancelled this task from voice mode. Stop working on it.`, meta: { task_id, kind: 'cancel' } },
    })
  }

  sendPermissionVerdict(request_id, behavior) {
    this._write({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    })
  }
}
