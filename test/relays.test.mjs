import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logRelay, listRelays, truncatePreview } from '../src/relays.mjs'

function tempPath() {
  return path.join(os.tmpdir(), `vcb-relays-test-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`)
}

test('logRelay appends a record with a truncated preview', () => {
  const p = tempPath()
  logRelay(p, { from: 'voice', to: 'code', kind: 'instruction', content: 'do the thing', task_id: 't1' })
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.from, 'voice')
  assert.equal(record.to, 'code')
  assert.equal(record.kind, 'instruction')
  assert.equal(record.task_id, 't1')
  assert.equal(record.preview, 'do the thing')
  assert.ok(record.at)
  fs.rmSync(p)
})

test('truncatePreview caps at 200 chars with an ellipsis', () => {
  const long = 'x'.repeat(250)
  const preview = truncatePreview(long)
  assert.equal(preview.length, 201)
  assert.ok(preview.endsWith('…'))
  assert.equal(truncatePreview(null), '')
})

test('listRelays returns most recent first, filtered by task_id', () => {
  const p = tempPath()
  logRelay(p, { from: 'voice', to: 'code', kind: 'instruction', content: 'a', task_id: 't1' })
  logRelay(p, { from: 'code', to: 'voice', kind: 'report', content: 'b', task_id: 't2' })
  logRelay(p, { from: 'code', to: 'voice', kind: 'report', content: 'c', task_id: 't1' })
  const all = listRelays(p, {})
  assert.equal(all.length, 3)
  assert.equal(all[0].preview, 'c') // most recent first

  const t1Only = listRelays(p, { task_id: 't1' })
  assert.equal(t1Only.length, 2)
  assert.ok(t1Only.every((r) => r.task_id === 't1'))
  fs.rmSync(p)
})

test('listRelays on a missing file returns an empty list, not an error', () => {
  assert.deepEqual(listRelays(tempPath(), {}), [])
})

test('logRelay never throws even if the directory does not exist', () => {
  assert.doesNotThrow(() => logRelay('/no/such/dir/relays.jsonl', { from: 'voice', to: 'code', kind: 'instruction', content: 'x' }))
})

test('listRelays respects limit', () => {
  const p = tempPath()
  for (let i = 0; i < 5; i++) logRelay(p, { from: 'voice', to: 'code', kind: 'instruction', content: `msg${i}` })
  const limited = listRelays(p, { limit: 2 })
  assert.equal(limited.length, 2)
  assert.equal(limited[0].preview, 'msg4')
  fs.rmSync(p)
})
