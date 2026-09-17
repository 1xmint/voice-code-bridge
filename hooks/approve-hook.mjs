#!/usr/bin/env node
// Claude Code hook script for voice-code-bridge. NOT installed automatically
// -- see scripts/install-hooks.mjs.
//
//   UserPromptSubmit -- recognizes a typed "approve <id>" or "yes <id>"
//   reply to a project-gate hold (see hooks/project-gate.mjs) and forwards
//   it to the bridge as an approval, the same as the voice path
//   (answer_code_permission). The bridge issues a one-time pass for the
//   held command; Code can then simply rerun the exact same command.
//
// Never blocks or delays prompt submission: any failure to reach the bridge
// (no secret, bridge down, non-200, network error) is swallowed silently --
// fails safe, same as the gate hook itself. This hook has no opinion to
// report back into the transcript; the bridge pushes its own channel notice
// ("approved <id>: rerun <command>") once the pass is issued.
import { pathToFileURL } from 'node:url'
import { getPort, readSecret, postJson } from './project-gate.mjs'

const APPROVE_RE = /^\s*(?:approve|yes)\s+([a-z0-9]{4,})\s*$/i

// Exported for tests: returns the gate id from a typed "approve <id>" /
// "yes <id>" prompt, or null if the prompt doesn't match.
export function matchApprove(prompt) {
  const m = APPROVE_RE.exec(String(prompt ?? ''))
  return m ? m[1] : null
}

export async function handleUserPromptSubmit(input) {
  const id = matchApprove(input?.prompt)
  if (!id) return
  const secret = readSecret()
  if (!secret) return
  try {
    // prompt + transcript_path travel with the request so the bridge can
    // verify this really came from a typed reply in this session's
    // transcript, not a forged POST claiming to be one (see
    // verifyApprovalProof in src/http.mjs).
    await postJson({
      port: getPort(),
      path: `/gate/${secret}`,
      body: { action: 'approve', id, approver: 'user', prompt: input?.prompt, transcript_path: input?.transcript_path },
      timeoutMs: 5000,
    })
  } catch {
    // fail safe: no-op
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

export async function run(input) {
  if (input?.hook_event_name === 'UserPromptSubmit') return handleUserPromptSubmit(input)
}

async function main() {
  const raw = await readStdin()
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }
  await run(input)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0))
}
