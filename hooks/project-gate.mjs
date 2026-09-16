#!/usr/bin/env node
// Claude Code hook script for voice-code-bridge. NOT installed automatically
// -- see the settings.json snippet in docs/hooks.md (or the task report) to
// wire it up. One file, two hook events, dispatched by hook_event_name on
// stdin:
//
//   PreToolUse (matcher: Bash) -- the project gate. Always HOLDS (never
//   default-allows) a Bash command that deploys to a live server, spends or
//   signs, posts publicly, or force-pushes/rewrites history, regardless of
//   permission mode. Registers the held command with the bridge and waits
//   for a human answer; on timeout or if the bridge is unreachable, falls
//   back to "ask" (the normal interactive prompt) -- never "allow".
//
//   PermissionRequest (matcher: broad, e.g. "*") -- passes any auto-mode
//   fallback permission prompt through to the bridge so voice mode can see
//   and answer it. Same timeout/unreachable rule: falls back to "ask",
//   never "allow". Project gates above still hold regardless of this path.
//
// Both talk to the bridge over POST /gate/<secret> (see src/http.mjs),
// reading the secret from the same config file the bridge itself uses --
// no network credential beyond what's already on this machine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

// --- Gate categories -------------------------------------------------------
// Each pattern is checked against the full command string. Kept conservative
// (matches broadly) since a false "hold" costs a confirmation click, while a
// false pass-through costs real money, a public post, or lost history.
const GATE_PATTERNS = [
  {
    category: 'deploy',
    label: 'a deploy to a live server',
    patterns: [
      /\bssh\b/i,
      /\bscp\b/i,
      /\brsync\b/i,
      /\bsystemctl\b.*\b(restart|stop|start|reload)\b/i,
      /\bfly\s+deploy\b/i,
      /\bflyctl\s+deploy\b/i,
      /\bvercel\b.*\b(deploy|--prod)\b/i,
      /\bwrangler\b.*\bdeploy\b/i,
      /\b(deploy|release)\.(sh|mjs|js|py|ps1)\b/i,
      /\bnpm\s+run\s+deploy\b/i,
      /\bpm2\s+(restart|reload|deploy)\b/i,
    ],
  },
  {
    category: 'spend_sign',
    label: 'spending or signing',
    patterns: [
      /\bcast\s+send\b/i,
      /\bcast\s+wallet\s+sign\b/i,
      /\bturnkey\b/i,
      /\bprivate[_-]?key\b/i,
      /\bwallet\s+sign\b/i,
      /\bsign(-|\s)transaction\b/i,
      /\bsolana\s+transfer\b/i,
      /\beth\s+sendtransaction\b/i,
    ],
  },
  {
    category: 'post_public',
    label: 'posting publicly',
    patterns: [
      /api\.twitter\.com/i,
      /api\.x\.com/i,
      /\btweepy\b.*\bpost\b/i,
      /\bpost[_-]?tweet\b/i,
      /\brealorrug\b.*\b(publish|post)\b/i,
      /\b--publish\b/i,
      /\bpublish[_-]?mode\b/i,
    ],
  },
  {
    category: 'history_rewrite',
    label: 'a force-push or history rewrite',
    patterns: [
      /\bgit\s+push\b.*(--force\b|-f\b)/i,
      /\bgit\s+reset\s+--hard\b/i,
      /\bgit\s+rebase\b.*\bmain\b/i,
      /\bgit\s+rebase\s+main\b/i,
      /\bgit\s+filter-branch\b/i,
      /\bgit\s+filter-repo\b/i,
    ],
  },
]

// Only what the shell will run counts: heredoc bodies and quoted strings are
// data (a commit message or test text that mentions "git push --force" is not
// a force-push). A command hidden inside quotes, like bash -c "git push -f",
// is missed; the classifier and normal prompts still see those.
export function stripData(command) {
  let s = String(command || '')
  s = s.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, '<<heredoc')
  s = s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
  return s
}

export function matchGate(command) {
  const cmd = stripData(command)
  for (const { category, label, patterns } of GATE_PATTERNS) {
    for (const re of patterns) {
      if (re.test(cmd)) return { category, label }
    }
  }
  return null
}

// --- Bridge config + transport ---------------------------------------------
export function getHome() {
  return process.env.VCB_HOME || path.join(os.homedir(), '.voice-code-bridge')
}

export function getPort() {
  const p = Number(process.env.VCB_PORT)
  return Number.isFinite(p) && p > 0 ? p : 8790
}

export function readSecret(home = getHome()) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    return config.secret || null
  } catch {
    return null
  }
}

function postJson({ port, path: urlPath, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: timeoutMs },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : null })
          } catch {
            resolve({ statusCode: res.statusCode, body: null })
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// Registers a held/asked action, then polls for a decision until it arrives
// or timeoutMs elapses. Returns 'allow' | 'deny' | 'ask'. 'ask' covers both
// an explicit deny-to-prompt-normally case and any failure to reach the
// bridge at all -- callers must never turn a failure into 'allow'.
export async function holdForDecision({ secret, port = getPort(), payload, timeoutMs = 25_000, pollMs = 1000 }) {
  if (!secret) return 'ask'
  try {
    const reg = await postJson({ port, path: `/gate/${secret}`, body: { action: 'register', ...payload }, timeoutMs: 5000 })
    if (reg.statusCode !== 200 || !reg.body?.request_id) return 'ask'
    const requestId = reg.body.request_id
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs))
      const poll = await postJson({ port, path: `/gate/${secret}`, body: { action: 'poll', request_id: requestId }, timeoutMs: 5000 })
      const status = poll.body?.status
      if (status === 'allow' || status === 'deny') return status
    }
    return 'ask'
  } catch {
    return 'ask'
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
    if (process.stdin.isTTY) resolve('')
  })
}

function emit(hookEventName, decisionField, decision, reason) {
  const out = { hookSpecificOutput: { hookEventName } }
  out.hookSpecificOutput[decisionField] = decision
  if (reason) out.hookSpecificOutput[decisionField === 'permissionDecision' ? 'permissionDecisionReason' : 'reason'] = reason
  process.stdout.write(JSON.stringify(out))
}

async function handlePreToolUse(input) {
  const command = input?.tool_input?.command
  const match = matchGate(command)
  if (!match) return // no output: let normal permission/auto-mode flow decide
  const secret = readSecret()
  const decision = await holdForDecision({
    secret,
    payload: {
      kind: 'hold',
      tool_name: input?.tool_name,
      command,
      description: `${match.label}: ${command}`,
      repo: input?.cwd,
      agent: input?.agent_type || input?.agent_id || 'main',
    },
  })
  // A gate hold never resolves to "allow" on its own timeout/unreachable path
  // (holdForDecision already guarantees this); an explicit "deny" answer is
  // reported as a deny, everything else falls back to the normal prompt.
  const permissionDecision = decision === 'deny' ? 'deny' : decision === 'allow' ? 'allow' : 'ask'
  emit('PreToolUse', 'permissionDecision', permissionDecision, `Project gate: ${match.label}.`)
}

async function handlePermissionRequest(input) {
  const secret = readSecret()
  const decision = await holdForDecision({
    secret,
    payload: {
      kind: 'ask',
      tool_name: input?.tool_name,
      command: input?.tool_input?.command || JSON.stringify(input?.tool_input || {}),
      description: `Permission needed for ${input?.tool_name}`,
      repo: input?.cwd,
      agent: input?.agent_type || input?.agent_id || 'main',
    },
  })
  const decisionValue = decision === 'deny' ? 'deny' : decision === 'allow' ? 'allow' : 'ask'
  emit('PermissionRequest', 'decision', decisionValue, 'Routed through voice-code-bridge.')
}

export async function run(input) {
  if (input?.hook_event_name === 'PreToolUse') return handlePreToolUse(input)
  if (input?.hook_event_name === 'PermissionRequest') return handlePermissionRequest(input)
  // Unknown event: no opinion.
}

async function main() {
  const raw = await readStdin()
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return // malformed input: no opinion, let the normal flow proceed
  }
  await run(input)
}

// pathToFileURL, not a hand-built file:// string: on Windows the URL has three
// slashes, the old check never matched, and the hook silently did nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0))
}
