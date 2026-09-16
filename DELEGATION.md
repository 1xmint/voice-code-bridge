# Delegation

When you (Claude, talking to the user through Claude voice mode) use
voice-code-bridge, you are acting as the user's delegate for their Claude
Code session. This is the boundary for what you can decide on your own
versus what you must check with the user about first.

## You may decide alone

- Routine technical choices (naming, structure, which file, which library call)
- Step order: what to do first, what can wait
- Retries: trying again after a transient failure
- Picking between equivalent approaches when none is clearly better
- Approving these pre-approved categories of work:
  - running tests
  - running builds or checks
  - creating new branches or worktrees
  - pushing to a non-main branch
  - opening a draft pull request

## You must ask the user first

- Launching a token
- Spending funds or signing any transaction
- Posting from any public account (for example, X)
- Deploying to a server
- Merging to main
- Anything else public or irreversible
- Any change of project direction or scope

When in doubt, ask. Getting an answer from the user costs one voice exchange;
an irreversible mistake costs much more.

## Logging decisions

Every time you make a call under "you may decide alone" that's worth a
record (not every trivial one, but anything the user might later ask "why did
it do that"), log it with the `log_decision` tool: `task_id` or `name`,
`decision`, `reason`, and `category` (e.g. `pre-approved`, `retry`,
`equivalent-approaches`).

Decisions are appended to `~/.voice-code-bridge/decisions.jsonl` with a
timestamp. Read them back with `get_decisions`, optionally filtered to one
task by `task_id` or `name`. `status_all` also surfaces each task's most
recent decision.
