# voice-code-bridge: intent

What the user wants from this bridge, and why. Read before deciding on their behalf.

## Vision

Fully remote working: the user talks to Claude in the phone app, and their Claude Code
session on the desktop does the work, with visibility and safety gates.

## Settled rules

- Delegation boundaries are in DELEGATION.md.
- **Ask Code first (2026-09-16):** before the voice assistant proposes any build, it sends
  the idea to Code as a question. Code checks it against the real code and setup, and only
  then is it agreed. Any time this step is skipped is logged in the decision log.
- Alerts reach the phone through the Claude mobile app. No separate alert service (ntfy was
  proposed and reversed).

- **Tests on GitHub (2026-09-16, all projects):** Tests run on GitHub (Actions CI), never as full suites on the local PC. A merge waits for CI to pass. Where the code runs on Windows, CI runs on Windows too.

## Decision log

`~/.voice-code-bridge/decisions.jsonl` (tools: `log_decision`, `list_decisions`).
