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
  Merges happen one at a time, in merge order; CI waits run beside them, so a pull request
  whose CI is green never queues behind another one's CI.
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
- **`skip_merge`** — takes an item out of the merge queue (the orchestrator can set it, with
  a reason). It still gets everything short of the merge: when its session commits, the
  branch is rebased if behind and pushed, so the PR shows the work; its CI is read about once
  a minute, a red run goes to the session like any other, and the card says `held · CI …`.
  None of this waits inside the serial merge chain. A PR branch that moved on its own is never
  pushed over. Releasing it sends the item back through sync and CI before it merges; a green
  run for a head that is unchanged and still on the base tip is kept, so it merges without
  running CI again.
  A held item whose CI is green, or whose PR is a draft until release, counts as **NEEDS YOU**:
  nothing automatic moves it, only you.
- **Draft while held** (`ci.draft_while_held`, on by default) — a held item's pull request (a
  review hold or `skip_merge`) is a GitHub **draft**. With CI that skips drafts, nothing runs
  while it waits for you: a review-held item comes to you as soon as it is synced, and releasing
  the hold syncs the branch, marks the PR ready and runs CI once, on the head that merges.
  Putting a hold on an open PR turns it back into a draft.
- **Resume when merged** (`resume_after`) — a stopped item that is only waiting for other items
  (a flag, an asset) is parked on them with the message to resume with. It stops needing you;
  once they have all merged, planestro rebases its branch onto the base (a conflict goes to the
  session, as in any sync) and resumes the session with the message. The orchestrator can do
  the same from triage (`resume_after`). **Stop waiting** makes it a plain block again.
- **Sync with base** (an item action, and the orchestrator's `sync_with_base`) — brings a worker
  branch up to date with its base between turns, for when something it needs has merged since
  its worktree was cut (the session cannot use what its branch does not have). It rebases onto
  `origin/<base>` and pushes with `--force-with-lease` only if the branch is already pushed; an
  epic's integration branch has the base merged in instead and is never rewritten. A branch
  already on the base tip is left alone, and a pushed branch that moved on its own (commits the
  worktree lacks) is never rebased or pushed over: the sync is refused as diverged. It is refused while a turn or step runs, while the item
  awaits an answer, or with uncommitted changes; a conflict is aborted and goes to the session
  (a blocked item stays blocked). The orchestrator's `unblock_item` takes `sync_first: true` to
  sync before the session resumes, and a wake about an item says which of its dependencies
  merged after its worktree was cut.
- **PAUSE AUTOMATION** — the global lever: running steps finish, nothing new starts,
  across restarts.

## Parts

Work that is really N parts (an atlas of eight rows, a set of icons, a pack of sounds) is reported
as parts: the worker calls `report_progress` (or gives `parts` to `report_done` / `report_blocked`,
or in Codex's closing JSON) with every part's state, `accepted` | `pending` | `rejected`, and the
gate a rejection failed. The item page and the board card show the strip, the orchestrator's packets
quote it instead of summarising prose, and when the parts accepted so far project the whole past
the item's budget the Activity log says so once, before the cap.

## Tools from outside: sound, 3D, and whatever comes next

A worker that makes sounds or models is a Claude session with that service's tools. A model row
names MCP servers in `mcp` (`elevenlabs`, `meshy`, …); the servers themselves, with their keys,
live in `planestro.local.yml` under `mcp_servers`, machine-local like the API key. Every call to
those tools passes through planestro and counts against `mcp_calls_per_item`, the one spend cap
planestro can meter itself; past it the calls are refused and the worker is told to finish or say
what it still needs. With `hold_for_review` the result is an **audition**: the review panel plays
each sound (or offers each model file), you tick the candidates you want, and *Send picks & changes*
resumes the worker with the picks as the first line of your note. What it commits is a pull request
like any other.

## The orchestrator

A separate Claude conversation that wakes on events that need judgment — a plan to look
over, a second red CI run, a conflict, a review nobody has looked at for hours. It can
message workers, reorder the merge queue, hold an item, ask you a question. It never owns
state (its session is rotated freely; the files are its memory) and it cannot approve an
epic's breakdown or release a review hold: those are yours. Its suggestions about planestro itself
(`note_planestro`) are listed under **planestro feedback** on the Console, with a badge on the
Console tab while any are unread, so they are never buried in an item's Activity log.

### Talking to it

The **Orchestrator** button in the corner of every page opens a chat. A message wakes it with
your text and the current state, and it answers in the chat (its questions from other wakes
show up there too). In a wake you started it may also add work for you: `create_item` adds a
backlog item (queued only if you say so), and it refuses in any wake you did not start, so the
orchestrator never adds work unasked. It resolves stopped items with the same tools it uses in
triage (`unblock_item`, `retry_op`, …). The **Ask the orchestrator** button on a blocked item
opens the chat about that item. While automation is paused it answers when you resume.

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

Whether or not the approval is delegated, the orchestrator can **amend** instead of approving with
a stipulation nobody sees (`amend_plan`): the stipulation goes to the planner as an amendment to
fold in (not one of the fix rounds), the revised plan comes back for review, and the approval
card says *amended by the orchestrator* with the text, so what you approve is the complete plan.

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

### Needs-you triage

With `orchestrator.triage` on (the default), anything that would land on your NEEDS YOU list
because an item *stopped* — a block of any reason, or a worker's question — goes to the
orchestrator first. While it looks, the card shows **orchestrator triaging** and the item is
not counted as needing you. It then does one of two things:

- **resolves it** when the fix is within its authority: `unblock_item` with an instruction
  (resubmit the plan an MCP "Stream closed" ate, carry on after a hiccup), `answer_question`
  when the brief already answers the worker, `retry_op` for a transient GitHub 5xx or network
  failure, `set_item_fields` for a wrong parent / base / dependency / implementer / fallback
  setting (a whitelist — nothing else), `sync_with_base` (or `unblock_item` with
  `sync_first`) for an item whose dependency merged after its worktree was cut, and
  `recreate_worktree` for a missing worktree or one
  cut from the wrong base. That last one refuses if the tree is dirty or the branch has any
  commit that is not on the old or the new base, re-runs the setup hooks, then unblocks;
- **asks you one decision** with `ask_user_decision` when the call is genuinely yours —
  spending (budget caps, usage limits), scope, taste, anything irreversible. The item page
  and the board's preview show it as a card: the question in plain words, one sentence of
  why, two to four options with its recommendation first, a box for your own answer, and the
  raw block reason tucked under *details*. Your answer (`POST /api/items/:id/decision`) is
  logged, and the orchestrator is woken with the question and the answer to carry it out.

Nothing is stranded: a wake that ends without resolving or asking, a triage older than
`orchestrator.triage_timeout_min`, a paused engine or an unavailable orchestrator all put the
item back on you exactly as it stopped, and after four triaged stops in one status an item's
next stops come straight to you. You can unblock or answer yourself at any time; that ends
the triage.

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

A card never outlives the stop it asked about: a new block (the orchestrator's `mark_blocked`, or the
engine's own) replaces it, a new card replaces it, and `withdraw_decision` takes it back when the
situation changed, so you are never asked something that is already moot.

A card is a product call you can answer in one tap, in player and product terms. It never asks you
to edit code or config or run a command: a fix that needs a capability no worker or tool has (a
workflow file, SSH, a secret) is filed as a backlog item for whoever runs planestro
(`file_for_maintainer`, never queued), and the stopped item waits on it.

**Finish from here** (an item action, and the orchestrator's `finish_from_worktree`): the work is
committed on the branch but the item stopped before its pull request (over budget after
committing, a size gate, a commit a person made for a runner that could not). It clears the stop
and opens the pull request from the worktree, through the same sync and CI as any item. It refuses
a dirty tree or a branch with nothing ahead of its base.

Every wake about an item also carries the repository's open pull requests (number, title, branch,
author, age, and which are planestro's own), so a stop is not escalated while a person is already
fixing it in a pull request planestro did not open.
