# Operations

## Starting and stopping

`serve` takes a lock on the data dir: one planestro per project. Stopping it (Ctrl-C,
SIGTERM) commits pending changes first, then interrupts running turns; an interrupted turn
is resumed at the next start, in the same conversation, with a note that it was interrupted.
**Parked items cost nothing to restart under** — a plan awaiting approval, a question, a
review: all of it is in the item file.

## From a phone

`serve --host 0.0.0.0` makes the UI reachable on your network at `http://<this machine>.local:4300`
(or its LAN address). **There is no authentication**: anyone on that network can approve plans and
start agents, so only do it on a network you trust.

Under 840px the same UI rearranges for one hand: tabs along the bottom (Board, Icebox and Done
share the first one), the pause lever still in the header, and the board as a single scroll under a
strip of its seven stages — tap a stage to jump to it; an amber one holds a decision waiting on you, a red one something blocked.
Cards do not drag there, because a drag and a scroll are the same gesture: tap a card for its
next steps, long-press it for the move menu. Added to the home screen it opens full-screen.

## Watch mode

`serve --watch` is for working on planestro itself while it works for you.

- A change under `packages/web` (or `shared`) **rebuilds the UI**. The process that owns
  the agents is not touched; open pages notice the new bundle within seconds and reload —
  or, if you are mid-typing, show a click-to-reload banner.
- A change under `packages/server` (or `shared`) **restarts the server, draining first**:
  automation is paused so running turns finish and nothing new starts, the restart happens
  in that gap, and automation resumes if the supervisor was what paused it.
- A server that dies on a syntax error is restarted by your next save, not in a loop.
- **One supervisor per data dir.** It holds `<data_dir>/.planestro/supervisor` (`pid`, `port`,
  `host`, `started_at`); a second `serve --watch` on the same data dir exits with the pid and
  URL of the first. A lock whose pid is dead is replaced.
- A server that cannot own the data dir (another planestro has it: `serve` exits 10) or the
  port (EADDRINUSE: exits 11) **stops the supervisor** with that reason; no source change would
  fix either. After every start the supervisor polls `/api/state` for 60 s and logs an ERROR
  if the server never answers.

## The big red lever

**PAUSE AUTOMATION** (persisted in `planestro.local.yml`): whatever is running finishes its
current safe operation; nothing is admitted, no merge job starts, the orchestrator does not
wake. Use it before doing anything by hand in the code repository that planestro is also
working in.

## Restarting safely

A restart in the middle of a turn, a setup hook or a merge leaves work to be recovered (the
reconciler does, but a setup that was cut short can orphan an item). To restart for a new
build or config: **Console → Prepare to restart** (or `curl -X POST :4300/api/engine/drain`).
Nothing new starts, and what is running finishes — turns, engine steps, operations in flight,
an orchestrator wake — including the follow-ups they start. The header shows **DRAINING · N
left**, then **SAFE TO RESTART** (`GET /api/engine` → `restart.idle: true`). Unlike PAUSE it
is not persisted: planestro comes back running. Items waiting in triage stay there and are
picked up after the restart. **Cancel restart preparation** (or `DELETE /api/engine/drain`)
carries on without one.

## Dry-run

`engine.mode: dry-run` runs the real lifecycle against in-memory fakes and logs every
command a live engine would have run as `Would …` (Console tab). Use it to see what
planestro would do to a new repository before letting it. The fake world is rebuilt from
the item files at startup.

## Upgrading

```sh
git pull && npm install && npm run build
npm run planestro -- migrate <data_dir>     # only if the schema moved; harmless otherwise
```

An older data dir opens **read-only** until migrated — it is never rewritten behind your
back. With `--watch` running from the same checkout, a pull that touches server code
restarts the server: stop planestro, pull, migrate, start. New shipped prompts are used
from the tool until your project has its own copy; `init` on the existing data dir copies
in any that are missing.

Schema 3 moves the orchestrator's questions into `questions/Q-<n>.md`: `migrate` imports every
question from the journal (the same text asked again about the same item becomes one question,
with the repeats in its thread; one whose item is already finished or iceboxed arrives
resolved) and commits it as `planestro: migrate schema 2 → 3`. The rules for the new question
tools travel in each wake's packet, so a project's own copy of `orchestrator-system` keeps
working without an edit.

## Recovery

| Situation | What to do |
|---|---|
| Something looks out of step with GitHub | **Reconcile** (Console tab, or `planestro reconcile`). It converges crash leftovers and prints each correction; it never deletes. |
| An item is blocked | The reason is on the card and in its Activity log: see [Troubleshooting](troubleshooting.md). **unblock…** clears it and, with a message, resumes the session with your decision. |
| The work landed some other way | **close as done…** — finishes the item without a pull request; its worktree and branch are removed only if they hold nothing. |
| You iceboxed an item that was in flight | Queue it again: it picks its existing worktree back up (setup hooks are not re-run). |
| A pull request was held | **Approve & merge** (a review hold) or **Release hold** (`skip_merge`): either way it goes back through sync and CI, because the base may have moved (a branch still on the base tip is not re-pushed; its green run is reused). Why it is held is on its page (**Held: …**). |
| A plan says its pull request must wait | The approval card quotes the sentence: **Approve and hold the PR** opens the pull request held, for that reason. Before the pull request exists, **Drop the hold** takes it off again. |
| You edited files by hand while it ran | **Reload from disk** (Settings → Data & releases). Prefer stopping planestro first. |

## Backups and history

The data dir is a git repository: every semantic change is a commit, `git.auto_push` sends
it to its remote at each checkpoint, and the journal records every operation's begin and
end. `git log -- items/MP-12.md` is an item's full history.

## Spending

- Claude: `budget_usd_per_item` caps an item across all of its turns, counted turn by turn (a
  resumed session reports its running total; planestro takes what it rose by). A resume that
  costs more than the item has left is not started, and above `budget_usd_fresh_above` a fix
  goes to a fresh session with a brief rather than reloading a long one. Sessions use your
  `claude` login by default; set an Anthropic API key (Settings → This machine) to bill the
  API under the Commercial Terms, which is what the Agent SDK's documentation asks of
  SDK-built agents.
- Codex: `budget_turns_per_item` and `budget_tokens_per_item`; it bills your Codex login.
- `concurrency.max_sessions` and `concurrency.runner_limits` bound how much runs at once.
