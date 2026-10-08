# Codex CLI spike — findings

Validated on **2026-09-17** against **codex-cli 0.154.0** (macOS, a logged-in ChatGPT
account), in throwaway repositories. Runner: `npm run spike:codex -- <step>`
(`spikes/codex-spike.ts`); live end-to-end runs: `npm run spike:codex-live -- item|review|epic`
(`spikes/codex-live.ts`: the real engine, real git against a local bare remote, the real
Codex CLI; only GitHub and the Claude side are stand-ins). `packages/server/src/compat.ts`
pins the version so planestro can warn when the installed CLI drifts.

| # | Question | Result | Notes |
|---|---|---|---|
| a | Does `codex exec` run fully headless? | **PASS** | **Close stdin** (`stdio: ['ignore', …]`): with a pipe for stdin it prints `Reading additional input from stdin...` and waits forever. With stdin ignored it prints that line once and proceeds. |
| b | Machine-readable progress? | **PASS** | `--json` streams NDJSON: `thread.started{thread_id}`, `turn.started`, `item.started` / `item.completed` with `item.type` `agent_message{text}` or `command_execution{command, aggregated_output, exit_code, status}`, `turn.completed{usage}`. Image generation appears as ordinary `command_execution` items (the agent reads its imagegen skill, then copies the PNG out of `~/.codex/generated_images/<thread_id>/`). |
| c | A structured "done / blocked / question" without MCP? | **PASS** | `--output-schema` constrains the final message; `-o` writes it to a file. Stands in for `report_done` / `report_blocked` / a parked question. |
| d | Can it commit inside a git worktree under the sandbox? | **PASS** | `-s workspace-write -C <worktree>` created files and committed, including in a linked worktree whose git dir lives in the main repository. Writes elsewhere fail `operation not permitted`; network fails `Could not resolve host`. No prompt, no hang. **Correction (2026-09-30, HH-281):** the linked-worktree case passed only because the spike ran under the temp dir, which the sandbox always lets a turn write; in a real checkout every commit failed on `index.lock`. The port now names the worktree's git dir and the shared `objects/`, `refs/heads/`, `logs/refs/heads/` as `sandbox_workspace_write.writable_roots` (`gitWritableRoots`), which works on `resume` too (`--add-dir` does not). |
| e | Resume the same conversation later? | **PASS, but the sandbox is not resumed** | `codex exec resume <thread_id> "<prompt>"` recalls earlier turns. Found by the live acceptance run: with `--ignore-user-config` the resumed thread comes back **read-only** and reports it cannot save or commit. `resume` has no `-s`; `-c sandbox_mode="workspace-write"` works on both forms, so the port always passes it. (The first spike missed this because the author's personal config sets workspace-write.) |
| f | Image generation headless? | **PASS** | The built-in image tool works in `exec`, no API key, no flag: 1254×1254 RGBA with real transparency; resized and committed by the agent on request. |
| g | Image-to-image with `-i ref.png`? | **PASS, with a caveat** | The tool *edits from* the attached image: same subject, pose, lighting, framing; recoloured as asked. It is a strongly guided regeneration, not a pixel-preserving edit (surface texture changed). Anything that must stay pixel-exact still needs the project's own deterministic finishing step. |
| h | Killed mid-turn | **PASS, note the exit code** | SIGTERM ends the process with **exit 0** and no final message: "killed" is what the port remembers, not what Codex reports, and *exit 0 without a final message* is an incomplete turn. Resuming afterwards works; stderr logs one harmless `Custom tool call output is missing`. |
| i | Resuming a thread that does not exist | **PASS** | Exit 1 at once, stderr `thread/resume failed: no rollout found for thread id …` → `session_lost`. |
| j | Config isolation | **PASS** | `--ignore-user-config` keeps the login and still reads the repo's `AGENTS.md`, while dropping the user's MCP servers (whose auth failures otherwise spam stderr). |
| k | `--add-dir` | **do not use** | It grants *write* access. Reads outside the workspace are already allowed; a worker must never be able to write the data dir. |
| l | Cost accounting | **PARTIAL** | `turn.completed.usage` is tokens (input / cached / output / reasoning), never dollars. A live art turn used 20–35k uncached tokens; budgets for Codex items are turns and tokens. |
| m | Over-obedience | note | Told "never work around a sandbox refusal", Codex reported `blocked` when an *optional* check's cache write was refused. Told to "match the existing art" in a repository with none, it asked for a reference instead of guessing. Both are right; both were fixed in the prompt, not the port. |

Still unprovoked, so unverified: an expired login and a rate limit. The port classifies
them from stderr patterns (`auth_required`, `rate_limited`); a real occurrence should
confirm the patterns.

## App-server validation — 2026-10-07

Validated with **codex-cli 0.154.0** and the configurable model **gpt-6-astra**,
using the existing login in disposable fixtures. The adapter verifies that the
thread returns the requested model; there is no engine branch for this model ID.
Protocol bindings were generated locally with `codex app-server generate-ts`.

- `thread/start`, `thread/resume`, `turn/start`, dynamic `item/tool/call`,
  replies, token notifications and `turn/interrupt` were exercised.
  An initial small tool turn consumed 13,977 budget tokens; its resume consumed
  573, confirming that the adapter subtracts the earlier conversation total.
- Unlike exec finding **a**, **app-server stdin must remain open**. It carries
  JSON-RPC replies throughout the turn and outstanding tool work. A delayed shell
  command followed by a dynamic tool call succeeded. This is the same open-stream
  requirement as [sdk-notes gotcha 11](sdk-notes.md). Approval requests are recorded
  then declined in their handling cycle; no RPC waits for a human.
- **`thread/resume` does not replace developer instructions** (#246, 2026-10-08,
  codex-cli 0.154.0, gpt-6-astra). A thread started with "Standing rule, version 1:
  answer with RULE-1" and resumed with `developerInstructions` saying version 2 still
  answered `RULE-1` (two runs); its rollout holds only the version-1 developer message (the resume
  wrote none). `ThreadResumeParams` accepts the field and ignores it for a stored thread.
  Restating version 2 at the top of the resumed turn's *input* did not win either: still
  `RULE-1`. A changed `orchestrator-system` / `standing-decisions` therefore reaches a
  resumed Codex conversation only through a fresh thread. Tokens: 10,818 fresh, 220 and
  277 for the resumes.
- Every start and resume specifies sandbox policy. Fresh and resumed workspace
  turns both wrote their expected fixture file. Coding turns share exec's narrow
  linked-worktree Git write paths (index/HEAD, objects and branch refs/logs); the
  shared Git configuration and hooks remain read-only. Read-only planning handed in its
  plan through Planestro, with Claude absent from the selected model rows.
  Scoped call tests reject foreign threads/turns, forged item arguments and roles.
- **Isolation regression found live:** an empty `mcp_servers` override alone
  did not stop a project server starting. The effective config concealed that
  server, while the raw project layer still contained it. The adapter now reads
  **all** config layers, replaces every listed server with a complete disabled
  transport, and disables personal plugins/app tools/skill MCP installation and
  native web search. PR/diff/run inspection uses deterministic Planestro tools.
  A harmless server-start canary stayed absent on corrected fresh and resumed
  turns. Missing config-layer support fails closed. External tools use parent-owned
  clients over the scoped stdio dispatch, never the operator `/mcp` endpoint.
- Native image generation produced a completed `imageGeneration` event.
  **Image-to-image did not produce a validated image result**, so app-server art
  remains disabled (`features.image_generation: false`); art workers stay on exec.
  **Reference reading was separately validated** in a read-only session with image
  generation disabled: the model identified a blue fixture via a scoped tool,
  without commands or an image-generation event. Code/planning attachments may
  therefore be read without enabling art creation or editing.
- An isolated home without login returned HTTP 401 and is classified
  `auth_required`. The user's login was never removed or changed. Expired OAuth
  refresh and actual quota exhaustion/reset were **not** provoked.
- `account/rateLimits/read` returned `primary.usedPercent`,
  `windowDurationMins`, `resetsAt`, and optional/null secondary/limit fields.
  This proves the reading's shape, **not exhaustion/reset semantics or reliable
  live notifications**. No Codex `RateLimitSnapshot` is constructed yet; manual
  `model_unavailable` suspension remains available. A later capacity failure
  (`serverOverloaded`) remains an explicit runner error, not an invented quota
  outage. Legacy exec stderr exhaustion patterns remain unconfirmed.

### Fresh-context measurements

The representative fixture supplies synthetic backlog items and real code-reading
work. The fresh wake inspects schema/orchestrator source and the backlog; the
fresh planner reads schema, settings, GitHub ports, orchestration and related tests
before submitting its plan. Measurements count exactly
`max(0, input_tokens - cached_input_tokens) + output_tokens`.

| Turn | Budget tokens | Last context | Outcome |
|---|---:|---:|---|
| Fresh orchestrator wake, first run | 48,537 | 47,330 | Completed |
| Fresh orchestrator wake, corrected isolation | 50,204 | 48,958 | Completed |
| Fresh planning turn, first run | 62,417 | 59,572 | Plan submitted |
| Fresh planning repeat | 0 | Not reported | Provider at capacity |

The 200,000 fresh-wake allowance accommodated both wakes; the second already
exceeded the regular 50,000 allowance. The measured plan fitted within 100,000,
but this is one bounded task, not evidence that every large planning handoff fits.
The defaults remain **100,000 per planning turn, 50,000 per resumed wake,
200,000 per fresh wake**, all configurable. No configured limits were changed.
Notifications arrive after model responses; an in-flight response may overshoot
a cap. Exec only reports usage at turn completion; Planestro must not kill the
already completed turn before ingesting its final JSON. Its full usage is charged,
and the engine checks the item cap before the next turn. Reasoning tokens are already included in output.

Native app-server requests without an existing decision are persisted, declined
immediately and parked. **Allow once** for a complete local command saves its exact
command and working directory in the pending turn. When the worker reissues that
same request, planestro persists consumption before replying `accept`. Unconsumed
grants survive a deferred turn or restart; consumed grants cannot be replayed.
This is a planestro-owned grant, not a Codex grant on the old request. It never
widens the next turn's sandbox or writes an exec-policy rule. Different commands
park again. Remote execution, host/network grants, additional filesystem
permissions, unknown permission fields and permanent approvals remain unsupported.
External MCP tools retain their separate permission policy and scoped call budgets.

App-server credentials are seeded once into the dedicated home by atomically
linking a complete private file. Subsequent turns preserve Codex's refresh-token
rotation. Credential-free tests cover concurrent initialization and a simulated
rotation; they do not claim to provoke a live OAuth refresh or change the user's
login. Reauthentication in that home is documented in the provider-switch guide.

A capped wake uses the existing plan/permission/triage/question end hooks and
journals its outcome and tokens. Its batch is discarded. The wake queue stays in
memory; restart derives needed wakes from persisted item/question state. Shutdown
interruptions skip those end hooks, leaving that persisted ownership intact.

Reproduce manually (these are authenticated, never CI commands):

- `npx tsx spikes/app-server-validation.ts`: dynamic tools and resume, and whether resume
  takes new developer instructions (#246).
- `npx tsx spikes/app-server-representative.ts`: fresh-context measurements and isolated auth.
- `npx tsx spikes/app-server-capabilities.ts`: writable resume, open stream and isolation;
  add `--images` for the optional raw-protocol art validation.
- `npx tsx spikes/app-server-reference-image.ts`: read-only attachment recognition,
  with generation disabled.

### Manual backlog acceptance after upgrade

These are the user's real backlog, not automated fixtures. They were not changed
by implementation or live validation.

- HH-345 / HH-429: select explicitly, inspect the preview, then verify approved work
  continues from current dirty files/commits with the existing worktree and branch.
- HH-438: keep the pending plan approval and its conditions.
- HH-433: keep the existing art implementer, exec transport, PR and review state.
- Switch a selected coding item back to Claude and verify a new brief includes the
  Codex work; the original Claude conversation must not resume.


**Later finding (2026-09-17):** `-i/--image` takes one or more files, so a prompt placed right after it is read as another image and `codex exec` falls back to stdin ("No prompt provided via stdin"). The port ends the options with `--` before the prompt.
