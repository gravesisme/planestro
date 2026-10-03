# planestro

Local-first backlog planning and Claude Code orchestration for a solo developer.
Markdown files with YAML frontmatter are the source of truth (one item per file,
a prompt library, a journal), deterministic code runs the git / GitHub / CI
mechanics, and Claude sessions are consulted only for judgment. TypeScript,
Node 24, npm workspaces: `packages/shared` (schema + file codecs + pure logic),
`packages/server` (store, engine, Hono API, CLI), `packages/web` (React + Vite).
`npm test` (vitest), `npm run typecheck`, `npm run build`, `npm run dev` /
`npm run dev:web` (Vite on :5173 proxies to the server on :4300). `AGENTS.md`
is a byte-identical copy of this file for Codex, held together by a test: edit
one, then copy it over the other.

## Design invariants

Evaluate every change against these; they are the architecture.

1. **planestro owns state; Claude proposes changes to state.** While planestro
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
3. **Claude is never the sole holder of anything needed to recover.** Every
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
   `worktrees.byproducts` are never dirt: cleanup sets them aside the same way.)
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
`sync_first`, and `resume_after`): never while a turn or op is live, pushed only
if the branch is already on the remote, and a conflict goes to the session.
The serial merge chain only syncs and merges; no CI wait ever runs inside it. A head
that is not green yet leaves the chain (`op: awaiting_ci`), is polled beside it
(`watchCi`) and comes back once green, so one item's CI never delays another's merge.
Releasing a hold keeps a green run whose head is unchanged and still on the base tip.
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
  breakdown; an epic is never QUEUED. Anywhere else both are refused in words, never thrown.
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
- `kind` (item | epic) changes only through `Engine.convertKind` (the page's **Convert to
  epic / to item**, the orchestrator's `convert_item`), while nothing has run for
  implementation (`kindConversionRefusal`): the plan moves to Notes, the planning worktree
  goes only on positive evidence. A plain item's plan that reads as an epic (`submit_breakdown`
  on an item, or `epicShapeOf` on the text) is flagged in `op_data.looks_like_epic`, and
  approval refuses it for everyone but a user approving it as one item on purpose (#69).
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
  cancelled by drafting.
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
  prompt that stands on its own, never planning or an answer to the session's own question), or
  `over_budget` before anything is spent. The fresh session replaces `session_id`; its intent is
  persisted first (`op_data.fresh_brief`). `commit_paths` commits named dirty files with no turn.
- A report (`submit_plan`, `report_done`, `report_blocked`) whose call never reached planestro is applied
  from the turn's record (#167): the port keeps the session's last lost report with its arguments, the engine
  persists it in `op_data.outbox` and applies it through the same tool when the turn ends (or at the next start),
  and those tools are idempotent. The prompt goes to the SDK as a stream held open while background work runs, so
  stdin is not closed under it (sdk-notes gotcha 11).
- A session slot is held only while something drives the item (a turn, an engine step,
  an op), never by an epic. An active item that nothing drives for
  `concurrency.stall_after_min` is carried on once (`driveStalls`), then blocked `stalled`.
- Frontmatter keys are classified authoritative / operational / derived in
  `packages/shared/src/schema.ts`; derived values (`base_branch`, `lane`,
  `needs_you`, …) are never persisted. Dependencies unblock on MERGED.
- Allow rules are suggested from the ruling history, never applied (`allowSuggest.ts`, #169: `planestro
  permissions suggest`, `GET /permissions/suggest`, the Console). Rulings come from Activity
  (`permission allow (reason): Bash(…)`) and, whole, from `permission.answered` (`tool`, `command`,
  `reason`); only safe classes get a `…@worktree` rule, and one that the replay finds would have let any
  past denial through, alone or with the others, is refused (zero false allows on the history).
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
- Schema changes go through `packages/server/src/migrations` and bump
  `SCHEMA_VERSION`; a newer data dir opens read-only.
- `planestro sample` (`packages/server/src/sample.ts`) is the no-credentials demo
  the README leads with; it writes through the DataStore and `sample.test.ts`
  drives an item from it to FINISHED, so a schema or lifecycle change that would
  break the demo fails the suite. `docs/going-public.md` tracks what is left
  before the repository is made public.
- SDK behaviour the engine relies on is recorded in `docs/notes/sdk-notes.md`
  (validated versions in `packages/server/src/compat.ts`).
