---
schema: 1
name: plan-epic
kind: template
role: plan
title: Break an epic down into children
description: Sent when an epic is planned. The planner proposes the child items, who implements each, and what waits on what; the user edits and approves the list.
---
You are planning EPIC {{item.id}} — "{{item.title}}" (category: {{item.category}}).

Your working directory {{worktree}} is a read-only checkout of `{{base_branch}}`. Explore the code as much as you need; change nothing. This turn produces a plan, not code.

## The epic

{{item.description}}

## Notes from the user

{{item.notes}}

## Break this epic down

Propose the child items that together deliver the epic. Each child becomes its own backlog item with its own worktree, its own plan, its own pull request into the epic's integration branch — and its own worker, who will see ONLY that child's description plus the repository. Write each description as a complete brief: what to build, where it goes, what done looks like.

### Who can implement a child

{{implementers}}

Route every child to the implementer whose description fits it. Work that needs raster images (icons, sprites, illustrations, textures) can only go to an implementer that says it makes them; do not give code to such a model unless its description says it also writes code.

### Rules that keep the children mergeable

- Children of one epic do not edit the same files. Split along file boundaries: an art child DELIVERS files at named paths; a code child CONSUMES them.
- If a child needs what another child produces, list that child in `depends_on` (by its index in your list, starting at 0). A dependent child starts only after what it depends on has merged into the epic branch, and is told which files were delivered. Do not add dependencies that are not real: independent children run in parallel.
- For an art child, name the exact output path(s), the pixel size, the format, and the look it must match (point at existing assets in the repository). Say how the art will be used, so the artist can judge it.
- For a code child that consumes art, name the path(s) it should expect, and what to do in tests if the file is a placeholder.
- Prefer the fewest children that keep those rules. Do not create a child for something one of the others would naturally do.
- Categories available: {{categories}}.

## Hand it in

Call `submit_breakdown` once with:
- `plan`: the epic-level plan in markdown — the approach, the seams between children, the order things land, the risks.
- `children`: the list, each `{ "title", "description", "implementer", "category", "depends_on": [indexes] }`, plus optionally `"planner"` (a Claude model id to plan that child; the default is this epic's planner) and `"hold_for_review": true` for a child whose pull request should wait for the user's review before merging. Say a hold with this flag, not in the title.

planestro checks the list (known implementers and categories, real indexes, no cycles). If it answers with a rejection, fix exactly what it names and call `submit_breakdown` again. Then end your turn. Do not use `submit_plan` or `ExitPlanMode` for an epic.
