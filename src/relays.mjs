// Cross-session relay log: every message this bridge hands from voice to
// Code, or from Code back to voice, appended to relays.jsonl. This is the
// only traffic the bridge can see: it is a stdio channel to exactly one
// Claude Code process plus one HTTP endpoint for voice, so "sessions" here
// means the voice side and that one connected Code session, identified by
// task_id/name. Peer-to-peer SendMessage traffic between separate Claude
// Code sessions or subagents (an agent-teams feature) never touches this
// process, so it cannot be logged here; see README for what would be needed.
import fs from 'node:fs'

const PREVIEW_LEN = 200

export function truncatePreview(content) {
  if (content === null || content === undefined) return ''
  const s = String(content)
  return s.length > PREVIEW_LEN ? `${s.slice(0, PREVIEW_LEN)}…` : s
}

// Appends one relay record. Best-effort: a disk error here must never break
// the actual relay it's describing.
export function logRelay(relaysJsonlPath, { from, to, kind, content, task_id = null } = {}) {
  if (!relaysJsonlPath) return
  const record = {
    at: new Date().toISOString(),
    from,
    to,
    kind,
    task_id,
    preview: truncatePreview(content),
  }
  try {
    fs.appendFileSync(relaysJsonlPath, JSON.stringify(record) + '\n')
  } catch {
    // logging only; never let disk trouble break a relay
  }
}

// Reads relays.jsonl, most recent first, optionally filtered by task_id or
// by session (matches `from` or `to`).
export function listRelays(relaysJsonlPath, { task_id, session, limit = 20 } = {}) {
  if (!relaysJsonlPath || !fs.existsSync(relaysJsonlPath)) return []
  const raw = fs.readFileSync(relaysJsonlPath, 'utf8')
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip a torn line
    }
  }
  let filtered = out
  if (task_id) filtered = filtered.filter((r) => r.task_id === task_id)
  if (session) filtered = filtered.filter((r) => r.from === session || r.to === session)
  return filtered.slice(-limit).reverse()
}
