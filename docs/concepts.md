# Concepts

## Files are the truth

A project is a **code repository** plus a **data dir**. Everything planestro knows is in the
data dir, as files you can read, grep and edit:

```
planestro.yml          versioned project config          planestro.local.yml   this machine only (gitignored)
items/MP-12.md         one item: YAML frontmatter + # Description, # Notes, # Plan, # Activity
prompts/*.md           the prompt library
releases/1.5.0.md      one release: notes, store copy, the items it shipped
questions/Q-7.md       one orchestrator question: # Summary, # Details, # Recommendation, # Thread
schedules/audit.md     one recurring piece of work: cron, time zone, the item it files (# Description)
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
- An item may carry a **priority**: high, medium or low (unset by default). Each column, and the
  queue, takes high before medium before low before none; dragging orders items within a
  priority, and dropping one among another priority's items offers to change it.

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
| `audition` | A worker made takes (a sound's a/b/c per role, a model's variants) to pick from before it builds on one: play them on the item page, from a phone too, and pick one per role, or ask for new ones if it offered that. Never sent to the orchestrator |
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
[Mixed-agent epics](mixed-agent-epics.md). An epic opens its branch when a child queues, or
when you **start** it; a childless epic is not offered **start**, and one started anyway
(through the API) plans its breakdown instead, since nothing would ever drive it.

### Item or epic

The kind is chosen in the open: **New item** asks *Item* (one piece of work: one worker plans
it, implements it and opens one pull request) or *Epic* (several shippable pieces: its planner
breaks it into child items, each with its own worker and pull request, merged through an
integration branch), and an epic can name who plans its breakdown.

An epic created as an item by mistake is caught at plan review, by code rather than by a
model: a plan on a plain item **reads as an epic** when its planner hands in children with
`submit_breakdown` (a plain item's planner is told to, when the request is really several
pieces) or when the plan itself lays out child items (a section headed as the children listing
at least two, or a table with a *Child* column). The plan is flagged
(`op_data.looks_like_epic`, with the reason), **Approve** is refused for you and for the
orchestrator alike, and the item page shows the reason with **Convert to epic**. If it truly is
one piece of work, request changes, or approve it as one item deliberately (**It is one item:
approve anyway…**, yours only; the Activity log says so). A revised plan is judged again.

**Convert to epic / to item** is on the item page while nothing has run for implementation:
not submitted yet, queued, or planning with no approved plan (an epic: until its breakdown is
approved and while it has no children). The description stays; the plan, or the breakdown and
its proposed children, moves into **Notes**, which the new kind's planner reads. The planning
worktree and branch are removed only on positive evidence that they hold nothing (a clean tree,
nothing ahead of a freshly fetched base); work in them refuses the conversion. What was not
submitted stays in the backlog; what was carries on as the new kind: an epic has its breakdown
planned at once, an item is queued. It is committed as `HH-198: convert to epic`.

## Holds

- **Review hold** — a model marked `hold_for_review` (art, typically) gets its pull request
  synced and through CI as usual; then, instead of merging, the item parks on
  `awaiting: review` with before/after images. Approve, or send it back to the same session
  with a note.
- **`skip_merge`** — takes an item out of the merge queue, with the reason on the item
  (`hold_reason`, shown as **Held: …** on its page and card). Four things set it: you, at plan
  approval; the orchestrator (`skip_merge`, or approving a plan that states a hold); the worker,
  with `report_done`'s `hold`; and an edit of the field. It still gets everything short of the merge: when its session commits, the
  branch is rebased if behind and pushed, so the PR shows the work; its CI is read about once
  a minute, a red run goes to the session like any other, and the card says `held · CI …`.
  None of this waits inside the serial merge chain. A PR branch that moved on its own is never
  pushed over. Releasing it sends the item back through sync and CI before it merges; a green
  run for a head that is unchanged and still on the base tip is kept, so it merges without
  running CI again.
  A held item whose CI is green, or whose PR is a draft until release, counts as **NEEDS YOU**:
  nothing automatic moves it, only you.
- **A hold written in the plan** — a plan that says its pull request must wait ("The PR stays
  held until the release is cut", "Do not merge until HH-12 has merged", "Merge hold: …") holds
  nothing by being written down, so planestro finds the sentence itself (code, not a model; it
  is read from the plan as it stands, so an edited plan counts).
  The approval card quotes it and offers **Approve and hold the PR**, with the reason for you to
  edit; **Approve & implement** is still there, and the Activity log records that the plan was
  approved without its hold. When the orchestrator approves a plan for you, a stated hold is
  applied. The check is narrow and reads English, one sentence at a time: what it misses, the
  worker can still say as it reports the work done (`hold`).
  A hold set before the pull request exists makes it open held; the item page shows **Its pull
  request will be held** with **Drop the hold**. A hold you released, dropped or left out at
  approval is not put back by the worker: its request is logged instead. A hold ends when the
  item merges, finishes or leaves the board.
- **Draft while held** (`ci.draft_while_held`, on by default) — a pull request held for a
  person (a review hold, `review.hold_into`, your own hold, a loop's review) is a GitHub **draft**.
  With CI that skips drafts, nothing runs while it waits for you: a review-held item comes to you
  as soon as it is synced, and releasing the hold syncs the branch, marks the PR ready and runs CI
  once, on the head that merges. Putting such a hold on an open PR turns it back into a draft once
  any run in flight has ended. A hold the orchestrator or the worker puts on waits for a report or
  a fix, which needs a CI verdict, so it holds the merge only: its PR stays ready (a drafted one is
  marked ready again) and CI runs on every push (#195).
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
- **Take over** (`taken_over`) — you finish the item by hand. Its running turn is stopped (the
  same abort a restart uses, so nothing is left waiting), and whatever was queued for it is
  dropped: messages, the turn behind a permission answer, a fix, a resume, a held orchestrator
  wake, triage. A block, a decision card or a review wait is yours now and is cleared; a plan
  still waits for approval (approving it starts no session). Until you **hand it back**, nothing
  automatic drives it: no admission, turn, orchestrator wake, stall check, fix turn on red CI,
  merge or cleanup. Its CI is still read, so the card and page show it. The orchestrator is told
  in every packet, and its tools that act on an item refuse this one. Handing it back carries
  on from the item as it is: in review with a pull request, it re-enters the merge pipeline; in
  progress, the done check runs (committed work on a clean worktree goes to a pull request,
  otherwise the session resumes, told someone had its worktree); merged, it is cleaned up.
  Leaving the board (icebox, backlog, close as done) ends a take-over.
- **Moved into review by hand** — you opened the pull request yourself and moved the item to
  IN_REVIEW: its session's work is over, so its live turn is stopped and the follow-ups queued
  for it are dropped, as a take-over does, even without one.
- **PAUSE AUTOMATION** — the global lever: running steps finish, nothing new starts,
  across restarts.

## Parts

Work that is really N parts (an atlas of eight rows, a set of icons, a pack of sounds) is reported
as parts: the worker calls `report_progress` (or gives `parts` to `report_done` / `report_blocked`,
or in Codex's closing JSON) with every part's state, `accepted` | `pending` | `rejected`, and the
gate a rejection failed. The item page and the board card show the strip, the orchestrator's packets
quote it instead of summarising prose, and when the parts accepted so far project the whole past
the item's budget the Activity log says so once, before the cap.

## Loop until green

An item with `loop: { max_iterations, goal? }` (the item page's **loop … iterations** box) is
worked as a loop rather than once (#171). Its implementation turns carry the `loop-until-green`
partial: turn each finding into a check that is proven to fail, then iterate (change → regenerate →
checks, suite and captures) and call `report_iteration` with the tally after each pass. Each call
is one line in Activity (`iteration 3/8: 5/7 passing — …`) and the item page's Loop strip, and
counts against `max_iterations`, a budget of its own beside the turn and dollar caps.

- **The cap.** The iteration that spends the budget without going green blocks the item
  `loop_cap`, with the tally and the branch's diff. Raising `max_iterations` and unblocking lets it
  carry on.
- **Carrying on.** A turn that ends mid-loop, neither green nor done, is resumed once to carry on;
  a second end with no new iteration blocks it `loop_stalled`.
- **The hand-off.** `report_done` is refused until the last tally is green, and the first one
  needs `review`, the markdown of the loop's REVIEW.md. planestro files it in Notes and as a
  `REVIEW.md` attachment, `attach` puts the captures on the item, and the pull request is held
  (`loop review: …`) until the user has looked.

## Tools from outside: sound, 3D, and whatever comes next

A worker that makes sounds or models is a Claude session with that service's tools. A model row
names MCP servers in `mcp` (`elevenlabs`, `meshy`, …); the servers themselves, with their keys,
live in `planestro.local.yml` under `mcp_servers`, machine-local like the API key (Settings → MCP
servers adds, tests and imports them from Claude Code or Codex; their keys are never shown back). Every call to
those tools passes through planestro and counts against `mcp_calls_per_item`, the one spend cap
planestro can meter itself; past it the calls are refused and the worker is told to finish or say
what it still needs. For paid generation, `user_approves_plans` on the model makes the budget a
person's call: its plans state an `MCP budget:` line, only you approve them, and the number you
enter at approval (the item's `mcp_budget`) is the cap; with none, no call is made. With `hold_for_review` the result is an **audition**: the review panel plays
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
Console tab while any are unread, so they are never buried in an item's Activity log. With
`feedback.issue_repo` set, each one can be filed there as an issue, once (a note someone already filed is
linked instead), or marked handled; the list shows the issues each note became.

### Talking to it

The **Orchestrator** button in the corner of every page opens a chat. A message wakes it with
your text and the current state, and it answers in the chat (its questions from other wakes
show up there too, each linking to its own page: see [Its questions for you](#its-questions-for-you)). In a wake you started it may also add work for you: `create_item` adds a
backlog item (queued only if you say so; in an epic, with `parent`), and it refuses in any wake
you did not start, so the orchestrator never adds work unasked. It chooses the `kind` (an **epic**, with its planner if you
name one, for several separately shippable pieces; a submitted epic has its breakdown planned),
and `convert_item` turns an item into an epic or back under the same rules as the button
(see [Item or epic](#item-or-epic)). `submit_item` queues an item that is not submitted yet. An
epic is never queued: asked in the chat to start one, `submit_item` has its breakdown planned,
as if you had pressed **plan the breakdown**, and you approve the children. In any wake you did
not start it refuses an epic and says why, rather than reporting something that did not happen. It resolves stopped items with the same tools it uses in
triage (`unblock_item`, `retry_op`, …). The **Ask the orchestrator** button on a blocked item
opens the chat about that item. While automation is paused it answers when you resume.

The input grows with what you write, up to 40% of the screen. Enter sends at a keyboard (Shift+Enter
for a new line); on a phone Enter is a new line and **Send** sends. Paste an image into it, or attach
images and documents (text, markdown, JSON, CSV, YAML, logs, PDF; up to 8, each within
`attachments.managed_max_bytes`, photos converted and shrunk as on an item) with the paperclip.
planestro stores them in the data dir under `attachments/chat/`, commits them, and records them on
the message; the wake hands the images to the model (Claude as image content, Codex as local
images) and names every attachment by its path, so the orchestrator can Read it again later.

### Its questions for you

When the orchestrator needs something from you that is not a stopped item's decision card, it
asks with `ask_user`, and the question becomes a file of its own (`questions/Q-<n>.md`): a
one-line headline, a **summary in plain terms** (one to three sentences, for someone who has
not read the logs), the **details**, its **recommendation**, and a **thread**. The Console lists
the open ones under *Its questions for you*, each with its item and age:

- **Discuss** opens the question's page (`/questions/Q-7`): *In plain terms*, then *Details*
  (folded), then the recommendation with **Accept recommendation**, then the discussion. What
  you write there wakes the orchestrator with the whole question file (`question_message`),
  with the same authority as the chat; it answers in that thread, carries out what you settle
  on, and closes the question with `resolve_question`. The thread is the file's, so a
  conversation picked up two days later still has everything said before it.
- **Still relevant?** wakes it to check the question against the item as it is now
  (`question_review`): it withdraws a question that is moot, rewrites one the situation has
  moved past (`update_question`), or leaves it — and then planestro notes *reviewed, no
  change* in the thread. **Check all** does this for every open question in one wake.

A question about an item resolves by itself when that item is finished or iceboxed (no model is
asked what the state machine knows); you can also mark one answered, or reopen it, by hand.
Answered questions fold into an *Answered* list under the open ones. A message you sent that a
restart left unanswered is answered when planestro starts again.

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

A plan that [reads as an epic](#item-or-epic) is never approved by it: its wake says *this is
an epic, not one item*, `approve_plan` refuses, and it converts the item (`convert_item`: the
plan becomes the breakdown request, and you approve the children), asks for a plan without a
child breakdown if it truly is one item, or leaves it to you. Without the delegation it only
recommends the conversion in the Activity log.

A review that fails, or ends without deciding, also lands on you; so does unticking the box
while it is looking. You can approve or send back the plan yourself at any point. Leave the
box unticked for anything you want to read first.

Whether or not the approval is delegated, the orchestrator can **amend** instead of approving with
a stipulation nobody sees (`amend_plan`): the stipulation goes to the planner as an amendment to
fold in (not one of the fix rounds), the revised plan comes back for review, and the approval
card says *amended by the orchestrator* with the text, so what you approve is the complete plan.

### Letting it decide permission requests

A worker that wants to run something outside its allow-list parks until someone answers,
and "Always allow" only ever remembers that exact command. Ordinary commands that stay
inside the item's worktree never get that far (reading and printing for every project, the
project's own runners once you add them as `…@worktree` rules: see
[configuration](configuration.md#what-claude-workers-may-do)), and a `cd` out of the
worktree is refused rather than parked. With
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
  (resubmit the plan an MCP "Stream closed" ate, carry on after a hiccup; with `fresh: true`
  the instruction goes to a fresh session with a brief instead of the old conversation),
  `commit_paths` for work that is done but uncommitted (no session turn), `answer_question`
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
  An option can **do** what it names, so your answer is the authorization and nothing is asked
  twice: `raise_budget_usd` raises the item's budget, and an `action` has planestro add an item
  (`create_item`) or submit one (`submit_item`; an epic has its breakdown planned) as you, at
  the tap. The card says what the tap does in planestro's own words, with the new item's brief
  under it. An action is checked when the card is filed, so you are not offered one that would
  fail, and again when you pick it: if the backlog has moved since (the item was iceboxed,
  say), the answer is refused with the reason and the card stays as it was. What was done is
  in the Activity log of both items, and the orchestrator is told it is already done.

Nothing is stranded: a wake that ends without resolving or asking, a triage older than
`orchestrator.triage_timeout_min`, a paused engine or an unavailable orchestrator all put the
item back on you exactly as it stopped, and after four triaged stops in one status an item's
next stops come straight to you. You can unblock or answer yourself at any time; that ends
the triage.

## Schedules

Recurring work (a weekly audit, a dependency bump, a release cut) is a **schedule**:
`schedules/<name>.md`, made on the **Schedules** page. It has a five-field cron
(`0 9 * * MON`, or `@daily`), an IANA time zone it runs on, an item title and a
`# Description` to file, and the item's category, priority and kind. `{{date}}`, `{{slot}}`
and `{{schedule}}` in the title and description are filled in for each run.

At each slot of its cron the engine files one item from the template, with
`scheduled_from: <schedule>:<slot>` in its frontmatter, and records the slot in the schedule's
history. That key and the schedule's `last_slot` are its memory: a sleep, a wake or a restart
never files a slot twice, and a sleep across several slots files the latest one once.
Changing the cron or time zone, or turning a schedule back on, starts it from then.

- **Skip a run while the last one is open** (`skip_if_open`): a slot is skipped, and the
  history says why, while the item the schedule filed last is neither finished nor iceboxed.
- **Submit what it files** (`submit`): each item is submitted as you would (an epic has its
  breakdown planned). It is honoured only on a schedule you made (`created_by: user`): starting
  work is your word.
- **AUTOMATION PAUSED** stops the filing; on resume the latest missed slot is filed once. A
  provider usage guard holds only the turns, never the filing.

## Issues as items

The project's GitHub issues (those of `code_repo.github`, where its pull requests open) can be
filed as items: **Import issues** on the board picks them from the open ones, or imports every
open issue with the label `issues.import_label`; `planestro import issues [N ...] [--label L]`
does the same from a terminal (through the running server, when there is one). Each item takes
the issue's title and text and keeps `source: {github_issue: N}`, so an issue already imported is
skipped, never filed twice. Nothing is submitted: queue the item when you want it worked on.

Its pull request says `Closes #N`, closing the issue when it merges, only when you ask: **close the
issue when its PR merges** at import (`--closes`), or on the item before its PR opens. GitHub
closes an issue only from a PR into the default branch: on an epic's child it does nothing.

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

**What a resume costs.** A resumed session sends its whole conversation again before it does
anything: written to the prompt cache when the cache has expired, read from it when it has not.
planestro records the size of each conversation and the price the CLI quotes for reloading it, and
shows the estimate on the item page, on budget cards and in every wake about the item. It decides
each turn on it, without asking anyone:

- a resume the item can pay for, below `budget_usd_fresh_above`, is resumed;
- above that threshold, or when the item cannot pay for the resume, a turn whose instruction
  stands on its own goes to a **fresh session**: a new conversation that gets a brief rendered
  from the item file and git (the request, the plan, commits ahead of the base, uncommitted
  files, where it last stopped) and the task. It becomes the item's conversation; the old one
  stays on disk and is named in the Activity log. Planning turns, and answers to a question or a
  permission request the session itself raised, are never moved to a fresh session;
- when nothing fits what is left, the item stops as `over_budget` before anything is spent, and
  the orchestrator gets the numbers. A conversation planestro has no record of yet is asked about
  before its first request (the CLI's own quote) and declined at no cost if it does not fit.

You can ask for a fresh session yourself (**Unblock in a fresh session** on a blocked item), and
so can the orchestrator (`unblock_item` with `fresh: true`). A budget card's raise always covers
the reload and the work, or promises a fresh session: `ask_user_decision` refuses a smaller one.

**Commit without a session** (the orchestrator's `commit_paths`): work that is done but not
committed, on an item that cannot pay for a turn or would spend one only to run `git add` and
`git commit`. The orchestrator names the files and the message; planestro checks that each is one
of the worktree's own uncommitted files (never a byproduct, never during an unfinished rebase or
merge) and commits them. Nothing is pushed and the item stays as it is: **Finish from here**, or
`retry_op` for an item in review, carries on from the commit.

**Finish from here** (an item action, and the orchestrator's `finish_from_worktree`): the work is
committed on the branch but the item stopped before its pull request (over budget after
committing, a size gate, a commit a person made for a runner that could not). It clears the stop
and opens the pull request from the worktree, through the same sync and CI as any item. It refuses
a dirty tree or a branch with nothing ahead of its base.

Every wake about an item also carries the repository's open pull requests (number, title, branch,
author, age, and which are planestro's own), so a stop is not escalated while a person is already
fixing it in a pull request planestro did not open.
