---
name: planestro
description: Status, start, stop and item lookup for the planestro servers on this machine. Invoked as /planestro [status | start [--port N --host H --watch] | stop | item <ID>].
disable-model-invocation: true
argument-hint: "[status | start [--port N] | stop | item <ID>]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/planestro *)
---

# /planestro

You are operating planestro, the backlog and agent orchestrator, for the person at the keyboard.
The script is **read-only** except `start` and `stop`. planestro owns its state: never edit its data
files (items, `planestro.yml`, `.planestro/`) and never call its HTTP API (`/api/...`) to change
anything, since a change made that way reads as the user's own click. Changes the user asks for go
through the `planestro` MCP tools (below), and only the ones the project's `operator_mcp` settings list.

Every action goes through one script, `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro"`, which finds the
project's data dir (the current directory, `<repo>/planning`, or `$PLANESTRO_DATA_DIR`) and a
planestro checkout (`$PLANESTRO_DIR`, the checkout this plugin is installed from, or `../planestro` beside the repo).
Run it with the Bash tool, **in the foreground: never with `run_in_background`**, with a timeout of
at least 120000 ms for `start`. If it fails, show its message: it says what is missing.

The arguments were: `$ARGUMENTS`

## What to do

Take the first word of the arguments.

**Empty or `status`**
1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro" call get_state`.
2. If it says there is no data dir here, run `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro" status --json`
   and, for each instance, `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro" call get_state --url <its url>`.
3. If it says the project is not running, say so in one line and offer `/planestro start`.
4. Summarize briefly: project name and URL; engine mode, and PAUSED if paused; then **needs you**,
   **blocked** (with the reasons), **awaiting review**, **running**, **queued**, and **open PRs** with
   their CI. Name items by id and title (`list_items` gives titles:
   `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro" call list_items`). Omit empty groups. End with one line
   per other running instance (`instances.others`).

**`start`** (anything after it is passed on as flags)
1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro" start <the remaining arguments>`. When the repo has
   `start-planestro.sh`, the script uses it and ignores the flags.
2. If it asks for a port, ask the user which one (show `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro" status`
   so they can see which are taken) and suggest `--port N`. Never pick one yourself.
3. Report the URL, the log path and the reconcile corrections it printed. "already running" is
   success. The server runs in a session of its own and outlives this conversation.

**`stop`**
Run `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro" stop` and report what it stopped. It stops only this
project's server. It never stops a server for another data dir; to stop one, the user runs `/planestro
stop` from that project.

**`item <ID>`**
Run `"${CLAUDE_PLUGIN_ROOT}/scripts/planestro" item <ID>` and summarize: title, kind and status;
blocked or awaiting and why; PR and CI; the plan in a few lines; the last five Activity entries.

**Anything else** is a question about the backlog. Answer it from `get_state`, `list_items` (filters:
`'{"status":"IN_REVIEW"}'`, `'{"epic":"HH-113"}'`, `'{"queued":true}'`, `'{"q":"text"}'`) and `get_item`
through the same script. The plugin also registers the `planestro` MCP server, a bridge to
this project's own running server (`$PLANESTRO_URL` overrides it); its tools are the same, so use them when they are
connected.

**A change the user asks for** (file an item, submit or queue it, move it into or out of the Icebox,
reorder, unblock, message a session, approve a plan, …) is a `planestro` MCP tool call: `create_item`
then `submit_item` for "file it and queue it", `move_item` with `icebox` / `backlog` / `top` / … for
moves. Each tool appears only when its opt-in is on in the project's `planestro.yml`
(`operator_mcp.allow_writes`, `allow_submit`, `allow_actions`, `allow_decisions`), and the server's
instructions name the ones that are off. When the tool for it is not listed, tell the user which
setting would offer it (Settings → Your own MCP clients), or that it is theirs to do on the board.
Never work around a missing tool.
