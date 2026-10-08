# Configuration

`planestro.yml` lives in the data dir and is versioned with it. `planestro.local.yml` sits
beside it, is gitignored, and holds what is true of one machine only. Nearly every key can be
changed in **Settings**; all of them can be edited by hand while planestro is not running.
A test (`docs.test.ts`) fails if a key in the schema is missing from this page, or from the
Settings page's registry.

## The Settings page

Settings is organised by what you are deciding, not by file: **Project**, **Models**,
**Budgets & limits**, **Orchestrator**, **Workers & permissions**, **CI & merging**,
**Notifications**, **This machine** and **Data & releases** (a rail on the left; a dropdown on
a phone; the last tab you opened is remembered by the browser). Each tab opens with what it is
for and which file it writes. Every row shows a one-line summary, its default, a *changed* chip
when yours differs, the key it writes, and *Learn more* with the long explanation from this
page. The search box looks across every tab (label, key, summary, explanation, value); *Show
only changed* lists what differs from planestro's defaults, and each tab shows how many of its
settings do.

Rows are rendered from one registry, `packages/shared/src/settings.ts`, which also decides what
the server accepts: `PUT /api/config` and `PUT /api/config/local` take only the keys it marks
editable, validate the whole result through the schema (plus what the schema cannot see: a
planner that can plan, a default category that exists, an id prefix that is fixed once the
project has items), and commit each change on its own (`config: permissions.allow +"Bash(npm test*)"`,
`config: ci.timeout_min 30`). An empty value removes the key, so it falls back to its default.
Lists (setup hooks, byproducts, the permission lists, flaky checks, allowed hosts) have add and
remove editors; an allow-list entry that looks like a one-off command saved by *Always allow* is
marked. Models are cards with **Edit**, **Add a model** and **Mark unavailable**; a model's id
never changes (items store it), and a model still used by a default, a fallback, the
orchestrator or an open item cannot be removed.

What stays read-only: `project.id_prefix` once items exist, `mcp_servers` (its entries carry
API keys: edit `planestro.local.yml`), and the stamps and runtime state (`schema_version`,
`tool_version`, `engine.paused`, `engine.provider_guards`, `model_unavailable`, which the model
cards write). The Anthropic API key is never sent to the page: it shows *set here*, *set in the
environment* or *not set*, and takes a replacement.

**Budget dollars.** With a Claude login, the dollars planestro counts (budgets, an item's cost,
a decision card's "+$15 and resume") are what the same work would cost at API prices, the SDK's
`total_cost_usd`: a yardstick, not a charge; your plan's usage limits are what is spent. With an
API key (`anthropic_api_key` below, or `ANTHROPIC_API_KEY` in the environment planestro started
in) they are real charges to the API account. The server reports which (`billing:
subscription | api_key` in `/api/state`); the Budgets tab opens with a note worded for it, and
dollar figures elsewhere carry a short hint.

## planestro.yml

### Project and repository

| Key | Default | |
|---|---|---|
| `schema_version` | — | The data dir's schema. Older than the tool: opens read-only until `planestro migrate`. Newer: read-only until you upgrade the tool. |
| `tool_version` | — | Stamped by the tool that last migrated the dir. |
| `project.name` | — | Shown in the header. |
| `project.id_prefix` | — | Item ids are `<PREFIX>-<n>`. Uppercase letters and digits. |
| `code_repo.path` | — | The code repository, relative to the data dir (or absolute). Overridden per machine by `code_repo_path`. |
| `code_repo.default_branch` | — | The **base branch**: every branch planestro creates targets it, unless the item belongs to an epic or sets `base_branch_override`. |
| `code_repo.release_branch` | none | Protected from workers like the base branch. |
| `code_repo.github` | detected | `owner/repo`, for pull requests and CI. |

### Worktrees and hooks

| Key | Default | |
|---|---|---|
| `worktrees.root` | `.claude/worktrees` | Where item worktrees go, relative to the code repository. Overridden per machine by `worktrees_root`. |
| `worktrees.branch_pattern` | `{{prefix_lower}}/{{number}}-{{slug}}` | Worker branch name. |
| `worktrees.keep_on_remove` | `[]` | Paths inside a worktree (relative, e.g. `tmp`) whose files are moved to `<worktrees root>/.displaced/<item>-<time>/` before the worktree is removed, whether git tracks, ignores or does not know them: a worker's raw sources or scratch output. The Activity log says where they went. |
| `worktrees.copy_to_checkout` | `[]` | Paths inside a worktree (relative, e.g. `tmp`) whose untracked files are copied into the same path of the main checkout when the item merges, before its worktree is removed: output a sandboxed worker (Codex) cannot write there itself. Never overwrites: a file already there with other content stays only in `.displaced/`, and the Activity log names it. They are also kept, as `keep_on_remove` keeps. A copy that fails blocks the item `cleanup_dirty` and nothing is removed. Workers and the orchestrator are told, so no brief asks a worker for that step. |
| `worktrees.generated` | `{}` | Tracked files a command regenerates, as `pattern: command` (for example `messages.pot: godot --headless --script tools/i18n_export_pot.gd`; patterns match as for `byproducts`). When a rebase or merge conflicts **only** in these files, planestro takes the base's copy, finishes the sync, runs each matching command once in the worktree and commits what it changed as `<id>: regenerate …`, with no session turn. If another file conflicts, a command fails, or a command changes a file not listed, the sync is undone and the conflict goes to the session (or blocks) as before. The Activity log says which. |
| `worktrees.byproducts` | `[]` | Globs for untracked files the project's tools regenerate in any worktree, such as Godot's `*.import` sidecars made by a setup hook. They are never a session's work: no clean-tree check counts them (after a turn, before a sync, finish from worktree, recreate, close as done), engine commits leave them out, and cleanup moves them to `.displaced/` before removing the worktree. A pattern without `/` matches the file name at any depth; one with `/` matches the path from the worktree root. A byproduct the base starts tracking is moved aside before a sync, like any colliding file. |
| `worktrees.dir_pattern` | `{{prefix_lower}}-{{number}}-{{slug}}` | Worktree directory name. |
| `hooks.after_worktree_create` | `[]` | Commands run in a new worktree before planning (install dependencies, import assets). A non-zero exit blocks the item as `hook_failed`. Not re-run when an item that went to the icebox is queued again and reuses its worktree. |

### Models and defaults

| Key | Default | |
|---|---|---|
| `models.id` | — | What items store as `planner` / `implementer`. |
| `models.label` | — | What the UI shows. |
| `models.codex_transport` | `exec` | `exec` preserves existing art workers; `app-server` enables planning and orchestration through scoped tools. |
| `models.runner` | `claude` | `claude` or `codex`. A `codex` model with `codex_transport: app-server` plans and orchestrates as well as implements. The default `exec` transport remains for art. See [Agents](agents.md). |
| `models.claude_model` | — | The Claude model id; required for a `claude` runner. |
| `models.codex_model` | Codex's own default | The runner's model ID, passed to the selected exec or app-server transport. |
| `models.description` | none | One line on what the model is for. The epic planner routes children by it. |
| `models.mcp` | `[]` | MCP servers this model's sessions get, by the names in `mcp_servers` (planestro.local.yml). This is what makes a worker an audio or a 3D worker: a tool-capable session with the service's tools, usually with `hold_for_review` so what it made is auditioned before it merges. |
| `models.mcp_calls_per_item` | none | How many calls to those servers one item may make in all: a spend cap planestro counts itself (`op_data.mcp_calls`). Past it the calls are refused and the worker is told to finish or report what it still needs. |
| `models.user_approves_plans` | false | Paid tools (#157): a plan for this model is the user's to approve, never the orchestrator's, and its MCP calls need a budget the user sets at approval (the item's `mcp_budget`, prefilled from the plan's `MCP budget:` line). With no budget the worker makes no MCP call. The item's `mcp_budget` replaces `mcp_calls_per_item` when set. |
| `models.hold_for_review` | `false` | Park this model's pull requests on `awaiting: review` after CI until you approve them. |
| `models.engine_commits` | `false` | planestro commits for this model's sessions: work left uncommitted after a done report is committed with the worker's summary, and a block with work left in the tree is committed too: a block about git or committing (a sandbox that cannot write the worktree's `index.lock`, "planestro needs to commit this") is then cleared and the session resumed, and any other block stands with the work committed. Finish from here commits such a tree first instead of refusing it. For runners whose sandbox cannot reliably write git's files. |
| `models.fallback` | none | Another model id on the same runner. An item that allows fallback (**allow fallback model**, `allow_model_fallback: true`) runs on it while this model is out of usage, and the Claude SDK also uses it when this model is overloaded. Chains are followed (`a → b → c`). See [Model fallback](#model-fallback). |
| `models.external` | `false` | Not run by planestro; its items are watched. |
| `defaults.planner` | — | For new items. Must be a model that can plan. |
| `defaults.implementer` | — | For new items. |
| `defaults.category` | — | For new items. |
| `defaults.allow_model_fallback` | `false` | New items start with **allow fallback model** ticked; an epic's children inherit the epic's setting. |
| `defaults.auto_approve_plan` | `false` | New items start with **let the orchestrator approve the plan** ticked (the New item dialog, the orchestrator's `create_item`, an epic's children), except art models that require your approval or use legacy exec. General Codex app-server models can delegate plan review. Untick it on any item. Only matters while `orchestrator.may_approve_plans` is on. |
| `categories` | — | The list items choose from. Rename and remove in Settings, which reassigns items. |

### Budgets and concurrency

| Key | Default | |
|---|---|---|
| `budget_usd_per_item` | `25` | Dollar ceiling across all of an item's Claude turns; each turn starts with what remains. An item's own `budget_usd` (item page, or a decision card's "+$N and resume" option) replaces it for that item. At 80% of any budget the Activity log warns once. What is counted is what each turn spent: a resumed session reports its running total, and only what that rose by is the turn's. A resume the item cannot pay for is never started (see `budget_usd_fresh_above`). |
| `budget_usd_fresh_above` | `10` | A resumed session sends its whole conversation again before it does anything; the item page shows what that costs. When it is more than this, a turn whose instruction stands on its own (a CI fix, a rebase conflict, a reminder to commit, an unblock with a message, a review's changes) starts a **fresh session** with a brief instead: the item, its plan, what is committed and what is not, and the task. The same happens, whatever this is set to, when the item cannot pay for the resume but can for a fresh session. The fresh session becomes the item's; the old one is named in the Activity log. Never for planning, nor for an answer to something the session itself asked. `0` turns the price threshold off. |
| `budget_turns_per_item` | `20` | Worker turns per item for runners that report tokens instead of dollars (Codex). Blocks as `turn_budget`. An item's own `budget_turns` replaces it. |
| `budget_tokens_per_plan_turn` | `100000` | Observed tokens per Codex planning turn; the bounded hand-in retry has a separate 10,000-token allowance within the item cap. |
| `orchestrator.budget_tokens_per_wake` | `50000` | Observed tokens per resumed Codex wake. |
| `orchestrator.budget_tokens_per_fresh_wake` | `200000` | First wake after a new conversation, provider switch or rotation. |
| `budget_tokens_per_item` | `600000` | Uncached tokens per item for those runners. Blocks as `token_budget`. An item's own `budget_tokens` replaces it. All three are also in Settings → Budgets & limits. |
| `concurrency.max_sessions` | `3` | Items being worked on at once: a slot is taken by an item with a live turn, a running engine step or an operation in flight, never by an epic or by an item that is only waiting. |
| `concurrency.stall_after_min` | `10` | An item planning or in progress that nothing has driven for this long (no turn, no step, no operation, not waiting on anyone) is stalled. planestro carries it on once, the way an unblock does; a second stall within the hour blocks it as `stalled`. `0` turns this off. |
| `budget_usd_per_plan_turn` | `15` | What one planning turn may spend. Past it the turn ends and the planner is asked once, cheaply, for the plan it has (HH-162 spent $97 researching without handing one in); a second miss blocks as `no_plan`. |
| `concurrency.max_local_jobs` | `1` | Setup hooks and local check commands running at once. |
| `concurrency.runner_limits` | `{ codex: 1 }` | Simultaneous turns per runner. Unlisted runners are not limited here. |

### What Claude workers may do

| Key | Default | |
|---|---|---|
| `permissions.allow` | `[]` | Extra allow rules (`Bash(npm test*)`, …) on top of the built-in ones. "Always allow" in the UI appends here. A rule ending in `@worktree` holds only while the command stays in the item's worktree (below). |
| `permissions.deny` | `[]` | Extra deny patterns, checked before anything else. |

Pushes, `gh pr`, protected branches, branch and worktree management and force operations
are denied in code (`engine/policy.ts`) whatever these say, and so are in-place shell edits
(`sed -i`, `perl -i`: the Edit and Write tools never need approval). Rules match what a command
runs: leading `NAME=value` assignments and wrappers such as `timeout 120` are looked through,
`git -C <the worktree>` is judged as plain `git`, and `cd` into the worktree is a no-op; `git -C`
anywhere else matches nothing and parks. Codex workers are governed by their sandbox instead.

**Secret files** are on a built-in deny list (`engine/secrets.ts`, #227) that no rule overrides:
`~/.ssh`, `~/.aws`, `~/.gnupg`, gcloud config (`~/.config/gcloud`, `$CLOUDSDK_CONFIG`), `.git/config`,
`.env*` (except `.env.example`), `*.pem`, `*.key`, `id_rsa*` / `id_ed25519*`, `credentials.json`,
`secrets.*`, and Codex's login (`$CODEX_HOME/auth.json` and the copy in `~/.planestro/codex`). Paths
are judged as written and through symlinks. For Claude workers it is checked before everything else,
in a PreToolUse hook: before the built-in read-only helpers (`tail`, `head`, `wc`, `git --no-pager …`),
before `@worktree` rules and `permissions.allow`, and before what the CLI approves by itself (its own
read-only commands, reads in the worktree, edits under acceptEdits). It covers the file tools' paths
and the Bash arguments that resolve statically (words, `--flag=path`, `HEAD:path`, redirections,
`~` and `$HOME`); a bare name such as `id_rsa` counts only when it is a file there, a glob or a
redirection target, so `grep -rn id_rsa src` stays a search. `planestro permissions suggest` never
counts an approval that named one of these toward a rule. **The gaps:** a program a command runs reads
what it likes (`grep -r TOKEN .`, a script, `$(…)` that builds the path), and Codex workers are not
covered: the `workspace-write` and `read-only` sandboxes of the validated Codex CLI restrict writes,
not reads, and a command inside the sandbox raises no approval for planestro to see, so a Codex worker
can still read these files (`cat ~/.ssh/id_ed25519`). Keep secrets a Codex worker must not see off
the machine it runs on, or out of its user's reach.

Rules match each segment of a chained or piped command (`&&`, `||`, `;`, `|`), and every
segment must match. Before matching, each segment is reduced to the command it actually runs:
leading plain `NAME=value` assignments and the harmless wrappers `timeout N`/`gtimeout N`,
`nice`, `nohup`, `time` and `env` are peeled off. So `Bash(./tools/run_checks.sh*)` also
covers `CHECK_JOBS=4 ./tools/run_checks.sh x | tail -30`. The deny rules see through the same
prefixes, so `GIT_TRACE=1 git push` is still refused. A segment that sets an environment
variable which changes what runs (`PATH`, `LD_*`, `DYLD_*`, `GIT_*`, `NODE_OPTIONS`,
`BASH_ENV`, …), or whose value contains quotes or expansions, is never auto-allowed and parks
for a decision.

**Inside the worktree.** A command those rules do not allow is read a second time, whole:
every line, loops (`for … do … done`, `if`, `while`), groups, bare `NAME=value` assignments,
`$(…)` and redirections. It is allowed when every command in it matches a rule and nothing
it names lies outside the item's worktree:

- A rule ending in `@worktree` (`Bash(npm run *)@worktree`, `Bash(python3 *)@worktree`)
  counts only in this second reading. Settings → Workers & permissions offers the ones for
  the toolchain the code repository has (`package.json`, `pyproject.toml`, `Cargo.toml`,
  `go.mod`, `project.godot`, `Makefile`); none is on until you add it.
- Reading, comparing and printing are allowed this way for every project: `echo`, `printf`,
  `pwd`, `test`, `[`, `diff`, `ls`, `cat`, `grep`, `rg`, `sort`, `uniq`, `cut`, `tr`, `wc`,
  `head`, `tail`, `basename`, `dirname`, `date`, `sleep`, `which`, `command -v`, `file`,
  `stat`, `du`, `git grep`, `git rev-parse`, `git branch --show-current`, and `mkdir -p`
  outside planning turns. So `npm run check; echo "exit $?"` no longer parks on the `echo`.
  Their flags that run another program are not allowed this way (`rg --pre`,
  `git grep -O`, `sort --compress-program`), and `sed` and `find` are not in the list.
- A `cd` inside the worktree is followed for the commands chained to it with `&&`
  (`cd packages/web && cat ../shared/x.ts`). Past that chain it may have failed, so a later
  `..` has to stay inside from both directories. One in a subshell ends with it; one in a
  loop, a pipeline or the background parks the command.
- Every path the command names, and every file it redirects into, must be inside the
  worktree, under `/tmp` or the system temp folder, or `/dev/null`. `~`, `$HOME` and any
  variable the command did not set itself park it, and so does `..` beside a value only the
  shell will know (`$(pwd)/..`). An absolute path whose top folder does not exist on this
  machine (`grep "/api/config"`, a URL path handed to a script) is not taken for a path.
- A planning turn writes nothing: its redirections go to `/dev/null` only.
- Backticks, `<(…)`, `case`, `[[ … ]]`, `${x:-y}` and arithmetic are not read; a command
  holding one parks as before.

This reads the command's text. It catches a wrong path or a stray `cd`; it does not confine
what a script does once it runs, and a symlink inside the worktree is followed by the
command, not by the check. It is a guard against mistakes, not a sandbox.

**The working directory is pinned.** Every Bash command of a Claude worker starts in its
worktree: the shell goes back there after each command (`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`),
so a `cd` holds for the rest of that one command only. A `cd` that can be seen to leave
the worktree (`cd ..` from its root, `cd /tmp`, `cd ~`, `cd` alone) is refused in code, like a
push: the worker is told to use a path instead and its turn goes on, where a park would have
ended it. One that cannot be judged (`cd "$DIR"`, `cd -`) is left to the rules.

### CI and merging

| Key | Default | |
|---|---|---|
| `ci.mode` | `github` | `github-or-local` falls back to `local_check_command` when GitHub Actions cannot run (billing block, no workflow). |
| `ci.require_green_base` | `true` | Do not merge into a base whose own tip is red. Needs a `push`-event run of the CI workflow on the base; a repo whose workflow only runs on PRs gives it no signal (every red it sees is stale and ignored). |
| `ci.start_timeout_min` | `10` | How long a run may fail to appear before CI counts as blocked. |
| `ci.timeout_min` | `45` | How long a run may take once a runner has started it. Time spent queued for a runner is not counted. |
| `ci.queue_timeout_min` | `720` | How long a run may wait queued, with no job started, before CI counts as timed out. A queue, not a failure: check runner capacity, not the change. |
| `ci.max_queued_runs` | `0` | Admission control: while this many or more of the workflow's runs wait for a runner, no new item starts (items in flight carry on). `0` turns it off. The board shows a *CI queue* pill while runs are waiting. |
| `ci.stall_wake_min` | `30` | A backstop: an item in review that nothing has moved for this long wakes the orchestrator (`review_stalled`) once, until something changes. Nothing moving means no CI run queued or running, no session turn, and no stop, hold or take-over on it, and no Activity line from planestro, the session or you in that time. It is also how long a red epic waits for its base to move when the run looks like the base's regression (#204), before it stops as `ci_red`. `0` turns it off (that wait then has no limit). |
| `ci.local_check_command` | none | The fallback check, run in the item's worktree. |
| `ci.draft_while_held` | `true` | A pull request held for a person (a review hold, `review.hold_into`, the user's hold, a loop's review) is opened as a **draft** and marked ready only after the hold is released and the branch is synced, so CI runs once, on the branch that merges. Pair it with CI that skips drafts (`if: ${{ !github.event.pull_request.draft }}` and `types: [opened, synchronize, reopened, ready_for_review]`). Re-applying such a hold turns the PR back into a draft, once any run in flight has ended. A hold the orchestrator or a worker puts on holds the merge only: the PR stays ready and CI runs on every push (#195). A run whose jobs were all skipped is never read as red; the PR is marked ready once GitHub shows the synced head, and a ready PR whose head still has only skipped runs after a minute is sent ready-for-review again, once. |
| `ci.flaky_checks` | `[]` | Text that marks a red run as a known flake, such as a check's name (`atlas_layout_check`). When a failed log contains one of them, the failed jobs are re-run once for that head before the session is asked to fix anything. A second red is a real red. |
| `epics.auto_submit` | `true` | Open an epic's pull request when its last child merges. |
| `epics.conflict_budget_usd` | `10` | When merging the base into an epic's integration branch conflicts (the merge pipeline or Sync with base), a one-shot session on the epic's implementer resolves it in the epic's merge worktree, capped at this many dollars. It merges and commits, never pushes; planestro then checks the merge (finished, clean, contains `origin/<base>` and the branch as GitHub has it) and pushes it plainly. Otherwise the worktree goes back to where it was, the session's attempt is named in the Activity log, and the epic blocks `sync_conflict`. The orchestrator can retry one with `resolve_epic_conflict` and a hint. `0` turns the session off. |
| `review.image_scale` | `1` | Review thumbnails can also be shown at this integer scale, nearest-neighbour. |
| `review.max_file_bytes` | `10000000` | One changed file over this blocks the item as `asset_too_large` before a pull request exists. |
| `review.max_file_bytes_by_ext` | `{}` | Limits by extension that replace `max_file_bytes` for those files, for kinds of file that are legitimately big (`{ ".ogg": 20000000 }` for a game's music). |
| `review.hold_into` | `[]` | Branches a pull request into opens **held** for you (`skip_merge`, with the reason on the item), whether an item or an epic opened it: for a branch whose merges go live, such as a `main` that deploys to production. It stays out of the merge queue until you release the hold; CI still runs (as a draft while held, if `ci.draft_while_held`). The hold is put on when the pull request opens, so nothing depends on anyone noticing it in time. |
| `review.nudge_after_min` | `240` | A review nobody has looked at for this long wakes the orchestrator, once. |
| `notifications.on_merge` | none | A command run after each merge (`say "PR merged"`). |
| `notifications.on_usage_pause` | none | A command run when the [usage guard](#usage-guard) pauses automation (`say "planestro paused for usage"`). |
| `notifications.on_needs_you` | none | A command run once per wait when something [needs you](#notify-when-something-needs-you): a plan or breakdown ready, a permission request, a worker's question, a decision card, a block, a review or a hold, or a new orchestrator question. |
| `notifications.base_url` | the address the server listens on | Where `PLANESTRO_URL` points, such as the name your phone reaches this machine by (`http://studio.local:4300`). |
| `notifications.idle_after_min` | `2` | A wait is announced only once every planestro tab has gone this many minutes without input; one you answer meanwhile never is. `0` announces at once. |

### Orchestrator, engine, storage

| Key | Default | |
|---|---|---|
| `orchestrator.model` | `claude-opus-5-5` (`opus-5-5` from `init`) | The judgment layer's model: a model id from `models:` (Settings writes the id) or a configured runner model string. Changes apply on the next wake without a restart. |
| `orchestrator.allow_model_fallback` | `false` | While the orchestrator's model is out of usage, wake on its `fallback` instead. |
| `orchestrator.may_approve_plans` | `false` | Whether it may approve plans of items that opted in (**let the orchestrator approve the plan** on the item). It can never approve an epic's breakdown or release a review hold. |
| `orchestrator.may_decide_permissions` | `false` | Whether workers' permission requests go to it before you. It allows ordinary work in the worktree, denies with a reason (three denials on one item and the rest come to you), and hands over anything outside the worktree, installing software or touching credentials. The hard rules run first regardless. |
| `orchestrator.triage` | `true` | Needs-you triage: a block or a worker's question goes to the orchestrator before it reaches you. It resolves what is within its authority (unblock with an instruction, answer from the brief, retry a transient failure, fix a wrong parent or base and recreate an empty worktree) or turns it into one plain decision card. See [Needs-you triage](concepts.md#needs-you-triage). |
| `orchestrator.triage_timeout_min` | `10` | How long an item may stay in triage. Past it — or with the orchestrator off, unavailable or paused — the item comes to you exactly as it stopped. |
| `orchestrator.max_plan_revisions` | `2` | How many times it may send one item's plan back to the planner with fixes. Past that it can only approve the plan or leave it to you. |
| `orchestrator.rotate_after_wakes` | `10` | Start a fresh orchestrator conversation after this many wakes… A long conversation costs more per wake than a fresh one, and the files are its memory, so rotating often loses nothing. |
| `orchestrator.rotate_after_days` | `3` | …or this many days. The files are its memory, and the fresh conversation is given the last 7 days of the user's chat, so an instruction it has not carried out yet still stands. |
| `engine.mode` | `dry-run` | `dry-run` logs `Would …` against in-memory fakes; `live` acts. Overridden per machine by `engine.mode` in the local file. |
| `git.auto_commit` | `true` | Commit data-dir changes with semantic messages. |
| `git.auto_push` | `true` | Push the data dir at checkpoints, if it has a remote. |
| `git.checkpoint_interval_min` | `60` | Telemetry (costs, timestamps) is checkpointed this often rather than per change. |
| `attachments.managed_max_bytes` | `2000000` | Larger attachments are referenced in place instead of copied into the data dir. |

### Releases

`releases.sections` is the list of sections a release has, in order ([Releases](releases.md)).
Default: **Release notes** and **Notes**.

| Key | Default | |
|---|---|---|
| `releases.sections.title` | — | The section's `# heading` in the release file. |
| `releases.sections.max_chars` | none | A limit to count toward (a store field's); the page shows the count, red past it. |
| `releases.sections.carry` | `false` | A new release starts with the previous release's text for this section. |
| `releases.sections.hint` | none | One line shown under the heading. |

## planestro.local.yml

| Key | |
|---|---|
| `code_repo_path` | Where the code repository is on this machine. |
| `worktrees_root` | Where worktrees go on this machine. |
| `claude_bin` | Which Claude Code the sessions run. Unset: the installed `claude` on `PATH` when it is newer than the one the Agent SDK bundles (a new model can need a newer CLI), otherwise the bundled one; startup logs which. A path uses that executable; `bundled` forces the SDK's own. |
| `update.channel` | With `serve --watch`, keep this machine's planestro checkout current (#103). `main-green` moves the checkout the supervisor runs from to the newest `main` commit whose CI passed, runs `npm ci` if the lockfile changed, and restarts between turns like any update. Never your data, never backwards past the data dir's schema, never a checkout with local changes or one ahead of `origin/main` (a development tree). `off` (the default) leaves it alone. The Console shows the running commit and what the last check found. Give each project its own clone (for example `~/.planestro/app/<project>`, started with that as `PLANESTRO_HOME`), not the tree you develop planestro in. |
| `update.poll_min` | How often, in minutes, `update.channel: main-green` looks for a newer commit (default 15). |
| `update.min_age_hours` | Take a commit only after its CI has been green this many hours (default 0): a soak time, so one project can trail another. |
| `mcp_servers` | MCP servers a model row may name in `mcp`, with their keys, e.g. `elevenlabs: { command: uvx, args: [elevenlabs-mcp], env: { ELEVENLABS_API_KEY: … } }` or `meshy: { command: npx, args: [-y, "@meshy-ai/meshy-mcp-server"], env: { MESHY_API_KEY: … } }`. Machine-local and gitignored, like the API key. A url that is a running planestro's own operator endpoint (`/mcp` on a port `planestro start` recorded) is refused: workers never get it. |
| `allowed_hosts` | Extra names this machine is reached by — a Tailscale or DNS name for the phone. The server answers only requests addressed to `localhost`, `127.0.0.1`, the `--host` it is bound to (with `0.0.0.0`: this machine's hostname and interface addresses) and these; anything else, and any request from another website, gets a 403. |
| `codex_bin` | Path to `codex`, if not on `PATH`. Only used by models with `runner: codex`. |
| `anthropic_api_key` | Bills Claude sessions to the API under the Commercial Terms instead of a claude.ai login. `ANTHROPIC_API_KEY` in the environment does the same. |
| `model_unavailable` | Models this machine's account cannot use right now, by model id: `{ until, reason, since, manual }`. Written when a turn fails on a usage limit and by **mark unavailable** in Settings; cleared there or when `until` passes. Per machine because usage belongs to the account logged in here. |
| `engine.paused` | The PAUSE AUTOMATION lever, persisted. |
| `engine.paused_by` | `user` (the lever) or `disk`. Provider guards are independent. Only a disk pause can automatically release this global lever; a user pause never does. |
| `engine.disk_guard.free_gib` | While the [disk guard](#disk-guard) holds automation paused: the GiB free when it tripped… |
| `engine.disk_guard.path` | …on which volume (the repo or the worktrees root, whichever had less)… |
| `engine.disk_guard.tripped_at` | …and when. |
| `engine.provider_guards` | Guards keyed by provider, each with window, status, optional utilization/reset, trip time and optional resume time. Other providers remain available. |
| `engine.provider_guard_last` | Last crossing per provider. An explicit provider retry suppresses that same crossing until reset. |
| `engine.mode` | This machine's override of `engine.mode`. |

## Notify when something needs you

When an item comes to need you (its card says *needs you*) or the orchestrator opens a question, planestro
journals one `notification` for that wait and runs `notifications.on_needs_you`. An open planestro tab that
turned on desktop notifications shows it too. One wait is announced once: more activity on the same wait says
nothing new, and a stop the orchestrator is still triaging is not yours yet. While you are using planestro (any
open tab had input in the last `notifications.idle_after_min` minutes) it is held back, and a wait you answer
meanwhile is never sent.

The command gets `PLANESTRO_TITLE` and `PLANESTRO_MESSAGE`, as the others do, and also `PLANESTRO_ITEM` (empty
for a question about no item), `PLANESTRO_KIND` (`plan`, `breakdown`, `permission`, `question`, `review`,
`decision`, `blocked` or `hold`) and `PLANESTRO_URL`, an absolute link to the item (`/items/<id>#<kind>`) or the
question (`/questions/<id>`).

A phone alert needs no new dependency and costs nothing. planestro does not depend on any notification service:
`on_needs_you` is a command you choose. [ntfy](https://ntfy.sh) is free and open source: its public ntfy.sh server
needs no account (paid plans only raise its limits), and you can self-host it for free, even on this machine. Its
phone app is free too. Subscribe to a topic in the app and set:

```yaml
notifications:
  on_needs_you: curl -s -d "$PLANESTRO_MESSAGE" -H "Title: $PLANESTRO_TITLE" -H "Click: $PLANESTRO_URL" https://ntfy.sh/<your-topic>
  base_url: http://studio.local:4300   # how the phone reaches this machine
```

The link opens planestro only where the server is reachable: your LAN, or a VPN you run. planestro has no remote
access of its own. To be reached by another name, the server must listen beyond `127.0.0.1` (`planestro serve
--host 0.0.0.0`) and accept that name (`allowed_hosts` in `planestro.local.yml`). Anyone who can read your topic
sees the item titles, so pick a topic nobody can guess, or run your own server.

## Disk guard

A full disk fails every worker one by one, each as its own stop (HH-355, #161). Once a minute planestro
reads the free space on the volumes holding the code repo and the worktrees root. Below
`min_free_gib` it pauses automation (`paused_by: disk`): running steps finish, nothing new starts,
the topbar says *disk nearly full*, and `notifications.on_usage_pause` runs. At `resume_free_gib` it
resumes by itself. A write that still fails on ENOSPC blocks as `disk_full`, which is not triaged.
It never deletes anything: freeing space is yours.

| key | default | meaning |
|---|---|---|
| `disk_guard.enabled` | `true` | Read the free space at all. |
| `disk_guard.min_free_gib` | `10` | Pause below this many GiB free. |
| `disk_guard.resume_free_gib` | `15` | Resume at this many GiB free (a margin, so it does not flap). |

## Usage guard

A Claude subscription meters usage in rolling windows (five hours, seven days, per-model weekly
windows). Every Claude turn — worker turns and orchestrator wakes alike — streams the account's
current reading for its window, and planestro stops itself *before* the limit rather than at it.

| Key | Default | |
|---|---|---|
| `usage_guard.enabled` | `true` | Watch the readings at all. |
| `usage_guard.threshold` | `0.85` | Pause when any window's utilization reaches this fraction. |
| `usage_guard.on_warning` | `true` | Also pause on an `allowed_warning` reading, whatever the utilization. |
| `usage_guard.auto_resume` | `false` | Resume a guard-made pause 60 s after the window resets. Off by default: resuming on its own restarts spending while nobody is watching, so a guard pause waits for you unless you opt in. |

A `rejected` reading always trips the affected provider's guard. Running turns finish; new turns on other providers and deterministic CI/merge operations can continue. The machine-local `engine.provider_guards` records guards by provider; `engine.provider_guard_last` suppresses duplicate crossings. Global user and disk pauses remain authoritative. Global RESUME never clears a provider guard; Retry provider overrides only its crossing. `auto_resume` releases only that provider after its reset plus 60 seconds. It also unblocks items blocked `usage_exhausted` when their model's `model_unavailable` entry ends (the entry is then dropped, so each ending unblocks once): the items whose current-phase model is that model, or has it in its fallback chain when the item allows a fallback. Items blocked for anything else, held or taken over are left alone.

Legacy `paused_by: usage_guard` is normalized to a Claude guard and its global pause is cleared on each machine's startup. User/disk pauses are untouched. Codex uses model-specific unavailability unless quota telemetry has been verified; no quota readings are invented. See [Switching providers](switching-providers.md).

## Model fallback

A subscription model can run out of usage mid-week. planestro can carry on with another model
until it resets, per item and for the orchestrator, without a code change:

1. Give the model a fallback on the same runner: `- { id: fable-5, label: Fable 5, claude_model: claude-fable-5, fallback: opus-5-5 }`.
2. Allow it: tick **allow fallback model** on an item (or set `defaults.allow_model_fallback: true` so new items and epic children start with it), and **orchestrator → allow fallback** in Settings.

When a Claude turn fails because its model is out of usage (the CLI's usage-limit message, a
`billing_error` / `rate_limit` / `model_not_found` from the API, or a rejected rate-limit event),
planestro records the model as unavailable until the reset the provider reported (or an hour),
notes it in the item's Activity log and runs the same turn again on the fallback, resuming the
same conversation. Later turns go straight to the fallback until the reset; after it, the
original model is tried first again. An item that does not allow a fallback blocks as
`usage_exhausted` instead. You can also **mark unavailable until…** a model in Settings when you
already know it is out, so no turn is spent discovering it.
