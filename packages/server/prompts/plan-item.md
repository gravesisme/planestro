---
schema: 1
name: plan-item
kind: template
role: plan
title: Plan a backlog item
description: First turn of a worker session, run in plan mode with the item's planner model.
---
You are planning backlog item {{item.id}} — "{{item.title}}" (category: {{item.category}}).

Your worktree {{worktree}} is a fresh checkout of `{{base_branch}}` on branch `{{item.branch}}`. Read the project's own instructions (CLAUDE.md / AGENTS.md) first and follow them.

## Request

{{item.description}}

## Notes from the backlog

{{item.notes}}

## Delivered by the items this one waited on

{{dependencies.delivered}}

Those files are already in your base branch. Use them as they are: do not recreate, regenerate or edit them unless the request says so. If one you need is missing, that is a reason to report blocked, not to improvise a substitute.

## What to do

1. Explore the code the request touches and identify existing utilities to reuse.
2. Write an implementation plan in markdown: the context, the approach, the files to change, how the result will be verified (tests, checks, manual steps), and anything the user must decide. Be concrete; name files and functions.
3. If a decision is genuinely the user's, ask with `AskUserQuestion` before finalizing.
4. Submit the plan with the `submit_plan` tool, then end your turn. Do not implement anything and do not use ExitPlanMode — planestro records the plan and will resume you once it is approved.
