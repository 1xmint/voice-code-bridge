import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DecisionLog } from '../src/decisions.mjs'

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcb-decisions-')), 'decisions.jsonl')
}

test("log appends a record with a timestamp and reads it back", () => {
  const log = new DecisionLog({ jsonlPath: tempPath() })
  const record = log.log({ task_id: "abc", name: "realorrug", decision: "approved deploy", reason: "tests passed", category: "pre-approved" })
  assert.ok(record.at)
  assert.equal(record.decision, "approved deploy")
  const recent = log.listRecent()
  assert.equal(recent.length, 1)
  assert.equal(recent[0].task_id, "abc")
})

test("listRecent filters by task_id and returns newest first", () => {
  const log = new DecisionLog({ jsonlPath: tempPath() })
  log.log({ task_id: "a", decision: "one" })
  log.log({ task_id: "b", decision: "two" })
  log.log({ task_id: "a", decision: "three" })
  const forA = log.listRecent({ task_id: "a" })
  assert.equal(forA.length, 2)
  assert.equal(forA[0].decision, "three")
  assert.equal(forA[1].decision, "one")
})

test("listRecent filters by name when no task_id given", () => {
  const log = new DecisionLog({ jsonlPath: tempPath() })
  log.log({ name: "Realorrug", decision: "one" })
  log.log({ name: "other", decision: "two" })
  const forName = log.listRecent({ name: "realorrug" })
  assert.equal(forName.length, 1)
  assert.equal(forName[0].decision, "one")
})

test("lastForTask returns the most recent decision or null", () => {
  const log = new DecisionLog({ jsonlPath: tempPath() })
  assert.equal(log.lastForTask("a"), null)
  log.log({ task_id: "a", decision: "one" })
  log.log({ task_id: "a", decision: "two" })
  assert.equal(log.lastForTask("a").decision, "two")
})

test("log with no jsonlPath does not persist but still returns a record", () => {
  const log = new DecisionLog({})
  const record = log.log({ decision: "no path" })
  assert.equal(record.decision, "no path")
  assert.deepEqual(log.listRecent(), [])
})
