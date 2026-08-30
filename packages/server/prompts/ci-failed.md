---
schema: 1
name: ci-failed
kind: template
role: ci_failed
title: CI failed after rebase
description: Sent by the merge pipeline when the pull request's CI run is red.
---
planestro rebased `{{item.branch}}` onto the latest `{{base_branch}}` and pushed it to pull request #{{pr.number}} ({{pr.url}}). CI then failed (attempt {{ci.attempt}}).

Failing run: {{ci.run_url}}

Excerpt of the failing log:

```
{{ci.failed_log}}
```

You implemented this change and have the most context, so please fix it in your worktree {{worktree}}:

1. Reproduce locally where possible (the project's CLAUDE.md describes how to run its checks).
2. Fix the cause — in your change, or, if the failure is unrelated to it, explain why in `add_note`.
3. Commit on `{{item.branch}}` with a clear message. Do not push and do not rebase — planestro rebases and pushes for you.
4. Call `report_done` with a short summary of the fix, then end your turn.
