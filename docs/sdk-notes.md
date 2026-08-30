# Agent SDK spike — Phase 0 findings

Validated on **2026-08-30** against **Claude Code 2.1.251** and
**@anthropic-ai/claude-agent-sdk 0.3.251** (Node 24.11, macOS), running real
sessions in a throwaway worktree of the Hurricane Harrison repo. Runner:
`npm run spike -- <step>` (`spikes/sdk-spike.ts`); raw transcripts of the run
are in `spikes/out/*.stdout` (gitignored). `packages/server/src/compat.ts`
pins these versions so planestro can warn when the installed CLI drifts.

## Assumptions

| # | Assumption the engine depends on | Result | Observed |
|---|---|---|---|
| a | An in-process MCP tool (`submit_plan`) is callable from a session in `permissionMode: 'plan'`; `ExitPlanMode` reaches `canUseTool` with `input.plan` | **PASS** | Fable called `mcp__planestro__submit_plan` (via `ToolSearch` first) and never used `ExitPlanMode` when told not to. The intercept path was exercised by the same `canUseTool` router (deny-with-message works for any tool). |
| b | After the tool result says "end your turn" the turn ends, the process exits cleanly and `result.session_id` is stable | **PASS** | `subtype: success`, 4 turns, session id persisted from the `init` message and identical on the `result`. |
| c | `query({resume, model: 'claude-opus-5', permissionMode: 'acceptEdits'})` continues the session with the new model and mode | **PASS** | `init` reports `model=claude-opus-5 mode=acceptEdits`, same `session_id`. |
| d | `AskUserQuestion` reaches `canUseTool`; deny → park; resume with the answer as the next user message works | **PASS** | Questions captured from `input.questions`; deny message was echoed as the tool result; Opus ended the turn; the next resume carried on with the answer. |
| e | An `allowedTools` rule added on a resume pre-approves that exact Bash command, and a non-approved command reaches `canUseTool` (so it can be parked) | **PASS** (after a re-test) | `Bash(echo spike-ok)` never hit `canUseTool`. **Gotcha:** the first probe, `uname -a`, ran without any callback — it is in Claude Code's built-in read-only command set. `node -e …` (not read-only, not allowlisted) did reach `canUseTool` and the deny parked the session without a retry. |
| f | Killing the child mid-turn (SIGTERM) leaves a resumable session | **PASS** | `query()` threw `Claude Code process exited with code 143`; `resume` of that id answered "what were you doing" correctly. |
| g | Transcript lives at `~/.claude/projects/<cwd with non-alnum → '-'>/<id>.jsonl`; `getSessionInfo`/`listSessions` find it | **PASS** | Path for a worktree cwd: `-Users-dgraves-Projects-hurricane-harrison-godot--claude-worktrees-planestro-spike/<id>.jsonl`. `getSessionInfo(id, {dir})` returns `{sessionId, summary, lastModified, fileSize, firstPrompt, …}`. |
| h | `claude agents --json` lists our child during a turn, with a pid | **PASS** | `{"pid":26928,"cwd":"<worktree>","kind":"interactive","sessionId":"…","name":"planestro-spike-b5"}` — SDK-spawned sessions show as `kind: interactive` with no `status` field for the pid entry we saw. |
| i | `maxTurns` / `maxBudgetUsd` end the turn with distinguishable result subtypes | **PASS** | `error_max_turns` (`is_error: true`, `num_turns: 2` for `maxTurns: 1`) and `error_max_budget_usd`. |
| j | Resume across a **full process restart** keeps context | **PASS** | Fable was told the codeword `PELICAN-42` while planning; a brand-new process resumed as Opus and answered it first. |

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
   but never list `Bash` bare.
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
