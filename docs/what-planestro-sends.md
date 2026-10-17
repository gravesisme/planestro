# What planestro sends

planestro has no telemetry, no analytics and no crash reporting. It has no server of its own to send
anything to. A build from source sends nothing that you did not configure.

Everything that leaves your machine goes through a tool you installed and logged in to yourself:

| What | When | Where it goes |
| --- | --- | --- |
| `git` | fetch, push and worktree work in your code repository; `git.auto_push` for the planning repository | the remotes you configured |
| `gh` | pull requests, CI runs, runners, issues you import | GitHub, as your `gh` login |
| `claude` / the Claude Agent SDK | each turn and orchestrator wake: the prompt, the item's text, the files the agent reads | Anthropic, as your Claude Code login |
| `codex` | each turn routed to Codex | OpenAI, as your Codex login |
| MCP servers | the tool calls an agent makes to a server you added | that server |
| Notification commands | `notifications.on_merge`, `on_needs_you`, `on_usage_pause` | whatever the command you wrote does |
| Other planestro servers | the Projects page reads `/api/state` from the other instances on this machine | `127.0.0.1` |
| Self-update | only with `update.channel: main-green` (off by default): `git fetch` of the planestro checkout and `gh` reads of its CI | GitHub |

Your items, prompts, questions and attachments stay in your planning repository, and the journal
stays on disk beside it (it is not versioned). They reach a provider only as part of a turn's
prompt, and reach a remote only if you push the planning repository somewhere.

The web UI loads nothing from the internet: no fonts, scripts or images from elsewhere, and its
Content-Security-Policy refuses them. A Markdown image that points off the machine is shown as a
link, not loaded. See [SECURITY.md](../SECURITY.md) for who can reach the UI itself.
