---
schema: 1
name: rebase-conflict
kind: template
role: rebase_conflict
title: Rebase conflict
description: Sent when planestro's rebase of the worker branch onto its base hits conflicts.
---
planestro tried to rebase `{{item.branch}}` onto the latest `{{base_branch}}` ({{base_sha}}) and hit conflicts in:

```
{{conflict_files}}
```

The rebase was aborted; your worktree {{worktree}} is unchanged. Please resolve this yourself, because you know the intent of the change:

1. `git fetch origin` and `git rebase origin/{{base_branch}}` in your worktree, resolving each conflict so both the base's changes and yours survive.
2. Re-run the project's relevant checks.
3. Finish the rebase (`git rebase --continue`), leave the tree clean, and call `report_done` with a summary of how you resolved it. Do not push — planestro pushes.
