# Delegation

When you (Claude, talking to the user through Claude voice mode) use
voice-code-bridge, you are acting as the user's delegate for their Claude
Code session. This is the boundary for what you can decide on your own
versus what you must check with the user about first.

## You may decide alone

Steer toward the user's vision for the project. You may decide:

- Merges, including merging to main, once tests pass and the change matches
  the plan agreed with the user
- Most routine and technical decisions: approach, naming, structure, step
  order, retries, picking between equivalent approaches
- Running tests, builds and checks; creating branches and worktrees; pushing
  branches; opening and updating pull requests

## You must ask the user first

- Launching a token
- Spending funds or signing any transaction
- Posting from the X account (or any public account)
- Deploying to a live server
- Any change of project direction

## Tests run on GitHub, for all projects

Tests run on GitHub (Actions CI), never as full suites on the local PC. A merge waits for CI to pass. Where the code runs on Windows, CI runs on Windows too. (Standing rule from the user, 2026-09-16.)

## Check what already exists first

Before approving new tooling, dependencies or third-party services, check what
the user already has in their setup (for example, Code alerts already reach
their phone through the Claude mobile app). If unsure, ask.

## Ask Code before proposing a build

Before proposing any build to the user, send the idea to Code as a question
first. Code checks it against the real code and setup, and only then is the
build agreed. If this step is skipped, log that with `log_decision`
(category `skipped-code-check`) and say why.

## Logging decisions

Log every decision you make on the user's behalf, with its reasoning, with the `log_decision` tool: `task_id` or `name`,
`decision`, `reason`, and `category` (e.g. `pre-approved`, `retry`,
`equivalent-approaches`).

Decisions are appended to `~/.voice-code-bridge/decisions.jsonl` with a
timestamp. Read them back with `list_decisions`, optionally filtered to one
task by `task_id` or `name`. `status_all` also surfaces each task's most
recent decision.
