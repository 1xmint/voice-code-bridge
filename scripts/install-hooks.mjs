// Adds the bridge's hooks to ~/.claude/settings.json without touching existing
// hooks. Backs the file up first. Safe to run twice: skips hooks already present.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/')
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
fs.copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`)

const cmd = (file) => ({ type: 'command', command: `node "${repo}/${file}"` })
const tree = cmd('scripts/agent-tree-hook.mjs')
const gate = cmd('hooks/project-gate.mjs')
const hooks = (settings.hooks ||= {})

function add(event, entry) {
  const list = (hooks[event] ||= [])
  const exists = list.some((e) => e.matcher === entry.matcher && e.hooks?.some((h) => h.command === entry.hooks[0].command))
  if (!exists) list.push(entry)
}

add('PreToolUse', { matcher: 'Bash', hooks: [gate] })
add('PermissionRequest', { matcher: '*', hooks: [gate] })
for (const ev of ['PreToolUse', 'PostToolUse']) add(ev, { matcher: '*', hooks: [tree] })
for (const ev of ['SubagentStart', 'SubagentStop', 'Stop', 'Notification']) add(ev, { hooks: [tree] })

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
console.log('Hooks installed:', Object.entries(hooks).map(([k, v]) => `${k}=${v.length}`).join(' '))
