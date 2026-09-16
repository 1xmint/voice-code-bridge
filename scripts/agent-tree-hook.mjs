#!/usr/bin/env node
// Claude Code hook script: registered for SubagentStart, SubagentStop,
// PreToolUse, PostToolUse, Stop and Notification (see README's "Agent tree"
// section for the settings.json snippet). Claude Code runs this once per
// event, in its own process, with the event as JSON on stdin. It appends one
// line to ~/.voice-code-bridge/events.jsonl and exits — nothing here should
// ever slow down or block a Claude Code turn, so every failure is swallowed
// and the process always exits 0.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Only fields voice-code-bridge's agent tree actually uses. Anything else
// Claude Code sends on stdin (permission_mode, effort, prompt_id, ...) is
// dropped rather than grown into this log unbounded.
const FIELDS = [
  'session_id',
  'agent_id',
  'agent_type',
  'cwd',
  'tool_name',
  'tool_input',
  'tool_use_id',
  'transcript_path',
  'last_assistant_message',
  'notification_type',
]

function home() {
  return process.env.VCB_HOME || path.join(os.homedir(), '.voice-code-bridge')
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export function toRecord(input) {
  const record = { at: new Date().toISOString(), event: input.hook_event_name }
  for (const field of FIELDS) {
    if (input[field] !== undefined) record[field] = input[field]
  }
  return record
}

async function main() {
  const raw = await readStdin()
  let input
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    return
  }
  if (!input.hook_event_name) return
  const dir = home()
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(toRecord(input)) + '\n')
}

// Only run when invoked as a script (by Claude Code, as a hook command),
// never when imported by tests for its pure `toRecord` helper.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0))
}
