import test from 'node:test'
import assert from 'node:assert/strict'
import { parseShellCommands, ParseError } from '../hooks/shell-parse.mjs'

function commands(cmd) {
  return parseShellCommands(cmd).commands
}

test('shell-parse: splits on operators', () => {
  assert.deepEqual(commands('git status && npm test; echo done'), [['git', 'status'], ['npm', 'test'], ['echo', 'done']])
})

test('shell-parse: drops heredoc bodies but keeps the rest of the command', () => {
  const cmd = ['cat >> notes.txt <<' + "'EOF'", 'git push --force origin main', 'EOF', 'git add notes.txt'].join('\n')
  const cmds = commands(cmd)
  // 'notes.txt' is the >> redirect target, not an argument to cat, so it's
  // correctly absent from argv here.
  assert.deepEqual(cmds[0], ['cat'])
  assert.deepEqual(cmds[1], ['git', 'add', 'notes.txt'])
  assert.equal(cmds.length, 2)
})

test('shell-parse: recurses into subshells, $(...), and backticks', () => {
  assert.deepEqual(commands('(git push -f)'), [['git', 'push', '-f']])
  // the substitution is scanned (and its command recorded) while still
  // inside the outer word, so it appears before the outer command finishes
  assert.deepEqual(commands('echo $(git push -f)'), [['git', 'push', '-f'], ['echo']])
  assert.deepEqual(commands('echo `git push -f`'), [['git', 'push', '-f'], ['echo']])
})

test('shell-parse: unwraps env/sudo/nohup/time/xargs/command to the real program', () => {
  assert.deepEqual(commands('sudo git push -f'), [['git', 'push', '-f']])
  assert.deepEqual(commands('env FOO=1 git push -f'), [['git', 'push', '-f']])
  assert.deepEqual(commands('command git push -f'), [['git', 'push', '-f']])
})

test('shell-parse: recurses into bash/sh -c strings, and collects node -e / python -c / pwsh -Command as raw text', () => {
  const bash = parseShellCommands('bash -c "git push -f"')
  assert.deepEqual(bash.commands.at(-1), ['git', 'push', '-f'])

  const node = parseShellCommands('node -e "git push -f"')
  assert.deepEqual(node.rawTexts, ['git push -f'])

  const py = parseShellCommands('python -c "git push -f"')
  assert.deepEqual(py.rawTexts, ['git push -f'])

  const pwsh = parseShellCommands('pwsh -Command "git push -f"')
  assert.deepEqual(pwsh.rawTexts, ['git push -f'])
})

test('shell-parse: strips leading VAR=val assignments', () => {
  assert.deepEqual(commands('FOO=1 BAR=2 git push -f'), [['git', 'push', '-f']])
})

test('shell-parse: fails closed (throws ParseError) on unbalanced/unterminated input', () => {
  assert.throws(() => parseShellCommands('echo "unterminated'), ParseError)
  assert.throws(() => parseShellCommands("echo 'unterminated"), ParseError)
  assert.throws(() => parseShellCommands('echo $(git push -f'), ParseError)
  assert.throws(() => parseShellCommands('cat <<EOF\nno terminator here'), ParseError)
  assert.throws(() => parseShellCommands('echo )'), ParseError)
})
