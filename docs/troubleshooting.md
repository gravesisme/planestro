# Troubleshooting

A blocked item keeps its status and gains `blocked: true`, a `blocked_reason`, and a line
in its Activity log saying exactly what happened. Fix the cause, then **unblock…** — with a
message, the session resumes with your decision; without one, it carries on from where it
stopped: committed work goes to a pull request, an item in review re-enters the merge
pipeline, a setup that never ran is requeued, and otherwise the session is resumed.
A test (`docs.test.ts`) fails if the engine can raise a reason that is missing here.

With `orchestrator.triage` on, a new block first shows as **orchestrator triaging**: the
orchestrator fixes what it can (retries, worktree recreation, answers already in the brief)
and brings you only a plain decision card. See [Needs-you triage](concepts.md#needs-you-triage).

## The agent

| Reason | Meaning | Do |
|---|---|---|
| `agent_blocked` | The worker reported it cannot proceed and said what it needs (a decision, a missing reference image, a sandbox refusal of something the task requires). | Answer in the unblock message, or fix the item (attach the reference, correct the brief) and unblock. |
| `cli_too_old` | The Claude Code that runs the sessions is too old for the item's model ("does not support this model; version … or newer is required"). | Update Claude Code, or point `claude_bin` at a newer `claude`, restart planestro, and unblock. |
| `waited_on_gone` | The item was waiting to resume after other items merged (**resume when merged**), and one of them was deleted. | Unblock with the instruction it was waiting to act on (it is in the block reason), or park it on the item that replaced it. |
| `mcp_missing` | The item's model names an MCP server (`mcp` on the model row) that `planestro.local.yml` on this machine does not define under `mcp_servers`. | Add the server to `mcp_servers` in planestro.local.yml (command/args/env, or url), restart planestro, and unblock. |
| `turn_error` | A turn failed for a reason that needs judgment: an SDK error, the budget ran out mid-turn, a Codex turn that ended without its closing JSON. The orchestrator is woken for these. | Read the detail. Unblocking resumes the same conversation. |
| `no_plan` | The planner ended its turn without submitting a plan (or an epic's breakdown), twice: it was asked once for the plan it had, whether its turn ended by itself, hit `budget_usd_per_plan_turn`, or lost its hand-in in transport. | Unblock with "submit your plan"; if the work is already done, **close as done…**. |
| `no_commits` | The worker said it was done, but the branch has nothing ahead of its base. | If the work truly needed no change: **close as done…**. Otherwise unblock with what is missing. |
| `dirty_tree` | Uncommitted changes remain after two reminders to commit, or the merge pipeline found the tree dirty. (Untracked files that the base branch now tracks under the same path, such as regenerated `.import` sidecars, do not block the pipeline: they are moved to `<worktrees root>/.displaced/<item>-<time>/` and named in the Activity log.) | Look in the worktree; commit or discard, then unblock. |
| `planner_cannot_plan` | The item's planner is a model whose runner cannot plan (Codex). | Pick a Claude model as the planner. |
| `runner_unavailable` | The model's runner is not present in this engine. | Check the model's `runner`. |
| `over_budget` | The item has spent (almost) all of its dollar budget (`budget_usd` on the item, else `budget_usd_per_item`); less than a dollar is left, so no Claude turn was started. | Raise the budget in the item's cost row (or tap the card's "+$N and resume" option) and unblock; it carries on from where it stopped. Otherwise take the item over by hand. |
| `turn_budget` / `token_budget` | A token-billed runner spent its turn / token budget (`budget_turns` / `budget_tokens` on the item, else the project's `budget_turns_per_item` / `budget_tokens_per_item`). | Raise it in the item's cost row and unblock, or take the item over by hand. |
| `stalled` | Nothing drove the item for `concurrency.stall_after_min` minutes, and it stalled again within an hour of being carried on automatically. | Look at the worktree and the Activity log for what keeps stopping it; unblock with an instruction, or take it over. |
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
| `ci_disagree` | CI was seen green for a head, then the merge step's own look at that same head disagreed twice (the PR's head moved, or GitHub reported different verdicts). It is stopped rather than bounced between the two. | Check the pull request's head and its run; unblock to re-enter the pipeline. |
| `ci_skipped` | Every CI run for the head skipped its jobs (a draft guard), and none ran after planestro sent ready for review once more (or the pull request is still a draft). A skipped run is not a verdict. | Check the pull request's draft state and the workflow's job conditions, start a run by hand, then unblock. |
| `ci_blocked` | GitHub Actions did not run at all (billing block, no workflow). | Set `ci.mode: github-or-local` with a `ci.local_check_command`, or re-run by hand. |
| `base_red` | The base branch's own tip is red and `ci.require_green_base` is on. | Fix the base, or turn the gate off. |
| `merge_unverified` | `gh` reported a merge but the pull request is not MERGED. | Look at the pull request; reconcile. |
| `pr_closed_externally` | The pull request was closed without merging. | Reopen it, or close the item. |
| `cleanup_unverifiable` | After the merge, the branch tip could not be proven reachable from the base. **Nothing was deleted.** | Check the merge; remove the worktree and branch by hand if it is right. |
| `cleanup_dirty` | The worktree has uncommitted changes after the merge. | Discard or rescue them, then remove the worktree by hand. |
| `engine_error` | An unexpected error inside a lifecycle step; the message is the exception. Transient git and GitHub failures (a ref lock held by another git process, a network or GitHub timeout, a 5xx) are retried with backoff before a step fails, so one that still arrives here persisted for about a minute. | If a retry makes sense, unblock; if it repeats, it is a bug — the Activity log and journal have what is needed to report it. |

## Not blocked, but stuck?

- **"Orchestrator triaging" for a long time.** It ends by itself after
  `orchestrator.triage_timeout_min` (10); pausing automation, or unblocking / answering the
  item yourself, ends it at once. If the orchestrator keeps failing to wake, look at the
  Console for `orchestrator wake failed` — or turn `orchestrator.triage` off.

- **Nothing starts.** Automation paused? `max_sessions` full? Dependencies not merged
  (`waits on …` on the card)? A parent epic not opened?
- **Automation paused by the usage guard** (header: *PAUSED — usage 87% of 5-hour window ·
  resumes 6:20 pm*). A Claude subscription window reached `usage_guard.threshold` (or warned).
  It waits for you: press **RESUME** when you want to spend again (after the reset, or now if
  you would rather use the rest of the window). With `usage_guard.auto_resume: true` it resumes
  on its own a minute after the reset ([Usage guard](configuration.md#usage-guard)).
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
