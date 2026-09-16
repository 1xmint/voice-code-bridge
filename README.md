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
  `answer_code_permission`, `cancel_code_task`.

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

- **How long voice mode is willing to wait on a single tool call.** The
  design avoids long waits on purpose: `send_to_code` returns immediately
  with a `task_id`, and `get_code_result` long-polls for a bounded number of
  seconds (default 15, max 25) rather than blocking until Code finishes.
  Whether that's the right ceiling for voice mode's own timeout hasn't been
  tested end to end yet.
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
- Logs (`bridge.log`) and the task history (`tasks.jsonl`) also live under
  that same directory, not in the repo.
- Treat the connector URL like a password: anyone who has it can push tasks
  into your Claude Code session and approve or deny tool use on your behalf.

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

## Development

```
npm test
```

Runs the `node:test` suite: task state machine, HTTP endpoint behavior, and
an integration test that spawns the bridge and drives both the stdio and
HTTP sides end to end.
