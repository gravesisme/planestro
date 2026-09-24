---
schema: 1
name: commit-dirty-tree
kind: template
role: commit_dirty_tree
title: Commit uncommitted work
description: Sent when a worker reports done but its worktree still has uncommitted changes.
---
You reported the work on {{item.id}} as done, but the worktree {{worktree}} still has uncommitted changes:

```
{{dirty_files}}
```

Review them: commit what belongs to the change with a clear message on `{{item.branch}}`. Files a tool generated or regenerated as a side effect (caches, import metadata, build output, captures you did not mean to keep) do not belong: delete untracked ones and restore tracked ones — never commit them to make the tree clean. If such files keep reappearing, say so in your summary so the project can ignore them. Make sure the tree is clean, then call `report_done` again. Do not push.
