# Agents

planestro runs workers on two agent CLIs. The engine knows neither by name: it asks
`ports.agents[runner]` for a turn and treats the result the same way.

| | **Claude runner** (`runner: claude`, the default) | **Codex runner** (`runner: codex`) |
|---|---|---|
| CLI | Claude Code, through the Agent SDK | app-server for general work; exec for existing art |
| Can plan | yes — plan mode, `submit_plan`, `submit_breakdown` | yes with app-server; exec implements and fixes |
| Reports through | planestro's tools: `report_done`, `report_blocked`, `add_note`, `hand_off`, `AskUserQuestion` | app-server: scoped tools over stdio; exec: a constrained final message |
| Images | cannot generate them | validated on exec only; app-server art stays disabled |
| What it may do | a **per-command policy**: pushes, PR operations and protected branches are denied outright; an allow-list covers the routine, ordinary commands that stay inside the worktree included; its shell starts every command in the worktree and a `cd` out of it is refused; anything else *parks* as a permission request you answer | a **sandbox**: writes confined to the worktree (and temp), no network for its commands. app-server approvals are recorded and declined immediately, ending the turn for a later decision; exec has no permission callback |
| Budget | dollars: `budget_usd_per_item` | turns and tokens: `budget_turns_per_item`, `budget_tokens_per_item` |
| Conversation id | `session_id` | `agent_sessions.codex.session_id` with role and tool contract — a Codex thread cannot resume a Claude session or the reverse |
| Concurrency | `concurrency.max_sessions` admits items | `concurrency.runner_limits.codex` (default 1: image generation is slow and rate-limited) |

Both are verified the same way afterwards: a clean tree and commits ahead of the base, or
the item blocks. Neither can push — Claude because the policy refuses it, Codex because
its sandbox has no network. Both read your repository's own `CLAUDE.md` / `AGENTS.md`.

**Say the trust difference out loud.** A Claude worker that wants to do something unusual
asks you first. A Codex worker remains confined to its sandbox. App-server can record questions and approval requests, decline them immediately, and end its turn; no process waits for the user's answer. Exec art retains its existing final-message question flow. The item
page says which one an item runs under.

The orchestrator can use either provider. Explicit switching in both directions starts from current persisted context; see [Switching providers](switching-providers.md).

## Models

`models` in `planestro.yml` is the list the planner/implementer pickers offer:

```yaml
models:
  - { id: opus-5-5, label: Opus 5.5, claude_model: claude-opus-5-5, description: "Code, tests and docs. Cannot generate images." }
  - { id: fable-5-1, label: Fable 5.1, claude_model: claude-fable-5-1, fallback: opus-5-5 }
  - { id: codex-art, label: Codex Art, runner: codex, hold_for_review: true,
      description: "All raster art: icons, sprites, illustrations. Does not write code." }
```

- `runner` — which CLI runs it. A model that cannot plan is never offered as a planner, and
  the engine blocks an item that names one (`planner_cannot_plan`).
- `claude_model` / `codex_model` — the CLI's own model id. `codex_model` may be omitted:
  Codex then uses the model its own configuration names.
- `codex_effort` / `codex_tier` — Codex only: the reasoning effort (`low`…`xhigh`) and service
  tier (`default`, or `priority` for speed at a faster usage drain) of every turn on the row,
  so a low-effort orchestrator and a high-effort planner can share one Codex model. Unset
  leaves Codex's defaults. See [Configuration](configuration.md#models-and-defaults).
- `description` — one line on what the model is *for*. The epic planner routes children by
  it, so write it as an instruction: what to send here, and what never to.
- `hold_for_review` — park this model's pull requests on `awaiting: review` after CI,
  until you have looked. Meant for art; works for any model.
- `fallback` — another model on the same runner that takes over, for items that tick
  **allow fallback model**, while this one is out of usage. See
  [Model fallback](configuration.md#model-fallback).
- `external: true` — not run by planestro at all; its items are watched.

### Adding a Codex model

1. Install and log in: `codex login`. planestro warns at startup if the installed version
   differs from the one it was validated against (`packages/server/src/compat.ts`).
2. Add the `codex-art` row above to `models`.
3. Give an item that implementer — by hand, from the **art-item** / **art-repaint** prompt
   templates, or let an epic's planner route it.

Every Codex turn runs with `--ignore-user-config`: your personal Codex config, MCP servers
and rules are not inherited by workers; the repository's `AGENTS.md` still is.

## What a worker is told

Every turn is rendered from the prompt library (see [Prompts](prompts.md)) and the item's
files — never from the agent's memory. The worker rules (`worker-system` for Claude,
`worker-system-codex` for Codex) state the git scope, how to report, and — for Codex — how
to treat its sandbox: a refusal of something the task needs is `blocked`; a refusal of
something incidental (a tool's cache directory, an optional check) is worked around or
skipped and mentioned, not a reason to stop.

Image attachments on an item are passed to a Codex turn as image inputs (`-i`), so a
reference picture or an annotated screenshot reaches the model as a picture, not a path.
