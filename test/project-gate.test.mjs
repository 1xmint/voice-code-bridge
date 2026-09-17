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
  // git reset --hard is no longer held: with a real argv parse there is no
  // way to tell an already-local, unpushed reset from one undoing pushed
  // history, and holding every `reset --hard` would be a constant
  // false-positive tax for no real protection. See project-gate.mjs.
  assert.equal(matchGate('git reset --hard origin/main'), null)
})

test('matchGate: leaves routine commands alone', () => {
  assert.equal(matchGate('git status'), null)
  assert.equal(matchGate('npm test'), null)
  assert.equal(matchGate('git commit -m "message"'), null)
})

test('matchGate: MUST HOLD cases from the parser rewrite', () => {
  assert.equal(matchGate('git push --force').category, 'history_rewrite')
  assert.equal(matchGate('git push -f origin x').category, 'history_rewrite')
  assert.equal(matchGate('git push origin +main').category, 'history_rewrite')
  assert.equal(matchGate('cd x && git push -f').category, 'history_rewrite')
  assert.equal(matchGate('git -C repo push --force-with-lease').category, 'history_rewrite')
  assert.equal(matchGate('bash -c "git push -f"').category, 'history_rewrite')
  assert.equal(matchGate('echo $(git push -f)').category, 'history_rewrite')
  assert.equal(matchGate('git filter-repo --path x').category, 'history_rewrite')
  assert.equal(matchGate('curl -X POST https://api.x.com/2/tweets').category, 'post_public')
  assert.equal(matchGate('curl "https://api.twitter.com/2/tweets" -d @b.json').category, 'post_public')
  assert.equal(matchGate('wget --post-data=x https://api.x.com/2/tweets').category, 'post_public')
  assert.equal(matchGate('cast send 0xabc "transfer(address,uint256)" 0x1 1').category, 'spend_sign')
  assert.equal(matchGate('ssh box "systemctl restart app"').category, 'deploy')
  assert.equal(matchGate('flyctl deploy').category, 'deploy')
  assert.equal(matchGate('npm run deploy').category, 'deploy')
  assert.equal(matchGate('node -e "require(\'child_process\').execSync(\'git push -f\')"').category, 'history_rewrite')
  assert.equal(matchGate('echo "unterminated').category, 'unparseable')
})

test('matchGate: MUST PASS cases from the parser rewrite', () => {
  assert.equal(matchGate('echo git push --force'), null)
  assert.equal(matchGate('echo "curl -X POST https://api.x.com"'), null)
  assert.equal(matchGate('git commit -m "git push --force later"'), null)
  assert.equal(matchGate('grep -n "git push --force" test/x.mjs'), null)
  assert.equal(matchGate('sed -i "s/api.x.com/example.com/" test/a.mjs'), null)
  assert.equal(matchGate('git push origin feat/x'), null)
  assert.equal(matchGate('git reset --hard'), null)
  assert.equal(matchGate('cat notes.md'), null)
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
test('run as a script, the way Claude Code runs it, a held command with no bridge falls back to ask', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const os = await import('node:os')
  const hook = fileURLToPath(new URL('../hooks/project-gate.mjs', import.meta.url))
  const home = (await import('node:fs')).mkdtempSync((await import('node:path')).join(os.tmpdir(), 'vcb-gate-'))
  // 'echo git push --force' used to be held here (the old string-regex
  // matcher fired on the whole command, including echo's text argument),
  // but it's plain data being echoed, not a real force-push, and is now a
  // MUST PASS case for the argv parser -- so this uses a command that
  // really does force-push instead.
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } })
  const r = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env: { ...process.env, VCB_HOME: home, VCB_PORT: '1' } })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask')
})

test('matchGate ignores gated words in heredocs and commit messages, but still holds real commands and quoted URLs', () => {
  const heredoc = ['cat >> notes.txt <<' + "'EOF'", 'git push --force origin main', 'EOF', 'git add notes.txt'].join(String.fromCharCode(10))
  assert.equal(matchGate(heredoc), null)
  assert.equal(matchGate('git commit -m "never git push --force here"'), null)
  assert.equal(matchGate('curl -X POST "https://api.x.com/2/tweets"').category, 'post_public')
  assert.equal(matchGate('git push --force origin x').category, 'history_rewrite')
  assert.equal(matchGate(heredoc + String.fromCharCode(10) + 'git push -f origin x').category, 'history_rewrite')
})

test('gate holds past the hook wait drop out of the pending list', async () => {
  const { TaskStore } = await import('../src/tasks.mjs')
  const store = new TaskStore({})
  const g = store.registerGate({ command: 'git push --force' })
  assert.equal(store.listPendingGates().length, 1)
  assert.equal(store.listPendingGates(Date.now() + 31_000).length, 0)
  assert.equal(store.getGate(g.request_id).status, 'expired')
})
