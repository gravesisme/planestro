# Agent SDK spike — Phase 0 findings

Validated on **2026-08-30** against **Claude Code 2.1.251** and
**@anthropic-ai/claude-agent-sdk 0.3.251** (Node 24.11, macOS), running real
sessions in a throwaway worktree of a real project repo. Runner:
`npm run spike -- <step>` (`spikes/sdk-spike.ts`); raw transcripts of the run
are in `spikes/out/*.stdout` (gitignored). `packages/server/src/compat.ts`
pins these versions so planestro can warn when the installed CLI drifts.

## Taken 2026-10-21: Claude Code 2.1.306 and SDK 0.3.306 (#474)

SDK 0.3.305 → 0.3.306 is a parity release: its changelog has only "Updated to parity with
Claude Code v2.1.306", and its typings (`sdk.d.ts`, `agentSdkTypes.d.ts`, `sdk-tools.d.ts`,
`core.d.ts`) are byte-identical to 0.3.305's. Claude Code 2.1.306 fixes `claude -p` in cloud
sessions reporting "Not logged in" and an API error replaced by "prompt is too long" (with an
unneeded compaction) in sessions with many MCP tools. Neither touches `canUseTool`, hooks,
`cost-state`/`total_cost_usd`, the stdin stream, sessions or budgets, so the 2026-10-20 spike
below stands; the suite passes on the new version.

The bundled CLI was read for #473 at this version: in `dontAsk` an "ask" becomes a deny
(`{type:"mode",mode:"dontAsk"}`) before any host is asked, and the host is not a decider in
that mode, so `canUseTool` is never called there. Custom turns in `dontAsk` (the orchestrator,
the efficiency audit) now pass no callback, which also drops `--permission-prompt-tool=stdio`;
what they may use is still exactly their allow list.

## Re-validated 2026-10-20 against Claude Code 2.1.305 and SDK 0.3.305

SDK 0.3.300 → 0.3.305, whose bundled CLI (2.1.305) is the installed one, so the spike ran
it. Opus 5.5 as planner and implementer, in a throwaway `git init` repo, steps in the
header's order plus `resume-park`. **Every assumption (a)–(n) passes again**, and gotcha
19 was exercised for the first time. About $1.50 of usage.

| Step | Result |
|---|---|
| `plan` (a)(b) | PASS: `submit_plan` reached via `ToolSearch` in plan mode, `success`, 4 turns, stable session id. Plan mode still routes the allow-listed `submit_plan` through `canUseTool` (gotcha 10), although the SDK's shadowing warning says it will not. |
| `resume-impl` (c)(d)(j) | PASS: new process, `mode=acceptEdits`, same id, `PELICAN-42` recalled, `AskUserQuestion` reached `canUseTool` and the deny parked it. |
| `resume-answer` (d)(e) | PASS: `Bash(echo spike-ok)` pre-approved; `uname -a` ran without the callback (gotcha 3). |
| `resume-park` (e) | PASS: `node -e …` reached `canUseTool`, the deny parked it, no retry. (The step's "probe ran anyway: YES" is a false positive: the model's closing text quoted the command.) |
| `kill` (f)(h) | PASS: foreground `sleep 25` blocked and backgrounded (gotcha 8); `claude agents --json` found the pid; SIGTERM → `exited with code 143`. The entry now carries `"status":"busy"` and `startedAt` (nothing in planestro reads it). |
| `resume-after-kill` (f) | PASS: resumed, named the sleep. No zero-turn `result` came first this time (the background sleep died with the process); the engine handles either. |
| `sessions` (g) | PASS: transcript at the derived path; `getSessionInfo` and `listSessions({dir})` find it. |
| `budget` (i) | PASS: `error_max_turns`, `error_max_budget_usd`; `query()` still throws after the error result (gotcha 1). |
| `resume-quote` (k)(l)(m)(n) | PASS: the command hook's quote arrives (16,457 tokens, equal to the stream's window), the SDK's `SessionStart` callback still does not fire on a resume; declining in `UserPromptSubmit` made 0 requests; `total_cost_usd` is the running total ($0.1318 → $0.1657) and the transcript's `cost-state` was the baseline; a cap below the running total still ran 2 requests. Cache TTL 3600 s (gotcha 17). |
| gotcha 19 (scratch script, `secretHook` with `Bash(tail *)` allow-listed) | PASS: `tail -n 1 .env` (allow-listed) and `cat .env` (built-in read-only) were both refused by the PreToolUse hook before running; the file's content never reached the session. |

Changelog 0.3.301–0.3.305 against what `LiveClaudePort` relies on:

- **0.3.302: an omitted `permissionMode` starts in `default` (third-party providers, telemetry
  off, fresh install).** No effect: every planestro `query()` passes it (`ports.ts` makes it
  required). **Fork subagents are on by default** in SDK sessions; a fork run in the background
  is a background task, which the prompt stream (gotcha 11) already waits on through
  `background_tasks_changed`. Not exercised live.
- **0.3.305: servers set with `setMcpServers` were replaced by a same-named server from user
  settings.** planestro passes `mcpServers` at start with `strictMcpConfig: true` and
  `settingSources: ['project']`, so neither the bug nor the fix touches it.
- 0.3.301: per-tool `permission_policy` on sdk MCP server configs, `BUILTIN_TOOL_NAMES`; not used.
  A full disk while refreshing the login now reads `invalid_request`, not `authentication_failed`.
- Nothing about `canUseTool`, PreToolUse hooks, `cost-state`/`total_cost_usd`, the stdin
  stream, `listSessions`/`getSessionInfo` or `maxBudgetUsd`. The rest is `startup()` /
  `prewarm()` timeouts, the browser SDK and `getContextUsage()`, none of which planestro calls.

**`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` is no longer printed (#473).** It named bare allow
entries (`Read, Grep, Glob, mcp__planestro__…`), which only `customAllowedTools` sends,
and only in `dontAsk` mode: the orchestrator's wakes and the efficiency audit (gotcha 4,
#153). The SDK emits it from `query()` whenever a `canUseTool` is passed with a bare entry
(`process.emitWarning`), so `customCanUseTool` passes no callback in `dontAsk`, which never
consults it; worker turns (`splitAllowed`) send no bare names and print nothing. Note the
warning is not accurate for plan mode (see `plan` above): there the callback is still consulted.

One observation: in the `budget` step the model said it had no `Glob` tool and listed
files with `find` through Bash (read-only, auto-approved). planestro only allow-lists
`Glob`, so a session without it loses nothing.

## Re-validated 2026-09-28 against Claude Code 2.1.284

Same SDK (0.3.251), the installed CLI 2.1.284 (the spike now runs the CLI the engine
runs, via `resolveClaudeBin`, not the SDK's bundled 2.1.251), planner Opus 5.5 and
implementer Sonnet 5.5, in a throwaway `git init` repo. **Every assumption (a)–(j)
passes again.** About $1.90 of usage. Two observations, neither a change the engine needs:

- **A resumed session can yield an extra, empty `result` first.** Resuming the session
  killed mid-`sleep` (f) yielded `task_notification`, then `result success turns=0 ""`,
  then a second `init`, the answer, and the real `result`. The killed session had left a
  background task; its notification is delivered as a turn of its own. `LiveClaudePort`
  reads to the end of the stream and the last `result` wins (cost and turns are summed).
- **The CLI blocks a long foreground `sleep`.** The kill step's `sleep 25 && echo slept`
  was refused in the foreground and run in the background instead. Workers that wait with
  `sleep` will see the same; nothing in planestro relies on it.

The kill step now only kills a session whose id it holds: before `init` arrives the id
is undefined, and an entry without a `sessionId` (another session on the machine, such as
a live worker) would have matched it.

## Assumptions

| # | Assumption the engine depends on | Result | Observed |
|---|---|---|---|
| a | An in-process MCP tool (`submit_plan`) is callable from a session in `permissionMode: 'plan'`; `ExitPlanMode` reaches `canUseTool` with `input.plan` | **PASS** | Fable called `mcp__planestro__submit_plan` (via `ToolSearch` first) and never used `ExitPlanMode` when told not to. The intercept path was exercised by the same `canUseTool` router (deny-with-message works for any tool). |
| b | After the tool result says "end your turn" the turn ends, the process exits cleanly and `result.session_id` is stable | **PASS** | `subtype: success`, 4 turns, session id persisted from the `init` message and identical on the `result`. |
| c | `query({resume, model: 'claude-opus-5', permissionMode: 'acceptEdits'})` continues the session with the new model and mode | **PASS** | `init` reports `model=claude-opus-5 mode=acceptEdits`, same `session_id`. |
| d | `AskUserQuestion` reaches `canUseTool`; deny → park; resume with the answer as the next user message works | **PASS** | Questions captured from `input.questions`; deny message was echoed as the tool result; Opus ended the turn; the next resume carried on with the answer. |
| e | An `allowedTools` rule added on a resume pre-approves that exact Bash command, and a non-approved command reaches `canUseTool` (so it can be parked) | **PASS** (after a re-test) | `Bash(echo spike-ok)` never hit `canUseTool`. **Gotcha:** the first probe, `uname -a`, ran without any callback — it is in Claude Code's built-in read-only command set. `node -e …` (not read-only, not allowlisted) did reach `canUseTool` and the deny parked the session without a retry. |
| f | Killing the child mid-turn (SIGTERM) leaves a resumable session | **PASS** | `query()` threw `Claude Code process exited with code 143`; `resume` of that id answered "what were you doing" correctly. |
| g | Transcript lives at `~/.claude/projects/<cwd with non-alnum → '-'>/<id>.jsonl`; `getSessionInfo`/`listSessions` find it | **PASS** | Path for a worktree cwd: `-Users-me-Projects-myproject--claude-worktrees-planestro-spike/<id>.jsonl`. `getSessionInfo(id, {dir})` returns `{sessionId, summary, lastModified, fileSize, firstPrompt, …}`. |
| h | `claude agents --json` lists our child during a turn, with a pid | **PASS** | `{"pid":26928,"cwd":"<worktree>","kind":"interactive","sessionId":"…","name":"planestro-spike-b5"}` — SDK-spawned sessions show as `kind: interactive` with no `status` field for the pid entry we saw. |
| i | `maxTurns` / `maxBudgetUsd` end the turn with distinguishable result subtypes | **PASS** | `error_max_turns` (`is_error: true`, `num_turns: 2` for `maxTurns: 1`) and `error_max_budget_usd`. |
| j | Resume across a **full process restart** keeps context | **PASS** | Fable was told the codeword `PELICAN-42` while planning; a brand-new process resumed as Opus and answered it first. |
| k | A resume is quoted before it runs (`context_tokens`, `estimated_cache_write_usd`) | **PASS**, through a command hook only | The SDK's own `SessionStart` callback never fired on `query({resume})`; a command hook in `Options.settings` received `{"source":"resume","seconds_since_last_response":43,"context_tokens":18162,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0.0363}`. Gotcha 16. |
| l | A resume can be declined before its first request, at no cost | **PASS** | A `UserPromptSubmit` callback answering `decision: 'block'` ended the turn with zero assistant messages and the running total unchanged. |
| m | What `total_cost_usd` means on a resume | **It is the session's running total** | $0.0093 → $0.0113 for a turn that cost $0.0020; the transcript's last `cost-state` line held the $0.0093. Gotcha 14. |
| n | What `maxBudgetUsd` measures on a resume | **The process's own spend** | Under a cap below the running total the turn still made its requests; it ended `error_max_budget_usd` only once its own spend passed the cap. Gotcha 15. |

## Gotchas the engine must handle

1. **`query()` throws after yielding an error result.** After `result.subtype`
   is `error_max_turns` / `error_max_budget_usd` the async iterator rejects
   with `Claude Code returned an error result: …`. `runTurn` must `try/catch`
   around the loop and treat a caught error *after* a result as that result,
   not as a crash. A SIGTERM'd child rejects with `… exited with code 143`.
2. **Resuming a torn session emits a zero-turn `result` first.** After the
   SIGTERM test, the resume stream began with `result subtype=success
   turns=0 cost=0 result=""` *before* the new turn's `init`. Turn completion
   must be defined as "the iterator finished" (last `result`), never "the
   first `result` seen".
3. **Built-in read-only commands never prompt.** `uname`, `ls`, `cat`, `git
   status`, … are auto-approved in every mode; a permission-routing test must
   use a command outside that set. Conversely the engine can rely on it:
   read-only probes by a worker won't generate approval cards.
4. **Bare `allowedTools` entries shadow `canUseTool`** (SDK warning
   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). Listing `mcp__planestro__report_done`
   bare means the callback never sees it — fine for planestro's own tools,
   but never list `Bash` bare. **Since #58 (2026-10-01) nothing is passed bare:**
   `splitAllowed` (LiveClaudePort) sends the SDK only rules with a pattern and
   approves bare names (`Read`, `Grep`, `Glob`, `mcp__planestro__*`) first thing
   in `canUseTool`. What is allowed is unchanged, every call is visible to the
   callback, and the warning no longer prints at start. **Except `dontAsk`** (the
   orchestrator, #153): that mode never calls `canUseTool` and refuses anything not
   listed, so `customAllowedTools` lists its bare names and its MCP tools whole. #58's
   split there left every orchestrator tool refused for a morning.
5. **User-level settings leak into worker sessions.** With default
   `settingSources` the sessions loaded the user's MCP servers (ElevenLabs)
   and hooks (`hook_started` events before `init`). Workers should run with
   `settingSources: ['project']` (the code repo's CLAUDE.md, AGENTS.md and
   `.claude/settings.json` still load) and `strictMcpConfig: true` so only
   the `planestro` server is present. The project's own
   `.claude/settings.local.json` allowlist (e.g. `Bash(python3 *)`) also
   applies — permission tests must account for it.
6. **Models find MCP tools through `ToolSearch`** (deferred tool loading):
   the first call to `submit_plan` was preceded by a `ToolSearch` turn. Harmless,
   but budget one extra step per new tool.
7. **`rate_limit_event` messages are informational** and appeared in every
   run; they are not errors.
8. **Foreground `sleep` is blocked by the harness** (the kill test's worker
   backgrounded it); irrelevant to the engine, but explains the transcript.
9. **Cost:** each planning turn in the game repo cost ~$0.9 (Fable, project
   CLAUDE.md loaded), implementation turns ~$0.3–0.5 (Opus). Budget caps
   should be per item, not per turn.

10. **Plan mode routes allow-listed tools through `canUseTool` too** (seen live on
   HH-2: `mcp__planestro__submit_plan` reached the callback despite being in
   `allowedTools`). The callback must answer allow for planestro's own tools
   itself; it cannot rely on the allowlist in plan mode.

11. **In-process MCP tool calls can fail late in a long session** (seen live on
   HH-94, turn 46: `submit_plan` failed 3× with `Tool permission request
   failed: AbortError: Stream closed`, then succeeded on a fresh resumed
   turn). Cause (isolated for #167 on SDK 0.3.251 / CLI 2.1.288): given a
   string `prompt`, the SDK treats the query as a single user turn and closes
   the CLI's stdin at the first `result`. Work that outlives that result — a
   background agent (`Agent` with `run_in_background`) or the follow-up turn a
   finished background Bash starts — then has no control channel: the CLI
   throws `Stream closed` for every SDK-MCP call and `can_use_tool` request
   (the current CLI words it "The tool call was interrupted before a result
   was received"), the handler never runs, and a background Bash's follow-up
   turn silently never happens. Reproduced with a background agent calling an
   SDK-MCP tool after the main turn's result. Fix: the port passes the prompt
   as a stream (`InputGate`) and ends it at a `result` only when the level
   signal `background_tasks_changed` lists no non-ambient task, or 30 s after
   the last one ended with no follow-up turn; a CLI that never sends that
   signal ends where it always did. Still treat planestro tool results as
   fallible (a crash, a kill): the port records such calls
   (`noteToolFailures`, `TurnResult.toolFailures`) and the session's last
   report call that never reached its handler with its arguments
   (`ReportWatch` → `TurnResult.undelivered`, persisted at once as
   `op_data.outbox`). The engine applies that report through the same tool
   when the turn ends (or at the next start, for a turn the engine's stop
   killed) instead of resuming the session to hand it in again; the report
   tools are idempotent, so a call that did land is not recorded twice. A
   loss with no arguments to apply still gets one resumed retry for a plan,
   then `no_plan` naming the transport. The drop itself is read off the stream
   (`DropWatch`): a planestro tool error in transport wording, a permission
   request the CLI answers "Tool permission request failed …" or "interrupted
   before a result was received", or `init` listing planestro's server as
   failed or none of its tools. The item shows it within the turn
   (`op_data.mcp_drop`); a work turn that ends after one with no report landed
   or applied blocks `connection_lost` with the session's last message.
12. **A model that is out of usage** (subscription limit, or a model that needs
   credits the account lacks) is visible three ways, and planestro reads all
   of them (`noteUsage` / `classifyUsage` in `LiveClaudePort.ts`): a
   `rate_limit_event` whose `rate_limit_info.status` is `rejected` (with
   `resetsAt`, epoch seconds), an assistant message whose `error` is
   `rate_limit` / `billing_error` / `model_not_found`, and the CLI's own
   usage-limit text, whose prefixes the SDK exports as
   `USAGE_LIMIT_ERROR_PREFIXES` (marked alpha; planestro merges it with its own
   copy in `@planestro/shared` so a rename cannot switch detection off). A
   rejected event alone is not an outage — the turn must also have failed or
   ended on the usage message. `Options.fallbackModel` covers only *overloaded
   or unavailable* models inside one turn and re-tries the primary at the start
   of the next, so it is passed alongside, not relied on: an exhausted
   subscription is handled by the engine (see configuration.md, Model fallback).
13. **`rate_limit_event` carries the subscription's reading on every turn**, not
   only on rejection: `rate_limit_info` has `status` (`allowed` /
   `allowed_warning` / `rejected`), `rateLimitType` (the window: `five_hour`,
   `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
   `seven_day_overage_included`, `overage`), `utilization` (0–1) and
   `resetsAt` (epoch seconds), all optional but `status` (`SDKRateLimitInfo`
   in the SDK's `sdk.d.ts`). `noteUsage` keeps the most pressing reading per
   turn (`TurnResult.rateLimit`, worker turns and orchestrator wakes alike)
   and the engine's usage guard pauses automation on it before the limit is
   reached (configuration.md, Usage guard). API-key sessions report no
   subscription windows.

14. **`total_cost_usd` on a resumed session is the session's running total, not
   the turn's cost** (#64, spike `resume-quote`, (m)). The CLI records a
   `cost-state` line in the transcript and restores it on `resume`, so six
   resumes of one small session reported $0.0350, $0.0380, $0.0401, $0.0433,
   $0.0455, $0.0477 while each cost about $0.002. `modelUsage` is cumulative the
   same way. planestro added every reading to the item: HH-181's turns read
   1.41, 3.10, 4.35 … 30.27 in the journal, and the item showed over $300 for
   about $30 of work; HH-247's "$46 resume" was about $7.60. The port now takes
   the last total a process reports (a torn session's zero-turn result carries
   the restored figure, and adding the two counted it twice) and subtracts the
   baseline: the transcript's newest `cost-state` (`lastCostState`, read in the
   `UserPromptSubmit` callback from the hook's `transcript_path`), else the
   total the engine recorded after the previous turn (`session_context.total_usd`,
   passed as `resumeTotalUsd`). `TurnResult.costUsd` is the turn's;
   `sessionTotalUsd` the running total. With no baseline to be found the total
   is taken whole, as before.
15. **`maxBudgetUsd` measures the process's own spend** ((n)): a resume under a
   cap already below the session's running total still ran its requests, and
   the CLI's own budget reminder counts `used` from 0. The cap is checked
   between requests, so the first request can overshoot it: a new session under
   a $0.02 cap ended `error_max_budget_usd` at $0.033. A resume whose reload
   costs more than the cap is therefore stopped only after paying for it; the
   engine has to decline it before it starts.
16. **A resume is quoted before it runs, but not to an SDK callback** ((k), (l)).
   `SessionStartHookInput` carries `context_tokens`,
   `seconds_since_last_response`, `prompt_cache_likely_expired` and
   `estimated_cache_write_usd` for `source: 'resume'`. A `SessionStart` callback
   in `Options.hooks` never fires on a resume (it is over before the control
   channel is up); a command hook passed through `Options.settings` does, and
   gets that input on stdin. `UserPromptSubmit` and `Stop` callbacks do fire,
   and `UserPromptSubmit` runs before the first request: answering
   `{ decision: 'block' }` there ends the turn with zero requests and the
   running total unchanged. So `resumeWatch` has the command hook write the
   quote to a temp file, reads it in the `UserPromptSubmit` callback, and asks
   the engine (`onResumeQuote`) whether to go; 'stop' ends the turn as
   `resume_declined`. The quote's `context_tokens` is the window of the last
   response (input + cache read + cache write + output), the same number
   `noteContext` reads from the stream, within a fraction of a percent.
17. **Cache writes here use the one-hour TTL** (`usage.cache_creation.
   ephemeral_1h_input_tokens`), so a resume within the hour reads its context
   instead of writing it: the quote for a session last used a second ago said
   `prompt_cache_likely_expired: false`. The port reports which TTL a turn's
   writes used (`TurnResult.cacheTtlS`), and the engine's estimate takes the
   cache as warm inside it.
18. **The Bash tool's working directory carries over between calls** (checked
   2026-09-29, Claude Code 2.1.284, SDK 0.3.251): after `cd sub && pwd` a plain
   `pwd` answered `…/sub`. A `cd` that lands outside the session's `cwd`
   (`cd ..`, `cd /tmp`) is undone by the CLI after the command, and the result
   says so ("Shell cwd was reset to …"); whether one into an
   `additionalDirectories` folder is undone was not checked. With
   `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` in the session's `env` the shell
   is back in `cwd` after every command, `cd sub` included, with no message.
   Workers run with it (#96): the policy resolves every relative path against
   the worktree, which is only true if each command starts there. Passing `env`
   replaces the child's environment, so it is `{ ...process.env, … }`.
19. **The secret-file deny list rides a PreToolUse hook (#227), not
   `canUseTool`.** The callback never sees what the CLI approves by itself (an
   allow-listed `Bash(tail *)`, gotcha 3's read-only commands, reads in `cwd`,
   edits under acceptEdits); a PreToolUse hook answering
   `permissionDecision: 'deny'` runs before all of them, per the SDK's typings
   (0.3.251). Exercised live on 2026-10-20 (CLI 2.1.305, SDK 0.3.305): an
   allow-listed `tail -n 1 .env` and a read-only `cat .env` were both refused by
   the hook before running.
20. **A long run outlives the Bash cap only as a planestro tool call (#502).**
   Read from the CLI 2.1.306 binary, not exercised live: a foreground Bash call
   is capped at `BASH_MAX_TIMEOUT_MS` (default 600 000 ms); one that runs past
   its timeout is moved to the background and its result carries
   `timedOutAfterMs` (`BashOutput` in sdk-tools.d.ts), which `longRunHook`
   answers with a PostToolUse `additionalContext` naming run_heavy. An MCP tool
   call's wall-clock limit is the server's `timeout` (createSdkMcpServer, 0.3.306),
   else `MCP_TOOL_TIMEOUT`, else 1e8 ms (~28 h); an `sdk` server has no idle
   timeout, and the SDK's in-process `mcp_message` round trip sets none. So
   run_heavy's call is bounded by `heavy_runs.timeout_min` a batch, and the
   planestro server pins `timeout` (24 h) so an `MCP_TOOL_TIMEOUT` in the user's
   environment cannot cut it. Codex app-server dynamic tool calls (codex-cli
   0.154) showed no timeout of their own in the binary's strings.

## Engine decisions confirmed by the spike

- One `query()` per turn with `resume` is a sound runtime model: no process
  survives a human wait, and context survives restarts (b, c, d, f, j).
- Parking = deny with a "recorded — end your turn" message. Both Fable and
  Opus complied without retrying or working around the denial (a, d, e).
- The planestro MCP server replaces file edits for workers (a); the
  `canUseTool` router handles `ExitPlanMode`, `AskUserQuestion` and Bash
  uniformly (a, d, e).
- `claude agents --json` is a usable liveness/attachment probe keyed by
  `sessionId` (h); transcript path derivation is deterministic (g).
