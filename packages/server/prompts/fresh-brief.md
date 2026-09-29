---
schema: 1
name: fresh-brief
kind: template
role: fresh_brief
title: Fresh conversation brief
description: Opens a new conversation on an item whose earlier one is not being resumed (reloading it would cost more than the job, or a fresh one was asked for). Everything it needs comes from the item file and git.
---
You are picking up {{item.id}} — "{{item.title}}" in a new conversation. The conversation that worked on it before is not being resumed, so you remember none of it: what it did is in your worktree {{worktree}}, on branch `{{item.branch}}`, and in the record below. Read that first. Do the task at the end, and do not redo work that is already committed.

## What was asked for

{{item.description}}

## The approved plan

{{item.plan}}

Approval notes: {{approval_notes}}

## Where the work stands

- Status: {{item.status}}. {{brief.stopped}}
- Pull request: {{brief.pr}}
- A rebase or merge in flight: {{brief.in_progress}}
- The last summary the earlier conversation reported: {{brief.done_summary}}

Commits on `{{item.branch}}` ahead of `{{base_branch}}`:

```
{{brief.commits}}
```

Uncommitted files in the worktree:

```
{{brief.dirty}}
```

## Recent activity on the item

```
{{brief.activity}}
```

## Your task

{{brief.task}}

## Rules

- Look before you act: `git status`, `git log` and the files themselves are the truth about what is done. Where the task says "you" did something, the earlier conversation did it.
- Follow the project's own instructions (CLAUDE.md / AGENTS.md) for conventions, tests and checks.
- Commit on `{{item.branch}}` with clear messages and leave the tree clean. Files a tool generated as a side effect do not belong in a commit: delete untracked ones, restore tracked ones.
- Do not push, do not open a pull request, do not touch `{{base_branch}}` — planestro does that.
- If you hit a decision that is the user's to make, use `AskUserQuestion`. If you cannot proceed, call `report_blocked` with what you need.
- When the task is done and committed, call `report_done` with a one-paragraph summary suitable for a pull request description, then end your turn.
