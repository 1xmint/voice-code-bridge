import test from 'node:test'
import assert from 'node:assert/strict'
import { toRecord } from '../scripts/agent-tree-hook.mjs'

test('toRecord keeps the event name and only the fields the agent tree uses', () => {
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    agent_id: 'a1',
    agent_type: 'general-purpose',
    cwd: '/repo',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'tu1',
    transcript_path: '/proj/s1/subagents/agent-a1.jsonl',
    permission_mode: 'default', // should be dropped
    effort: { level: 'medium' }, // should be dropped
    prompt_id: 'p1', // should be dropped
  }
  const record = toRecord(input)
  assert.equal(record.event, 'PreToolUse')
  assert.equal(record.session_id, 's1')
  assert.equal(record.agent_id, 'a1')
  assert.equal(record.tool_name, 'Bash')
  assert.deepEqual(record.tool_input, { command: 'ls' })
  assert.ok(record.at)
  assert.equal(record.permission_mode, undefined)
  assert.equal(record.effort, undefined)
  assert.equal(record.prompt_id, undefined)
})

test('toRecord omits fields Claude Code did not send rather than writing them as null', () => {
  const record = toRecord({ hook_event_name: 'Stop', session_id: 's1' })
  assert.equal(record.event, 'Stop')
  assert.equal(record.session_id, 's1')
  assert.equal('agent_id' in record, false)
  assert.equal('tool_name' in record, false)
})

test('toRecord passes through Notification and SubagentStop specific fields', () => {
  const notif = toRecord({ hook_event_name: 'Notification', session_id: 's1', notification_type: 'permission_prompt' })
  assert.equal(notif.notification_type, 'permission_prompt')

  const stop = toRecord({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1', last_assistant_message: 'done' })
  assert.equal(stop.last_assistant_message, 'done')
})
