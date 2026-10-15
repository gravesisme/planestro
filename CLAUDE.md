# planestro

Local-first backlog planning and agent orchestration for a solo developer.
Markdown files with YAML frontmatter are the source of truth (one item per file,
a prompt library, a journal), deterministic code runs the git / GitHub / CI
mechanics, and model sessions are consulted only for judgment. TypeScript,
Node 24, npm workspaces: `packages/shared` (schema + file codecs + pure logic),
`packages/server` (store, engine, Hono API, CLI), `packages/web` (React + Vite).
`npm test` (vitest), `npm run typecheck`, `npm run build`, `npm run dev` /
`npm run dev:web` (Vite on :5173 proxies to the server on :4300). `AGENTS.md`
is a byte-identical copy of this file for Codex, held together by a test: edit
one, then copy it over the other.

## Design invariants

Evaluate every change against these; they are the architecture.

1. **planestro owns state; models propose changes to state.** While planestro
   runs it is the only writer of a data dir. Workers and the orchestrator talk
   to it through MCP tools (`submit_plan`, `add_note`, `append_activity`,
   `report_done`, `report_blocked`); they never edit item files. Humans may
   hand-edit files when planestro is not running (committed as `manual: …` at
   startup) or via "Reload from disk".
2. **No process ever waits on a human.** Any operation that needs asynchronous
   human input parks the session immediately: persist the request, deny the
   tool call with "recorded by planestro — end this turn", let the turn end,
   let the process exit, set `awaiting`, resume later with the decision as the
   next message. No timeouts, no held promises.
3. **A model is never the sole holder of anything needed to recover.** Every
   turn and every orchestrator wake is rendered from persisted state; the
   orchestrator session is rotated freely because the files are its memory.
4. **Don't ask an LLM what a state machine can know.** Git, worktrees, GitHub,
   CI polling, state transitions, persistence, cleanup, scheduling = code.
   Plan review, merge-order judgment, ambiguous failures, worker instruction,
   escalation = the orchestrator model.
5. **Project-neutral.** planestro manages a *Project* (`{name, id_prefix,
   code_repo, data_dir}`). Nothing in config, storage or prompts is specific
   to one repo; project rules come from that repo's own CLAUDE.md/AGENTS.md.
6. **Dry-run and the big red lever.** `engine.mode: live | dry-run` (ports log
   `Would …` instead of acting) and a global AUTOMATION PAUSED toggle that
   stops admissions, merge-queue jobs, orchestrator wakes and auto-sends after
   the current safe operation, persisted across restarts.
7. **Destructive operations require positive evidence.** Never delete a
   worktree, local branch, remote branch or session resource because state
   says it should be safe. Cleanup needs a fresh fetch, the PR reported
   `MERGED`, and `git merge-base --is-ancestor <tip> origin/<base>`.
   Ambiguity → `blocked` with a reason, never deletion. (Untracked files that
   collide with ones the base now tracks are moved aside to `.displaced/`,
   not deleted: `clearForSync`. Untracked files the project names in
   `worktrees.byproducts` are never dirt: cleanup sets them aside the same way.
   A folder git no longer lists as a worktree, holding no `.git`, is a leftover:
   cleanup moves its files there too and goes on to the branches (#356).
   A sync git refuses over local changes is not a conflict: untracked files it
   names are set aside and it runs once more, else `dirty_tree`. An epic's own
   `merge-<id>` worktree is cleared before merging: tips logged, its changes
   moved or copied to `.displaced/`, then reset to its own HEAD.)
8. **No lifecycle code contains the literal default branch name.** Everything
   operates on the item's resolved `base_branch`; a test greps `engine/` for it.

**Worker branches rebase. Integration branches merge.** An epic's
`feature/<slug>` branch is synced by merging its base into it (after taking in
`origin/feature/<slug>`, which moves whenever a child merges) and is never
rewritten or force-pushed; worker branches rebase with `--force-with-lease`.
Sync only when behind: a branch already on the base tip is neither rebased nor
re-pushed, and the CI run for its head is reused. Right after a push GitHub still
reports the old head for a few seconds; `waitForCi` reads that as propagation lag,
never as a moved head (the `head_moved` storm re-ran every open PR per merge).
Between turns the same sync runs on demand (`Engine.syncWithBase`: the item's
"Sync with base", the orchestrator's `sync_with_base` / `unblock_item` with
`sync_first`, `resume_after`, and plan approval before the implement turn
starts unless `sync_first: false`, #217): never while a turn or op is live, pushed
only if the branch is already on the remote, and a conflict goes to the session.
A worker's rebase conflict is never the worker's integration step (HH-532): planestro leaves the rebase stopped at it
(`op_data.rebase_continue`), the session edits only the conflicted files, and planestro continues the rebase, checks it
(finished, clean, contains `origin/<base>`) and pushes it, or aborts it back to the old head and blocks `sync_conflict`;
the same conflict at the same base tip is not handed to that session again without guidance (`rebase_declined`).
The serial merge chain only syncs and merges; no CI wait ever runs inside it. A head
that is not green yet leaves the chain (`op: awaiting_ci`), is polled beside it
(`watchCi`) and comes back once green, so one item's CI never delays another's merge.
Releasing a hold keeps a green run whose head is unchanged and still on the base tip.
A red head the session changed nothing for is re-run once (`onSameRedRun`), then blocks `ci_red_parked`:
nothing waits on a run that is not coming, and an item in review that nothing moves for `ci.stall_wake_min`
wakes the orchestrator once (`review_stalled`, #201).
A red epic whose failed log names files its base changed since it last synced, and none of its own, is not blocked:
`op_data.base_wait` waits for the base to move, merges it in and lets CI run once more (`driveBaseWaits`, #204).
A red run whose failed log matches `ci.infra_patterns` (or a built-in: disk full, runner lost) is the runner's: re-run once
under the same per-head `flake_rerun`, no fix turn, not counted; matched again it blocks `ci_infra`, naming the pattern (#219).
A CI wait on a runner label that looks stalled or offline (`runners.ts`, read by the gh port's `runners`, cached 30 s; the
orchestrator's `runner_status`, a worker's `runners_busy`) is said once per label: one banner and one `runner_stalled` wake for
every item on it, never a triage each (`op_data.runner_stall`), and a runner taking a job again sends them back to CI (#216).
A worker's heavy local run goes through `run_heavy` (`heavy_runs`, #218; matching Bash is redirected to it): one at a time
(`HeavyLock`, in memory), each batch after any CI job on a `shared_labels` runner has ended, read from that same report.
A held item (`skip_merge`) skips only the merge: its new commits are pushed and its
CI is polled from the tick, outside the merge chain (`driveHeld`).
Ref-updating git (fetch, push, worktree add) runs one at a time (`refLocked` in
`live-ports.ts`: worktrees share the ref store); transient git/gh errors are retried there.

## Data model notes

- Statuses are the lifecycle only: `NOT_YET_SUBMITTED, QUEUED, PLAN_IN_PROGRESS,
  PLAN_READY, IN_PROGRESS, IN_REVIEW, MERGED, FINISHED, ICEBOX`. `blocked` /
  `blocked_reason`, `awaiting` / `awaiting_data` and `op` / `op_data` are
  orthogonal, so an item never loses its phase when it needs a human. A stop
  goes to the orchestrator first (`triage`, not "needs you"): it resolves it with
  its tools or leaves one plain decision card (`awaiting_data.decision`); a wake
  that ends without either, or `orchestrator.triage_timeout_min`, hands it back.
- The orchestrator adds and starts work on the user's word only (#73). A card option may carry
  an `action` (`create_item`, `submit_item`) that the engine performs as the user when it is
  picked: `actionRefusal` checks it when the card is filed and again at the tap (a refusal
  leaves the card as it was), and once the first write is made nothing throws. Where the user
  is talking to it (`user_message`, `question_message`) `submit_item` on an epic plans its
  breakdown; an epic is never QUEUED. Anywhere else both are refused in words, never thrown, and so is
  `submit_item` on an item imported from an issue (`source.github_issue`: a stranger's text, #339).
- FINISHED has two ways in: the engine after a merged PR, and the user's
  **close as done** (`Engine.closeAsDone`) for work that landed some other way.
  The second is user-only, stops at IN_REVIEW (a PR decides from there), and
  removes the worktree/branch only when they are clean with nothing ahead of
  the base — otherwise it leaves them and says so in the Activity log.
- **Discard** (`Engine.discard`, #135) is the user's way out for work no longer wanted, QUEUED through
  IN_REVIEW (and an iceboxed epic child): the turn stops, the PR is closed with the reason, the item
  leaves its epic (`parent` unset, so the epic finishes without it) and goes to ICEBOX. Its remote
  branch is deleted only when the user ticks it, leased to the tip they were shown, with the tips
  logged first; otherwise local cleanup needs a clean tree whose HEAD the remote holds. An iceboxed
  child still holds its epic open, and the epic says so. IN_REVIEW → ICEBOX goes only through it.
- **Undo last turn** (#234): each worker implement/fix turn is bracketed by checkpoints of its worktree, read through a
  temporary index (the index's tree, every file git does not ignore, HEAD and the index kept as parents) under
  `refs/planestro/checkpoints/<item>/<n>/{before,after}`; refs are only added. The user's Undo (never an orchestrator tool)
  shows the files, patch and commits it discards, then restores `before` only on positive evidence: nothing live on the item,
  the worktree exactly `after`, and a fresh fetch showing nothing of the turn's on the remote. `<n>/undone` records what it
  discards first, and the next turn is told (`op_data.turn_undone`). The refs go at FINISHED in `cleanup`, tips logged first.
- `kind` (item | epic) changes only through `Engine.convertKind` (the page's **Convert to
  epic / to item**, the orchestrator's `convert_item`), while nothing has run for
  implementation (`kindConversionRefusal`): the plan moves to Notes, the planning worktree
  goes only on positive evidence. A plain item's plan that reads as an epic (`submit_breakdown`
  on an item, or `epicShapeOf` on the text) is flagged in `op_data.looks_like_epic`, and
  approval refuses it for everyone but a user approving it as one item on purpose (#69).
- A worker's `request_audition` (#207) parks the item on takes for the user to hear or see (`awaiting: audition`,
  worktree paths, ignored folders included). Only the listed takes are served (`auditionFile`), only while it waits;
  it never goes to triage, and only the user's picks resume the worker. A role needs `pick` takes (#318): the user keeps
  up to that many and regenerates the rest (note optional); the worker re-auditions with them in `kept` (locked, still
  served) until every role is filled. The #207 shape (`{take}` / `{regenerate}`, `allow_regenerate`) still reads.
- An item that returns to QUEUED after an icebox/backlog round-trip reuses the
  worktree it already has; setup hooks are not re-run.
- A hold (`skip_merge`) carries its reason in `hold_reason`, which lasts exactly as long as the
  hold (`DataStore.mutateItem` drops it) and ends with the item's run (`applyTransition`). Every
  hold is built by `holdOps`: the user's **Approve and hold the PR**, the orchestrator's
  `skip_merge` / `approve_plan`, the worker's `report_done` `hold`. A plan that states a merge
  hold is found by `holdShapeOf`, read from the Plan as it stands and never persisted; a hold the
  user released or left out is not put back by the worker (`op_data.hold_waived`) (#97).
  `hold_waits_on` says who a hold waits on (#195): a `person`'s (the user, `review.hold_into`, a loop's
  review, a review hold) is drafted under `ci.draft_while_held`; an `agent`'s (the orchestrator, the worker,
  a scope check; unset reads so) holds the merge only, its PR kept ready so CI runs. A run in flight is never
  cancelled by drafting. Only the user releases a `person`'s hold: `unskip_merge` refuses it in words (#339).
- **Loop until green** (#171) is the orthogonal, authoritative `loop: {max_iterations, goal?}`, not a
  `kind`. The worker's `report_iteration` tallies each pass into `loop_state` and Activity and counts
  it against `max_iterations`; the pass that spends it unless green blocks `loop_cap` (tally + diff).
  A turn that ends mid-loop is carried on once per new iteration, else `loop_stalled`. `report_done`
  is refused until green, and the first one carries `review` (REVIEW.md): filed in Notes and as an
  attachment, and the PR held by `holdOps` (`loop review: …`) unless `hold_waived`.
- `taken_over` (**take over** / **hand back**, `Engine.takeOver` / `handBack`) is also
  orthogonal: a person finishes the item by hand. It aborts the live turn, drops what
  was queued for it, and every drive path (turns, wakes, triage, stalls, fix turns,
  merge, cleanup) skips the item until it is handed back; CI is still read. Hand-back
  resumes from persisted state. A manual move into IN_REVIEW also stops the session.
- Cost is per turn (#64): a resumed conversation reports its running total, so the port takes
  what that rose by (`settleCost`; the baseline is the transcript's last `cost-state`, else
  `session_context.total_usd`). `session_context` also holds the conversation's window and the
  price the CLI quoted for reloading it; every turn goes one of three ways on that estimate
  (`chooseTurnPath`): resume, a **fresh session** with a brief rendered from the item file and
  git (`fresh-brief`; the resume is unaffordable or above `budget_usd_fresh_above`, only for a
  prompt that stands on its own; explicit provider handoffs may plan or answer a persisted question when both the original question and answer are carried), or
  `over_budget` before anything is spent. The fresh session replaces `session_id`; its intent is
  persisted first (`op_data.fresh_brief`). `commit_paths` commits named dirty files with no turn.
  Every turn and wake that ran journals one `usage.turn` as it ends (provider, model, role, dollars or tokens as
  the runner reports them); the Usage page (`GET /usage`, #236) reads only those, never item totals (pre-#107 ones are inflated).
  Each keeps the turn's token split (#345: `input`, `cache_read`, `cache_write` with `cache_ttl_s`, `output`, `context` at
  its end), summed from the stream once per response, never from the result's running totals; `tokens` is the work paid in
  full (input + cache write + output). The per-item efficiency report (#346: the item's **Efficiency** panel,
  `GET /items/:id/efficiency`, the Usage page's 7-day ranking, `GET /usage/items`) reads the same entries: each carries its
  `stage` (planning, implementation, fix once the PR is open, conflict), `resumed` and `start_context` (the first response's
  window: a new conversation's startup weight), and a wake its `items`, which share its cost.
- A report (`submit_plan`, `submit_breakdown`, `report_done`, `report_blocked`) whose call never reached planestro is applied
  from the turn's record (#167): the port keeps the session's last lost report with its arguments, the engine
  persists it in `op_data.outbox` and applies it through the same tool when the turn ends (or at the next start),
  and those tools are idempotent. Rejected/invalid reports are retained as `op_data.rejected_report`
  for inspection, removed from the replay outbox, and active work blocks `connection_lost`; they do not retry forever
  (a `report_done` refused for debug markers resumes the session with the refusal instead). `report_done` is refused
  in words while the branch adds a `planestro:debug-begin`/`-end` line (the `debug` template, #240; `addedLinesWith`). The prompt goes to the SDK as a stream held open while background work runs, so
  stdin is not closed under it (sdk-notes gotcha 11). A drop is shown on the item within the turn (`DropWatch` →
  `op_data.mcp_drop`, the card's **lost connection**, cleared by the next turn that runs with its connection); a work turn
  that ends after one with no report landed or applied blocks `connection_lost`, with the session's last message for the
  orchestrator to recover the report from.
- An instruction waiting for a slot, pause, drain or provider guard is persisted in `op_data.pending_turn`;
  `active_turn` preserves the instruction during execution for restart recovery. Answers include their exact
  question/ruling. Ending a turn cannot erase a newer queued answer; a takeover/discard clears both intents.
  Deferred work holds no process or slot, and a pending fix prevents its PR from merging over the instruction.
  Saved turns use the item's permitted model fallback, without bypassing provider guards. The board shows
  “waiting: saved instruction” and explains admission waits, including an incompatible phase or missing model.
  Restart recovery replays the saved instruction in the compatible session, preserving its answer/ruling
  rather than substituting a generic carry-on prompt.
- A session slot is held only while something drives the item (a turn, an engine step,
  an op), never by an epic. An active item that nothing drives for
  `concurrency.stall_after_min` is carried on once (`driveStalls`), then blocked `stalled`.
- A turn or orchestrator wake that failed before it did anything (`quietTransientFailure`: no message, tool call,
  file change or report; never auth, quota or a cap) is retried once after `concurrency.transient_retry_after_s` (#241):
  the stop is recorded with `op_data.transient_retry.due_at` (no triage, not needs-you) and `driveTimedRetries`
  runs `retryOp` from the tick; a wake is queued again with `retry.not_before`. A second failure stops as before.
  A Codex turn ended by apply_patch's "multiple operations target <file>" (#344, `patchRejected`) is retried the same way, told why.
  A `usage_exhausted` stop waits out its recorded reset the same way (#296: the orchestrator's `retry_at_reset`, the
  card's **Wait for the reset**): `op_data.usage_retry.due_at` (reset + 60 s, not needs-you), retried once; a second stops as before.
- The concurrency control (#330, `concurrency.ts`) changes `max_sessions` / `runner_limits` through the Settings write
  path, journaled `concurrency.changed` (who, why, from → to), so the last change rolls back in one step. Its guard,
  `concurrencyAdvice`, reads the `ci.result` entries the engine journals once per run attempt (a check killed at its
  timeout: rc=137, a job past its limit) and host load; a raise above it needs a confirm. Runner limits share the
  session slots and never do. `concurrency.guard.auto_step_down` (opt-in) rolls a raise back on the tick. A raised
  limit wakes the turns waiting for a slot.
- `priority` (#194: `high | medium | low`, optional, authoritative) orders before `rank` wherever items are
  listed (`sortByRank` → `DataStore.listItems`): each column, admission, the orchestrator's lists. A rank orders
  an item within its band; a move beside another band snaps to its own band's edge. Unset sorts last, as before.
- Frontmatter keys are classified authoritative / operational / derived in
  `packages/shared/src/schema.ts`; derived values (`base_branch`, `lane`,
  `needs_you`, …) are never persisted. Dependencies unblock on MERGED.
- Permission rules merge three layers (#229): `~/.planestro/policy.yml` (machine, hand-edited, read-only in the UI),
  the project's `permissions`, then `planestro.local.yml`'s; lists are unioned (`DataStore.permissionRules`, each rule
  with its sources), a deny from any layer wins (`sdkRules` keeps a touched allow off the SDK's list), secrets first. Suggestions,
  redirects and drift read the merged rules.
- Allow rules are suggested from the ruling history, never applied (`allowSuggest.ts`, #169: `planestro
  permissions suggest`, `GET /permissions/suggest`, the Console). Rulings come from Activity
  (`permission allow (reason): Bash(…)`) and, whole, from `permission.answered` (`tool`, `command`,
  `reason`); only safe classes get a `…@worktree` rule, and one that the replay finds would have let any
  past denial through, alone or with the others, is refused (zero false allows on the history).
  `permissions.redirect` (`{rule, message}`, #203) is a deny with a reason, merged across layers like #229's
  and judged in `makePolicy` after every deny: a match is refused up front, never parked. Suggest offers
  redirect candidates with the snippet that installs one, never installs it, and skips what one covers.
  The same report (#203) offers redirects (a kind of command denied every time from several items, its reason, never
  one a past approval would have hit) and drift over the journal's `tools.ran` (one per Claude worker turn: what ran
  without a park): allow rules nothing matched, approvals rising. Neither is applied. A delegated permission request
  carries the earlier rulings on its kind of command and the `permission-rubric` partial.
- Semantic git commits only (`HH-143: approve plan`), scoped to the paths the
  mutation touched; telemetry is checkpointed (`planestro: checkpoint <ts>`).
- Releases (`releases/<version>.md`) are a second file type beside items: status
  `planned | submitted | released | cancelled`, the item ids they shipped, and
  sections named by the project's `releases.sections` (with `max_chars` / `carry`).
  They never drive the engine; which finished items belong to one is date
  arithmetic (`releaseCandidates`), offered to the user, never applied.
- Orchestrator questions (`questions/Q-<n>.md`, schema 3) are a third file type: status
  `open | resolved | withdrawn`, an optional `item`, and `# Summary`, `# Details`,
  `# Recommendation`, `# Thread` (`- <ts> [user|orchestrator|app] text`). `ask_user` creates
  one; a post in its thread wakes `question_message`, "Still relevant?" wakes `question_review`
  (which ends in `resolve_question` / `update_question`, or planestro notes "reviewed, no
  change"). An item reaching FINISHED or ICEBOX resolves its open questions in the store
  (`settleQuestions`), never by asking the model.
- Schedules (`schedules/<name>.md`, schema 7, #247) are a fourth file type: cron, `tz`, an item title and
  `# Description` template (`{{date}}`, `{{slot}}`, `{{schedule}}`). `driveSchedules` (tick, after the pause check)
  files one item per slot keyed `scheduled_from: <name>:<slot>`; that key and the schedule's `last_slot` / `armed_at`
  mean a restart never files twice, a sleep files the latest missed slot once. `skip_if_open` skips while the last
  one is open. `submit` is honoured only with `created_by: user` and set only by the user (#73).
- Issues of `code_repo.github` become items through `importIssues` (`planestro import issues`, the board's **Import
  issues**, #231): the ones picked, or every open one with `issues.import_label`. `source: {github_issue}` is the evidence
  an issue is in (never filed twice); nothing is submitted (#73); the PR says `Closes #N` only with `source.closes`.
- Provider switches in either direction keep item state, worktrees, PRs and decisions, using the existing fresh-brief intent. `agent_sessions` (schema 4) stores a session id, role and tool contract per runner; an app-server thread also records the MCP servers it started with (`mcp`), since a resumed thread keeps those tools, and a different set starts a fresh brief (#366). A model row's MCP servers reach implement and fix turns on Claude and app-server rows (Codex through planestro's bridge, `externalTools`), never a planner. Provider usage guards are machine-local and independent of the global user/disk pause. Orchestrator model changes apply next wake without a restart; its queue remains in memory, including when a wake hits its token cap.
  Sessions run on the CLIs' own logins, never a model API key (`claudeEnv` drops `ANTHROPIC_API_KEY` and the Bedrock /
  Vertex switches; a local file's old key is dropped at load). A second login for the same runner is a named account (#242: `accounts` in planestro.local.yml,
  a `home` config dir, never a credential): a model row or the item (`account`) picks it, a missing one blocks
  `account_missing` rather than bill the default login, and guards / `model_unavailable` are keyed per account. Out of usage
  with another account free, the engine files the card itself (`continue_on_account`, `wait_for_reset`; no triage); a
  conversation resumes only from the same store (`sameSessionStore`), else a fresh brief.
- A wait on a person (an item whose `needs_you` turns true, an open orchestrator question) is announced once
  (#224): `NeedsYouWatch` (`engine/needsYou.ts`) sees every store event, journals one `notification`
  (`on_needs_you`, with an absolute link) per wait key and runs `notifications.on_needs_you`. It holds back while a
  client's input heartbeat (`client.active` on the WebSocket) is under `notifications.idle_after_min` old; its memory
  across restarts is the journal.
- Schema changes go through `packages/server/src/migrations` and bump
  `SCHEMA_VERSION`; a newer data dir opens read-only.
- `planestro sample` (`packages/server/src/sample.ts`) is the no-credentials demo
  the README leads with; it writes through the DataStore and `sample.test.ts`
  drives an item from it to FINISHED, so a schema or lifecycle change that would
  break the demo fails the suite. `docs/going-public.md` tracks what is left
  before the repository is made public.
- SDK behaviour the engine relies on is recorded in `docs/notes/sdk-notes.md`
  (validated versions in `packages/server/src/compat.ts`).
