# Operations

## Starting and stopping

`serve` takes a lock on the data dir: one planestro per project. Stopping it (Ctrl-C,
SIGTERM) commits pending changes first, then interrupts running turns; an interrupted turn
is resumed at the next start, in the same conversation, with a note that it was interrupted.
**Parked items cost nothing to restart under** — a plan awaiting approval, a question, a
review: all of it is in the item file.

## Watch mode

`serve --watch` is for working on planestro itself while it works for you.

- A change under `packages/web` (or `shared`) **rebuilds the UI**. The process that owns
  the agents is not touched; open pages notice the new bundle within seconds and reload —
  or, if you are mid-typing, show a click-to-reload banner.
- A change under `packages/server` (or `shared`) **restarts the server, draining first**:
  automation is paused so running turns finish and nothing new starts, the restart happens
  in that gap, and automation resumes if the supervisor was what paused it.
- A server that dies on a syntax error is restarted by your next save, not in a loop.

## The big red lever

**PAUSE AUTOMATION** (persisted in `planestro.local.yml`): whatever is running finishes its
current safe operation; nothing is admitted, no merge job starts, the orchestrator does not
wake. Use it before doing anything by hand in the code repository that planestro is also
working in.

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

## Recovery

| Situation | What to do |
|---|---|
| Something looks out of step with GitHub | **Reconcile** (Console tab, or `planestro reconcile`). It converges crash leftovers and prints each correction; it never deletes. |
| An item is blocked | The reason is on the card and in its Activity log: see [Troubleshooting](troubleshooting.md). **unblock…** clears it and, with a message, resumes the session with your decision. |
| The work landed some other way | **close as done…** — finishes the item without a pull request; its worktree and branch are removed only if they hold nothing. |
| You iceboxed an item that was in flight | Queue it again: it picks its existing worktree back up (setup hooks are not re-run). |
| A pull request was held | **Approve & merge** (a review hold) or **Release hold** (`skip_merge`): either way it goes back through sync and CI, because the base may have moved (a branch still on the base tip is not re-pushed; its green run is reused). |
| You edited files by hand while it ran | **Reload from disk** (Settings → Data). Prefer stopping planestro first. |

## Backups and history

The data dir is a git repository: every semantic change is a commit, `git.auto_push` sends
it to its remote at each checkpoint, and the journal records every operation's begin and
end. `git log -- items/MP-12.md` is an item's full history.

## Spending

- Claude: `budget_usd_per_item` caps an item across all of its turns. Sessions use your
  `claude` login by default; set an Anthropic API key (Settings → This machine) to bill the
  API under the Commercial Terms, which is what the Agent SDK's documentation asks of
  SDK-built agents.
- Codex: `budget_turns_per_item` and `budget_tokens_per_item`; it bills your Codex login.
- `concurrency.max_sessions` and `concurrency.runner_limits` bound how much runs at once.
