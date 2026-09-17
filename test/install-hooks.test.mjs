import test from 'node:test'
import assert from 'node:assert/strict'
import { applyHookEdits, cmdFor } from '../scripts/install-hooks.mjs'

const repo = 'C:/repo'

test('applyHookEdits adds the gate and tree hooks to an empty settings file', () => {
  const settings = {}
  const changes = applyHookEdits(settings, repo)
  assert.deepEqual(settings.hooks.PreToolUse.map((e) => e.matcher), ['Bash', '*'])
  assert.ok(settings.hooks.Notification)
  assert.equal(settings.hooks.PermissionRequest, undefined)
  assert.ok(changes.some((c) => c.includes('project-gate.mjs')))
})

test('applyHookEdits is idempotent: running twice adds nothing new', () => {
  const settings = {}
  applyHookEdits(settings, repo)
  const before = JSON.stringify(settings)
  const changes = applyHookEdits(settings, repo)
  assert.equal(JSON.stringify(settings), before)
  assert.deepEqual(changes, [])
})

test('applyHookEdits removes a pre-existing catch-all PermissionRequest -> project-gate entry', () => {
  const gate = cmdFor(repo, 'hooks/project-gate.mjs')
  const settings = { hooks: { PermissionRequest: [{ matcher: '*', hooks: [gate] }] } }
  const changes = applyHookEdits(settings, repo)
  assert.equal(settings.hooks.PermissionRequest, undefined)
  assert.ok(changes.some((c) => c.includes('removed PermissionRequest')))
})

test('applyHookEdits leaves an unrelated PermissionRequest entry alone', () => {
  const settings = { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'node other.mjs' }] }] } }
  applyHookEdits(settings, repo)
  assert.equal(settings.hooks.PermissionRequest.length, 1)
})
