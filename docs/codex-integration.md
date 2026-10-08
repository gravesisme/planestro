# Codex integration

General planning, coding, and orchestration use app-server over stdio when a model row sets `codex_transport: app-server`. See [Switching providers](switching-providers.md) for setup and continuation in either direction. The transport sections below describe the legacy `exec` path, which remains the default for existing Codex rows and art workers.

App-server command requests offer **Allow once**. planestro ends the requesting
turn, saves your decision with the next turn, and accepts the exact same local
command and working directory once when the worker retries. The grant is consumed
on disk before acceptance, including across restarts. Other commands keep the
normal sandbox; permanent rules and broader network/filesystem grants are not
supported. A changed command asks again. This uses the protocol's per-command
[`accept` decision](https://learn.chatgpt.com/docs/app-server#command-execution-approvals).

planestro runs implement and fix turns on the Codex CLI for any model with
`runner: codex` (see [Agents](agents.md)). The port is
`packages/server/src/engine/sessions/LiveCodexPort.ts`; everything it does was established
by a spike against the real CLI, recorded in [`notes/codex-spike.md`](notes/codex-spike.md).

## One turn

```
codex exec [resume <thread_id>] --json --ignore-user-config
           -c sandbox_mode="workspace-write"  [-s workspace-write -C <worktree>]   # the last two on a fresh thread only
           --output-schema final.schema.json -o last.json
           [-m <codex_model>] [-c model_reasoning_effort="<codex_effort>"] [-c service_tier="<codex_tier>"]
           [-i <image> …]   "<worker rules>\n\n---\n\n<prompt>"
```

| Step | What happens | Why |
|---|---|---|
| spawn | stdin is **ignored** | given a pipe, `codex exec` waits on it forever |
| sandbox | `workspace-write`, passed as a config override on **every** turn | a resumed thread does not keep its sandbox: without the override it comes back read-only |
| isolation | `--ignore-user-config` | workers never inherit the operator's personal Codex config or MCP servers; the repository's `AGENTS.md` is still read |
| no `--add-dir` | — | it grants *write* access; the data dir must stay read-only to a worker |
| rules | the `worker-system-codex` prompt rides at the top of the prompt | Codex has no system-prompt flag |
| images | every image attachment of the item is passed with `-i` | a reference picture or annotated screenshot reaches the model as a picture |
| progress | NDJSON events become console lines (`agent_message`, `→ command`, non-zero exits, errors); unknown events are skipped | the console is read by a person; the parser must survive a CLI upgrade |
| result | the final message, constrained by `--output-schema` | the worker has no planestro tools, so its last words are the report |

The final message is `{ "outcome": "done" | "blocked" | "question", "summary", "question", "hold", "parts", "hand_off" }`:

- **done** → `report_done(summary)`; the summary becomes the pull request body.
- **hold** (`null`, or what the pull request waits for) → passed to `report_done` with a
  `done`: the pull request is opened held, with that reason on the item
  ([Concepts](concepts.md#holds)).
- **blocked** → `report_blocked(summary)`; the item blocks as `agent_blocked`.
- **question** → the item parks on `awaiting: question` with a free-text answer box; your
  answer resumes the same thread.
- **hand_off** (`null`, or `{to, paths, note}`) → `hand_off(to, paths, note)` before the
  outcome is handled: the named files go to the item that waits on this one
  ([Concepts](concepts.md#handing-files-to-another-item)).

After the turn the engine does what it does for any worker: a dirty tree is sent back to be
committed, no commits ahead of the base blocks as `no_commits`, a changed file over
`review.max_file_bytes` blocks as `asset_too_large`; otherwise it pushes and opens the pull
request.

## Failure shapes

| What happened | How it is recognised | Result |
|---|---|---|
| The engine stopped mid-turn | the port sent SIGTERM (Codex then exits **0** with no final message) | `killed`: not an error; the turn is resumed at the next start |
| Exit 0, no final message | — | `no_final_message`: blocks as `turn_error`; unblocking resumes the thread |
| Thread cannot be resumed | stderr `no rollout found for thread id` | blocks as `session_lost`; the stored thread id is dropped, so the retry starts a fresh thread with the full prompt |
| Not logged in | stderr / error event mentions login, 401, token | blocks as `auth_required` — run `codex login`, unblock |
| Usage or rate limit | mentions rate limit, 429, usage limit, quota | blocks as `rate_limited` — wait, unblock |
| `codex` not found | spawn error | blocks as `spawn_error` — install it, or set *codex binary* in Settings |

The last three keep their own names because the fix is yours, not a judgment call for the
orchestrator.

## Budgets

Codex reports tokens, never dollars. Each turn adds to the item's `agent_turns` and
`tokens` (uncached input + output); `budget_turns_per_item` (20) and
`budget_tokens_per_item` (600 000) stop a runaway before its next turn. A live art turn
measured 20–35k tokens. The item page shows them beside the dollar cost of its Claude turns.

## Proving it

- `packages/server/test/codexPort.test.ts` drives the port against a **fake `codex` binary**
  that replays the recorded behaviour — including waiting on stdin and exiting 0 on SIGTERM.
- `packages/server/test/engine.codex.test.ts` drives the engine on dry-run ports: a held
  item, a parked question, guards and budgets, review round-trips, an epic breakdown, and
  the whole mixed-agent story in one test.
- `npm run spike:codex-live -- item | review | epic` is the live acceptance: the real
  engine, real git against a local bare remote, the **real Codex CLI**; only GitHub and the
  Claude side are stand-ins. It spends Codex quota and touches no real repository.
