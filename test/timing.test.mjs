import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpServer } from '../src/http.mjs'
import { TaskStore } from '../src/tasks.mjs'

const SECRET = 'timing-test-secret-0123456789abcdef'

async function start(t) {
  const lines = []
  const server = createHttpServer({ secret: SECRET, tasks: new TaskStore({}), channel: null, log: (l) => lines.push(l) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/mcp/${SECRET}`
  return { url, lines }
}

const probe = (seconds) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'timing_probe', arguments: { seconds } } })
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20))
}

test('timing_probe answers and logs delivery time', async (t) => {
  const { url, lines } = await start(t)
  const res = await fetch(url, { method: 'POST', body: probe(0.2) })
  const body = await res.json()
  assert.match(body.result.content[0].text, /lighthouse/)
  await until(() => lines.some((l) => l.includes('delivered at')))
  assert.ok(lines.some((l) => /tools\/call timing_probe delivered at \d/.test(l)), lines.join('\n'))
})

test('a caller that hangs up before the answer is logged with the elapsed time', async (t) => {
  const { url, lines } = await start(t)
  const ac = new AbortController()
  const pending = fetch(url, { method: 'POST', body: probe(1.5), signal: ac.signal }).catch(() => null)
  setTimeout(() => ac.abort(), 300)
  await pending
  await until(() => lines.some((l) => l.includes('HUNG UP')))
  const line = lines.find((l) => l.includes('HUNG UP'))
  assert.ok(line, lines.join('\n'))
  const secs = Number(line.match(/after ([\d.]+)s/)[1])
  assert.ok(secs < 1.5, `hang-up logged at ${secs}s, expected before the 1.5s answer`)
})
