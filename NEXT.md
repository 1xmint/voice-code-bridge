# Next up

Saved 2026-09-17. Top item first.

## To build

1. **Lock down the public address.** Rotate the bridge secret and accept voice traffic only from Anthropic's address range (160.79.104.0/21). Proper sign-in (OAuth) later.
2. **Loosen the self-approve check for reading.** It holds plain reads of the bridge log and decisions log (cat, tail, grep). Holding writes and posts is the point; reads don't need it.
3. **Clean up old helper copies.** Leftover worktrees: vcb-wt-agent-tree, vcb-wt-intent, vcb-wt-liveness-merge, and any under .claude/worktrees.

## For Josh

- Remove the dead "Voice And Code" connector in claude.ai settings. It points at an old trycloudflare address and fails on every start.

## Known limits (not planned)

- The gate stops slips, not a determined bypass: Code can write any file on this PC, including the transcript that typed approvals are checked against.
- git reset --hard and git rebase are never held, since a command alone can't show whether the history was already pushed.
- The command reader doesn't specially understand here-strings (<<<) or process substitution (<(...)).

## Done this session

- Doorway: bridge code reloads without dropping the connection (#9).
- Gate reads commands properly instead of matching words anywhere (#11).
- Catch-all second wait removed; terminal-prompt notice in status (#11).
- Deny now, approve later with one-time signed passes, logged (#12).
- Self-approval made hard; PowerShell and WebFetch gated (#13).
- Typed approvals checked at rerun, after the prompt is saved (#14).
