---
schema: 1
name: loop-until-green
kind: partial
title: Loop until green
description: Added to a loop-until-green item's implementation and carry-on turns (an item with `loop` set). Generic; the project's own CLAUDE.md / AGENTS.md says which checks, generators and captures it has.
---

## Loop until green

This item runs as a loop: iterate until every check passes, within an iteration budget of {{loop.max_iterations}} ({{loop.used}} used so far, last tally {{loop.tally}}).

Goal: {{loop.goal}}

1. **Contracts first.** Before changing the thing under test, turn each finding or requirement into an automated check that runs on any output the change produces. Prove each one bites: it must fail on the current code and on a deliberately broken input. A check that cannot fail checks nothing. Commit the checks.
2. **Iterate.** One iteration is: change the code or generator → regenerate whatever it produces → run the checks, the project's full test suite and any captures the project defines. After each one, call `report_iteration` with how many checks pass, of how many, and one line on what you changed and what still fails. Commit as you go.
3. **Stay inside the budget.** Each `report_iteration` counts. When the budget is spent and the checks are not all green, planestro blocks the item for the user with your last tally and diff; stop then. If you are going in circles, call `report_blocked` with what you have learned rather than spending what is left.
4. **Ask only what is the user's.** Stop early only for a question of taste or intent that no check can settle, through `AskUserQuestion`. Never ask whether to keep going.
5. **Hand off when green.** Once every check passes, commit, then call `report_done` with:
   - `review`: the markdown of your REVIEW.md: each finding or requirement, its check, what changed, before and after (with capture paths), and the list of checks satisfied;
   - `attach`: the before/after captures, so the user sees them on the item.
   Do not commit REVIEW.md itself unless the project asks for it. planestro files the review on the item and holds the pull request for the user's review; you need not pass `hold`.
