import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { matchGate, holdForDecision } from '../hooks/project-gate.mjs'

test('matchGate: catches the four gated categories', () => {
  assert.equal(matchGate('ssh guardian-vps-tail "systemctl restart app"').category, 'deploy')
  assert.equal(matchGate('flyctl deploy --app my-app').category, 'deploy')
  assert.equal(matchGate('cast send 0xabc "transfer(address,uint256)" 0x1 1').category, 'spend_sign')
  assert.equal(matchGate('curl -X POST https://api.twitter.com/2/tweets').category, 'post_public')
  assert.equal(matchGate('git push --force origin main').category, 'history_rewrite')
  assert.equal(matchGate('git push -f origin main').category, 'history_rewrite')
  assert.equal(matchGate('git push --force-with-lease origin main').category, 'history_rewrite')
  assert.equal(matchGate('git reset --hard origin/main').category, 'history_rewrite')
})

test('matchGate: leaves routine commands alone', () => {
  assert.equal(matchGate('git status'), null)
  assert.equal(matchGate('npm test'), null)
  assert.equal(matchGate('git commit -m "message"'), null)
})

test('holdForDecision: returns ask when the bridge is unreachable, never allow', async () => {
  const decision = await holdForDecision({ secret: 'nope', port: 65500, payload: { command: 'git push --force' }, timeoutMs: 200, pollMs: 50 })
  assert.equal(decision, 'ask')
})

test('holdForDecision: returns ask on timeout when the bridge never answers', async () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      if (parsed.action === 'register') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ request_id: 'held-1', task_id: 't1' }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'pending' }))
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const decision = await holdForDecision({ secret: 's', port, payload: { command: 'git push --force' }, timeoutMs: 250, pollMs: 60 })
  assert.equal(decision, 'ask')
  server.close()
})

test('holdForDecision: reports the answered decision once the bridge has one', async () => {
  let answered = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      if (parsed.action === 'register') {
        setTimeout(() => { answered = true }, 80)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ request_id: 'held-2', task_id: 't1' }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: answered ? 'allow' : 'pending' }))
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const decision = await holdForDecision({ secret: 's', port, payload: { command: 'git push --force' }, timeoutMs: 2000, pollMs: 40 })
  assert.equal(decision, 'allow')
  server.close()
})