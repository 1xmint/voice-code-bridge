import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TaskStore } from '../src/tasks.mjs'

function tempLog() {
  return path.join(os.tmpdir(), `vcb-reload-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`)
}

test('a restarted store restores tasks, reports, names, follow-ups and cancels from disk', () => {
  const jsonlPath = tempLog()
  const a = new TaskStore({ jsonlPath })
  const done = a.createTask({ instruction: 'one', name: 'alpha' }).task_id
  a.report({ task_id: done, status: 'done', summary: 'All done.' })
  const live = a.createTask({ instruction: 'two' }).task_id
  a.report({ task_id: live, status: 'working', summary: 'On it.' })
  a.createTask({ task_id: live, instruction: 'and also this' })
  const gone = a.createTask({ instruction: 'three' }).task_id
  a.cancel(gone)

  const b = new TaskStore({ jsonlPath })
  assert.equal(b.load(), 3)
  assert.equal(b.getTask(done).status, 'done')
  assert.equal(b.getTask(done).reports[0].summary, 'All done.')
  assert.equal(b.findByName('alpha').task_id, done)
  assert.equal(b.getTask(live).status, 'working')
  assert.equal(b.getTask(live).pendingFollowups.length, 1)
  assert.equal(b.getTask(live).pendingFollowups[0].acknowledged, false)
  assert.equal(b.getTask(gone).status, 'cancelled')
  assert.equal(b.getActiveTaskId(), live)
  fs.rmSync(jsonlPath, { force: true })
})

test('in-flight tasks get a restart note; finished ones do not; a new report clears it', () => {
  const jsonlPath = tempLog()
  const a = new TaskStore({ jsonlPath })
  const live = a.createTask({ instruction: 'x' }).task_id
  const done = a.createTask({ instruction: 'y' }).task_id
  a.report({ task_id: done, status: 'done', summary: 'ok' })

  const b = new TaskStore({ jsonlPath })
  b.load()
  assert.match(b.getTask(live).restart_note, /bridge restarted/)
  assert.equal(b.getTask(done).restart_note, undefined)
  b.report({ task_id: live, status: 'working', summary: 'still here' })
  assert.equal(b.getTask(live).restart_note, undefined)
  fs.rmSync(jsonlPath, { force: true })
})

test('a permission prompt pending at restart is dropped, since nobody can answer it any more', () => {
  const jsonlPath = tempLog()
  const a = new TaskStore({ jsonlPath })
  const id = a.createTask({ instruction: 'x' }).task_id
  a.report({ task_id: id, status: 'working', summary: 's' })
  a.setPermissionRequest(id, { request_id: 'abcde' })

  const b = new TaskStore({ jsonlPath })
  b.load()
  assert.equal(b.getTask(id).status, 'working')
  assert.equal(b.getTask(id).pendingPermission, null)
  fs.rmSync(jsonlPath, { force: true })
})

test('load tolerates a missing file and corrupt lines', () => {
  assert.equal(new TaskStore({ jsonlPath: tempLog() }).load(), 0)
  const jsonlPath = tempLog()
  fs.writeFileSync(jsonlPath, 'not json\n{"event":"task_created","task_id":"aa","instruction":"hi"}\n{broken\n')
  const s = new TaskStore({ jsonlPath })
  assert.equal(s.load(), 1)
  assert.equal(s.getTask('aa').instruction, 'hi')
  fs.rmSync(jsonlPath, { force: true })
})
