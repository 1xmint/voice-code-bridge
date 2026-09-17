import test from 'node:test'
import assert from 'node:assert/strict'
import { PassStore, hashCommand } from '../src/passes.mjs'

test('hashCommand: same command and cwd hash the same, a different one does not', () => {
  const a = hashCommand('flyctl deploy', '/repo')
  const b = hashCommand('flyctl deploy', '/repo')
  const c = hashCommand('flyctl deploy', '/other')
  const d = hashCommand('flyctl deploy --prod', '/repo')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
})

test('PassStore: issue then consume once, second consume fails', () => {
  const store = new PassStore()
  const hash = hashCommand('flyctl deploy', '/repo')
  store.issue({ hash, gate_id: 'g1', approver: 'voice' })
  const first = store.consume(hash)
  assert.ok(first)
  assert.equal(first.gate_id, 'g1')
  assert.equal(store.consume(hash), null)
})

test('PassStore: consuming a hash with no pass returns null', () => {
  const store = new PassStore()
  assert.equal(store.consume(hashCommand('anything', '/x')), null)
})

test('PassStore: an expired pass is rejected', async () => {
  const store = new PassStore()
  const hash = hashCommand('flyctl deploy', '/repo')
  store.issue({ hash, gate_id: 'g1', approver: 'voice', ttlMs: 5 })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(store.consume(hash), null)
})

test('PassStore: a tampered/forged pass (bad signature) is rejected', () => {
  const store = new PassStore()
  const hash = hashCommand('flyctl deploy', '/repo')
  // Bypass issue() and plant a record directly, as a forgery would have to.
  store.passes.set(hash, { hash, gate_id: 'g1', approver: 'voice', expires_at: Date.now() + 60_000, used: false, sig: 'not-a-real-signature' })
  assert.equal(store.consume(hash), null)
})

test('PassStore: a pass approved for one command does not cover a different command', () => {
  const store = new PassStore()
  const approvedHash = hashCommand('flyctl deploy', '/repo')
  store.issue({ hash: approvedHash, gate_id: 'g1', approver: 'voice' })
  const otherHash = hashCommand('flyctl deploy --prod', '/repo')
  assert.equal(store.consume(otherHash), null)
  // The originally approved command is still good.
  assert.ok(store.consume(approvedHash))
})
