# Dogfood log: the Crystal Cavern epic (Hurricane Harrison)

Everything planestro got wrong, or could do better, while driving the Hurricane Harrison
epic HH-113 (Crystal Cavern) with Claude and Codex Art workers, 2026-09-22/23. It is kept
live on the project tracker (planestro_issues); this file is a snapshot for review.
Items marked *game* are the game's own CI, not planestro. **Features are proposals for the
maintainer to review, not decisions.**

## Issues

### p1 — A Fable outage blocks every Claude item

*bug · fixed*

LiveClaudePort never classifies usage exhaustion: an exhausted subscription model ends as a generic turn_error, and nothing falls back. Only the Codex port recognises rate or usage limits.

**Evidence.** LiveCodexPort.ts:66 matches rate/usage limits; LiveClaudePort.consume() has no equivalent; docs/codex-epic-plan.md: "automatic retry … deliberately not done".

**Fix.** planestro#9: usage_exhausted subtype, per-model fallback in config, remembered unavailable-until window (planestro.local.yml), per-item opt-in, SDK fallbackModel for overloads.

### p2 — The orchestrator's model can only be set in YAML

*gap · fixed*

Settings shows orchestrator.model as read-only text ("edit in planestro.yml"), so switching it during an outage means stopping planestro and hand-editing.

**Evidence.** packages/web/src/pages/Settings.tsx:47; PUT /api/config whitelists only may_approve_plans, max_plan_revisions and may_decide_permissions.

**Fix.** planestro#9: orchestrator model select + allow-fallback checkbox in Settings, both whitelisted in PUT /config.

### p3 — Epic children can't carry their own planner

*gap · open*

approveBreakdown gives children only an implementer; every child's planner is the project default, so art children are planned by Fable too and a Fable outage reaches every child's planning turn.

**Evidence.** docs research 2026-09-22 (HH-107 was planned by fable-5 though its implementer is codex-art).

**Fix.** Let submit_breakdown name a planner per child, or inherit the epic's planner. Phase A's inherited fallback flag covers the outage in the meantime.

### p4 — The SDK's bundled Claude Code is too old for new models

*bug · open*

The Agent SDK runs its bundled CLI (2.1.251) unless claude_bin is set. The first fallback wake failed with “API Error: 400 Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required.” planestro already warns at startup that the installed CLI is 2.1.280 but still runs the bundled one.

**Evidence.** journal 2026-09-22T20:39:55 orchestrator.done summary; worked around by setting claude_bin to /Users/dgraves/.local/bin/claude

**Fix.** Default to the installed claude when it is newer than the bundled one (or bump the SDK), and classify “does not support this model” as its own actionable failure.

### p5 — An API error that arrives as text is recorded as success

*bug · open*

The failed wake above (and a Fable limit message at 17:19) ended with result subtype “success”: the orchestrator logged the error text as its summary and moved on. A worker turn in the same state would look finished.

**Evidence.** journal 2026-09-22T17:19:43 and 20:39:55 orchestrator.done, subtype success, summary = the error

**Fix.** Treat a result whose only text is an “API Error: …” line (or is_error) as a failure; wake retries once and then warns.

### p6 — A breakdown can't say “hold this for review”

*gap · open*

submit_breakdown has no per-child hold, so the planner wrote “(HOLD for review)” into three titles, which planestro ignores. Without a manual fix those children would have merged unseen.

**Evidence.** HH-122, HH-125, HH-128 titles; skip_merge set by hand via PATCH after approval

**Fix.** Add an optional `hold` (skip_merge) flag per child in submit_breakdown, shown and editable in the BreakdownPanel.

### p7 — An art item's planner isn't told Codex will implement it

*bug · open*

HH-114's planner (a Claude session) parked with a question: “This session is Claude, which can't generate images. How should the art be made?”, and recommended drawing the art procedurally in Python. The plan-item prompt never names the item's implementer, its runner or its description, so a planner can't tell it is writing a brief for Codex Art.

**Evidence.** HH-114 awaiting question at 2026-09-22T20:53:04; prompts/plan-item.md has no implementer placeholder. Worked around: answered HH-114, messaged HH-115 (already planning), added a “Who implements this” note to HH-116–HH-119.

**Fix.** Render the implementer (label, runner, description) into plan-item, and for a non-Claude runner say: you are writing the brief that runner follows; do not plan to do its work yourself. Pairs with p3 (per-child planner).

### p8 — A plan is reviewed twice when delegation is switched on after it's ready

*idea · open*

HH-114 and HH-115 each got an advisory orchestrator review (“user approves”) while waiting on you, then a second full review once auto-approve was ticked. The first review's findings were not reused.

**Evidence.** HH-114/HH-115 Activity 2026-09-22 ~20:55–21:00: “Orchestrator plan review (user approves)”, then “plan approval delegated”, then a fresh review

**Fix.** When delegation is ticked on a plan the orchestrator already reviewed, hand it that review in the wake packet and ask only for the decision.

### p9 — A turn waiting for a runner slot shows as a running agent

*bug · open*

With runner_limits codex: 1, HH-115 and HH-116 both appear in Sessions as busy Codex Art implement turns, and the header counts two agents running, but only one `codex exec` process exists. The engine registers the turn before withRunnerSlot admits it.

**Evidence.** api/state sessions at 2026-09-22 ~21:30: HH-115 + HH-116 'Codex Art implement'; pgrep shows one codex exec (HH-115). LiveEngine.runTurnFor sets this.turns before withRunnerSlot (line ~461 vs 474).

**Fix.** Mark slot-waiting turns as 'waiting for a Codex slot' in SessionView (busy: false) and leave them out of the running-agents count.

### p10 — Art-only PRs run the full Godot suite on metered CI

*idea · open*

Each Codex Art child's PR (PNGs, a prep tool, a deliverables doc) runs the whole headless suite. Six art PRs in this epic at ~30 min each come out of the 2,000-minute budget, although nothing registers the art until C2.

**Evidence.** HH-114 → PR #296 awaiting_ci on feature/crystal-cavern

**Fix.** Game side: a lighter CI path for PRs that only add unregistered assets/docs/tools; or planestro's ci.mode github-or-local for art items with a local import + targeted checks.

### p11 — The Codex sandbox intermittently can't write the worktree's git lock (3 of 5 Codex items so far)

*bug · open*

HH-115 finished all 14 PNGs (validation 101/101, checks green) but ended agent_blocked: the workspace-write sandbox refused to create .git/worktrees/hh-115-…/index.lock. Earlier in the same turn a file was staged successfully, and sibling HH-114 committed fine with the same flags, so the git metadata dir (outside the worktree) is only sometimes writable. The orchestrator diagnosed it correctly but can't do git.

**Evidence.** HH-115, HH-116 and now HH-119's CI-fix turn blocked on EPERM for .git/worktrees/<name>/index.lock; HH-114 and HH-117 committed fine. Same flags every time. In HH-115's own session `git add` exited 0 at 01:23:35Z and failed EPERM at 01:36:47Z. Recovered each by hand (0fe93c13, 7d00f91f, f0bafa10) plus a resume message.

**Fix.** planestro should own the commit for runners without reliable git: after a Codex turn ends done (or blocked on a git refusal) with a dirty tree, the engine stages and commits the worktree itself with the worker's summary, then continues to the PR. Keeps the worker sandbox tight (no --add-dir) and matches 'planestro owns git'.

### p12 — Unblocking without a message leaves an item idle

*bug · open*

After committing HH-115's work by hand, 'unblock' with no message cleared the block but nothing re-evaluated the item: IN_PROGRESS, no op, no turn, no PR. The docs say the engine re-evaluates; for an agent_blocked implement item it doesn't check the clean-tree + commits-ahead path.

**Evidence.** HH-115 2026-09-22 ~21:45: 'user unblocked' then idle for 60 s; a /message was needed to resume the Codex thread.

**Fix.** On a messageless unblock of an implement-phase item, run afterWorkTurn's deterministic check (clean + ahead of base → open the PR); otherwise resume with a 'continue' note.

### p13 — Worker questions go straight to the user, even trivial technical ones

*idea · open*

HH-117's Codex worker parked the item on the user with “Accept the Foreman's 512×509 opaque bounds, or regenerate for exactly 512×512?”, a tolerance call the plan and project rules already answer (footprint within ~2 px of the hurt shape). The orchestrator decides permissions and plans but never sees worker questions. The Codex question also arrived with no options, so the phone UI can only offer free text.

**Evidence.** HH-117 awaiting question 2026-09-22T22:21:01; answered by Claude on the user's behalf.

**Fix.** Route worker questions through the orchestrator first when the item delegates plan approval: it answers ones the plan, CLAUDE.md or the design doc settle and hands the rest to the user. Ask Codex for 2–4 options in its question JSON.

### p14 — An item parked on another item still counts as “needs you”

*gap · open*

HH-118 is intentionally blocked until HH-129 (the normalizer flag) merges, but it keeps the red NEEDS YOU badge and 'awaiting user'. There is no way to say 'blocked on HH-129' for an item already in progress: depends_on only gates starting, and a messageless unblock leaves it idle (p12).

**Evidence.** Board 2026-09-22 ~22:50: NEEDS YOU · 1 = HH-118 after the designer had already decided; the designer asked whether they needed to act.

**Fix.** Let an in-progress item wait on another item (a 'resume when HH-129 merges' state, with the message to send), shown as waiting rather than needing the user, and resumed automatically.

### p15 — Approved PRs wait behind other items' CI in the serial merge chain

*bug · open*

The designer approved HH-114/115/116 at 22:42–22:43. Their CI was already green (planestro reset it to 'pending' on release), but no merge started for 15+ minutes. driveInReview runs every candidate's mergeJob through one strictly serial chain, and the chain was held by HH-117's mergeJob, which sits in awaiting_ci for ~20 minutes and then aborts at 'awaiting_review' anyway (a Codex Art hold). HH-119's CI wait queues the same way. A held item's CI wait blocks every approved merge behind it.

**Evidence.** HH-114/115/116: 'approved for merge' 22:42–22:43, then no op; HH-117 op awaiting_ci since 22:41 (PR #299 run started 02:41Z); LiveEngine.driveInReview comment 'mergeChain keeps them strictly serial'.

**Fix.** Only hold the chain for the sync+merge step, not for CI polling; or poll CI outside the chain and enter it when green. Also: on release, keep ci_result green when the head and base are unchanged instead of resetting to pending.

### p16 — The per-item budget has no override, and a big Opus item outgrows it

*gap · open*

HH-120 (Thunder Stomp) spent $67.79 against the $60 per-item cap and stopped one step from done. The only fix is editing planestro.yml for every item and reloading; Settings doesn't expose the cap and an item can't carry its own. Opus 5.5 plan + implement turns on this repo cost far more than the default assumes. Also, the block report is cut to 500 characters in the Activity log, so the worker's list of what's left was lost there (only the console had it).

**Evidence.** HH-120 BLOCKED 23:09:28 'Budget nearly exhausted (about $3 left)'; budget raised to 150 by the designer's choice, reloaded via POST /api/reload, unblocked.

**Fix.** Per-item budget override on the item page (and via breakdown), budget in Settings, a warning at 80% instead of a hard stop mid-verification, and keep the full block report (collapse it in the UI instead of truncating).

### p17 — Deferred .import files dirty every later worker's tree

*gap · open*

The art items followed the plan ('C2 owns the imports') and didn't commit .png.import files. After HH-114 merged, every worktree's after_worktree_create import regenerates them, so later workers (HH-129) find untracked files they must delete each time, and it recurs until HH-121 commits them. The breakdown split files cleanly but didn't account for generated sidecars.

**Evidence.** HH-129 question 23:16:16. Second occurrence 01:20: HH-119's merge aborted as dirty_tree because untracked cc_*/enemy_*.import sidecars (generated by a local check run in that worktree, mine) collided with the tracked copies HH-121 had just merged; removing exactly the untracked .import files let the rebase through.

**Fix.** Breakdown guidance: an asset item commits its own generated sidecars (or the project's hook gitignores them until registered). planestro's sync step could safely drop untracked files that the base now tracks with identical names, since they are regenerated artefacts, instead of blocking. Lesson for Claude: don't run the check suite inside a worker's worktree without cleaning the sidecars it generates.

### p18 — submit_plan failed with 'Stream closed'; the orchestrator blamed the budget

*bug · open*

HH-121's planner wrote a full plan, but both submit_plan calls failed with 'Stream closed' (the in-process MCP transport dropping late in a long turn, sdk-notes #11). The engine saw a turn with no plan and blocked it as no_plan. The orchestrator then diagnosed a budget stop at 'the ~$22 per-item default', which is wrong: the cap is $150 and the item had spent $20. It reasoned from stale notes rather than the item's actual config and the console. The planner saved the plan to a file, which is the only reason nothing was lost.

**Evidence.** HH-121 console 23:45:10–19 ('both submit_plan calls failed with Stream closed'); orchestrator diagnosis 23:45:31; budget_usd_per_item 150. Recovered by unblocking with 'resubmit the saved plan'.

**Fix.** Retry the MCP tool call (or respawn the MCP server) on a transport error before telling the model it failed. Classify a turn whose tool calls errored with 'Stream closed' as a transport failure (auto-resume once with 'resubmit'), not no_plan. Give the orchestrator the item's real budget and spend in its wake packet.

### p19 — The art model's own rule ('no .import files') collides with checks that pin import settings

*gap · open*

The codex-art model row says it 'does not write GDScript, scenes or .import files', and the breakdown told art items to leave imports to C2. But an interface icon is pinned by stat_skill_icons_check to a lossless 512px mipmapped import, so HH-119's PR went red on its first CI (~18 CI minutes). The orchestrator's art pre-review read the PNG and the HUD mock but not the import contract.

**Evidence.** PR #300 CI run 35814845870: stat_skill_icons_check 'requires lossless import, 512px limit and mipmaps'; plus an unrelated level_up_pause_resume_check flake in the same run.

**Fix.** Let an art item deliver the import sidecar when a check pins its settings (the model description should say 'writes .import only when asked'). The planner should list pinned import contracts for the files it delivers, and the pre-review should run the file-specific checks locally before CI.

### p20 — Permission parking burns the budget: the allow rules miss the forms workers use

*bug · fixed*

HH-121 parked 11 times, and its worker said most of its $161 went on permission stops. The allow rule is Bash(./tools/run_checks.sh*), but workers run `CHECK_JOBS=4 ./tools/run_checks.sh … 2>&1 | tail -30`. allowedByRules requires every pipeline segment to match by prefix, so the env prefix and the `tail` both miss. `timeout 120 godot --headless` misses the godot rule the same way. Each park ends the turn, wakes the orchestrator, and the resume re-reads the whole context. The orchestrator's approval is one-shot, so the identical command parked again 20 s later.

**Evidence.** HH-121 Activity 23:51–00:01: parked/one-shot pairs for the same CHECK_JOBS=4 run_checks commands; BLOCKED 00:02:05 at $161/$150. Mitigated in config: narrow CHECK_JOBS=N and `timeout N godot --headless` rules plus tail -, head -, wc -l, verified with allowedByRules (unsafe forms still refused).

**Fix.** planestro#10: normalizeSegment() peels NAME=value assignments and timeout/nice/nohup/time/env wrappers before matching, for BOTH allow and deny (the deny rules had the mirror bug: `GIT_TRACE=1 git push` slipped past 'never push'). Dangerous env names (PATH, LD_*, DYLD_*, GIT_*, NODE_OPTIONS, …) never auto-allow. 8 new tests (4 fail on the old matcher); 146/146.

### p21 — Workers reach for `timeout`, which macOS doesn't have

*bug · open*

Every capture attempt in HH-121 ran `timeout 120 … Godot …` and failed instantly with 'command not found' (rc 127), which the worker read as the capture hanging or walls rendering blank. It spent the end of a $269 item chasing it. The orchestrator also suggested `timeout 120` (and I added `timeout N godot` allow rules that are useless on macOS). The Godot capture also waited on frame_post_draw, which never fires in an occluded window.

**Evidence.** Running the same command by hand: '(eval):1: command not found: timeout', rc=127. With force_draw and no timeout the capture wrote both sheets in seconds (commit d5fad2ef).

**Fix.** Worker-system prompt: state the host OS and that GNU coreutils (timeout, gtimeout) are absent on macOS; use the Bash tool's own timeout. Treat rc 127 'command not found' as a distinct, loudly reported failure in the console.

### p22 — The 10 MB review file limit blocks legitimate music

*gap · open*

review.max_file_bytes (default 10 MB) exists to catch accidental huge art, but it blocked HH-130's 11.3 MB world theme after the work was done and verified. This repo's shipped themes are 7–11 MB. Like p12, unblocking doesn't reopen the PR path, so the PR had to be opened by hand.

**Evidence.** HH-130 BLOCKED (asset_too_large) 00:21:26; limit raised to 16 MB in planestro.yml; PR #304 opened by hand.

**Fix.** Per-extension or per-directory limits (audio vs images), a warning with a one-click 'allow this file' instead of a hard block, and resume the PR step when the block is cleared.

### p23 — Game CI (not planestro): stale Godot import cache survives a .import change

*bug · open*

PR #300 went red twice on stat_skill_icons_check although the icon and its .import were correct and the check passed locally. CI's restore-keys prefix fallback restored a cache from the PR's first run (the icon imported with default settings); Godot doesn't re-import an unchanged source when only .import settings change; the second run then saved the stale import under the new exact key. Planestro's side worked: the orchestrator diagnosed the cache correctly and asked; the Codex fix turn was wasted work.

**Evidence.** PR #300 runs 35814845870 and 35819614594; caches 8005031281 and 8007521361 (refs/pull/300/merge) deleted; empty commit 50a5b51 re-runs CI; the reconciler discarded the stale verdict.

**Fix.** HH-137 (queued, → develop): prune .godot/imported entries whose .import changed since a manifest saved in the cache, keeping the key scheme and the fallback.

### p24 — The Codex token cap is only discovered at the next turn

*gap · open*

HH-118 reached 810k tokens against budget_tokens_per_item 600k mid-item; planestro only checks the cap before starting a turn, so the item would have been refused on its final pack after all the art was done. Nothing warned when it crossed the cap, and the cap isn't in Settings.

**Evidence.** HH-118 tokens 810154, agent_turns 3; budget_tokens_per_item 600000 (default). Raised to 1.5M by the designer's choice before it blocked.

**Fix.** Warn in Activity and on the board at 80% of any budget (dollars, turns, tokens); expose all three caps in Settings; allow a per-item override (with p16).

### p25 — Idle items hold session slots: nothing was admitted

*bug · open*

At ~01:25 no agent was running although HH-122, HH-136 and HH-137 were queued with dependencies met. admit() counts every PLAN_IN_PROGRESS/IN_PROGRESS item that isn't awaiting or blocked, whether or not anything drives it: (1) HH-109 had been unblocked without a message on 2026-09-18 and sat idle for five days, its work already merged as #293; (2) the epic HH-113 counts as a session for its whole life; (3) HH-123 was orphaned by a restart between its worktree hook and its first planning turn (my idle check counted agent sessions, not setup jobs). 3 of 3 slots, zero agents.

**Evidence.** api/state 01:24: sessions []; ACTIVE_FOR_SLOTS = ['PLAN_IN_PROGRESS','IN_PROGRESS'] (LiveEngine.ts:20). Recovered: closed HH-109 as done (removed its clean worktree), messaged HH-123 to plan, raised max_sessions 3 → 4 to offset the epic.

**Fix.** Count a slot only for an item with a live turn, a running job or an op; never count an epic (flavor 'epic'). resumeInterrupted should also pick up an active-status item with no op and no session. See feature f1 (stall detector).

### p26 — Permission park races: workers report blocked instead of waiting (root cause in the worker prompt)

*bug · open*

HH-136's worker read every parked Bash request as a denial and called report_blocked; the orchestrator's one-shot allow landed seconds later. It happened twice in a row. My own 'you were allowed, re-run it' unblock made it worse: that started a fresh turn without the one-shot approval (only the decision's own resume carries it), so the identical command parked again. Per-command approval can't finish an item whose worker blocks on every park.

**Evidence.** HH-136 twice and HH-137 once (01:28–01:30). Root cause found in prompts/worker-system.md: line 26 'Every turn must end with either report_done or report_blocked' vs line 27 'if a request was recorded by planestro … end your turn', so obeying both = report_blocked. Mitigated overnight: rewrote line 27 via PUT /api/prompts/worker-system ('NOT a denial … end your turn with no report; the one exception to the rule above'), added read-only lookup allow rules, resumed both items.

**Fix.** Ship the corrected wording in planestro's default worker-system prompt (init + sample), plus the engine-side guard: a turn that parked and then called report_blocked is recorded as the park. Carry pending one-shot approvals into any resume.

### p27 — Game CI (not planestro): level_up_pause_resume_check flakes in the parallel pool

*bug · open*

Two of PR #300's red runs were level_up_pause_resume_check alone (physics legs: building contact, banked picks). It passes 3/3 locally at ~9 s and never touches the PR's content. It isn't in is_slow_check, so it shares CI's 2 vCPUs with the parallel pool. Each false red cost an ~18-minute CI run and a Codex fix turn.

**Evidence.** PR #300: runs 35814845870 and on e950d74; 3/3 local passes at e950d74; re-run via empty commit.

**Fix.** HH-138 (queued, → develop): move it to the serial class, or fix its timing if a real bug shows up. Planestro angle: a ci_red on a check the PR can't have affected could go to the orchestrator as a likely flake before a worker fix turn (idea).

### p28 — A human takeover doesn't stop the item's live or queued turns

*bug · open*

While I finished HH-136 by hand (commit, push, PR #305, transition to IN_REVIEW), a worker turn I had started earlier kept running in the same worktree, and an orchestrator permission allow later queued a 'fix' turn. The worker saw the transient failures from my own mid-edit state and blocked the item, now IN_REVIEW with a PR, as agent_blocked. There's no 'I'm taking this over' state, and the transition to IN_REVIEW doesn't cancel pending follow-ups.

**Evidence.** HH-136 01:41:59 user → IN_REVIEW (PR #305); 01:44 parked/allowed/blocked by the old session; api/state showed an HH-136 'fix' session at 01:46.

**Fix.** A 'take over' action that aborts the item's live turn, drops queued follow-ups and one-shot resumes, and marks the item human-owned until released. A manual transition to IN_REVIEW should also cancel pending worker turns.

### p29 — No way to bring a worker branch up to date before resuming it

*gap · open*

When a dependency an in-progress item needs merges into the epic branch (HH-129, then HH-136 for HH-118), the item must be rebased before it can use it. planestro only syncs a worker branch at PR time, so a person has to rebase by hand. The orchestrator can't (no git), yet it resumed HH-118 on the old base anyway: the final-pack turn is running without the flag it needs.

**Evidence.** HH-118 02:02:48–02:02:53: final-pack instructions queued and the session started; branch at 6f42b22c without --row-jump-overrides; the orchestrator's question asked the user to rebase. Earlier the same by hand after HH-129 (rebased 883fa0e9).

**Fix.** A 'sync with base' engine operation (rebase a worker branch between turns, only when no turn is live, with conflicts going to the session) usable by the orchestrator. Resuming an item whose dependency just merged should run it first.

### p30 — A transient GitHub timeout blocks an item as engine_error

*bug · open*

HH-123 rebased and pushed fine, then `gh pr view` timed out reaching api.github.com and the item blocked as engine_error until a person unblocked it. Nothing was wrong; an unblock with no message let the merge queue carry on.

**Evidence.** HH-123 PR #306, blocked engine_error ~02:03 (orchestrator: 'transient network timeout'); api.github.com 200 minutes later; unblocked.

**Fix.** Retry gh/network operations with backoff (for example 3 tries over a minute) before blocking; classify a network error as its own reason that the tick retries automatically.

### p31 — The orchestrator called a 3-of-8-rows art item 'the final pack'

*bug · open*

After HH-136 landed, the orchestrator told me (and queued to the worker) that HH-118 only needed its final pack. The item's own deliverables doc said otherwise: only master, idle, stomp_windup and death are accepted; stomp, throw and emerge are rejected (area ratios 0.908/0.921 < 0.940, missing gutter), and recover and vanish are pending (head bob 41.5 px > 28, incomplete hands). The worker then hit the 1.5M Codex token cap. I nearly hand-finished a pack that can't be made without five more generations.

**Evidence.** HH-118 activity 02:02:51–02:09; docs/underworld/superintendent_deliverables.md and prompts.json on hh/118; blocked token_budget at 1,538,904 tokens, $1.43.

**Fix.** Have Codex Art items report a structured per-part status (accepted/pending/rejected, with reasons) in report_blocked/report_done, show it on the item page, and make the orchestrator quote it instead of summarising from memory. Warn before the token cap when the accepted fraction is low (a progress-vs-budget check).

### p32 — A held (skip_merge) item's fix commits are never pushed; ci_result sits at 'pending' forever

*bug · open*

HH-122 was on skip_merge for the designer's review. I sent it the designer's four fixes, and the worker committed 26680a0 at 02:52. planestro logged 'session updated the branch; re-entering the merge pipeline' and set ci_result: pending. But the push and rebase only happen inside the merge op, which the hold skips, so nothing reached PR #309 for over an hour. The PR still showed the old captures, and the item looked like it was waiting on CI. The branch had also fallen behind the feature tip (#306, the develop merge, #300), with the predicted add/add conflict on the four enemy_*.png.import files.

**Evidence.** HH-122 activity 02:52:57–02:53:07; PR #309 head 7177e05 vs local 26680a0 at 03:56. I rebased by hand (took the feature's .import uids), and pushed 41cf8bf3.

**Fix.** When a held item's branch moves, run the sync step (rebase onto base plus push) without the merge, so the PR and CI reflect the fix and the reviewer sees fresh captures. Never set ci_result: pending without a push that will produce a CI run. Surface 'held, local commits not pushed' on the item.

### p33 — Game CI (not planestro): atlas_layout_check's 80 ms wall-clock assertion flakes on the 2-vCPU runner

*bug · open*

HH-122's merge CI failed only on atlas_layout_check: 'second Ruins build stays cheap: 80 ms' (and 86 ms), against an `elapsed < 80` limit whose own comment says ~8 ms headless on a Mac. Nothing in the greybox touches the Ruins. The worker's fix turn also hit the $0.5 per-turn budget and blocked the item as turn_error, so one flake cost a block plus a manual rerun.

**Evidence.** run 35852982291 (e7ccce3d), 352/353 passed; tools/atlas_layout_check.gd:32. Rerun of the failed job started 07:3x.

**Fix.** Game side: compare against the first (uncached) build as a ratio (for example second < first × 0.5), or raise the absolute bound well clear of CI noise; or run the check in the serial slow class. planestro side: on ci_red, re-run the failed job once before waking a worker turn when the failure is a known-flaky check (or when the failing check doesn't touch the diff).

### p34 — Worktree setup races the merge op's fetch; unblock doesn't retry setup, so the item re-blocks as worktree_missing

*bug · open*

HH-122's merge moved origin/feature/crystal-cavern in the same second that HH-124's admission ran `git fetch --prune`, so the fetch failed with 'cannot lock ref … is at 5850b31 but expected d81cc47' and HH-124 blocked as engine_error. The orchestrator correctly called it transient. But unblocking doesn't re-run worktree creation, so the item re-blocked as worktree_missing, and a user can't move it back to QUEUED. I created the worktree and branch by hand, ran the after_worktree_create hook, and unblocked with a message.

**Evidence.** HH-124 07:49:33–34 engine_error, 07:5x worktree_missing; 'User may not move a worker item from PLAN_IN_PROGRESS to QUEUED'.

**Fix.** Serialize the engine's git fetches in the main checkout (one mutex for fetch and merge ops), and retry a 'cannot lock ref' fetch once. On unblock of an item with no worktree, re-run worktree creation plus hooks instead of blocking worktree_missing. Or allow PLAN_IN_PROGRESS → QUEUED when there's no worktree.

### p35 — planestro MCP 'Stream closed' mid-turn turns a finished plan into no_plan

*bug · open*

HH-125's planner wrote a full 215-line plan, but its submit_plan call (and a question) failed with 'Stream closed', so the planestro MCP connection had dropped. The turn ended 'success' and the engine blocked it as no_plan. The orchestrator guessed a budget cap, which was wrong. The plan survived only because the planner saved it to ~/.claude/plans/. Cost of the lost turn: $8.93.

**Evidence.** HH-125 07:49:50–07:54:15: op.end outcome ok, subtype success, cost 8.93; console: "the `submit_plan` call failed with 'Stream closed'". AGAIN HH-127 12:26: submit_plan failed twice with Stream closed, the plan was saved to ~/.claude/plans/, and the item blocked as no_plan. It recurs, and both times it came late in a long planning turn.

**Fix.** Detect MCP tool errors (Stream closed) in the session stream and reconnect or retry the tool call; on no_plan, scan the final message and the SDK plan file for a plan and offer 'submit this plan' instead of a bare block; include the tool error in the block reason, so the orchestrator doesn't guess.

### p36 — Over-budget items get $0.50 fix turns that always fail, then strand at ci_result 'unknown'

*bug · open*

HH-125 ($274 spent against a $250 cap) hit a rebase conflict when the designer released its hold. The engine handed the conflict to a fix turn with maxBudgetUsd = max(0.5, cap minus spent) = $0.50. The worker resolved the rebase and filed report_done, but the turn ended error_max_budget_usd, so afterWorkTurn never ran. The item was left at ci_result 'unknown' with no op, and a messageless unblock only ticks, so it sat idle until my stall detector flagged it. The same $0.50 floor killed HH-122's CI-flake turn.

**Evidence.** HH-125 10:02:25 conflict then fix turn; 10:12:25 report_done and BLOCKED turn_error; 10:22:40 unblocked, then idle. LiveEngine.ts:471 (budget floor) and :693 (ci_result unknown). Worked around by pushing the resolved branch myself and merging PR #317 by hand on green.

**Fix.** (1) When an item is over budget, block with 'over_budget' before starting a turn, naming the cap, instead of launching a $0.50 turn. (2) After a turn that errored but already called report_done or moved the branch, still run the re-check. (3) Make unblock re-enter the merge pipeline for an IN_REVIEW item at ci_result 'unknown', as restart recovery already does. (4) Allow ci_result in PATCH, or add a 're-check CI' action.

### p37 — Held items never see their CI result: ci_result stays 'pending' while GitHub is red

*bug · open*

Items on skip_merge sit at ci_result 'pending' indefinitely. The CI poll only runs inside the merge op, which a hold skips. At 18:00, PR #325 (HH-146) and PR #329 (HH-145) were both red on GitHub (a reaper_endgame_check timeout flake, and a real break where HH-148's new check used the old cart API) while planestro showed 'pending'. So no fix turn started, and the orchestrator and board both implied that things were fine. Combined with p32 (held items' fix commits never pushed), a held item is effectively invisible to the pipeline.

**Evidence.** At 18:00: HH-146 and HH-145 showed ci_result pending and skip_merge true; gh pr checks 325/329 were fail. Fixed by hand: re-ran #325's flaky job, and sent HH-145 the failing test.

**Fix.** Poll CI for held items too (read-only: update ci_result and wake the fix path on red without merging). Show 'held · CI red' on the board card. When an item is released, re-check CI before merging, and never trust a stale 'green'.

### p38 — A decision card asked the designer to edit ci.yml

*bug · fixed*

HH-149's triage filed a decision card whose recommended answer was a workflow edit, which is an engineering task the designer can't do from a phone. Cards should offer only choices a designer can make (approve, hold, clean up, retry); anything needing a file edit belongs to the orchestrator or a fix turn.

**Evidence.** HH-149, the evening of 2026-09-23; answered by hand from the supervising session.

**Fix.** Validate decision options in the triage tool: refuse options that name files, commands or code, and route them to a fix turn instead.

**Shipped.** PR #41: a card is a product call; an engineering fix is filed for the maintainer instead, and a card never asks for an action somewhere else.

### p39 — Cleanup proof keyed to a stale SHA after a hand merge

*bug · fixed*

HH-149 blocked on cleanup_unverifiable. The proof checked reachability of aa1b5a6, the tip planestro last pushed, but the branch moved to 955fb3a (a reconcile pushed from the supervising session) and the PR was merged outside planestro. GitHub's merged head 955fb3a was in the base, so the cleanup was safe. The orchestrator diagnosed this correctly, retried, failed identically, and filed a card.

**Evidence.** HH-149, 2026-09-24 01:15; PR #328 merge 78d0453f; `git merge-base --is-ancestor 955fb3a origin/feature/crystal-cavern` true. Cleaned up by hand, but unblocking re-runs the same proof (the tick resumes cleanup for any unblocked MERGED item, LiveEngine.ts:934) and it re-blocks, because `ci_head_sha` still holds aa1b5a6 and neither PATCH nor transition can change it (MERGED → FINISHED is refused). Left blocked; harmless, since the epic counts MERGED children as done.

**Fix.** Prove cleanup against the PR's merged head SHA (from pr_status), or against the current remote branch tip, not the last SHA planestro pushed. When the PR is merged and the local tip is reachable from base, clean up.

**Shipped.** commit bb80a62: cleanup proves the tips it is about to delete (worktree HEAD, local and remote branch), never a remembered sha.

### p40 — Cleanup deletes a Codex art worker's raw sources

*bug · fixed*

HH-161 merged and cleanup removed its worktree immediately, taking `tmp/cc_dressing/source/` (the raw generations; finished masters and prompts were committed). The orchestrator caught it after the fact and asked for a manual copy of HH-158's and HH-160's raws before they merged. HH-161's raws were recovered from Codex's own store, `~/.codex/generated_images/<thread id>` (thread id in `agent_sessions.codex`).

**Fix.** Before removing a codex-art worktree, copy its `tmp/` art folders to a durable place (for example `<code repo>/tmp/<item>/`, configurable), or refuse cleanup while the item carries a pending rescue flag. Record the Codex thread's image-store path on the item so a lost raw can be found.

**Shipped.** PR #39 (`worktrees.keep_on_remove`), then #53 and PR #89 (`worktrees.copy_to_checkout`, #72).

### p41 — Planning turns end without submit_plan, repeatedly and expensively

*bug · fixed*

Four planning turns in one night ended "success" with no plan (HH-166, HH-165, HH-162, plus HH-168 cut by usage). HH-162's cost $97.11 over 23 turns of research with an untouched worktree. The orchestrator now resolves each with a directed "submit now" message, which works, but the research spend is already gone. Two items (HH-168, HH-169) that were unblocked without a message after the usage cut sat idle until nudged (p12 again).

**Evidence.** Journal op planning_turn-mufh3m6b-hkyj (HH-162, 07:53 to 08:18, outcome ok, cost 97.11); orchestrator triage note at 08:19.

**Fix.** Cap a planning turn's spend (a planning budget separate from the item's), and when a planning turn ends without submit_plan, resume the same session at once with a short "submit now" prompt instead of blocking. Resume after a messageless unblock too (p12).

**Shipped.** PR #38: a planning turn has its own cap (`budget_usd_per_plan_turn`), and a turn that ends without a plan is asked once for the plan it has.

### p42 — A withdrawn decision card stays on the item

*bug · fixed*

The orchestrator re-blocked HH-162 as user_takeover at 08:47 and called its budget card "withdrawn/moot", but `awaiting_data.decision` stayed, so the card still asked the designer to raise the cap at 09:07. Cleared by hand by answering it.

**Fix.** Blocking for the user or filing a new card replaces or clears any pending decision; give the orchestrator an explicit withdraw tool.

**Shipped.** PR #34: blocks replace a card, and `withdraw_decision`.

### p43 — A card asked the designer to raise a budget the card can't raise

*bug · fixed*

HH-162's card said "raise the item budget in planestro, then answer". Answering felt like the action, so the designer tapped it and nothing changed; the worker resumed on $0.50 and died again. The orchestrator itself noted this ("the card flow makes answer feel like the action"), but only inside a long triage comment.

**Fix.** Cards never ask for an action somewhere else. Put the budget control on the card (an option that raises the cap and resumes), or block the answer until the cap changes.

**Shipped.** A card option's `raise_budget_usd` ("+$40 and resume") raises the item's budget when picked; the prompt forbids asking for an action elsewhere (PR #41).

### p44 — A PR attached by hand never enters the merge pipeline

*bug · fixed*

HH-162 was finished outside planestro (branch pushed, PR #350 opened, `fields.pr` patched, transition to IN_REVIEW, unblock). `ci_result` stays unset, so the tick never runs the merge op, the green CI is never seen, and the `skip_merge` hold never reaches "awaiting review": NEEDS YOU showed 0 while the designer waited to review it. Reconcile changes nothing.

**Fix.** Adopting a PR (the PATCH, or reconcile's "adopted PR" correction) sets `ci_result: 'pending'` so the merge op runs, or f2's "Finish from here" does it end to end.

**Shipped.** PR #40.

### p45 — An epic based on another epic's branch breaks when that branch merges

*bug · fixed*

HH-163 (animations) was opened from `feature/crystal-cavern`. When HH-113's epic PR merged into develop and the branch was deleted, `submitEpic` failed (`No commits between feature/crystal-cavern and feature/animate-crystal-cavern-enemies, Base ref must be a branch`). Fixed by hand: `base_branch_override = develop`, unblock; PR #357 opened, then its develop sync conflicted in LICENSES.md (both epics appended rows), resolved by hand.

**Fix.** When an epic's base is itself an epic branch that has merged, retarget the child epic to the parent's base automatically (and note it in Activity); `submitEpic` should detect a deleted base rather than fail on `gh pr create`.

**Shipped.** PR #46: a base that was a merged epic's branch follows to that epic's own base.

## Feature proposals (for review)

### f1 — Feature: a stall detector

An item in an active status with no op, no live turn, no job, not awaiting and not blocked for more than N minutes is stuck by definition. HH-109 sat five days and HH-123 would have sat all night. The tick could flag it on the board ('stalled 12 min') and, for known shapes, act: resume planning with the full prompt, re-run afterWorkTurn's deterministic done check (clean + ahead → open PR), or wake the orchestrator.

**Evidence.** HH-109 (5 days idle), HH-123 (restart orphan), HH-115/HH-121/HH-130 (messageless unblock idled, p12).

**Proposal.** For your review: stall detection in tick(), with a board badge and an automatic resume for the safe cases.

### f2 — Feature: 'Finish from here' for done work that can't reach a PR

Four times tonight a worker's work was finished and committed but the item couldn't reach a PR: over budget (HH-121), a size gate (HH-130), a Codex git refusal (HH-115/116/119). Each time I did the same by hand: push, gh pr create, PATCH pr, unblock, transition IN_REVIEW. One item action (and orchestrator tool) that runs planestro's own openPr on a clean, ahead worktree would make this a click.

**Evidence.** HH-121 #303, HH-130 #304 opened by hand; HH-115/116/119 committed by hand then resumed.

**Proposal.** For your review: Engine.finishFromWorktree(id) behind an item-page button and an orchestrator tool, only when the tree is clean and ahead of base.

### f3 — Feature: a safe 'restart when idle' command

Restarting planestro safely needs 'no turns, no jobs, no setup hooks, no in-flight git ops'. I approximated it with the sessions count and orphaned HH-123 in its hook-to-plan gap. A built-in drain (stop admitting, let current ops finish, then exit or re-exec with new flags) would make config and code updates safe, e.g. from Settings.

**Evidence.** HH-123 orphaned at 00:57 by a restart that waited only for sessions == 0; HH-119's merge op aborted 'engine_stopping'.

**Proposal.** For your review: POST /api/engine/drain → pause admissions and wait for this.jobs and this.turns to empty, then exit; a --restart wrapper in npm start re-execs.

### f4 — Feature: structured progress for multi-part art items, with a budget forecast

An art item like a boss atlas is really N parts (eight rows here), each accepted, pending or rejected with a gate reason. Today that lives only in the worker's prose and a JSON file on its branch, so the orchestrator summarised HH-118 as 'the final pack' when five of eight rows were still missing (p31), and the token cap was the first signal. If report_done/report_blocked/add_note took an optional parts list [{name, state, reason}], the item page could show a progress strip, the orchestrator could quote it, and the engine could warn when tokens spent / parts accepted projects past the cap.

**Evidence.** HH-118: 4/8 rows accepted at 1.54M tokens; finished at ~2.78M after a raise to 2.5M.

**Proposal.** For your review: a `parts` field on the report tools and items, a progress strip on the item page and board card, and a forecast warning at 80% of the budget.

### f5 — Feature: an audio-asset path for workers (ElevenLabs), like Codex Art is for images

HH-125 blocked because no worker can generate audio. Today a human (or this session) runs ElevenLabs, publishes an audition page, and hands picks back by message. planestro could treat audio like art: an 'audio' runner or tool that the worker calls with prompts (cost-capped per item, like budget_tokens_per_item), writing masters to a declared folder; the item then parks on an 'audition' hold that renders the candidates with pick buttons on the item page, and resumes the worker with the picks as structured data.

**Evidence.** HH-125 08:26 agent_blocked on the voice set; d25; the per-boss SFX recipe (tools/build_boss_sfx.py + audition artifact) done by hand for the sixth time.

**Proposal.** For your review: (1) a sound-effects runner behind a per-item spend cap; (2) an 'audition' review hold with a candidate grid on the item page; (3) picks delivered to the worker as JSON. Keep it project-neutral: prompts, roles and the build command come from the item and the project's config.

### f6 — Feature (APPROVED by the designer 2026-09-23): open held PRs as drafts, with no CI until they're released

Held items (skip_merge or hold_for_review) run full CI on every push and rebase while they wait for the designer, often 2–3 times before anyone looks. Open them as GitHub **draft** PRs, have CI skip drafts, and on release mark the PR ready (`gh pr ready`), which runs CI exactly once on the up-to-date branch before the merge. The worker's local full suite stays the evidence during the hold.

**Evidence.** Sept 2026: about 6,200 hosted CI minutes, of which about 97% were epic-child PRs, with 1.7 runs per branch. The budget was exhausted on 2026-09-23 and raised to $50/month.

**Proposal (approved).**
- planestro: create the PR as a draft when the item is held at PR time; `gh pr ready` on releaseHold and art approval; back to draft if a hold is re-applied.
- The game's `ci.yml`: skip draft PRs (`if: !github.event.pull_request.draft`) and add `types: [opened, synchronize, reopened, ready_for_review]`.
- It pairs with the game's self-hosted runner for epic children (game PR #337).

### f7 — Feature (requested by the designer 2026-09-24): "approve with amendments" sends the plan back to be amended

When the orchestrator reviews a plan and approves it WITH stipulations (HH-167's retention fix, HH-168's "work in your own tmp/, commit review.png + validation.json, commit the pipeline"), the stipulations live only in an Activity comment. The designer approving from a phone can easily miss them, and the worker never sees them unless someone relays them. Asked for by the designer: "When the orchestrator leaves a comment that it approves a plan with stipulation, it needs to tell the agent to update the plan with those stipulations."

**Evidence.** HH-168, 07:53: verdict "sound — approve WITH the same retention amendment HH-167 needed", left as a comment with approve_plan not permitted; relayed by hand as a plan rejection at 08:50.

**Proposal.** Give the orchestrator's plan review three verdicts: approve, reject, and amend. "Amend" sends the plan back to its session with the stipulations as the message (the same path as a user rejection), and the item re-enters review once the worker resubmits. The approved plan then contains every condition, and the designer only ever approves a complete plan. The review card should also say "amended by the orchestrator: n stipulations folded in".

**Shipped.** PR #36: the orchestrator's `amend_plan`.

### f8 — Feature (requested by the designer 2026-09-24): surface the orchestrator's planestro notes

The orchestrator's "PLANESTRO UX NOTE" suggestions sit inside long triage comments, where the designer finds them only by reading carefully.

**Proposal.** A `note_planestro` orchestrator tool that files rows in a planestro-feedback list (Console or Settings) with a badge.

**Shipped.** PR #37.

### f9 — Feature (requested by the designer 2026-09-24): collapse the description in the quick view when the item needs you

At a decision, the quick view puts the long Description/Plan before the Activity log, which is what matters in that moment.

**Proposal.** When the item needs the designer (decision, review, block), show the Description/Plan collapsed by default (one line and a toggle) and the latest Activity first.

**Shipped.** PR #35.

## Shipped since these notes began

- Model fallback (Fable 5 → Opus 5.5), per item and for the orchestrator: PR #9.
- Permission matching for env-prefixed commands: PR #10.
- Phone photo attachments (file picker, HEIC to JPEG, shrink to the limit): PR #14.
- Needs-you triage (the orchestrator resolves blocks itself or files a plain decision card): PR #15. It addresses much of p12, p28, p30, p34 and p35 and f1/f2 in spirit; re-check each against it.
- From the 2026-09-24 rows: p38–p45 and f7–f9 all shipped (PRs #34–#41, #46, #53, #89 and commit bb80a62); each row names its fix.
