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

Review them: commit everything that belongs to the change with a clear message on `{{item.branch}}` (or remove what should not be there), make sure the tree is clean, then call `report_done` again. Do not push.
