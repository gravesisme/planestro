# Configuration

`planestro.yml` lives in the data dir and is versioned with it. `planestro.local.yml` sits
beside it, is gitignored, and holds what is true of one machine only. Most keys can be
changed in **Settings**; all of them can be edited by hand while planestro is not running.
A test (`docs.test.ts`) fails if a key in the schema is missing from this page.

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
| `worktrees.dir_pattern` | `{{prefix_lower}}-{{number}}-{{slug}}` | Worktree directory name. |
| `hooks.after_worktree_create` | `[]` | Commands run in a new worktree before planning (install dependencies, import assets). A non-zero exit blocks the item as `hook_failed`. Not re-run when an item that went to the icebox is queued again and reuses its worktree. |

### Models and defaults

| Key | Default | |
|---|---|---|
| `models.id` | — | What items store as `planner` / `implementer`. |
| `models.label` | — | What the UI shows. |
| `models.runner` | `claude` | `claude` or `codex`. A `codex` model implements but never plans. See [Agents](agents.md). |
| `models.claude_model` | — | The Claude model id; required for a `claude` runner. |
| `models.codex_model` | Codex's own default | Passed to `codex exec -m`. |
| `models.description` | none | One line on what the model is for. The epic planner routes children by it. |
| `models.hold_for_review` | `false` | Park this model's pull requests on `awaiting: review` after CI until you approve them. |
| `models.fallback` | none | Another model id on the same runner. An item that allows fallback (**allow fallback model**, `allow_model_fallback: true`) runs on it while this model is out of usage, and the Claude SDK also uses it when this model is overloaded. Chains are followed (`a → b → c`). See [Model fallback](#model-fallback). |
| `models.external` | `false` | Not run by planestro; its items are watched. |
| `defaults.planner` | — | For new items. Must be a model that can plan. |
| `defaults.implementer` | — | For new items. |
| `defaults.category` | — | For new items. |
| `defaults.allow_model_fallback` | `false` | New items start with **allow fallback model** ticked; an epic's children inherit the epic's setting. |
| `categories` | — | The list items choose from. Rename and remove in Settings, which reassigns items. |

### Budgets and concurrency

| Key | Default | |
|---|---|---|
| `budget_usd_per_item` | `25` | Dollar ceiling across all of an item's Claude turns; each turn starts with what remains. |
| `budget_turns_per_item` | `20` | Worker turns per item for runners that report tokens instead of dollars (Codex). Blocks as `turn_budget`. |
| `budget_tokens_per_item` | `600000` | Uncached tokens per item for those runners. Blocks as `token_budget`. |
| `concurrency.max_sessions` | `3` | Items admitted to planning/implementing at once. |
| `concurrency.max_local_jobs` | `1` | Setup hooks and local check commands running at once. |
| `concurrency.runner_limits` | `{ codex: 1 }` | Simultaneous turns per runner. Unlisted runners are not limited here. |

### What Claude workers may do

| Key | Default | |
|---|---|---|
| `permissions.allow` | `[]` | Extra allow rules (`Bash(npm test*)`, …) on top of the built-in ones. "Always allow" in the UI appends here. |
| `permissions.deny` | `[]` | Extra deny patterns, checked before anything else. |

Pushes, `gh pr`, protected branches, branch and worktree management and force operations
are denied in code (`engine/policy.ts`) whatever these say. Codex workers are governed by
their sandbox instead.

Rules match each segment of a chained or piped command (`&&`, `||`, `;`, `|`), and every
segment must match. Before matching, each segment is reduced to the command it actually runs:
leading plain `NAME=value` assignments and the harmless wrappers `timeout N`/`gtimeout N`,
`nice`, `nohup`, `time` and `env` are peeled off. So `Bash(./tools/run_checks.sh*)` also
covers `CHECK_JOBS=4 ./tools/run_checks.sh x | tail -30`. The deny rules see through the same
prefixes, so `GIT_TRACE=1 git push` is still refused. A segment that sets an environment
variable which changes what runs (`PATH`, `LD_*`, `DYLD_*`, `GIT_*`, `NODE_OPTIONS`,
`BASH_ENV`, …), or whose value contains quotes or expansions, is never auto-allowed and parks
for a decision.

### CI and merging

| Key | Default | |
|---|---|---|
| `ci.mode` | `github` | `github-or-local` falls back to `local_check_command` when GitHub Actions cannot run (billing block, no workflow). |
| `ci.require_green_base` | `true` | Do not merge into a base whose own tip is red. Needs a `push`-event run of the CI workflow on the base; a repo whose workflow only runs on PRs gives it no signal (every red it sees is stale and ignored). |
| `ci.start_timeout_min` | `10` | How long a run may fail to appear before CI counts as blocked. |
| `ci.timeout_min` | `45` | How long a run may take. |
| `ci.local_check_command` | none | The fallback check, run in the item's worktree. |
| `epics.auto_submit` | `true` | Open an epic's pull request when its last child merges. |
| `review.image_scale` | `1` | Review thumbnails can also be shown at this integer scale, nearest-neighbour. |
| `review.max_file_bytes` | `10000000` | One changed file over this blocks the item as `asset_too_large` before a pull request exists. |
| `review.nudge_after_min` | `240` | A review nobody has looked at for this long wakes the orchestrator, once. |
| `notifications.on_merge` | none | A command run after each merge (`say "PR merged"`). |

### Orchestrator, engine, storage

| Key | Default | |
|---|---|---|
| `orchestrator.model` | `claude-fable-5` | The judgment layer's model: a model id from `models:` (Settings writes the id) or a Claude model string. |
| `orchestrator.allow_model_fallback` | `false` | While the orchestrator's model is out of usage, wake on its `fallback` instead. |
| `orchestrator.may_approve_plans` | `false` | Whether it may approve plans of items that opted in (**let the orchestrator approve the plan** on the item). It can never approve an epic's breakdown or release a review hold. |
| `orchestrator.may_decide_permissions` | `false` | Whether workers' permission requests go to it before you. It allows ordinary work in the worktree, denies with a reason (three denials on one item and the rest come to you), and hands over anything outside the worktree, installing software or touching credentials. The hard rules run first regardless. |
| `orchestrator.max_plan_revisions` | `2` | How many times it may send one item's plan back to the planner with fixes. Past that it can only approve the plan or leave it to you. |
| `orchestrator.rotate_after_wakes` | `40` | Start a fresh orchestrator conversation after this many wakes… |
| `orchestrator.rotate_after_days` | `3` | …or this many days. The files are its memory. |
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
| `claude_bin` | Path to `claude`, if not on `PATH`. |
| `allowed_hosts` | Extra names this machine is reached by — a Tailscale or DNS name for the phone. The server answers only requests addressed to `localhost`, `127.0.0.1`, the `--host` it is bound to (with `0.0.0.0`: this machine's hostname and interface addresses) and these; anything else, and any request from another website, gets a 403. |
| `codex_bin` | Path to `codex`, if not on `PATH`. Only used by models with `runner: codex`. |
| `anthropic_api_key` | Bills Claude sessions to the API under the Commercial Terms instead of a claude.ai login. `ANTHROPIC_API_KEY` in the environment does the same. |
| `model_unavailable` | Models this machine's account cannot use right now, by model id: `{ until, reason, since, manual }`. Written when a turn fails on a usage limit and by **mark unavailable** in Settings; cleared there or when `until` passes. Per machine because usage belongs to the account logged in here. |
| `engine.paused` | The PAUSE AUTOMATION lever, persisted. |
| `engine.mode` | This machine's override of `engine.mode`. |

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

