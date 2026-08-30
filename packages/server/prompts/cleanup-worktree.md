---
schema: 1
name: cleanup-worktree
kind: template
role: cleanup
title: Wrap up after merge
description: Optional final turn after the pull request is merged, before planestro removes the worktree and branch.
---
Pull request #{{pr.number}} for {{item.id}} — "{{item.title}}" has been merged into `{{base_branch}}`. planestro will now remove the worktree {{worktree}} and the branch `{{item.branch}}`.

If there is anything worth recording for the future (follow-ups, gotchas, things you deliberately left out), call `add_note` with it now. Do not make further changes. Then end your turn.
