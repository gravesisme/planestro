/**
 * The settings registry (issue #83): every user-facing key of planestro.yml and planestro.local.yml,
 * with where it lives on the Settings page, what it is called there, a one-line summary, the long
 * explanation ("Learn more", from docs/configuration.md) and how it is edited. The page renders
 * from this list and the server accepts writes only to the keys it names as editable, so a
 * setting cannot ship without its explanation (docs.test.ts checks it against the schema).
 * Defaults are never written here: they are read from the zod schema (`settingDefault`).
 */
import { Config, LocalConfig } from './schema.ts';

export const SETTINGS_TABS = [
  { id: 'project', name: 'Project', hint: 'repo, branches, categories', file: 'planestro.yml',
    intro: 'What planestro is managing: the code repository, the branch every piece of work starts from, how items are sorted on the board, and whether the engine acts or only says what it would do.' },
  { id: 'models', name: 'Models', hint: 'who plans, who builds', file: 'planestro.yml · models: / defaults:',
    intro: 'The AI models items can use, which one plans and which one implements new items by default, and what happens when a model runs out of usage.' },
  { id: 'budgets', name: 'Budgets & limits', hint: 'spend, sessions, usage guard', file: 'planestro.yml',
    intro: 'How much work one item may do, how many things run at once, and when planestro pauses itself before your plan runs out.' },
  { id: 'orchestrator', name: 'Orchestrator', hint: 'what it may decide for you', file: 'planestro.yml · orchestrator:',
    intro: 'The orchestrator is the judgment layer that reviews plans, triages stops and answers workers. These settings decide how much it may do on your behalf before something reaches you.' },
  { id: 'workers', name: 'Workers & permissions', hint: 'worktrees, commands, files', file: 'planestro.yml · worktrees: / hooks: / permissions:',
    intro: 'Where each item gets its own copy of the code, what runs when that copy is made, which files are not work, and which commands workers may run without asking.' },
  { id: 'ci', name: 'CI & merging', hint: 'checks, holds, review', file: 'planestro.yml · ci: / review: / epics:',
    intro: 'How planestro decides a pull request is safe to merge, and when it stops to show you something first.' },
  { id: 'notifications', name: 'Notifications', hint: 'what tells you, and how', file: 'planestro.yml · notifications:',
    intro: 'Commands planestro runs on events, so you hear about merges and pauses away from the browser.' },
  { id: 'machine', name: 'This machine', hint: 'paths, programs, keys', file: 'planestro.local.yml (not committed)',
    intro: 'Settings that are true of this computer only. They are never committed, so the same data folder works on another machine with its own paths.' },
  { id: 'data', name: 'Data & releases', hint: 'git, attachments, release sections', file: 'planestro.yml · git: / attachments: / releases:',
    intro: 'Where planestro keeps its files, how it commits and pushes them, and what sections a release has.' },
] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

/**
 * How a row is edited. `model` is a select over the model list (`planners` limits it to models that
 * can plan); `models`, `categories` and `sections` are whole editors of their own; `secret` shows
 * set / not set and takes a replacement, never the value.
 */
export type SettingControl = 'number' | 'toggle' | 'text' | 'select' | 'model' | 'list' | 'record' | 'commands' | 'secret' | 'readonly' | 'categories' | 'models' | 'sections';
export type SettingFile = 'config' | 'local';

export interface SettingDef {
  key: string;
  file: SettingFile;
  tab: SettingsTabId;
  group: string;
  label: string;
  summary: string;
  /** The long explanation, one paragraph per entry ("Learn more"). */
  detail?: string[];
  control: SettingControl;
  /** Shown beside the number (`$`, `min`, `MB`, `%`). */
  unit?: string;
  /** The stored value is the shown number times this: `0.01` shows 0.85 as 85 %, `1e6` shows bytes as MB. */
  per?: number;
  min?: number;
  options?: { value: string; label: string }[];
  /** `model` control: only models that can plan. */
  planners?: boolean;
  placeholder?: string;
  mono?: boolean;
  /** Takes effect the next time planestro starts. */
  restart?: boolean;
  /** Fixed once the project has items (ids appear in branches, commits and pull requests). */
  lockedWithItems?: boolean;
  /** Other schema keys this row's control writes (the categories editor sets defaults.category). */
  covers?: string[];
}

/** Controls whose value the generic write endpoints accept; the others have their own routes or none. */
export const WRITABLE_CONTROLS: readonly SettingControl[] = ['number', 'toggle', 'text', 'select', 'model', 'list', 'record', 'commands', 'secret', 'sections'];

const C = (d: Omit<SettingDef, 'file'>): SettingDef => ({ file: 'config', ...d });
const L = (d: Omit<SettingDef, 'file' | 'tab'> & { tab?: SettingsTabId }): SettingDef => ({ file: 'local', tab: 'machine', ...d });

export const SETTINGS: readonly SettingDef[] = [
  // ---- Project
  C({ key: 'project.name', tab: 'project', group: 'Repository', label: 'Project name', summary: 'Shown in the header and the browser tab.', control: 'text' }),
  C({ key: 'project.id_prefix', tab: 'project', group: 'Repository', label: 'Item id prefix', summary: 'Items are numbered <PREFIX>-1, <PREFIX>-2, … Uppercase letters and digits.', control: 'text', mono: true, lockedWithItems: true,
    detail: ['Fixed once the project has items: ids appear in file names, branch names, commits and pull requests, and changing the prefix would not rename any of them.'] }),
  C({ key: 'code_repo.path', tab: 'project', group: 'Repository', label: 'Code repository', summary: 'The repository planestro works on, relative to the data folder or absolute.', control: 'text', mono: true, restart: true,
    detail: ['Each machine can point somewhere else with This machine → Code repository, which is not committed. Takes effect the next time planestro starts.'] }),
  C({ key: 'code_repo.default_branch', tab: 'project', group: 'Repository', label: 'Base branch', summary: 'Every branch planestro creates starts from here and merges back here, unless the item is part of an epic.', control: 'text', mono: true,
    detail: ['An epic gets its own integration branch (feature/<slug>); its children target that instead. An item can also set its own base on its page (base_branch_override).'] }),
  C({ key: 'code_repo.release_branch', tab: 'project', group: 'Repository', label: 'Release branch', summary: 'Protected from workers, like the base branch.', control: 'text', mono: true, placeholder: 'none' }),
  C({ key: 'code_repo.github', tab: 'project', group: 'Repository', label: 'GitHub repository', summary: 'owner/repo: where pull requests open and CI is read.', control: 'text', mono: true, placeholder: 'owner/repo' }),
  C({ key: 'categories', tab: 'project', group: 'Board', label: 'Categories', summary: 'The list items choose from. Renaming or removing one moves its items for you.', control: 'categories', covers: ['defaults.category'],
    detail: ['The default category is the one new items start in (defaults.category). A category that still has items can only be removed by choosing where they go.'] }),
  C({ key: 'engine.mode', tab: 'project', group: 'Engine', label: 'Live or dry-run', summary: 'Dry-run logs "Would …" for every git, GitHub and session step instead of doing it.', control: 'select', restart: true,
    options: [{ value: 'dry-run', label: 'Dry-run (log what would happen)' }, { value: 'live', label: 'Live' }],
    detail: ['Watch a dry run against your repository before going live. This machine can override it (This machine → Engine mode). Takes effect the next time planestro starts.'] }),

  // ---- Models
  C({ key: 'models', tab: 'models', group: 'Models', label: 'Models', summary: 'The models items can use, what each runs on, and which one takes over while it is out of usage.', control: 'models',
    detail: [
      'A claude model plans and implements; a codex model implements only. A model can hold its pull requests for your review (art is reviewed by eye), give its sessions MCP servers (a sound or 3D service, with keys in planestro.local.yml), and have planestro commit for it when its sandbox cannot write git\'s files.',
      'A fallback is another model on the same runner. An item that allows fallback runs on it while this model is out of usage, and the Claude SDK also uses it when this model is overloaded. Chains are followed (a → b → c).',
      'An outage is noticed on the first failed turn and remembered until the provider\'s reset; Mark unavailable records one you already know about, so no turn is spent discovering it.',
    ] }),
  C({ key: 'defaults.planner', tab: 'models', group: 'Defaults for new items', label: 'Default planner', summary: 'Writes the plan for a new item. Only Claude models can plan.', control: 'model', planners: true }),
  C({ key: 'defaults.implementer', tab: 'models', group: 'Defaults for new items', label: 'Default implementer', summary: 'Does the work once the plan is approved.', control: 'model' }),
  C({ key: 'defaults.allow_model_fallback', tab: 'models', group: 'Defaults for new items', label: 'Allow fallback model', summary: "New items may switch to their model's fallback while it is out of usage. Epic children follow the epic.", control: 'toggle',
    detail: ['When a turn fails because its model is out of usage, planestro records the model as unavailable until the reset the provider reported, and runs the same turn again on the fallback in the same conversation. An item without this ticked blocks as usage_exhausted instead.'] }),

  // ---- Budgets & limits
  C({ key: 'budget_usd_per_item', tab: 'budgets', group: 'Per item', label: 'Dollar budget', summary: 'How much work one item may do across all of its Claude turns. It warns at 80% and stops at the cap.', control: 'number', unit: '$', min: 0.01,
    detail: ['Each turn starts with what remains. An item can carry its own budget on its page, which replaces this one for it; when an item stops for money, the orchestrator sends you a card that raises it in one tap ("+$15 and resume").', 'A resumed session reloads its whole conversation first, so a small raise on a long-running item can be spent before any new work happens.'] }),
  C({ key: 'budget_usd_per_plan_turn', tab: 'budgets', group: 'Per item', label: 'Per planning turn', summary: 'How much one planning turn may do before the planner is asked for the plan it has.', control: 'number', unit: '$', min: 0.01,
    detail: ['Past it the turn ends and the planner is asked once, cheaply, for the plan it has (one planner spent $97 researching without handing one in). A second miss blocks as no_plan.'] }),
  C({ key: 'budget_turns_per_item', tab: 'budgets', group: 'Per item', label: 'Turns (Codex)', summary: 'Worker turns per item for runners that report tokens instead of dollars.', control: 'number', unit: 'turns', min: 1,
    detail: ['Blocks as turn_budget. An item\'s own budget_turns replaces it.'] }),
  C({ key: 'budget_tokens_per_item', tab: 'budgets', group: 'Per item', label: 'Tokens (Codex)', summary: 'Uncached tokens per item for those runners.', control: 'number', unit: 'tokens', min: 1,
    detail: ['Blocks as token_budget. A live art turn measured 20–35k; the default leaves room for a dozen revisions. An item\'s own budget_tokens replaces it.'] }),
  C({ key: 'concurrency.max_sessions', tab: 'budgets', group: 'Running at once', label: 'Items worked on at once', summary: 'A slot is taken only while something is actually running for an item: a turn, an engine step, a git operation.', control: 'number', min: 1,
    detail: ['Never by an epic, and never by an item that is only waiting on you or on CI.'] }),
  C({ key: 'concurrency.max_local_jobs', tab: 'budgets', group: 'Running at once', label: 'Local jobs at once', summary: 'Setup hooks and local check commands running at the same time.', control: 'number', min: 1 }),
  C({ key: 'concurrency.runner_limits', tab: 'budgets', group: 'Running at once', label: 'Per-runner limits', summary: 'Turns at once per runner, for runners with their own rate limits. Unlisted runners are not limited here.', control: 'record', unit: 'turns', min: 1, placeholder: 'codex' }),
  C({ key: 'concurrency.stall_after_min', tab: 'budgets', group: 'Running at once', label: 'Stalled after', summary: 'An active item nothing has touched for this long is carried on once, then blocked as stalled. 0 turns this off.', control: 'number', unit: 'min', min: 0,
    detail: ['An item planning or in progress that nothing has driven (no turn, no step, no operation, not waiting on anyone) is stalled. planestro carries it on once, the way an unblock does; a second stall within the hour blocks it as stalled.'] }),
  C({ key: 'usage_guard.enabled', tab: 'budgets', group: 'Usage guard', label: 'Pause before the plan limit', summary: "Watch your Claude plan's usage windows and pause automation before one runs out.", control: 'toggle',
    detail: ['A Claude subscription meters usage in rolling windows (five hours, seven days, per-model weekly windows). Every Claude turn streams the account\'s current reading, and planestro stops itself before the limit rather than at it.', 'Tripping it is the same as PAUSE AUTOMATION: turns already running finish, nothing new starts. It trips once per window crossing and never takes over a pause you made yourself. API-key billing has no windows, so the guard stays idle there.'] }),
  C({ key: 'usage_guard.threshold', tab: 'budgets', group: 'Usage guard', label: 'Pause at', summary: 'How full a window may get. Turns already running keep spending after the pause, so leave headroom.', control: 'number', unit: '%', per: 0.01, min: 1 }),
  C({ key: 'usage_guard.on_warning', tab: 'budgets', group: 'Usage guard', label: 'Also pause on a warning', summary: 'Pause when Claude reports a usage warning, whatever the percentage.', control: 'toggle' }),
  C({ key: 'usage_guard.auto_resume', tab: 'budgets', group: 'Usage guard', label: 'Resume by itself', summary: 'Resume a minute after the window resets. Off: a guard pause waits for you.', control: 'toggle',
    detail: ['Off by default: resuming on its own restarts spending while nobody is watching. RESUME by hand cancels the automatic resume; a pause you pulled yourself is never resumed automatically.'] }),

  // ---- Orchestrator
  C({ key: 'orchestrator.model', tab: 'orchestrator', group: 'Model', label: 'Model', summary: 'The model that makes judgment calls. Only Claude models can.', control: 'model', planners: true }),
  C({ key: 'orchestrator.allow_model_fallback', tab: 'orchestrator', group: 'Model', label: 'Allow fallback', summary: "While the orchestrator's model is out of usage, wake on its fallback instead.", control: 'toggle' }),
  C({ key: 'orchestrator.rotate_after_wakes', tab: 'orchestrator', group: 'Model', label: 'Fresh conversation every', summary: 'Its files are its memory, so a fresh conversation loses nothing and costs less per wake.', control: 'number', unit: 'wakes', min: 1 }),
  C({ key: 'orchestrator.rotate_after_days', tab: 'orchestrator', group: 'Model', label: '…or every', summary: 'Whichever comes first.', control: 'number', unit: 'days', min: 0.01 }),
  C({ key: 'orchestrator.triage', tab: 'orchestrator', group: 'What it may decide', label: 'Handles stops first', summary: "A block or a worker's question goes to it before you. It fixes what it can and brings you one plain decision card.", control: 'toggle',
    detail: ['It resolves what is within its authority (unblock with an instruction, answer from the brief, retry a transient failure, fix a wrong parent or base and recreate an empty worktree) or turns the stop into one decision card, with its recommendation first.'] }),
  C({ key: 'orchestrator.triage_timeout_min', tab: 'orchestrator', group: 'What it may decide', label: "Then it's yours after", summary: 'An item still in triage after this long comes to you exactly as it stopped.', control: 'number', unit: 'min', min: 0.01,
    detail: ['With the orchestrator off, unavailable or paused, a stop comes to you straight away.'] }),
  C({ key: 'orchestrator.may_approve_plans', tab: 'orchestrator', group: 'What it may decide', label: 'May approve plans', summary: "Only for items that opt in on their page. Never an epic's breakdown or a review hold.", control: 'toggle',
    detail: ['An item opts in with "let the orchestrator approve the plan". The orchestrator then approves the plan, sends it back to the planner with specific fixes, or leaves it to you; once the fix rounds are used it can only approve or leave it to you.'] }),
  C({ key: 'defaults.auto_approve_plan', tab: 'orchestrator', group: 'What it may decide', label: 'New items let it approve their plan', summary: 'New items start with "let the orchestrator approve the plan" ticked, except those implemented outside Claude (art), which you review.', control: 'toggle',
    detail: ['Applies to items created from now on: the New item dialog, the orchestrator\'s create_item and an epic\'s children. You can untick it on any item.', 'An item whose implementer runs on another runner (Codex Art) stays unticked: its plan is art direction, which is yours to approve.', 'Only matters while "May approve plans" is on.'] }),
  C({ key: 'orchestrator.max_plan_revisions', tab: 'orchestrator', group: 'What it may decide', label: "Fix rounds before it's yours", summary: 'How often it may send one plan back to the planner.', control: 'number', min: 0 }),
  C({ key: 'orchestrator.may_decide_permissions', tab: 'orchestrator', group: 'What it may decide', label: "May answer workers' permission requests", summary: "It allows ordinary work inside the item's worktree and leaves anything outside it, installs and credentials to you.", control: 'toggle',
    detail: ["Three denials on one item and the rest come to you. planestro's hard rules (no pushes, no pull requests, no protected branches, no force flags) apply before anyone is asked."] }),

  // ---- Workers & permissions
  C({ key: 'hooks.after_worktree_create', tab: 'workers', group: 'Worktrees', label: 'Setup commands', summary: 'Run in each new worktree before planning. A failure blocks the item as hook_failed.', control: 'list', mono: true, placeholder: 'npm ci',
    detail: ['Install dependencies, import assets. Not re-run when an item that went to the icebox is queued again and reuses its worktree.'] }),
  C({ key: 'worktrees.byproducts', tab: 'workers', group: 'Worktrees', label: 'Files that are never work', summary: "Untracked files your tools regenerate (Godot's *.import). Clean-tree checks ignore them; cleanup moves them aside.", control: 'list', mono: true, placeholder: '*.import',
    detail: ['No clean-tree check counts them (after a turn, before a sync, finish from worktree, recreate, close as done), engine commits leave them out, and cleanup moves them to .displaced/ before removing the worktree.', 'A pattern without / matches the file name at any depth; one with / matches the path from the worktree root.'] }),
  C({ key: 'worktrees.keep_on_remove', tab: 'workers', group: 'Worktrees', label: 'Keep when a worktree is removed', summary: "Folders whose files are moved to .displaced/ instead of deleted: a worker's raw sources or scratch output.", control: 'list', mono: true, placeholder: 'tmp',
    detail: ['Paths inside a worktree, relative (tmp). Their files go to <worktrees folder>/.displaced/<item>-<time>/ whether git tracks, ignores or does not know them; the Activity log says where.'] }),
  C({ key: 'worktrees.copy_to_checkout', tab: 'workers', group: 'Worktrees', label: 'Copy into the main checkout on merge', summary: "Folders whose files planestro copies into the same folder of your main checkout when an item merges: a sandboxed worker's output it cannot put there itself.", control: 'list', mono: true, placeholder: 'tmp',
    detail: ['Paths inside a worktree, relative (tmp). Only files git does not track are copied, and never over a file that is already there with other content: that one stays only in .displaced/, and the Activity log names it.', 'They are kept on removal too, as Keep when a worktree is removed does. A copy that fails stops the cleanup (cleanup_dirty); nothing is removed.', 'Workers and the orchestrator are told, so a brief never asks a sandboxed worker to copy there itself.'] }),
  C({ key: 'worktrees.generated', tab: 'workers', group: 'Worktrees', label: 'Generated files', summary: 'Tracked files a command rebuilds. A sync that conflicts only in these takes the base\'s copy and runs the command, with no session turn.', control: 'commands', mono: true, placeholder: 'resources/i18n/messages.pot',
    detail: ['Each row is a file pattern and the command that regenerates it, run in the worktree (godot --headless --script tools/i18n_export_pot.gd). A pattern without / matches the file name at any depth; one with / matches the path from the worktree root.', 'When a rebase or merge conflicts only in files listed here, planestro takes the base\'s copy, finishes the sync, runs each command once and commits the regenerated files as "<id>: regenerate …". The Activity log says so.', 'If any other file conflicts, a command fails, or it changes a file not listed here, the sync is undone and the conflict goes to the session as before.'] }),
  C({ key: 'worktrees.root', tab: 'workers', group: 'Worktrees', label: 'Worktrees folder', summary: 'Where item worktrees go, relative to the code repository.', control: 'text', mono: true,
    detail: ['Each machine can override it with This machine → Worktrees folder.'] }),
  C({ key: 'worktrees.branch_pattern', tab: 'workers', group: 'Worktrees', label: 'Branch name', summary: 'The branch a worker gets. {{prefix_lower}}, {{number}} and {{slug}} are filled in.', control: 'text', mono: true,
    detail: ['Changing it affects new worktrees only; existing items keep the branch they have.'] }),
  C({ key: 'worktrees.dir_pattern', tab: 'workers', group: 'Worktrees', label: 'Worktree folder name', summary: 'The folder each worktree gets, with the same placeholders.', control: 'text', mono: true }),
  C({ key: 'permissions.allow', tab: 'workers', group: 'Commands workers may run', label: 'Always allowed', summary: '"Always allow" on a request adds here. Entries that look like one-off commands are marked.', control: 'list', mono: true, placeholder: 'Bash(npm test*)',
    detail: [
      'Extra allow rules on top of the built-in ones. Rules match each part of a chained or piped command (&&, ||, ;, |), and every part must match. Leading NAME=value assignments and wrappers such as timeout 120 are looked through.',
      'Pushes, gh pr, protected branches, branch and worktree management, force operations and in-place shell edits (sed -i) are refused in code whatever this list says. Codex workers are governed by their sandbox instead.',
    ] }),
  C({ key: 'permissions.deny', tab: 'workers', group: 'Commands workers may run', label: 'Never allowed', summary: 'Checked before anything else.', control: 'list', mono: true, placeholder: 'Bash(rm -rf *)' }),

  // ---- CI & merging
  C({ key: 'ci.mode', tab: 'ci', group: 'Checks', label: 'What counts as CI', summary: "GitHub Actions, or a local check when Actions can't run (billing, no workflow).", control: 'select',
    options: [{ value: 'github', label: 'GitHub Actions only' }, { value: 'github-or-local', label: 'GitHub, or local when blocked' }] }),
  C({ key: 'ci.local_check_command', tab: 'ci', group: 'Checks', label: 'Local check', summary: "Run in the item's worktree when local checks are used.", control: 'text', mono: true, placeholder: 'npm run build' }),
  C({ key: 'ci.flaky_checks', tab: 'ci', group: 'Checks', label: 'Known flaky checks', summary: 'A red run whose log names one of these is re-run once before a session is asked to fix it.', control: 'list', mono: true, placeholder: 'atlas_layout_check',
    detail: ['A check\'s name or a message. The failed jobs are re-run once for that head; a second red is a real red.'] }),
  C({ key: 'ci.start_timeout_min', tab: 'ci', group: 'Checks', label: 'A run must start within', summary: 'Longer and CI counts as blocked.', control: 'number', unit: 'min', min: 0.01 }),
  C({ key: 'ci.timeout_min', tab: 'ci', group: 'Checks', label: 'A run may take', summary: 'Longer counts as ci_timeout.', control: 'number', unit: 'min', min: 0.01 }),
  C({ key: 'ci.require_green_base', tab: 'ci', group: 'Merging', label: 'Only merge onto a green base', summary: "Refuse to merge while the base branch's own latest run is red.", control: 'toggle',
    detail: ['Needs a push-event run of the CI workflow on the base; a repository whose workflow only runs on pull requests gives it no signal (every red it sees is stale and ignored).'] }),
  C({ key: 'ci.draft_while_held', tab: 'ci', group: 'Merging', label: 'Held pull requests are drafts', summary: 'CI runs once, on the branch that will merge, after you release the hold.', control: 'toggle',
    detail: ['A held item\'s pull request (a review hold or skip_merge) is opened as a draft and marked ready only after the hold is released and the branch is synced. Pair it with CI that skips drafts (if: ${{ !github.event.pull_request.draft }} with types: [opened, synchronize, reopened, ready_for_review]).'] }),
  C({ key: 'epics.auto_submit', tab: 'ci', group: 'Merging', label: "Open an epic's PR when its last child merges", summary: 'Off: you open it from the epic.', control: 'toggle' }),
  C({ key: 'epics.conflict_budget_usd', tab: 'ci', group: 'Merging', label: "Resolve an epic's merge conflict", summary: "When merging the base into an epic's branch conflicts, a one-shot session on the epic's implementer resolves it, up to this much. 0: block for a person instead.", control: 'number', unit: '$', min: 0,
    detail: ['An epic has no session of its own, so without this a conflict on its integration branch always needed a person at a terminal.', 'The session merges and commits in the epic\'s merge worktree; it never pushes. planestro checks the merge (finished, clean, contains the base and the branch as GitHub has it) and pushes it. Otherwise the worktree goes back to where it was and the epic blocks as sync_conflict, with the session\'s attempt named in the Activity log.', 'The orchestrator can retry a blocked one with resolve_epic_conflict and a hint.'] }),
  C({ key: 'review.max_file_bytes', tab: 'ci', group: 'Review', label: 'Largest changed file', summary: 'A bigger file stops the item as asset_too_large before a pull request exists.', control: 'number', unit: 'MB', per: 1_000_000, min: 0.001 }),
  C({ key: 'review.max_file_bytes_by_ext', tab: 'ci', group: 'Review', label: 'Largest file, by extension', summary: "Limits that replace the one above for kinds of file that are legitimately big (a game's music).", control: 'record', unit: 'MB', per: 1_000_000, min: 0.001, placeholder: '.ogg' }),
  C({ key: 'review.image_scale', tab: 'ci', group: 'Review', label: 'Also show images at', summary: 'Review thumbnails at this integer scale too, nearest-neighbour (pixel art).', control: 'number', unit: '×', min: 1 }),
  C({ key: 'review.nudge_after_min', tab: 'ci', group: 'Review', label: 'Remind about an unread review after', summary: 'Wakes the orchestrator once.', control: 'number', unit: 'min', min: 1 }),

  // ---- Notifications
  C({ key: 'notifications.on_merge', tab: 'notifications', group: 'Commands', label: 'When a PR merges', summary: 'Any shell command, run in the code repository.', control: 'text', mono: true, placeholder: 'say "PR merged"' }),
  C({ key: 'notifications.on_usage_pause', tab: 'notifications', group: 'Commands', label: 'When the usage guard pauses', summary: 'Run when automation pauses before a usage limit.', control: 'text', mono: true, placeholder: 'say "planestro paused for usage"',
    detail: ["On a Mac, osascript -e 'display notification \"…\" with title \"planestro\"' shows a notification (under Script Editor's icon)."] }),

  // ---- This machine
  L({ key: 'code_repo_path', group: 'Paths', label: 'Code repository', summary: 'Where the repository is on this computer, if not where planestro.yml says.', control: 'text', mono: true, restart: true }),
  L({ key: 'worktrees_root', group: 'Paths', label: 'Worktrees folder', summary: 'Where worktrees go on this computer.', control: 'text', mono: true, restart: true }),
  L({ key: 'claude_bin', group: 'Programs', label: 'Claude Code', summary: 'Which claude the sessions run. Empty: the newer of the one on PATH and the one the SDK bundles.', control: 'text', mono: true, placeholder: 'claude (on PATH)', restart: true,
    detail: ['A path uses that executable; bundled forces the SDK\'s own. A new model can need a newer CLI; startup logs which one is used.'] }),
  L({ key: 'codex_bin', group: 'Programs', label: 'Codex', summary: 'Only used by models with runner codex.', control: 'text', mono: true, placeholder: 'codex (on PATH)', restart: true }),
  L({ key: 'anthropic_api_key', group: 'Access', label: 'Anthropic API key', summary: 'Bills sessions to your API account instead of your Claude plan. With a key, the dollar budgets are real money.', control: 'secret', placeholder: 'sk-ant-…', restart: true,
    detail: ['Sessions then bill the API under Anthropic\'s Commercial Terms. ANTHROPIC_API_KEY in the environment planestro starts in does the same. Stored only in planestro.local.yml, which is gitignored; the page never shows it back. Restart planestro after changing it.'] }),
  L({ key: 'allowed_hosts', group: 'Access', label: 'Reachable as', summary: 'Extra names for this machine, e.g. a Tailscale name for your phone.', control: 'list', mono: true, placeholder: 'macbook.tailnet.ts.net', restart: true,
    detail: ['The server answers only requests addressed to localhost, 127.0.0.1, the host it is bound to and these; anything else, and any request from another website, gets a 403.'] }),
  L({ key: 'mcp_servers', group: 'Access', label: 'MCP servers', summary: 'Services a model may name in its MCP list, with their keys. Edit planestro.local.yml by hand.', control: 'readonly',
    detail: ['A stdio server (command, args, env) or an HTTP one (url, headers). Read-only here because the entries carry API keys, which the page never shows.'] }),
  L({ key: 'engine.mode', group: 'Engine', label: 'Engine mode on this machine', summary: 'Overrides Project → Live or dry-run here only.', control: 'select', restart: true,
    options: [{ value: 'dry-run', label: 'Dry-run' }, { value: 'live', label: 'Live' }] }),

  // ---- Data & releases
  C({ key: 'git.auto_commit', tab: 'data', group: 'Storage', label: 'Commit every change', summary: 'With messages like "HH-12: approve plan".', control: 'toggle' }),
  C({ key: 'git.auto_push', tab: 'data', group: 'Storage', label: 'Push at checkpoints', summary: 'If the data folder has a remote.', control: 'toggle' }),
  C({ key: 'git.checkpoint_interval_min', tab: 'data', group: 'Storage', label: 'Checkpoint every', summary: 'Costs and timestamps are saved this often instead of per change.', control: 'number', unit: 'min', min: 0.01, restart: true }),
  C({ key: 'attachments.managed_max_bytes', tab: 'data', group: 'Storage', label: 'Largest copied attachment', summary: 'Bigger attachments are referenced where they are instead of copied into the data folder.', control: 'number', unit: 'MB', per: 1_000_000, min: 0.001 }),
  C({ key: 'releases.sections', tab: 'data', group: 'Releases', label: 'Release sections', summary: 'The headings a release has, in order.', control: 'sections',
    detail: ['A section can have a character limit to count toward (a store field\'s), start each new release with the previous release\'s text (store copy that rarely changes), and a one-line hint under its heading.'] }),
];

/** Schema keys the page deliberately leaves out: stamps, runtime state and records written by other controls. */
export const NOT_USER_FACING: Record<SettingFile, readonly string[]> = {
  config: ['schema_version', 'tool_version'],
  // engine.paused is the header's PAUSE AUTOMATION lever; the rest is what the usage guard recorded; model_unavailable is written by the model cards' Mark unavailable.
  local: ['engine.paused', 'engine.paused_by', 'engine.usage_guard', 'engine.usage_guard_last', 'model_unavailable'],
};

export function settingDef(file: SettingFile, key: string): SettingDef | undefined { return SETTINGS.find((s) => s.file === file && s.key === key); }

/** The zod node at a dotted key, through defaults and optionals. */
function schemaAt(root: unknown, key: string): any {
  let cur: any = root;
  for (const part of key.split('.')) {
    cur = unwrap(cur);
    cur = cur?.shape?.[part];
    if (!cur) return undefined;
  }
  return cur;
}
function unwrap(s: any): any { for (let i = 0; i < 6 && s && !s.shape && (s.def?.type === 'default' || s.def?.type === 'optional' || s.def?.type === 'prefault'); i++) s = s.def.innerType; return s; }

/**
 * What planestro uses when the key is not set: `{ value }` from the schema's default, `{ none: true }`
 * for an optional key without one, or undefined for a required key (it has no default to differ from).
 */
export function settingDefault(file: SettingFile, key: string): { value: unknown } | { none: true } | undefined {
  const node = schemaAt(file === 'config' ? Config : LocalConfig, key);
  if (!node) return undefined;
  let s: any = node;
  for (let i = 0; i < 6 && s; i++) {
    if (s.def?.type === 'default') return { value: typeof s.def.defaultValue === 'function' ? s.def.defaultValue() : s.def.defaultValue };
    if (s.def?.type === 'optional') return { none: true };
    s = s.def?.innerType;
  }
  // Inside a defaulted parent object (worktrees: … .default({...})), the parent's default names it.
  const parts = key.split('.');
  if (parts.length > 1) { const parent = settingDefault(file, parts.slice(0, -1).join('.')); if (parent && 'value' in parent && parent.value && typeof parent.value === 'object') return { value: (parent.value as Record<string, unknown>)[parts.at(-1)!] }; }
  return undefined;
}

export function getPath(obj: unknown, key: string): unknown {
  let cur: any = obj;
  for (const p of key.split('.')) { if (cur === null || typeof cur !== 'object') return undefined; cur = cur[p]; }
  return cur;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Whether the current value differs from what planestro would use unset (never for required keys or the whole-list editors). */
export function settingChanged(def: SettingDef, value: unknown): boolean {
  if (def.control === 'models' || def.control === 'categories' || def.control === 'readonly' || def.control === 'secret') return false;
  const d = settingDefault(def.file, def.key);
  if (!d) return false;
  if ('none' in d) return value !== undefined && value !== '' && !(Array.isArray(value) && !value.length);
  if (value === undefined) return false;
  return !same(value, d.value);
}

/** A number as the page shows it: `per` scales it, and float noise (0.85 / 0.01) is rounded away. */
export function shownNumber(def: Pick<SettingDef, 'per'>, stored: number): number { return Number((stored / (def.per ?? 1)).toPrecision(12)); }
export function storedNumber(def: Pick<SettingDef, 'per'>, shown: number): number { return Number((shown * (def.per ?? 1)).toPrecision(12)); }

/**
 * An allow rule that "Always allow" saved from a single command rather than a pattern: no wildcard,
 * or a whole pipeline with redirections. Such a rule matches that exact command and nothing else,
 * and usually means the list is collecting noise.
 */
export function looksOneOff(rule: string): boolean {
  const m = /^Bash\((.*)\)$/s.exec(rule.trim());
  if (!m) return false;
  const cmd = m[1];
  return cmd.length > 80 || /&&|\|\||;|\s\|\s|2>&1|\$\(/.test(cmd) || (!cmd.includes('*') && cmd.split(/\s+/).length > 3);
}

/** Who pays for the dollars planestro counts: a Claude plan's usage limits, or an API account. */
export type BillingMode = 'subscription' | 'api_key';
export function billingMode(localKey: string | undefined, envKey: string | undefined): BillingMode { return localKey?.trim() || envKey?.trim() ? 'api_key' : 'subscription'; }
/** The short hint beside a dollar figure. */
export function dollarHint(billing: BillingMode | undefined): string { return billing === 'api_key' ? 'billed to your API account' : 'API-price estimate, not a charge'; }
