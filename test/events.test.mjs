import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentTree, shortToolInput, metaPathFor, truncate } from '../src/events.mjs'

// Fixture events mimic what scripts/agent-tree-hook.mjs writes: one JSON
// object per hook invocation, in the order Claude Code fires them for a
// main session that spawns one subagent.
function fixtureEvents({ t0 = '2026-09-16T10:00:00.000Z' } = {}) {
  const at = (offsetSeconds) => new Date(Date.parse(t0) + offsetSeconds * 1000).toISOString()
  return [
    { at: at(0), event: 'PreToolUse', session_id: 's1', cwd: '/repo', tool_name: 'Task', tool_input: { description: 'audit deps' } },
    { at: at(1), event: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'general-purpose', cwd: '/repo', transcript_path: '/proj/s1/subagents/agent-a1.jsonl' },
    { at: at(2), event: 'PreToolUse', session_id: 's1', agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'npm audit' }, cwd: '/repo' },
    { at: at(30), event: 'PostToolUse', session_id: 's1', agent_id: 'a1', tool_name: 'Bash', cwd: '/repo' },
    { at: at(31), event: 'PreToolUse', session_id: 's1', agent_id: 'a1', tool_name: 'Read', tool_input: { file_path: 'package.json' }, cwd: '/repo' },
  ]
}

test('buildAgentTree groups by session and separates main from subagents', () => {
  const tree = buildAgentTree({ lines: fixtureEvents(), now: Date.parse('2026-09-16T10:01:00.000Z') })
  assert.equal(tree.length, 1)
  const [session] = tree
  assert.equal(session.session_id, 's1')
  assert.equal(session.subagents.length, 1)
  assert.equal(session.subagents[0].agent_id, 'a1')
  assert.equal(session.subagents[0].agent_type, 'general-purpose')
})

test('current tool and time on step reflect the last unmatched PreToolUse', () => {
  const tree = buildAgentTree({ lines: fixtureEvents(), now: Date.parse('2026-09-16T10:01:00.000Z') })
  const agent = tree[0].subagents[0]
  // last event was PreToolUse Read at t+31s; "now" is t+60s -> 29s on step
  assert.equal(agent.current_tool, 'Read')
  assert.equal(agent.current_tool_input, 'package.json')
  assert.equal(agent.time_on_step_s, 29)
  assert.equal(agent.state, 'running')
})

test('a finished PostToolUse clears current_tool until the next PreToolUse', () => {
  const events = fixtureEvents().slice(0, 4) // ends right after the Bash PostToolUse
  const tree = buildAgentTree({ lines: events, now: Date.parse('2026-09-16T10:00:35.000Z') })
  const agent = tree[0].subagents[0]
  assert.equal(agent.current_tool, null)
  assert.equal(agent.time_on_step_s, null)
})

test('SubagentStop marks the agent done and records its last message', () => {
  const events = [...fixtureEvents(), { at: '2026-09-16T10:01:00.000Z', event: 'SubagentStop', session_id: 's1', agent_id: 'a1', last_assistant_message: 'Found 2 vulnerabilities.' }]
  const tree = buildAgentTree({ lines: events, now: Date.parse('2026-09-16T10:01:05.000Z') })
  const agent = tree[0].subagents[0]
  assert.equal(agent.state, 'done')
  assert.equal(agent.last_message, 'Found 2 vulnerabilities.')
  assert.equal(agent.current_tool, null)
})

test('a blocking Notification marks the agent blocked with a reason', () => {
  const events = [...fixtureEvents(), { at: '2026-09-16T10:01:00.000Z', event: 'Notification', session_id: 's1', agent_id: 'a1', notification_type: 'permission_prompt' }]
  const tree = buildAgentTree({ lines: events, now: Date.parse('2026-09-16T10:01:05.000Z') })
  const agent = tree[0].subagents[0]
  assert.equal(agent.state, 'blocked')
  assert.equal(agent.blocked_reason, 'permission_prompt')
})

test('waiting_on lists subagents still running or blocked, from the parent session', () => {
  const tree = buildAgentTree({ lines: fixtureEvents(), now: Date.parse('2026-09-16T10:01:00.000Z') })
  assert.deepEqual(tree[0].waiting_on, ['a1'])
})

test('the rolling log keeps only the last 5 entries per agent', () => {
  const base = fixtureEvents({ t0: '2026-09-16T10:00:00.000Z' })
  const extra = []
  for (let i = 0; i < 8; i++) {
    extra.push({ at: `2026-09-16T10:02:0${i}.000Z`, event: 'PreToolUse', session_id: 's1', agent_id: 'a1', tool_name: `Tool${i}` })
  }
  const tree = buildAgentTree({ lines: [...base, ...extra], now: Date.parse('2026-09-16T10:03:00.000Z') })
  assert.equal(tree[0].subagents[0].log.length, 5)
  assert.ok(tree[0].subagents[0].log.at(-1).includes('Tool7'))
})

test('metaPathFor derives the sibling .meta.json only for a subagent transcript path', () => {
  assert.equal(
    metaPathFor({ agent_id: 'a1', transcript_path: '/proj/s1/subagents/agent-a1.jsonl' }),
    '/proj/s1/subagents/agent-a1.meta.json'
  )
  assert.equal(metaPathFor({ agent_id: 'a1', transcript_path: '/proj/s1.jsonl' }), null)
  assert.equal(metaPathFor({ transcript_path: '/proj/s1/subagents/agent-a1.jsonl' }), null)
})

test('SubagentStart reads description from the sidecar meta.json, best-effort', () => {
  const events = [
    { at: '2026-09-16T10:00:00.000Z', event: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'general-purpose', transcript_path: '/proj/s1/subagents/agent-a1.jsonl' },
  ]
  const readFile = (p) => {
    assert.equal(p, '/proj/s1/subagents/agent-a1.meta.json')
    return JSON.stringify({ description: 'audit dependencies' })
  }
  const tree = buildAgentTree({ lines: events, now: Date.parse('2026-09-16T10:00:05.000Z'), readFile })
  assert.equal(tree[0].subagents[0].description, 'audit dependencies')
})

test('a missing or unreadable meta.json leaves description null instead of throwing', () => {
  const events = [
    { at: '2026-09-16T10:00:00.000Z', event: 'SubagentStart', session_id: 's1', agent_id: 'a1', transcript_path: '/proj/s1/subagents/agent-a1.jsonl' },
  ]
  const readFile = () => { throw new Error('ENOENT') }
  const tree = buildAgentTree({ lines: events, now: Date.parse('2026-09-16T10:00:05.000Z'), readFile })
  assert.equal(tree[0].subagents[0].description, null)
})

test('shortToolInput picks the first preferred field and truncates', () => {
  assert.equal(shortToolInput({ command: 'a'.repeat(100) }).length, 81) // 80 chars + ellipsis
  assert.equal(shortToolInput({ file_path: 'src/x.mjs' }), 'src/x.mjs')
  assert.equal(shortToolInput({}), null)
  assert.equal(shortToolInput(null), null)
})

test('truncate handles null and long strings', () => {
  assert.equal(truncate(null, 10), null)
  assert.equal(truncate('hello world', 5), 'hello…')
})

test('multiple sessions stay separate trees', () => {
  const events = [
    { at: '2026-09-16T10:00:00.000Z', event: 'PreToolUse', session_id: 's1', tool_name: 'Bash' },
    { at: '2026-09-16T10:00:00.000Z', event: 'PreToolUse', session_id: 's2', tool_name: 'Read' },
  ]
  const tree = buildAgentTree({ lines: events, now: Date.parse('2026-09-16T10:00:01.000Z') })
  assert.equal(tree.length, 2)
  assert.deepEqual(tree.map((s) => s.session_id).sort(), ['s1', 's2'])
})
