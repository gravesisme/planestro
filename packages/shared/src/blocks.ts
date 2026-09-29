/**
 * What each `blocked_reason` means and what to do about it, for the item page: a code alone
 * ("ci_timeout") sends the reader to the manual. Same wording as docs/troubleshooting.md; a test
 * keeps every reason the engine can raise present here, as it does for the manual. Markdown.
 */
export const BLOCK_HELP: Record<string, { meaning: string; todo: string }> = {
  agent_blocked: { meaning: "The worker reported it cannot proceed and said what it needs (a decision, a missing reference image, a sandbox refusal of something the task requires).", todo: "Answer in the unblock message, or fix the item (attach the reference, correct the brief) and unblock." },
  cli_too_old: { meaning: "The Claude Code that runs the sessions is too old for the item's model (the API answered \"does not support this model; version … or newer is required\").", todo: "Update Claude Code, or point `claude_bin` in planestro.local.yml at a newer `claude`, restart planestro, and unblock." },
  waited_on_gone: { meaning: "The item was waiting to resume after other items merged, and one of them was deleted.", todo: "Unblock with the instruction it was waiting to act on (it is in the block reason), or park it on the item that replaced the deleted one." },
  mcp_missing: { meaning: "The item's model names an MCP server (`mcp` on the model row) that `planestro.local.yml` on this machine does not define under `mcp_servers`.", todo: "Add the server (command/args/env, or url) to `mcp_servers` in planestro.local.yml, restart planestro, and unblock." },
  turn_error: { meaning: "A turn failed for a reason that needs judgment: an SDK error, the budget ran out mid-turn, a Codex turn that ended without its closing JSON. The orchestrator is woken for these.", todo: "Read the detail. Unblocking resumes the same conversation." },
  no_plan: { meaning: "The planner ended its turn without submitting a plan (or an epic's breakdown), twice: it was asked once for the plan it had, whether its turn ended by itself, hit `budget_usd_per_plan_turn`, or lost its hand-in in transport.", todo: "Unblock with \"submit your plan\"; if the work is already done, **close as done…**." },
  no_commits: { meaning: "The worker said it was done, but the branch has nothing ahead of its base.", todo: "If the work truly needed no change: **close as done…**. Otherwise unblock with what is missing." },
  dirty_tree: { meaning: "Uncommitted changes remain after two reminders to commit, or the merge pipeline found the tree dirty. (Untracked files the base now tracks under the same path, such as regenerated sidecars, are moved aside to `.displaced/` instead of blocking, and untracked files `worktrees.byproducts` names never count.) The block names the files.", todo: "Look in the worktree; commit or discard, then unblock. If they are files a tool regenerates in every worktree, add their pattern to `worktrees.byproducts`." },
  planner_cannot_plan: { meaning: "The item's planner is a model whose runner cannot plan (Codex).", todo: "Pick a Claude model as the planner." },
  runner_unavailable: { meaning: "The model's runner is not present in this engine.", todo: "Check the model's `runner`." },
  auth_required: { meaning: "The agent CLI is not logged in.", todo: "`codex login` (or `claude` login), then unblock." },
  usage_exhausted: { meaning: "The item's model is out of usage (a subscription limit or missing credits) and no fallback could take the turn: the item does not allow a fallback model, its model has no `fallback`, or every model in the chain is out too. The outage is remembered in Settings → Models until the provider's reset.", todo: "Wait for the reset and unblock; or tick **allow fallback model** on the item (its model needs a `fallback` in `models:`) and unblock to continue on the fallback now." },
  rate_limited: { meaning: "The agent hit a usage or rate limit.", todo: "Wait, then unblock. Lower `concurrency.runner_limits` if it recurs." },
  session_lost: { meaning: "The conversation could not be resumed (its transcript is gone).", todo: "Unblock: the stored id was dropped, so the retry starts a fresh conversation with the full prompt." },
  spawn_error: { meaning: "The agent CLI could not be started.", todo: "Install it, or set its path in Settings → This machine." },
  hook_failed: { meaning: "An `after_worktree_create` command exited non-zero.", todo: "Fix the hook or the environment; unblock re-runs setup." },
  worktree_missing: { meaning: "The item's worktree no longer exists. Nothing is recreated automatically: local commits could be lost.", todo: "Restore it, or close / re-create the item." },
  worktree_taken: { meaning: "The path planestro would use already holds a worktree on a different branch.", todo: "Move it aside or remove it." },
  sync_conflict: { meaning: "Syncing with the base conflicted and nothing could resolve it: an external item has no session, and on an epic's branch the one-shot conflict session (epics.conflict_budget_usd) could not, or is turned off. The log says why.", todo: "Resolve by hand in the directory named in the log, then unblock; or, for an epic, let the orchestrator retry it with resolve_epic_conflict and a hint." },
  asset_too_large: { meaning: "A changed file exceeds `review.max_file_bytes`. No pull request was opened.", todo: "Shrink it (or raise the limit), commit, unblock." },
  ci_red: { meaning: "CI failed and there is no session to hand the failure to.", todo: "Fix the branch by hand." },
  ci_red_twice: { meaning: "CI failed again after the session's fix.", todo: "Read both logs; message the session with what it is missing, or take over." },
  ci_timeout: { meaning: "A run did not finish within `ci.timeout_min`.", todo: "Check the run; unblock to re-enter the pipeline." },
  ci_disagree: { meaning: "CI was seen green for a head, then the merge step's own look at that same head disagreed twice (the PR's head moved, or GitHub reported different verdicts). It is stopped rather than bounced between the two.", todo: "Check the pull request's head and its run; unblock to re-enter the pipeline." },
  ci_skipped: { meaning: "Every CI run for the head skipped its jobs (a draft guard), and none ran after planestro sent ready for review once more (or the pull request is still a draft). A skipped run is not a verdict.", todo: "Check the pull request's draft state and the workflow's job conditions, start a run by hand, then unblock." },
  ci_blocked: { meaning: "GitHub Actions did not run at all (billing block, no workflow).", todo: "Set `ci.mode: github-or-local` with a `ci.local_check_command`, or re-run by hand." },
  base_red: { meaning: "The base branch's own tip is red and `ci.require_green_base` is on.", todo: "Fix the base, or turn the gate off." },
  merge_unverified: { meaning: "`gh` reported a merge but the pull request is not MERGED.", todo: "Look at the pull request; reconcile." },
  pr_closed_externally: { meaning: "The pull request was closed without merging.", todo: "Reopen it, or close the item." },
  cleanup_unverifiable: { meaning: "After the merge, the branch tip could not be proven reachable from the base. **Nothing was deleted.**", todo: "Check the merge; remove the worktree and branch by hand if it is right." },
  cleanup_dirty: { meaning: "The worktree has uncommitted changes after the merge.", todo: "Discard or rescue them, then remove the worktree by hand." },
  engine_error: { meaning: "An unexpected error inside a lifecycle step; the message is the exception. Transient git and GitHub failures (a ref lock held by another git process, a network or GitHub timeout, a 5xx) are retried with backoff before a step fails, so one that still arrives here persisted for about a minute.", todo: "If a retry makes sense, unblock; if it repeats, it is a bug — the Activity log and journal have what is needed to report it." },
  turn_budget: { meaning: "A token-billed runner spent its turn budget (`budget_turns` on the item, else `budget_turns_per_item`).", todo: "Raise it in the cost row on this page and unblock, or take the item over by hand." },
  over_budget: { meaning: "The item has spent (almost) all of its dollar budget (`budget_usd` on the item, else `budget_usd_per_item`): less than a dollar is left, too little for a Claude turn to finish anything, so none was started.", todo: "If the work is worth it, raise the budget in the cost row on this page (or tap the card's \"+$N and resume\" option) and unblock; it carries on from where it stopped. Otherwise take the item over by hand." },
  stalled: { meaning: "Nothing drove this item for `concurrency.stall_after_min` minutes (no turn, no engine step, no operation, not waiting on anyone), and it stalled again within an hour of being carried on automatically.", todo: "Look at the worktree and the Activity log for what keeps stopping it; unblock with an instruction, or take it over." },
  token_budget: { meaning: "A token-billed runner spent its token budget (`budget_tokens` on the item, else `budget_tokens_per_item`).", todo: "Raise it in the cost row on this page and unblock, or take the item over by hand." },
  orchestrator: { meaning: "The orchestrator stopped this item for you; its reason is in the log.", todo: "Decide what it asked; unblock, with a message if the session needs direction." },
};

/** Reasons built at run time (`interrupted_<op>`) share one entry. */
export function blockHelp(reason: string | undefined): { meaning: string; todo: string } | undefined {
  if (!reason) return undefined;
  if (BLOCK_HELP[reason]) return BLOCK_HELP[reason];
  if (reason.startsWith('interrupted_')) return { meaning: `planestro restarted in the middle of \`${reason.slice('interrupted_'.length)}\`, a step it will not blindly repeat.`, todo: 'Check the repository state named in the log, then unblock.' };
  return undefined;
}
