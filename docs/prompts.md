# Prompts

Everything an agent is told is a file in the data dir's `prompts/`, rendered fresh for each
turn from the item's files. `init` seeds the directory with the shipped library
(`packages/server/prompts/`); from then on the copies are yours. A prompt planestro gains in
a later version is read from the tool until your project saves its own copy — and
re-running `init` adds any that are missing.

```markdown
---
schema: 1
name: art-item
kind: template
title: Art item (for an image-generating implementer)
description: A backlog item body for raster art.
favorite: true
---
## What to make

{{subject}}
```

## Kinds and roles

| | |
|---|---|
| `kind: template` with a **`role`** | planestro sends it itself at a lifecycle step. Edit it to change what every session is told. |
| `kind: template`, no role | A starting point for an item: **+ New item from this prompt**, or the picker in the New item dialog. |
| `kind: action` | A described manual procedure, startable like a template. |
| `kind: partial` | Included by others with `{{> name}}`; never sent alone. |

| Role | Prompt | Sent when |
|---|---|---|
| `worker_system` | `worker-system`, `worker-system-codex` | Every worker turn: git scope, how to report. The engine picks by the model's runner. |
| `plan` | `plan-item`, `plan-epic` | An item is planned; an epic's breakdown is planned. A plain item's planner is also told, in code (so a data dir's older copy of `plan-item` gets it too), to hand in a breakdown with `submit_breakdown` if the request is really an epic ([Item or epic](concepts.md#item-or-epic)). |
| `implement` | `implement-plan` | The plan is approved. |
| `ci_failed`, `rebase_conflict`, `commit_dirty_tree` | same names | CI is red; a sync conflicted; a turn ended with uncommitted changes. |
| `resume_context` | `resume-context` | Prefixed to a turn that resumes a parked session. |
| `fresh_brief` | `fresh-brief` | Opens a fresh session on an item whose earlier one is not resumed (reloading it costs more than the job, or a fresh one was asked for). It carries the item, its plan and the state of its branch, and the task in `brief.task`. |
| `cleanup` | `cleanup-worktree` | Not sent by the engine (cleanup is code, with positive evidence); kept for cleaning up by hand. |
| `orchestrator_system` | `orchestrator-system` | The orchestrator's standing rules. Each wake's context packet is built in code from the item files. |
| (partial) | `standing-decisions` | The project's own rulings, included at the end of `orchestrator-system` with `{{> standing-decisions}}`, so the orchestrator applies them on every wake and after every fresh conversation. Ships empty; add one line per ruling ("art is reviewed by the designer: never approve it on their behalf"). A data dir without its own copy uses the shipped one. |
| (partial) | `permission-rubric` | How the orchestrator rules a delegated permission request, kind of command by kind, with the standard reason for each. Added to every permission request it is handed, after the earlier rulings on the same kind of command, so equivalent requests get the same answer. A data dir without its own copy uses the shipped one. |
| (partial) | `loop-until-green` | Appended by the engine to a loop item's implementation and carry-on turns (an item with `loop`, #171): contracts proven to fail first, then iterate and `report_iteration` each pass within `{{loop.max_iterations}}`, and hand off with `report_done` `review`. Context: `loop.max_iterations`, `loop.used`, `loop.tally`, `loop.goal`. A data dir without its own copy uses the shipped one. |

## Placeholders

`{{a.b.c}}` looks up a dotted path; `{{> name}}` includes a partial. **Rendering is strict**:
an unresolved placeholder is an error, never a half-filled prompt sent to an agent.

| Available to lifecycle prompts | |
|---|---|
| `item.id`, `.number`, `.slug`, `.title`, `.category`, `.status`, `.file` | the item |
| `item.description`, `.notes`, `.plan` | its sections |
| `item.branch`, `.worktree`, `.pr`, `.planner`, `.implementer` | its git and model state |
| `worktree`, `base_branch`, `attachments`, `attachments_dir`, `pr.number`, `pr.url` | resolved paths and refs |
| `dependencies.delivered` | what the items this one waited on added or changed, from git at merge time |
| `repo.path`, `.default_branch`, `.release_branch`, `.github`, `project.name`, `data_dir` | the project |
| `implementers`, `categories` | `plan-epic` only |
| `approval_notes`, `brief.task`, `.stopped`, `.commits`, `.dirty`, `.in_progress`, `.pr`, `.done_summary`, `.activity` | `fresh-brief` only: the task, where the item last stopped, commits ahead of the base, uncommitted files, an unfinished rebase or merge, the pull request, the last reported summary, recent Activity |

A starting-point template may carry `model: <model id>` in its frontmatter: the New item dialog then
preselects that implementer, so an art brief lands on the art model without anyone remembering to
switch it. (Model ids are the project's own, so the shipped templates leave it unset.)

In a *starting-point* template, any placeholder the project cannot resolve by itself
(`{{subject}}`, `{{since}}`) becomes a required field in the New item dialog; the item is
created with the text filled in.

## The library

| For a Claude implementer | For an image-generating implementer |
|---|---|
| `feature` — the problem before the build | `art-item` — subject, path, size, style, provenance |
| `bug-fixes` — a list of observed bugs | `art-repaint` — repaint from an attached reference, saying what must be kept |
| `audit-recent-code`, `audit-repo` — reviews | |
| `review-external-branch` — review a branch someone else pushed | |

**Favorites** (the ☆ on the Prompts page; `favorite: true` in the file) lead the library
list and the New item picker. **+ New** creates a prompt from the UI; **Render** previews a
prompt against a real item.
