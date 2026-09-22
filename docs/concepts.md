# Concepts

## Files are the truth

A project is a **code repository** plus a **data dir**. Everything planestro knows is in the
data dir, as files you can read, grep and edit:

```
planestro.yml          versioned project config          planestro.local.yml   this machine only (gitignored)
items/MP-12.md         one item: YAML frontmatter + # Description, # Notes, # Plan, # Activity
prompts/*.md           the prompt library
releases/1.5.0.md      one release: notes, store copy, the items it shipped
attachments/MP-12/     small files attached to an item
journal/2026-09.ndjson every operation, begin and end
```

The data dir is git-versioned with meaningful commits (`MP-12: approve plan`). While
planestro runs it is the only writer; agents report through tools, never by editing files.
When it is not running you may edit by hand; the edits are committed as `manual: …` at the
next start.

## The lifecycle

```
NOT_YET_SUBMITTED → QUEUED → PLAN_IN_PROGRESS → PLAN_READY → IN_PROGRESS → IN_REVIEW → MERGED → FINISHED
                                  (planner)     (you approve)  (implementer)   (sync, CI, merge)  (cleanup)
```

- **Queue** an item and a worktree and branch are created from the base branch; the
  *planner* model explores and submits a plan.
- You **approve** (or send back) the plan. The *implementer* model works in the same
  worktree and commits. It never pushes.
- planestro pushes, opens the pull request, keeps the branch synced with its base, waits
  for CI, merges, proves the merge landed, and only then deletes the worktree and branch.
- `ICEBOX` holds ideas. **Close as done** finishes an item whose work landed some other way.

Which moves are legal, and for whom — you, the engine, the orchestrator — is one table:
`packages/shared/src/transitions.ts`.

## Parking: nothing waits on you

Whenever a human is needed, the session is *parked*: the request is written into the item
(`awaiting: …`), the agent's turn ends, its process exits. The item shows **NEEDS YOU**.
Your answer resumes the same conversation — after an hour, after a restart.

| `awaiting` | What it wants |
|---|---|
| `plan_approval` | Approve the plan or request changes |
| `breakdown_approval` | An epic's proposed children: edit, approve, or send back |
| `question` | The agent asked something; answer it |
| `permission` | A Claude worker wants to run something outside its allow-list: once, always, or deny |
| `review` | A held pull request is synced and green; look at what was made, approve or send back |
| `user` | The item is blocked; read the reason ([Troubleshooting](troubleshooting.md)) |
| `orchestrator` | Not you: the orchestrator has it — a delegated plan approval, or a permission request it was asked to decide (below) |

`blocked` and `awaiting` sit beside the status, so an item never loses its phase when it
needs you.

## Epics and dependencies

An **epic** owns an integration branch, `feature/<slug>`. Its children branch from it and
open their pull requests into it; when every child has merged, the epic's own pull request
into the base opens and goes through the same pipeline.

`depends_on` makes an item wait until the items it names have **merged**. A waiting child
has no worktree yet; when it starts, its worktree is cut from the epic branch *as it is
then* — containing what it waited for — and its prompts list the files each dependency
delivered, recorded from git at merge time.

An epic's children can be written by hand, or proposed by the planner: see
[Mixed-agent epics](mixed-agent-epics.md).

## Holds

- **Review hold** — a model marked `hold_for_review` (art, typically) gets its pull request
  synced and through CI as usual; then, instead of merging, the item parks on
  `awaiting: review` with before/after images. Approve, or send it back to the same session
  with a note.
- **`skip_merge`** — takes an item out of the merge queue entirely (the orchestrator can
  set it, with a reason). Releasing it sends the item back through sync and CI.
- **PAUSE AUTOMATION** — the global lever: running steps finish, nothing new starts,
  across restarts.

## The orchestrator

A separate Claude conversation that wakes on events that need judgment — a plan to look
over, a second red CI run, a conflict, a review nobody has looked at for hours. It can
message workers, reorder the merge queue, hold an item, ask you a question. It never owns
state (its session is rotated freely; the files are its memory) and it cannot approve an
epic's breakdown or release a review hold: those are yours.

### Letting it approve a plan

For a small item you would wave through anyway, tick **let the orchestrator approve the
plan** (on the item, or when creating it). It needs `orchestrator.may_approve_plans` on in
Settings; with that off the box does nothing. When the planner submits, the item waits on
the orchestrator instead of on you, and the orchestrator does exactly one of three things:

- **approves** — implementation starts, with its notes handed to the implementer;
- **sends the plan back with specific fixes** — the planner revises and it reviews again, at
  most `orchestrator.max_plan_revisions` times (2) per item. The count is kept on the item
  (`plan_revisions`) and enforced by the engine, not by the model's memory;
- **leaves it to you** — a decision that is yours, real risk, a large rework, or it still
  wants changes after its fix rounds. The item turns into an ordinary `plan_approval`, with
  its reasons in the Activity log.

A review that fails, or ends without deciding, also lands on you; so does unticking the box
while it is looking. You can approve or send back the plan yourself at any point. Leave the
box unticked for anything you want to read first.

### Letting it decide permission requests

A worker that wants to run something outside its allow-list parks until someone answers,
and "Always allow" only ever remembers that exact command. With
`orchestrator.may_decide_permissions` on (Settings → Orchestrator), the request goes to the
orchestrator first. It sees the whole command, the worker's stated purpose and the item, and
does one of three things: **allow** it once (the session resumes, and no allow rule is
written), **deny** it with what to do instead (the worker continues without it), or **ask you**
— for anything that writes outside the worktree and temp dirs, installs or downloads, touches
credentials, or that it cannot fully follow. planestro's hard rules (no pushes, no pull
requests, no protected branches, no force flags) are checked before anyone is asked, and a
request the orchestrator refuses three times on one item comes to you. While it is deciding,
the item is not "needs you"; you can still answer the request yourself.

## Handing files to another item

The merge-time hand-off above needs the giver's branch merged. When another item needs a
worker's output *before* that — a generated image the code item integrates, a fixture, a
schema — the worker calls **`hand_off`** (a Codex worker puts `hand_off` in its final
message) with the receiver's id, the files (paths in its own worktree) and a note. It works
only along an existing tie: the receiver's `depends_on` names the giver, or they are children
of the same epic. planestro copies the files into the receiver's **attachments** (so every
one of its turns lists them, and images reach the model as pictures), appends the note to
its Notes, records the delivery on both items, and tells the receiver's session: an idle
session is resumed with the hand-off, a busy or parked one reads it at its next turn, and an
item that has not started finds it in its attachments and notes. Files are capped at
`attachments.managed_max_bytes` each — the deliverable, not previews and scratch. The
orchestrator has the same tool (`hand_off_files`) for a delivery a worker did not think to
make.

## Externally driven items

An item whose implementer is an `external: true` model is *watched*, not run: someone else
(another tool, a colleague) pushes the branch and opens the pull request; planestro follows
it to merge and keeps the board honest.
