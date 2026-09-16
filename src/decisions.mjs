// Append-only decision log: records choices the voice assistant makes on the
// user's behalf while delegated (see DELEGATION.md), for later review. Lives
// at ~/.voice-code-bridge/decisions.jsonl, one JSON object per line.
import fs from 'node:fs'

export class DecisionLog {
  constructor({ jsonlPath } = {}) {
    this.jsonlPath = jsonlPath
  }

  log({ task_id, name, decision, reason, category } = {}) {
    const record = {
      at: new Date().toISOString(),
      task_id: task_id || null,
      name: name || null,
      decision,
      reason: reason || null,
      category: category || null,
    }
    if (this.jsonlPath) {
      try {
        fs.appendFileSync(this.jsonlPath, JSON.stringify(record) + '\n')
      } catch {
        // best-effort logging only; never let disk trouble break the caller
      }
    }
    return record
  }

  _readAll() {
    if (!this.jsonlPath || !fs.existsSync(this.jsonlPath)) return []
    const lines = fs.readFileSync(this.jsonlPath, 'utf8').split('\n').filter((l) => l.trim())
    const out = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line))
      } catch {
        // skip a corrupt line rather than fail the whole read
      }
    }
    return out
  }

  // Most recent first, optionally filtered to one task by id or name.
  listRecent({ task_id, name, limit = 20 } = {}) {
    let all = this._readAll()
    if (task_id) {
      all = all.filter((d) => d.task_id === task_id)
    } else if (name) {
      const key = String(name).trim().toLowerCase()
      all = all.filter((d) => (d.name || '').toLowerCase() === key)
    }
    return all.slice(-limit).reverse()
  }

  lastForTask(task_id) {
    if (!task_id) return null
    return this.listRecent({ task_id, limit: 1 })[0] || null
  }
}
