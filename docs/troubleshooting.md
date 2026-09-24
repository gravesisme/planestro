# Troubleshooting

A blocked item keeps its status and gains `blocked: true`, a `blocked_reason`, and a line
in its Activity log saying exactly what happened. Fix the cause, then **unblock…** — with a
message, the session resumes with your decision; without one, the engine re-evaluates.
A test (`docs.test.ts`) fails if the engine can raise a reason that is missing here.

With `orchestrator.triage` on, a new block first shows as **orchestrator triaging**: the
orchestrator fixes what it can (retries, worktree recreation, answers already in the brief)
and brings you only a plain decision card. See [Needs-you triage](concepts.md#needs-you-triage).

## The agent

| Reason | Meaning | Do |
|---|---|---|
| `agent_blocked` | The worker reported it cannot proceed and said what it needs (a decision, a missing reference image, a sandbox refusal of something the task requires). | Answer in the unblock message, or fix the item (attach the reference, correct the brief) and unblock. |
| `turn_error` | A turn failed for a reason that needs judgment: an SDK error, the budget ran out mid-turn, a Codex turn that ended without its closing JSON. The orchestrator is woken for these. | Read the detail. Unblocking resumes the same conversation. |
| `no_plan` | The planner ended its turn without submitting a plan (or an epic's breakdown). | Unblock with "submit your plan"; if the work is already done, **close as done…**. |
| `no_commits` | The worker said it was done, but the branch has nothing ahead of its base. | If the work truly needed no change: **close as done…**. Otherwise unblock with what is missing. |
| `dirty_tree` | Uncommitted changes remain after two reminders to commit. | Look in the worktree; commit or discard, then unblock. |
| `planner_cannot_plan` | The item's planner is a model whose runner cannot plan (Codex). | Pick a Claude model as the planner. |
| `runner_unavailable` | The model's runner is not present in this engine. | Check the model's `runner`. |
| `turn_budget` / `token_budget` | A token-billed runner spent `budget_turns_per_item` / `budget_tokens_per_item` on this item. | Raise the budget, or take the item over by hand. |
| `auth_required` | The agent CLI is not logged in. | `codex login` (or `claude` login), then unblock. |
| `usage_exhausted` | The item's model is out of usage (a subscription limit or missing credits) and no fallback could take the turn: the item does not allow a fallback model, its model has no `fallback`, or every model in the chain is out too. The outage is remembered in Settings → Models until the provider's reset. | Wait for the reset and unblock; or tick **allow fallback model** on the item (its model needs a `fallback` in `models:`) and unblock to continue on the fallback now. |
| `rate_limited` | The agent hit a usage or rate limit. | Wait, then unblock. Lower `concurrency.runner_limits` if it recurs. |
| `session_lost` | The conversation could not be resumed (its transcript is gone). | Unblock: the stored id was dropped, so the retry starts a fresh conversation with the full prompt. |
| `spawn_error` | The agent CLI could not be started. | Install it, or set its path in Settings → This machine. |

## Git and worktrees

| Reason | Meaning | Do |
|---|---|---|
| `hook_failed` | An `after_worktree_create` command exited non-zero. | Fix the hook or the environment; unblock re-runs setup. |
| `worktree_missing` | The item's worktree no longer exists. Nothing is recreated automatically: local commits could be lost. | Restore it, or close / re-create the item. |
| `worktree_taken` | The path planestro would use already holds a worktree on a different branch. | Move it aside or remove it. |
| `sync_conflict` | Syncing with the base conflicted and there is no session to hand the conflict to (an epic branch, an external item). | Resolve by hand in the directory named in the log, then unblock. |
| `asset_too_large` | A changed file exceeds `review.max_file_bytes`. No pull request was opened. | Shrink it (or raise the limit), commit, unblock. |

## CI and merging

| Reason | Meaning | Do |
|---|---|---|
| `ci_red` | CI failed and there is no session to hand the failure to. | Fix the branch by hand. |
| `ci_red_twice` | CI failed again after the session's fix. | Read both logs; message the session with what it is missing, or take over. |
| `ci_timeout` | A run did not finish within `ci.timeout_min`. | Check the run; unblock to re-enter the pipeline. |
| `ci_blocked` | GitHub Actions did not run at all (billing block, no workflow). | Set `ci.mode: github-or-local` with a `ci.local_check_command`, or re-run by hand. |
| `base_red` | The base branch's own tip is red and `ci.require_green_base` is on. | Fix the base, or turn the gate off. |
| `merge_unverified` | `gh` reported a merge but the pull request is not MERGED. | Look at the pull request; reconcile. |
| `pr_closed_externally` | The pull request was closed without merging. | Reopen it, or close the item. |
| `cleanup_unverifiable` | After the merge, the branch tip could not be proven reachable from the base. **Nothing was deleted.** | Check the merge; remove the worktree and branch by hand if it is right. |
| `cleanup_dirty` | The worktree has uncommitted changes after the merge. | Discard or rescue them, then remove the worktree by hand. |
| `engine_error` | An unexpected error inside a lifecycle step; the message is the exception. | If a retry makes sense, unblock; if it repeats, it is a bug — the Activity log and journal have what is needed to report it. |

## Not blocked, but stuck?

- **"Orchestrator triaging" for a long time.** It ends by itself after
  `orchestrator.triage_timeout_min` (10); pausing automation, or unblocking / answering the
  item yourself, ends it at once. If the orchestrator keeps failing to wake, look at the
  Console for `orchestrator wake failed` — or turn `orchestrator.triage` off.

- **Nothing starts.** Automation paused? `max_sessions` full? Dependencies not merged
  (`waits on …` on the card)? A parent epic not opened?
- **A child of an epic never starts.** It waits until every `depends_on` item has
  **merged into the epic branch** — a review hold on an art child is usually what it is
  waiting for.
- **Held pull request.** `awaiting: review` → *Approve & merge*; `skip_merge` →
  *Release hold*.
- **The page says an update is ready.** Watch mode rebuilt the UI while you were typing;
  click the banner when you are done.
- **Startup warns that Claude Code or Codex changed version.** The orchestration was
  validated against the versions in `packages/server/src/compat.ts`; it is a warning, not
  a failure. Re-run the spikes (`npm run spike`, `npm run spike:codex`) if behaviour looks off.
