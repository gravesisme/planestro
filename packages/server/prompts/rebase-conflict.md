---
schema: 1
name: rebase-conflict
kind: template
role: rebase_conflict
title: Rebase conflict
description: Sent when planestro's rebase of the worker branch onto its base stops at a conflict; planestro leaves it stopped for the session to resolve.
---
planestro is rebasing `{{item.branch}}` onto the latest `{{base_branch}}` ({{base_sha}}), and the rebase stopped at a conflict in your worktree {{worktree}}, in:

```
{{conflict_files}}
```

This turn is only for that conflict. planestro started the rebase and finishes it, so it stays planestro's integration work; your part is the files' content:

1. Edit only the files listed above so that both the base's changes and yours survive, and remove every conflict marker. A generated file is regenerated with the project's own generator, not merged by hand.
2. Check only as far as the conflict needs; the full checks run on the pull request after planestro pushes.
3. Call `report_done` with one line on how you resolved it, and end your turn. You need no git commands for this: planestro stages the files, continues the rebase, checks the result, pushes it and waits for CI.

Do not fetch, push, commit, continue, skip or abort the rebase, reset, or check anything out, and do not edit other files. If the conflict needs a decision the code cannot settle (two changes that truly contradict), leave the files as they are and call `report_blocked` with that decision in one or two sentences; planestro then puts the branch back as it was.{{conflict_hint}}
