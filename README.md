# voice-code-bridge

Talk to your live Claude Code session from Claude's native voice mode (the
Claude phone app), and get results spoken back to you.

## What it does

`voice-code-bridge` runs as one process on your computer, alongside a
terminal running Claude Code. It does two things at once:

- It's a Claude Code **channel** (a research-preview MCP server type):
  Claude Code spawns it over stdio, and it pushes whatever you say in voice
  mode into your Claude Code session as a task, then relays progress reports
  and permission prompts back out.
- It's a small public **HTTP MCP endpoint**, reachable through a tunnel, that
  you register as a custom connector in claude.ai. Voice mode calls tools on
  it: `send_to_code`, `get_code_status`, `get_code_result`,
  `answer_code_permission`, `cancel_code_task`, `log_decision`,
  `list_decisions`, `status_all`.

So the loop is: you talk to Claude on your phone → Claude calls
`send_to_code` → the bridge hands the instruction to your Claude Code
session as a channel event → Claude Code does the work with its normal
tools and calls `report` as it goes → you ask "what did it find" → Claude
calls `get_code_result` and reads the answer back to you.

## What's proven

As of **2026-09-16**: a claude.ai custom connector (no OAuth) pointing at a
[cloudflared](https://github.com/cloudflare/cloudflared) quick tunnel, in
front of a hand-rolled stateless MCP HTTP server, was called successfully
from both typed chat and voice mode in the Claude app. That confirmed the
HTTP side's request/response shape (`server/discover` first, answered with
`-32601`, then `initialize`; `initialize` params echoed back; the
`Claude-User` user agent) — this repo's HTTP endpoint keeps that same
handling.

## What's not yet proven

- **Exactly how long voice mode will wait on a single tool call.** Measured
  so far (2026-09-16): a 3 second call works; a 30 second call fails in the
  app with "MCP tool call failed" even though the server finished it and a
  quick tunnel carries 30 and 110 second calls fine. So the client limit sits
  somewhere under about 31 seconds. `get_code_result` therefore long-polls
  for at most 20 seconds (default 15; override with `VCB_MAX_WAIT_SECONDS`)
  and answers "no change yet" rather than blocking until Code finishes. Each
  tool call's duration is written to `bridge.log`.
- **The full loop against a real Claude Code channel session.** The stdio
  side has been tested by acting as Claude Code (a scripted client that
  sends `initialize`, `tools/call report`, and permission notifications —
  see `test/integration.test.mjs`), but not yet by an actual Claude Code
  process loaded with `--dangerously-load-development-channels`.

## Setup

1. Clone this repo and `npm install` (no dependencies today, but this keeps
   `npm test` conventional).
2. From the repo root, register the bridge as an MCP server for Claude Code:
   ```
   claude mcp add voice-bridge -- node bin/voice-code-bridge.mjs
   ```
3. Run `scripts/start.ps1` in PowerShell. It will:
   - download `cloudflared` into `~/.voice-code-bridge/bin` if it isn't there
     yet,
   - start a quick tunnel to the bridge's HTTP port (default 8790),
   - print the full connector URL (`https://<random>.trycloudflare.com/mcp/<secret>`),
   - check that `voice-bridge` is registered and print the command above if
     it isn't,
   - launch `claude --dangerously-load-development-channels server:voice-bridge --remote-control`
     in the repo directory.
4. In claude.ai, add (or edit) a custom connector pointing at the printed
   URL. Talk to Claude in voice mode and ask it to send something to Code.

**The quick-tunnel URL changes every time you restart the script** —
`cloudflared tunnel --url` mints a new random hostname each run, so you have
to re-edit the connector URL in claude.ai each time. The obvious next step
is a named Cloudflare Tunnel (stable hostname, one-time setup) or a
Tailscale Funnel, either of which would let the connector URL stay fixed.

## Security

- The HTTP endpoint only answers `POST /mcp/<secret>`; everything else,
  including the bare path and wrong secrets, gets a 404.
- The secret is 32 random bytes, generated once on first run and stored
  outside the repo at `~/.voice-code-bridge/config.json` (override the
  directory with the `VCB_HOME` environment variable). It's never logged.
- Secret comparison is constant-time.
- Request bodies are capped in size.
- Logs (`bridge.log`), the task history (`tasks.jsonl`), and the decision
  log (`decisions.jsonl`) also live under that same directory, not in the
  repo.
- Treat the connector URL like a password: anyone who has it can push tasks
  into your Claude Code session and approve or deny tool use on your behalf.

## Decision log and status_all

While delegated (see `DELEGATION.md`), the voice assistant logs notable
decisions with `log_decision` (`task_id` or `name`, `decision`, `reason`,
`category`) and can read them back with `list_decisions`, optionally
filtered to one task. Records append to
`~/.voice-code-bridge/decisions.jsonl` (same `VCB_HOME` override as other
state), one JSON object per line, and are never deleted from there
automatically.

`status_all` returns one compact snapshot of every task currently tracked:
name/id, status, session, spoken summary, age of the last report, a stalled
flag and reason when one applies, the pending question for a task waiting on
the user, and the last logged decision for that task. Use it for "what's
going on" across everything, instead of checking each task one at a time.

## How this relates to Claude Code channels and the dev flag

Channels are a Claude Code **research preview** feature. This bridge isn't
on the built-in allowlist, so it has to be started with
`--dangerously-load-development-channels server:voice-bridge`, which shows a
one-time warning dialog before it loads. If your organization has disabled
channels via the `channelsEnabled` policy, this won't work until an admin
enables it.

## Terms, for anyone else running this

Each person runs their **own, unmodified Claude Code**, signed in with their
**own account**. This bridge never touches Claude credentials, never reads
or forwards your API key or session token, and doesn't route your traffic
through anything other than the tunnel you set up yourself. Whatever
plugins you already use in that Claude Code session (for example,
`orchestrate`) load exactly as they normally would — the bridge is just
another MCP server in the mix, not a wrapper around your session.

## Agent tree: seeing sub-agents, not just "working"

Voice mode used to see one flat status per task: "working". It had no idea
Claude Code had spawned three sub-agents, what each was doing, or which one
was stuck. `agent_tree` fixes that from **real events, not self-reports**.

### Design choice: hooks, not transcript tailing

Two sources exist on disk for this:

- **Session transcripts**, `~/.claude/projects/<proj>/<session>.jsonl`, with
  each spawned sub-agent's own transcript alongside it at
  `<proj>/<session>/subagents/agent-<agentId>.jsonl`, plus a sidecar
  `agent-<agentId>.meta.json` (observed on disk to contain `agentType`,
  `description`, `toolUseId`, `spawnDepth`).
- **Hooks**: `SubagentStart`/`SubagentStop` and `PreToolUse`/`PostToolUse`
  fire synchronously as Claude Code runs, and (per
  `code.claude.com/docs/en/hooks`) already carry `agent_id`, `agent_type`,
  `session_id`, `cwd`, `tool_name`, `tool_input`, and `transcript_path` on
  stdin — Claude Code assigns the identity, we don't have to infer it.

**Hooks are the primary source.** They give real-time, ready-made subagent
identity and exact timing ("this tool call started 12s ago") for free.
Transcripts are written on the CLI's own schedule, require tailing and
parsing nested JSON, and carry no equivalent of "still running right now" —
you'd have to infer liveness by watching a file stop growing. The one thing
transcripts have that hooks don't (per the documented hook fields) is a
sub-agent's **description**, which lives only in that `meta.json` sidecar.
So `src/events.mjs` reads events from the hook log as the source of truth
for identity/current-step/timing, and opportunistically reads the sidecar
`meta.json` (derived from `transcript_path`, best-effort, never required)
purely to enrich a node with the goal Claude Code gave that sub-agent.

### How it works

1. `scripts/agent-tree-hook.mjs` is a small, dependency-free Node script.
   Claude Code runs it once per hook event and hands it JSON on stdin; it
   appends one line to `~/.voice-code-bridge/events.jsonl` and always exits
   0 (a logging failure must never slow down or block a Claude Code turn).
2. `src/events.mjs`'s `buildAgentTree()` reads that log (bounded to the last
   5000 lines) and folds it into one entry per session: the main agent plus
   every sub-agent it spawned, each summarized with `current_tool`,
   `time_on_step_s`, `last_activity_s`, `state`
   (`running`/`blocked`/`done`), a 5-entry rolling action log, and — for the
   session as a whole — `waiting_on`, the sub-agents still running or
   blocked.
3. The `agent_tree` MCP tool (in `src/http.mjs`) calls `buildAgentTree()` and
   returns the whole tree as JSON in one call — cheap, since it's a single
   bounded file read, no polling of Claude Code itself.

### Hook configuration (add this yourself to `settings.json`)

This bridge does not, and will not, edit your `~/.claude/settings.json`.
Add this snippet yourself (merge with any hooks you already have), pointing
`command` at your actual path to `scripts/agent-tree-hook.mjs`:

```json
{
  "hooks": {
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node \"C:/path/to/voice-code-bridge/scripts/agent-tree-hook.mjs\"" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node \"C:/path/to/voice-code-bridge/scripts/agent-tree-hook.mjs\"" }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/path/to/voice-code-bridge/scripts/agent-tree-hook.mjs\"" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/path/to/voice-code-bridge/scripts/agent-tree-hook.mjs\"" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"C:/path/to/voice-code-bridge/scripts/agent-tree-hook.mjs\"" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node \"C:/path/to/voice-code-bridge/scripts/agent-tree-hook.mjs\"" }] }
    ]
  }
}
```

Without this configured, `agent_tree` returns "No agent activity recorded
yet" rather than an error.

### Cross-session relay log

Every message this bridge actually relays — an instruction sent to Code, a
progress report back, a permission request/verdict, a cancel — is appended
to `~/.voice-code-bridge/relays.jsonl` (timestamp, from, to, kind, task_id,
a ~200-char preview), and readable through the `list_relays` tool, filtered
by `task_id`.

**What this can't see:** this bridge is a stdio channel to exactly one
Claude Code process plus one HTTP endpoint for voice. It has no visibility
into peer-to-peer `SendMessage` traffic between *separate* Claude Code
sessions or sub-agents (an agent-teams feature) — that never touches this
process. The only way to capture that would be a hook on whatever tool
agent-teams messaging uses internally (if it fires `PreToolUse`/
`PostToolUse` like any other tool call, `agent-tree-hook.mjs` would already
log it under that tool's name — this hasn't been confirmed against a real
agent-teams session).

## Development

```
npm test
```

Runs the `node:test` suite: task state machine, HTTP endpoint behavior, and
an integration test that spawns the bridge and drives both the stdio and
HTTP sides end to end.
