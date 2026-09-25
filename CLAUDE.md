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
`feature/<slug>` branch is synced by merging its base into it and is never
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
- FINISHED has two ways in: the engine after a merged PR, and the user's
  **close as done** (`Engine.closeAsDone`) for work that landed some other way.
  The second is user-only, stops at IN_REVIEW (a PR decides from there), and
  removes the worktree/branch only when they are clean with nothing ahead of
  the base — otherwise it leaves them and says so in the Activity log.
- An item that returns to QUEUED after an icebox/backlog round-trip reuses the
  worktree it already has; setup hooks are not re-run.
- `taken_over` (**take over** / **hand back**, `Engine.takeOver` / `handBack`) is also
  orthogonal: a person finishes the item by hand. It aborts the live turn, drops what
  was queued for it, and every drive path (turns, wakes, triage, stalls, fix turns,
  merge, cleanup) skips the item until it is handed back; CI is still read. Hand-back
  resumes from persisted state. A manual move into IN_REVIEW also stops the session.
- A session slot is held only while something drives the item (a turn, an engine step,
  an op), never by an epic. An active item that nothing drives for
  `concurrency.stall_after_min` is carried on once (`driveStalls`), then blocked `stalled`.
- Frontmatter keys are classified authoritative / operational / derived in
  `packages/shared/src/schema.ts`; derived values (`base_branch`, `lane`,
  `needs_you`, …) are never persisted. Dependencies unblock on MERGED.
- Semantic git commits only (`HH-143: approve plan`), scoped to the paths the
  mutation touched; telemetry is checkpointed (`planestro: checkpoint <ts>`).
- Releases (`releases/<version>.md`) are a second file type beside items: status
  `planned | submitted | released | cancelled`, the item ids they shipped, and
  sections named by the project's `releases.sections` (with `max_chars` / `carry`).
  They never drive the engine; which finished items belong to one is date
  arithmetic (`releaseCandidates`), offered to the user, never applied.
- Schema changes go through `packages/server/src/migrations` and bump
  `SCHEMA_VERSION`; a newer data dir opens read-only.
- `planestro sample` (`packages/server/src/sample.ts`) is the no-credentials demo
  the README leads with; it writes through the DataStore and `sample.test.ts`
  drives an item from it to FINISHED, so a schema or lifecycle change that would
  break the demo fails the suite. `docs/going-public.md` tracks what is left
  before the repository is made public.
- SDK behaviour the engine relies on is recorded in `docs/notes/sdk-notes.md`
  (validated versions in `packages/server/src/compat.ts`).
