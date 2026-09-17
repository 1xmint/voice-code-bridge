// Adds the bridge's hooks to ~/.claude/settings.json without touching existing
// hooks. Backs the file up first. Safe to run twice: skips hooks already
// present, and removes the old catch-all PermissionRequest -> project-gate
// entry if a previous run left one (that hook is gone; see project-gate.mjs
// and hooks/project-gate.mjs -- visibility into a permission prompt now
// comes from the existing Notification -> agent-tree-hook wiring instead).
// Also installs the UserPromptSubmit -> approve-hook.mjs hook, which
// recognizes a typed "approve <id>"/"yes <id>" reply to a project-gate hold.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function cmdFor(repo, file) {
  return { type: 'command', command: `node "${repo}/${file}"` }
}

// Mutates `settings` in place, returns a list of short change descriptions
// (for logging). Pure w.r.t. the filesystem so it's testable without touching
// a real settings.json.
export function applyHookEdits(settings, repo) {
  const changes = []
  const tree = cmdFor(repo, 'scripts/agent-tree-hook.mjs')
  const gate = cmdFor(repo, 'hooks/project-gate.mjs')
  const approve = cmdFor(repo, 'hooks/approve-hook.mjs')
  const hooks = (settings.hooks ||= {})

  function add(event, entry) {
    const list = (hooks[event] ||= [])
    const exists = list.some((e) => e.matcher === entry.matcher && e.hooks?.some((h) => h.command === entry.hooks[0].command))
    if (!exists) {
      list.push(entry)
      changes.push(`added ${event}${entry.matcher ? ` (${entry.matcher})` : ''} -> ${entry.hooks[0].command}`)
    }
  }

  function remove(event, predicate, label) {
    const list = hooks[event]
    if (!list) return
    const before = list.length
    hooks[event] = list.filter((e) => !predicate(e))
    if (hooks[event].length < before) changes.push(`removed ${label}`)
    if (!hooks[event].length) delete hooks[event]
  }

  add('PreToolUse', { matcher: 'Bash', hooks: [gate] })
  for (const ev of ['PreToolUse', 'PostToolUse']) add(ev, { matcher: '*', hooks: [tree] })
  for (const ev of ['SubagentStart', 'SubagentStop', 'Stop', 'Notification']) add(ev, { hooks: [tree] })
  // Recognizes a typed "approve <id>"/"yes <id>" reply to a project-gate
  // hold and forwards it to the bridge (see hooks/approve-hook.mjs).
  add('UserPromptSubmit', { hooks: [approve] })

  // No longer installed: the catch-all PermissionRequest -> project-gate
  // passthrough. Remove any entry a previous install left behind.
  remove(
    'PermissionRequest',
    (e) => e.matcher === '*' && e.hooks?.some((h) => h.command === gate.command),
    'PermissionRequest (*) -> project-gate.mjs'
  )

  return changes
}

function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/')
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  fs.copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`)

  const changes = applyHookEdits(settings, repo)

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  console.log('Hooks installed:', Object.entries(settings.hooks || {}).map(([k, v]) => `${k}=${v.length}`).join(' '))
  console.log(changes.length ? `Changes:\n  ${changes.join('\n  ')}` : 'No changes.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
