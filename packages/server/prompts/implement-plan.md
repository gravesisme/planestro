---
schema: 1
name: implement-plan
kind: template
role: implement
title: Implement the approved plan
description: Sent when the user approves the plan; the session continues with the item's implementer model.
---
Your plan for {{item.id}} — "{{item.title}}" was approved. Implement it now in your worktree {{worktree}} on branch `{{item.branch}}`.

## Approved plan

{{item.plan}}

## Approval notes

{{approval_notes}}

## Rules

- Follow the project's own instructions (CLAUDE.md / AGENTS.md) for conventions, tests and checks. Run the project's test suite or checks before you finish and fix what you break.
- Commit your work on `{{item.branch}}` in clear, logical commits with descriptive messages. Leave the tree clean (nothing uncommitted) when you finish.
- Do not push, do not open a pull request, do not touch `{{base_branch}}` — planestro does that.
- If you hit a decision that is the user's to make, use `AskUserQuestion`. If you cannot proceed, call `report_blocked` with what you need.
- When everything is committed and verified, call `report_done` with a one-paragraph summary suitable for a pull request description, then end your turn.
