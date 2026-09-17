#!/usr/bin/env node
// Claude Code hook script for voice-code-bridge. NOT installed automatically
// -- see the settings.json snippet in docs/hooks.md (or the task report) to
// wire it up. Handles one hook event, dispatched by hook_event_name on
// stdin:
//
//   PreToolUse (matcher: Bash) -- the project gate. Always HOLDS (never
//   default-allows) a Bash command that deploys to a live server, spends or
//   signs, posts publicly, or force-pushes/rewrites history, regardless of
//   permission mode. Registers the held command with the bridge and waits
//   for a human answer; on timeout or if the bridge is unreachable, falls
//   back to "ask" (the normal interactive prompt) -- never "allow".
//
// There used to be a second, PermissionRequest (matcher: "*") passthrough
// here that forwarded every auto-mode fallback permission prompt to the
// bridge. That's gone: it was a catch-all with no gating logic of its own.
// Visibility into "Claude Code is sitting at a permission prompt" now comes
// from the Notification hook (scripts/agent-tree-hook.mjs, already wired
// separately) instead -- see waiting_on_terminal in src/events.mjs.
//
// Talks to the bridge over POST /gate/<secret> (see src/http.mjs),
// reading the secret from the same config file the bridge itself uses --
// no network credential beyond what's already on this machine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { parseShellCommands, ParseError } from './shell-parse.mjs'

// --- Gate categories -------------------------------------------------------
// matchGate used to run regexes over the whole command string. That gives
// false holds when a gated word only appears as data: echo text, a heredoc
// body, a commit message, a grep/sed pattern on a test file. It now parses
// the command (see shell-parse.mjs) into the argv(s) it actually runs and
// checks *those*, plus a conservative text scan for the handful of
// interpreter strings (node -e / python -c / pwsh -Command) that are code,
// not shell, so can't be argv-parsed.
//
// Unparseable input (unbalanced quote, unterminated heredoc/subshell) fails
// closed: category 'unparseable', always a hold, never a silent pass.
const RAW_TEXT_PATTERNS = [
  { category: 'history_rewrite', label: 'a force-push or history rewrite', re: /\bgit\s+push\b[^\n]*(--force(-with-lease|-if-includes)?\b|(^|\s)-f\b)|\bfilter-repo\b|\bfilter-branch\b/i },
  { category: 'post_public', label: 'posting publicly', re: /api\.(x|twitter)\.com|upload\.twitter\.com|post[_-]?tweet|--publish\b/i },
  { category: 'spend_sign', label: 'spending or signing', re: /\bcast\s+send\b|\bcast\s+wallet\s+sign\b|\bturnkey\b|private[_-]?key|sendtransaction|solana\s+transfer|spl-token\s+transfer/i },
  { category: 'deploy', label: 'a deploy to a live server', re: /\bssh\b|\bscp\b|\brsync\b|\bflyctl\s+deploy\b|\bwrangler\s+(deploy|publish)\b|\bsystemctl\s+(restart|stop|start|reload)\b/i },
]

function gitGlobalOptSkip(args, i) {
  const a = args[i]
  if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') return 2
  if (/^--(git-dir|work-tree|namespace)=/.test(a)) return 1
  if (/^-[a-zA-Z]$/.test(a) || a === '--no-pager' || a === '--paginate' || a === '-p') return 1
  return 0
}

function matchHistoryRewrite(argv) {
  if (basenameLower(argv[0]) !== 'git') return null
  let i = 1
  while (i < argv.length) {
    const skip = gitGlobalOptSkip(argv, i)
    if (!skip) break
    i += skip
  }
  const sub = argv[i]
  if (!sub) return null
  if (sub === 'filter-branch' || sub === 'filter-repo') return { category: 'history_rewrite', label: 'a force-push or history rewrite' }
  if (sub === 'push') {
    const rest = argv.slice(i + 1)
    const forced = rest.some((a) => a === '-f' || a === '--force' || a === '--force-with-lease' || a === '--force-if-includes' || /^--force-with-lease=/.test(a) || a.startsWith('+'))
    if (forced) return { category: 'history_rewrite', label: 'a force-push or history rewrite' }
  }
  // git reset --hard / git rebase: intentionally not held here -- neither
  // can be told apart from a purely-local, already-unpushed reset/rebase
  // from argv alone, and holding every reset --hard / rebase would be a
  // constant false-positive tax. Left to the normal permission flow.
  return null
}

function basenameLower(p) {
  if (!p) return ''
  const s = String(p).replace(/\\/g, '/')
  const b = s.slice(s.lastIndexOf('/') + 1)
  return b.toLowerCase()
}

function matchPostPublic(argv) {
  const name = basenameLower(argv[0])
  const args = argv.slice(1)
  const httpTools = new Set(['curl', 'wget', 'http', 'https', 'invoke-webrequest', 'iwr', 'curl.exe'])
  if (httpTools.has(name)) {
    if (args.some((a) => /api\.(x|twitter)\.com|upload\.twitter\.com/i.test(a))) return { category: 'post_public', label: 'posting publicly' }
  }
  if (/post[_-]?tweet/i.test(name) || args.some((a) => /post[_-]?tweet/i.test(a))) return { category: 'post_public', label: 'posting publicly' }
  if (name === 'realorrug' && args.some((a) => /^(--)?(publish|post)$/i.test(a))) return { category: 'post_public', label: 'posting publicly' }
  if (argv.some((a) => a === '--publish')) return { category: 'post_public', label: 'posting publicly' }
  return null
}

function matchSpendSign(argv) {
  const name = basenameLower(argv[0])
  const args = argv.slice(1)
  if (name === 'cast' && args[0] === 'send') return { category: 'spend_sign', label: 'spending or signing' }
  if (name === 'cast' && args[0] === 'wallet' && args[1] === 'sign') return { category: 'spend_sign', label: 'spending or signing' }
  if (name === 'solana' && args[0] === 'transfer') return { category: 'spend_sign', label: 'spending or signing' }
  if (name === 'spl-token' && args[0] === 'transfer') return { category: 'spend_sign', label: 'spending or signing' }
  if (name === 'turnkey') return { category: 'spend_sign', label: 'spending or signing' }
  if (argv.some((a) => /sendtransaction$/i.test(a) || a === 'eth_sendRawTransaction' || a === 'eth_sendTransaction')) return { category: 'spend_sign', label: 'spending or signing' }
  if (argv.some((a) => /^--?private[_-]key(=|$)/i.test(a))) return { category: 'spend_sign', label: 'spending or signing' }
  return null
}

const DEPLOY_EXECUTABLES = new Set(['ssh', 'scp', 'rsync'])
function matchDeploy(argv) {
  const name = basenameLower(argv[0])
  const args = argv.slice(1)
  if (DEPLOY_EXECUTABLES.has(name)) return { category: 'deploy', label: 'a deploy to a live server' }
  if ((name === 'fly' || name === 'flyctl') && args[0] === 'deploy') return { category: 'deploy', label: 'a deploy to a live server' }
  if (name === 'vercel' && (args.includes('deploy') || args.includes('--prod'))) return { category: 'deploy', label: 'a deploy to a live server' }
  if (name === 'wrangler' && (args[0] === 'deploy' || args[0] === 'publish')) return { category: 'deploy', label: 'a deploy to a live server' }
  if (['npm', 'pnpm', 'yarn'].includes(name) && args[0] === 'run' && args[1] === 'deploy') return { category: 'deploy', label: 'a deploy to a live server' }
  if (name === 'pm2' && ['restart', 'reload', 'deploy'].includes(args[0])) return { category: 'deploy', label: 'a deploy to a live server' }
  if (name === 'systemctl' && ['restart', 'stop', 'start', 'reload'].includes(args[0])) return { category: 'deploy', label: 'a deploy to a live server' }
  const releaseScript = /^(deploy|release)\.(sh|mjs|js|py|ps1)$/i
  if (releaseScript.test(name)) return { category: 'deploy', label: 'a deploy to a live server' }
  if (['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'pwsh', 'powershell'].includes(name)) {
    const firstNonFlag = args.find((a) => !a.startsWith('-'))
    if (firstNonFlag && releaseScript.test(basenameLower(firstNonFlag))) return { category: 'deploy', label: 'a deploy to a live server' }
  }
  return null
}

const ARGV_MATCHERS = [matchHistoryRewrite, matchPostPublic, matchSpendSign, matchDeploy]

export function matchGate(command) {
  let parsed
  try {
    parsed = parseShellCommands(command)
  } catch (err) {
    if (err instanceof ParseError) return { category: 'unparseable', label: `an unparseable command (failing closed: ${err.message})` }
    throw err
  }
  for (const argv of parsed.commands) {
    for (const matcher of ARGV_MATCHERS) {
      const hit = matcher(argv)
      if (hit) return hit
    }
  }
  for (const text of parsed.rawTexts) {
    for (const { category, label, re } of RAW_TEXT_PATTERNS) {
      if (re.test(text)) return { category, label }
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

export async function run(input) {
  if (input?.hook_event_name === 'PreToolUse') return handlePreToolUse(input)
  // Unknown event (including the old PermissionRequest passthrough, no
  // longer handled here): no opinion.
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
