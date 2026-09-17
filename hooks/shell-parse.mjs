// A small POSIX-ish shell tokenizer used by hooks/project-gate.mjs to decide
// what a Bash command actually *runs*, instead of pattern-matching the whole
// command string (which false-positives on gated words that only appear as
// data: echo text, heredoc bodies, grep/sed patterns, commit messages, ...).
//
// This is not a full shell grammar. It covers the constructs the gate cares
// about: quoting/escaping, comments, heredocs (bodies dropped), the ;/&&/||/
// |/&/newline separators, $(...) / `...` / (...) recursion, leading VAR=val
// assignments, and a short wrapper-skip list (env/sudo/nohup/time/xargs/
// command) so the real program is what gets matched. Anything it can't make
// sense of (unbalanced quote, unterminated heredoc/subshell) throws
// ParseError -- callers must fail closed (hold) on that, never pass through.
//
// Known gaps (documented, not silently guessed): here-strings (<<<), process
// substitution (<(...) / >(...)), brace/glob expansion, and `case`/`if`/`for`
// keyword bodies are not specially understood -- they tokenize as plain words
// or (for unmatched parens inside e.g. `case` patterns) may throw. Since a
// throw fails closed to a hold, this is safe, just occasionally over-cautious.

export class ParseError extends Error {}

const WRAPPER_NAMES = new Set(['env', 'sudo', 'nohup', 'time', 'xargs', 'command'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash'])

function basename(p) {
  if (!p) return p
  const s = String(p).replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i === -1 ? s : s.slice(i + 1)
}

// --- core scanner ------------------------------------------------------
// Scans `str` starting at `pos`, appending completed simple commands (argv
// arrays, after assignment/wrapper resolution) to `out.commands` and raw
// script bodies (for node -e / python -c / pwsh -Command) to `out.rawTexts`.
// `terminator` is null at top level, or ')'/'`' when recursing into a
// subshell, $(...), or backtick substitution -- scanning stops and consumes
// that terminator, returning the position just past it.
function scan(str, pos, out, terminator) {
  let i = pos
  const n = str.length
  let word = null // current word buffer, or null if no word started
  let argv = [] // words of the current simple command
  let sawAnyWord = false
  let atCommandStart = true // true right after a separator/start, before any word chars
  const pendingHeredocs = [] // { delim, strip }

  function pushWordChar(ch) {
    if (word === null) word = ''
    word += ch
    atCommandStart = false
  }

  function endWord() {
    if (word !== null) {
      argv.push(word)
      word = null
      sawAnyWord = true
    }
  }

  function endCommand() {
    endWord()
    if (argv.length) resolveAndEmit(argv, out)
    argv = []
    atCommandStart = true
  }

  function consumeHeredocBodies() {
    for (const { delim, strip } of pendingHeredocs) {
      let found = false
      while (i < n) {
        let lineEnd = str.indexOf('\n', i)
        if (lineEnd === -1) lineEnd = n
        let line = str.slice(i, lineEnd)
        const check = strip ? line.replace(/^\t+/, '') : line
        i = lineEnd < n ? lineEnd + 1 : lineEnd
        if (check === delim) {
          found = true
          break
        }
        if (lineEnd === n) break // ran out of input mid-body
      }
      if (!found) throw new ParseError(`unterminated heredoc <<${delim}`)
    }
    pendingHeredocs.length = 0
  }

  while (i < n) {
    const ch = str[i]

    if (terminator && ch === terminator) {
      endCommand()
      return i + 1
    }

    if (ch === '#' && word === null && atCommandStart) {
      // comment: skip to end of line
      const nl = str.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }

    if (ch === "'") {
      const close = str.indexOf("'", i + 1)
      if (close === -1) throw new ParseError('unterminated single quote')
      pushWordChar(str.slice(i + 1, close))
      i = close + 1
      continue
    }

    if (ch === '"') {
      i += 1
      let buf = ''
      let closed = false
      while (i < n) {
        const c = str[i]
        if (c === '"') {
          closed = true
          i += 1
          break
        }
        if (c === '\\' && i + 1 < n && /["\\$`\n]/.test(str[i + 1])) {
          buf += str[i + 1]
          i += 2
          continue
        }
        if (c === '$' && str[i + 1] === '(') {
          i = scanSubstitution(str, i + 1, out)
          continue
        }
        if (c === '`') {
          i = scanBacktick(str, i, out)
          continue
        }
        buf += c
        i += 1
      }
      if (!closed) throw new ParseError('unterminated double quote')
      pushWordChar(buf)
      continue
    }

    if (ch === '\\') {
      if (i + 1 >= n) throw new ParseError('dangling escape')
      if (str[i + 1] === '\n') {
        i += 2 // line continuation
        continue
      }
      pushWordChar(str[i + 1])
      i += 2
      continue
    }

    if (ch === '$' && str[i + 1] === '(') {
      i = scanSubstitution(str, i + 1, out)
      continue
    }

    if (ch === '`') {
      i = scanBacktick(str, i, out)
      continue
    }

    if (ch === '(' && word === null && argv.length === 0) {
      // subshell grouping as its own command
      i = scan(str, i + 1, out, ')')
      continue
    }

    if (/\s/.test(ch) && ch !== '\n') {
      endWord()
      i += 1
      continue
    }

    if (ch === '\n') {
      endWord()
      i += 1
      if (pendingHeredocs.length) consumeHeredocBodies()
      endCommand()
      continue
    }

    if (ch === ';' || ch === '|' || ch === '&') {
      endWord()
      if (ch === '&' && str[i + 1] === '&') i += 2
      else if (ch === '|' && str[i + 1] === '|') i += 2
      else i += 1
      endCommand()
      continue
    }

    if (ch === '<' && str[i + 1] === '<') {
      endWord()
      let j = i + 2
      let strip = false
      if (str[j] === '-') {
        strip = true
        j += 1
      }
      while (str[j] === ' ' || str[j] === '\t') j += 1
      let delim = ''
      if (str[j] === "'" || str[j] === '"') {
        const q = str[j]
        const close = str.indexOf(q, j + 1)
        if (close === -1) throw new ParseError('unterminated heredoc delimiter quote')
        delim = str.slice(j + 1, close)
        j = close + 1
      } else {
        const m = /^[^\s;&|()<>]+/.exec(str.slice(j))
        if (!m) throw new ParseError('missing heredoc delimiter')
        delim = m[0]
        j += m[0].length
      }
      pendingHeredocs.push({ delim, strip })
      i = j
      continue
    }

    if (ch === '>' || ch === '<') {
      // simple redirection target: skip the operator and its target word,
      // it's not part of argv.
      i += 1
      if (str[i] === '>' || str[i] === '&') i += 1
      while (i < n && /\s/.test(str[i])) i += 1
      // consume one word as the redirection target (reuse word scanning by
      // a tiny inline loop; quotes still respected minimally)
      while (i < n && !/\s/.test(str[i]) && !';|&\n'.includes(str[i])) {
        if (str[i] === "'") {
          const close = str.indexOf("'", i + 1)
          if (close === -1) throw new ParseError('unterminated single quote')
          i = close + 1
          continue
        }
        if (str[i] === '"') {
          const close = str.indexOf('"', i + 1)
          if (close === -1) throw new ParseError('unterminated double quote')
          i = close + 1
          continue
        }
        i += 1
      }
      continue
    }

    if (ch === ')') {
      // stray close paren with no matching open at this level
      throw new ParseError('unbalanced )')
    }

    pushWordChar(ch)
    i += 1
  }

  if (terminator) throw new ParseError(`unterminated ${terminator === ')' ? 'subshell/substitution' : 'backtick'}`)
  if (pendingHeredocs.length) throw new ParseError('unterminated heredoc')
  endCommand()
  return i
}

// str[open] === '(' (the char right after "$"); consumes the balanced ")".
function scanSubstitution(str, open, out) {
  const end = findBalancedParen(str, open)
  if (end === -1) throw new ParseError('unterminated $(...)')
  const inner = str.slice(open + 1, end)
  scan(inner, 0, out, null)
  return end + 1
}

function findBalancedParen(str, open) {
  let depth = 0
  let i = open
  const n = str.length
  while (i < n) {
    const ch = str[i]
    if (ch === "'") {
      const close = str.indexOf("'", i + 1)
      if (close === -1) return -1
      i = close + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < n && str[j] !== '"') {
        if (str[j] === '\\') j += 1
        j += 1
      }
      if (j >= n) return -1
      i = j + 1
      continue
    }
    if (ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      i += 1
      if (depth === 0) return i - 1
      continue
    }
    i += 1
  }
  return -1
}

// str[i] === '`'; consumes through the matching unescaped backtick.
function scanBacktick(str, i, out) {
  let j = i + 1
  const n = str.length
  let buf = ''
  while (j < n && str[j] !== '`') {
    if (str[j] === '\\' && j + 1 < n) {
      buf += str[j + 1]
      j += 2
      continue
    }
    buf += str[j]
    j += 1
  }
  if (j >= n) throw new ParseError('unterminated backtick')
  scan(buf, 0, out, null)
  return j + 1
}

// --- assignment / wrapper / interpreter resolution ----------------------

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
}

// Strips leading VAR=val assignments, then repeatedly unwraps known
// passthrough executables (env/sudo/nohup/time/xargs/command) to find the
// argv of the program that actually runs.
function resolveArgv(argv) {
  let a = argv.slice()
  while (a.length && isAssignment(a[0])) a = a.slice(1)
  let guard = 0
  while (a.length && guard++ < 20) {
    const name = basename(a[0]).toLowerCase()
    if (!WRAPPER_NAMES.has(name)) break
    let j = 1
    // env/command allow VAR=val prefixes too
    while (j < a.length && isAssignment(a[j])) j += 1
    while (j < a.length && a[j].startsWith('-')) {
      const flag = a[j]
      j += 1
      if ((name === 'sudo' && (flag === '-u' || flag === '--user')) || (name === 'xargs' && /^-[InPsad]$/.test(flag))) {
        j += 1 // these take a separate value token
      }
    }
    if (j >= a.length) return a.slice(a.length) // nothing left to run
    a = a.slice(j)
  }
  return a
}

function resolveAndEmit(rawArgv, out) {
  const argv = resolveArgv(rawArgv)
  if (!argv.length) return
  out.commands.push(argv)
  const name = basename(argv[0]).toLowerCase()

  if (SHELLS.has(name)) {
    const ci = argv.indexOf('-c')
    if (ci !== -1 && argv[ci + 1] !== undefined) {
      scan(argv[ci + 1], 0, out, null)
    }
    return
  }
  if (name === 'node' || name === 'nodejs') {
    const ei = argv.indexOf('-e')
    if (ei !== -1 && argv[ei + 1] !== undefined) out.rawTexts.push(argv[ei + 1])
    return
  }
  if (name === 'python' || name === 'python3') {
    const ci = argv.indexOf('-c')
    if (ci !== -1 && argv[ci + 1] !== undefined) out.rawTexts.push(argv[ci + 1])
    return
  }
  if (name === 'pwsh' || name === 'powershell' || name === 'powershell.exe') {
    const ci = argv.findIndex((w) => /^-command$/i.test(w))
    if (ci !== -1 && argv[ci + 1] !== undefined) out.rawTexts.push(argv[ci + 1])
    return
  }
}

// Parses `command` and returns `{ commands, rawTexts }`:
//  - commands: argv arrays for every simple command found, at every nesting
//    level (subshells, $(...), backticks, `sh -c "..."` bodies), already
//    resolved past leading assignments and known wrapper executables.
//  - rawTexts: script bodies handed to `node -e`, `python -c`, or
//    `pwsh/powershell -Command`, which are code, not shell, and are meant to
//    be scanned with a conservative text check rather than parsed as shell.
// Throws ParseError on anything it can't make sense of; callers must treat
// that as fail-closed (hold), never as "no match".
export function parseShellCommands(command) {
  const out = { commands: [], rawTexts: [] }
  scan(String(command ?? ''), 0, out, null)
  return out
}
