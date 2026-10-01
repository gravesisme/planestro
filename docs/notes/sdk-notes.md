# Agent SDK spike — Phase 0 findings

Validated on **2026-08-30** against **Claude Code 2.1.251** and
**@anthropic-ai/claude-agent-sdk 0.3.251** (Node 24.11, macOS), running real
sessions in a throwaway worktree of a real project repo. Runner:
`npm run spike -- <step>` (`spikes/sdk-spike.ts`); raw transcripts of the run
are in `spikes/out/*.stdout` (gitignored). `packages/server/src/compat.ts`
pins these versions so planestro can warn when the installed CLI drifts.

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
   callback, and the warning no longer prints at start.
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
   turn). Treat planestro tool results as fallible: the engine's no_plan /
   done detection paths are the safety net, and a resumed turn re-running the
   tool is the recovery. Cause not yet isolated (SDK-internal transport; the
   message points at the `canUseTool` control channel, which plan mode uses
   even for planestro's own tools — gotcha 10). The port records such calls
   (`noteToolFailures`: an errored `tool_result` for an `mcp__planestro__*`
   call, whose handler never ran) in `TurnResult.toolFailures`; the engine
   logs each one, resumes a plan turn once to hand the plan in again, and
   blocks `no_plan` naming the transport if that fails too. An identical
   re-submit of a recorded plan is a no-op.
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
