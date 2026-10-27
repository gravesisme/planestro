/**
 * The settings registry (issue #83): every user-facing key of planestro.yml and planestro.local.yml,
 * with where it lives on the Settings page, what it is called there, a one-line summary, the long
 * explanation ("Learn more", from docs/configuration.md) and how it is edited. The page renders
 * from this list and the server accepts writes only to the keys it names as editable, so a
 * setting cannot ship without its explanation (docs.test.ts checks it against the schema).
 * Defaults are never written here: they are read from the zod schema (`settingDefault`, in settings.ts,
 * which re-exports this file: this one stays free of zod for the web's view entry, #408).
 */

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
    intro: 'How you hear about merges, pauses and anything that needs you: desktop notifications from this browser, and commands planestro runs on those events.' },
  { id: 'access', name: 'Access', hint: 'paired devices, MCP servers', file: 'planestro.local.yml (not committed)',
    intro: 'Who and what may reach planestro on this machine: a phone or laptop on your network (pair it here), and the MCP servers models may use, with their keys.' },
  { id: 'machine', name: 'This machine', hint: 'paths, programs, updates', file: 'planestro.local.yml (not committed)',
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
export type SettingControl = 'number' | 'toggle' | 'text' | 'select' | 'model' | 'list' | 'record' | 'commands' | 'mcp' | 'categories' | 'models' | 'sections' | 'devices';
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
  /** Its value is run, or decides what runs (a command, a program, an allow rule): only this machine may change it. */
  runs?: boolean;
  /** Other schema keys this row's control writes (the categories editor sets defaults.category). */
  covers?: string[];
}

/** Controls whose value the generic write endpoints accept; the others have their own routes or none. */
export const WRITABLE_CONTROLS: readonly SettingControl[] = ['number', 'toggle', 'text', 'select', 'model', 'list', 'record', 'commands', 'sections'];

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
  C({ key: 'issues.import_label', tab: 'project', group: 'Repository', label: 'Import issues labelled', summary: 'Import issues, with none picked, files every open issue of the GitHub repository with this label as an item.', control: 'text', mono: true, placeholder: 'none',
    detail: ['Import issues (the board, or `planestro import issues`) files each issue as an unsubmitted item that remembers it: importing it again files nothing. Pick issues one by one, or import every open one with this label.', 'Its pull request says "Closes #N", closing the issue when it merges, only if you ask for that at import or on the item.'] }),
  C({ key: 'categories', tab: 'project', group: 'Board', label: 'Categories', summary: 'The list items choose from. Renaming or removing one moves its items for you.', control: 'categories', covers: ['defaults.category', 'category_colors'],
    detail: ['The default category is the one new items start in (defaults.category). A category that still has items can only be removed by choosing where they go.'] }),
  C({ key: 'engine.mode', tab: 'project', group: 'Engine', label: 'Live or dry-run', summary: 'Dry-run logs "Would …" for every git, GitHub and session step instead of doing it.', control: 'select', restart: true,
    options: [{ value: 'dry-run', label: 'Dry-run (log what would happen)' }, { value: 'live', label: 'Live' }],
    detail: ['Watch a dry run against your repository before going live. This machine can override it (This machine → Engine mode). Takes effect the next time planestro starts.'] }),
  C({ key: 'operator_mcp.allow_writes', tab: 'project', group: 'Your own MCP clients', label: 'May file and edit items', summary: "The backlog's MCP endpoint (/mcp) also offers create_item, which files to Not yet submitted for you to submit, edit_item (title, priority, category, release, epic, dependencies, Description, Notes) and mark_note. Off, it cannot change anything.", control: 'toggle',
    detail: ['For your own Claude Code or Codex sessions registered with the endpoint. A follow-up filed from there lands in Not yet submitted; it cannot submit, approve a plan, merge or discard.', "planestro's workers and orchestrator never reach this endpoint, with this on or off."] }),
  C({ key: 'operator_mcp.allow_actions', tab: 'project', group: 'Your own MCP clients', label: 'May act on items', summary: 'The endpoint also offers the actions a supervising session needs: unblock, message, answer a question or decision, deny a permission request, sync with base, re-run CI, file a feedback note as an issue. Separate from filing items.', control: 'toggle',
    detail: ['Each action goes through the same engine path as the board, and its Activity line says [operator], not [user]. Decision options that file or submit items stay on the board; plan approval and discards need "May make decisions on items", and merges are always planestro\'s.'] }),
  C({ key: 'operator_mcp.allow_decisions', tab: 'project', group: 'Your own MCP clients', label: 'May make decisions on items', summary: 'The endpoint also offers approve or send back a plan, discard, and close as done, each as the board does it and recorded as [operator]. Approving an epic-shaped plan as one item and deleting a remote branch stay on the board.', control: 'toggle' }),
  C({ key: 'operator_mcp.allow_permissions', tab: 'project', group: 'Your own MCP clients', label: 'May allow a permission request once', summary: 'With acting on items on, decide_permission may also allow a parked permission request once. Off, it may only deny one. It never adds an allow rule.', control: 'toggle' }),

  // ---- Models
  C({ key: 'models', tab: 'models', group: 'Models', label: 'Models', summary: 'The models items can use, what each runs on, and which one takes over while it is out of usage.', control: 'models',
    detail: [
      'A claude model plans and implements; a codex model implements only. A model can hold its pull requests for your review (art is reviewed by eye), give its sessions MCP servers (a sound or 3D service, with keys in planestro.local.yml), and have planestro commit for it when its sandbox cannot write git\'s files.',
      'A fallback is another model on the same runner. An item that allows fallback runs on it while this model is out of usage, and the Claude SDK also uses it when this model is overloaded. Chains are followed (a → b → c).',
      'An outage is noticed on the first failed turn and remembered until the provider\'s reset; Mark unavailable records one you already know about, so no turn is spent discovering it.',
    ] }),
  C({ key: 'defaults.planner', tab: 'models', group: 'Defaults for new items', label: 'Default planner', summary: 'Writes the plan for a new item. Requires a model with planning capability (Claude or Codex app-server).', control: 'model', planners: true }),
  C({ key: 'defaults.implementer', tab: 'models', group: 'Defaults for new items', label: 'Default implementer', summary: 'Does the work once the plan is approved.', control: 'model' }),
  C({ key: 'defaults.allow_model_fallback', tab: 'models', group: 'Defaults for new items', label: 'Allow fallback model', summary: "New items may switch to their model's fallback while it is out of usage. Epic children follow the epic.", control: 'toggle',
    detail: ['When a turn fails because its model is out of usage, planestro records the model as unavailable until the reset the provider reported, and runs the same turn again on the fallback in the same conversation. An item without this ticked blocks as usage_exhausted instead.'] }),

  // ---- Budgets & limits
  C({ key: 'budget_usd_per_item', tab: 'budgets', group: 'Per item', label: 'Dollar budget', summary: 'How much work one item may do across all of its Claude turns. It warns at 80% and stops at the cap.', control: 'number', unit: '$', min: 0.01,
    detail: ['Each turn starts with what remains. An item can carry its own budget on its page, which replaces this one for it; when an item stops for money, the orchestrator sends you a card that raises it in one tap ("+$15 and resume").', 'A resumed session reloads its whole conversation first. planestro knows what that costs (the item page shows it) and never starts a resume the item cannot pay for: it starts a fresh conversation with a brief instead, or stops before anything is spent. A raise on a card always covers the reload and the work.'] }),
  C({ key: 'budget_usd_fresh_above', tab: 'budgets', group: 'Per item', label: 'Start fresh above', summary: 'When reloading an item\'s conversation would cost more than this, a fix starts a fresh conversation with a brief instead. 0 turns this off.', control: 'number', unit: '$', min: 0,
    detail: ['A long conversation is sent again in full every time it is resumed. For a turn whose instruction stands on its own (a CI fix, a rebase conflict, a reminder to commit, an unblock with a message) planestro compares that cost with this threshold and, above it, gives the task to a new conversation: the item, its plan, what is committed and what is not, and the task. The new conversation becomes the item\'s; the old one is named in the Activity log.', 'Dollar-based automatic rotation applies only to self-contained work instructions. Explicit provider handoffs can also restart planning or carry a question together with its persisted answer.'] }),
  C({ key: 'fresh_above_context_tokens', tab: 'budgets', group: 'Per item', label: 'Start fresh above (context)', summary: 'When an item\'s conversation holds more than this many tokens, a fix starts a fresh conversation with a brief, whatever the reload costs. 0 turns this off.', control: 'number', unit: 'tokens', min: 0,
    detail: ['A resumed turn reads its whole conversation again on every call it makes, so a long window costs on each step even while the cache is warm (#464: one item ran 88 turns in a single conversation up to 875k tokens). The same turns as the price threshold above go to a fresh conversation, which starts at a fraction of that size; planning and answers to the session\'s own questions always resume.'] }),
  C({ key: 'budget_usd_per_plan_turn', tab: 'budgets', group: 'Per item', label: 'Per planning turn', summary: 'How much one planning turn may do before the planner is asked for the plan it has.', control: 'number', unit: '$', min: 0.01,
    detail: ['Past it the turn ends and the planner is asked once, cheaply, for the plan it has (one planner spent $97 researching without handing one in). A second miss blocks as no_plan.'] }),
  C({ key: 'budget_turns_per_item', tab: 'budgets', group: 'Per item', label: 'Turns (Codex)', summary: 'Worker turns per item for runners that report tokens instead of dollars.', control: 'number', unit: 'turns', min: 1,
    detail: ['Blocks as turn_budget. An item\'s own budget_turns replaces it.'] }),
  C({ key: 'budget_tokens_per_plan_turn', tab: 'budgets', group: 'Per item', label: 'Tokens per planning turn', summary: 'Observed uncached input plus output. A capped planner gets one bounded hand-in turn.', control: 'number', unit: 'tokens', min: 1 }),
  C({ key: 'orchestrator.budget_tokens_per_wake', tab: 'orchestrator', group: 'Model', label: 'Tokens per wake', summary: 'Observed token limit for a resumed Codex wake.', control: 'number', unit: 'tokens', min: 1 }),
  C({ key: 'orchestrator.budget_tokens_per_fresh_wake', tab: 'orchestrator', group: 'Model', label: 'Tokens per fresh wake', summary: 'Higher allowance for new conversations, including provider switches.', control: 'number', unit: 'tokens', min: 1 }),
  C({ key: 'budget_tokens_per_item', tab: 'budgets', group: 'Per item', label: 'Tokens (Codex)', summary: 'Uncached tokens per item for those runners.', control: 'number', unit: 'tokens', min: 1,
    detail: ['Blocks as token_budget. A live art turn measured 20–35k; the default leaves room for a dozen revisions. An item\'s own budget_tokens replaces it.'] }),
  C({ key: 'concurrency.max_sessions', tab: 'budgets', group: 'Running at once', label: 'Items worked on at once', summary: 'A slot is taken only while something is actually running for an item: a turn, an engine step, a git operation.', control: 'number', min: 1,
    detail: ['Never by an epic, and never by an item that is only waiting on you or on CI.'] }),
  C({ key: 'concurrency.max_local_jobs', tab: 'budgets', group: 'Running at once', label: 'Local jobs at once', summary: 'Setup hooks and local check commands running at the same time.', control: 'number', min: 1 }),
  C({ key: 'concurrency.runner_limits', tab: 'budgets', group: 'Running at once', label: 'Per-runner limits', summary: 'Turns at once per runner, for runners with their own rate limits. Unlisted runners are not limited here.', control: 'record', unit: 'turns', min: 1, placeholder: 'codex' }),
  C({ key: 'concurrency.stall_after_min', tab: 'budgets', group: 'Running at once', label: 'Stalled after', summary: 'An active item nothing has touched for this long is carried on once, then blocked as stalled. 0 turns this off.', control: 'number', unit: 'min', min: 0,
    detail: ['An item planning or in progress that nothing has driven (no turn, no step, no operation, not waiting on anyone) is stalled. planestro carries it on once, the way an unblock does; a second stall within the hour blocks it as stalled.'] }),
  C({ key: 'concurrency.turn_quiet_min', tab: 'budgets', group: 'Running at once', label: 'Stop a quiet turn after', summary: 'A running turn that has shown no output for this long is stopped and blocked as turn_quiet. 0 turns this off.', control: 'number', unit: 'min', min: 0,
    detail: ['A session can stay open with nothing happening: a dev server it started in the background, or a command that hangs. It holds its session slot until something stops it. Set this above your longest silent step (a full test suite, an asset import).', 'The block goes to the orchestrator first, like any other; the conversation resumes from where it stopped.'] }),
  C({ key: 'concurrency.transient_retry_after_s', tab: 'budgets', group: 'Running at once', label: 'Retry a failed turn after', summary: 'A turn that failed on a network error, an overload or a rate limit before it did anything is retried once after this long. 0 turns this off.', control: 'number', unit: 's', min: 0,
    detail: ['Only a turn that produced nothing (no message, no tool call, no file change, no report) is retried, and only once: a second failure, a login, a usage limit or a token cap stops as before. Orchestrator wakes are retried the same way.'] }),
  C({ key: 'concurrency.guard.ci_window', tab: 'budgets', group: 'Concurrency guard', label: 'CI results looked at', summary: 'How many of the latest CI results planestro saw decide whether raising concurrency is safe.', control: 'number', min: 1,
    detail: ['The concurrency control in the status popover recommends a raise, one step at a time, only while none of these was a check killed at its timeout (rc=137, exit code 137, or a job past its time limit). Above the recommendation it asks you to confirm.'] }),
  C({ key: 'concurrency.guard.max_load_per_cpu', tab: 'budgets', group: 'Concurrency guard', label: 'Load per core', summary: 'A raise is not recommended while the 5-minute load average per CPU core is at or over this.', control: 'number', min: 0 }),
  C({ key: 'concurrency.guard.settle_min', tab: 'budgets', group: 'Concurrency guard', label: 'Settle after a raise', summary: 'After a raise, the next one is recommended only once this long has passed.', control: 'number', unit: 'min', min: 0 }),
  C({ key: 'concurrency.guard.auto_step_down', tab: 'budgets', group: 'Concurrency guard', label: 'Step down by itself', summary: 'After a raise, a check killed at its timeout or a sustained load spike rolls the raise back and says so.', control: 'toggle',
    detail: ['Off by default. Checked on each pass of the engine: only the last change, and only a raise, is rolled back, to the values before it, journaled as the engine with the reason. A step-down is never stepped down again.'] }),
  C({ key: 'concurrency.guard.step_down_load_per_cpu', tab: 'budgets', group: 'Concurrency guard', label: 'Step down at load per core', summary: 'The 15-minute load average per core that counts as a sustained spike for stepping down.', control: 'number', min: 0 }),
  C({ key: 'usage_guard.enabled', tab: 'budgets', group: 'Usage guard', label: 'Pause before the plan limit', summary: "Watch supported subscription usage windows and pause that provider before one runs out.", control: 'toggle',
    detail: ['A Claude subscription meters usage in rolling windows (five hours, seven days, per-model weekly windows). Every Claude turn streams the account\'s current reading, and planestro stops itself before the limit rather than at it.', 'A provider guard stops new turns on that provider. Other providers and deterministic CI/merge operations continue unless globally paused. It trips once per window crossing.'] }),
  C({ key: 'usage_guard.threshold', tab: 'budgets', group: 'Usage guard', label: 'Pause at', summary: 'How full a window may get. Turns already running keep spending after the pause, so leave headroom.', control: 'number', unit: '%', per: 0.01, min: 1 }),
  C({ key: 'usage_guard.on_warning', tab: 'budgets', group: 'Usage guard', label: 'Also pause on a warning', summary: 'Pause when Claude reports a usage warning, whatever the percentage.', control: 'toggle' }),
  C({ key: 'usage_guard.auto_resume', tab: 'budgets', group: 'Usage guard', label: 'Resume by itself', summary: 'Resume a minute after the window resets. Off: a guard pause waits for you.', control: 'toggle',
    detail: ['Off by default: resuming on its own restarts spending while nobody is watching. Retry provider overrides only that provider. Global user and disk pauses are never released by a provider reset. With it on, an item blocked usage_exhausted is also unblocked once its model\'s outage (Settings → Models) ends.'] }),
  C({ key: 'disk_guard.enabled', tab: 'budgets', group: 'Disk guard', label: 'Pause before the disk fills', summary: 'Read free space on the repo and worktrees volume once a minute, and pause automation when it runs low, instead of every worker failing on a full disk.', control: 'toggle' }),
  C({ key: 'disk_guard.min_free_gib', tab: 'budgets', group: 'Disk guard', label: 'Pause below', summary: 'Free space under which nothing new starts. Running steps finish.', control: 'number', unit: 'GiB', min: 1 }),
  C({ key: 'disk_guard.resume_free_gib', tab: 'budgets', group: 'Disk guard', label: 'Resume at', summary: 'Free space at which it resumes by itself: a margin above the pause, so it does not flap.', control: 'number', unit: 'GiB', min: 1 }),

  // ---- Orchestrator
  C({ key: 'orchestrator.model', tab: 'orchestrator', group: 'Model', label: 'Model', summary: 'The model that makes judgment calls. Applies to the next wake. No restart required.', control: 'model', planners: true }),
  C({ key: 'orchestrator.allow_model_fallback', tab: 'orchestrator', group: 'Model', label: 'Allow fallback', summary: "While the orchestrator's model is out of usage, wake on its fallback instead.", control: 'toggle' }),
  C({ key: 'orchestrator.rotate_after_wakes', tab: 'orchestrator', group: 'Model', label: 'Fresh conversation every', summary: 'Its files are its memory, so a fresh conversation loses nothing and costs less per wake.', control: 'number', unit: 'wakes', min: 1 }),
  C({ key: 'orchestrator.rotate_after_days', tab: 'orchestrator', group: 'Model', label: '…or every', summary: 'Whichever comes first.', control: 'number', unit: 'days', min: 0.01 }),
  C({ key: 'efficiency_audit.enabled', tab: 'orchestrator', group: 'Daily efficiency audit', label: 'One fix a day', summary: "Once a day, one wake on the orchestrator's model reads a digest of the last days' usage and files one planestro feedback note: the biggest waste, its evidence and one mechanical change.", control: 'toggle',
    detail: ['The digest is built in code from what planestro records (cost by item and stage, starting context, cache hits, wasted test runs, permission parks); the wake reads it and nothing else. Nothing is changed or filed beyond the note.', 'A day whose biggest waste is still yesterday\'s note, not yet acted on, says so on that note instead of filing it again. A day after one with no turns is skipped.'] }),
  C({ key: 'efficiency_audit.cron', tab: 'orchestrator', group: 'Daily efficiency audit', label: 'When', summary: "A cron expression on this machine's clock; overnight by default, when no turns compete.", control: 'text', mono: true }),
  C({ key: 'efficiency_audit.days', tab: 'orchestrator', group: 'Daily efficiency audit', label: 'Days read', summary: 'How many days, up to yesterday, the digest covers.', control: 'number', unit: 'days', min: 1 }),
  C({ key: 'efficiency_audit.budget_usd', tab: 'orchestrator', group: 'Daily efficiency audit', label: 'At most', summary: 'The hard cap on one audit, for a runner that reports dollars.', control: 'number', unit: '$', min: 0.01 }),
  C({ key: 'efficiency_audit.budget_tokens', tab: 'orchestrator', group: 'Daily efficiency audit', label: 'Or at most', summary: 'The cap for a runner that reports tokens.', control: 'number', unit: 'tokens', min: 1000 }),
  C({ key: 'orchestrator.triage', tab: 'orchestrator', group: 'What it may decide', label: 'Handles stops first', summary: "A block or a worker's question goes to it before you. It fixes what it can and brings you one plain decision card.", control: 'toggle',
    detail: ['It resolves what is within its authority (unblock with an instruction, answer from the brief, retry a transient failure, fix a wrong parent or base and recreate an empty worktree) or turns the stop into one decision card, with its recommendation first.'] }),
  C({ key: 'orchestrator.triage_timeout_min', tab: 'orchestrator', group: 'What it may decide', label: "Then it's yours after", summary: 'An item still in triage after this long comes to you exactly as it stopped.', control: 'number', unit: 'min', min: 0.01,
    detail: ['With the orchestrator off, unavailable or paused, a stop comes to you straight away.'] }),
  C({ key: 'orchestrator.may_approve_plans', tab: 'orchestrator', group: 'What it may decide', label: 'May approve plans', summary: "Only for items that opt in on their page. Never an epic's breakdown or a review hold.", control: 'toggle',
    detail: ['An item opts in with "let the orchestrator approve the plan". The orchestrator then approves the plan, sends it back to the planner with specific fixes, or leaves it to you; once the fix rounds are used it can only approve or leave it to you.'] }),
  C({ key: 'defaults.auto_approve_plan', tab: 'orchestrator', group: 'What it may decide', label: 'New items let it approve their plan', summary: 'New items start with "let the orchestrator approve the plan" ticked, except art models that require your approval or use the legacy exec transport.', control: 'toggle',
    detail: ['Applies to items created from now on: the New item dialog, the orchestrator\'s create_item and an epic\'s children. You can untick it on any item.', 'Art models that require your approval stay unticked. General Codex app-server models can use orchestrator plan review.', 'Only matters while "May approve plans" is on.'] }),
  C({ key: 'orchestrator.max_plan_revisions', tab: 'orchestrator', group: 'What it may decide', label: "Fix rounds before it's yours", summary: 'How often it may send one plan back to the planner.', control: 'number', min: 0 }),
  C({ key: 'feedback.issue_repo', tab: 'orchestrator', group: 'Its notes about planestro', label: 'File notes as issues in', summary: 'Leave it unset to report through GitHub\'s new-issue page with your review. Set it only for a repo you own: planestro then files issues there directly.', control: 'text', mono: true, placeholder: 'owner/repo',
    detail: ['The Console lists its notes under planestro feedback. Unset, each offers "Report to planestro": GitHub\'s new-issue page on planestro\'s repo, prefilled with the note\'s text and the version, where you remove anything private and submit it yourself. Opening it records nothing; "Mark handled" does.', 'Set, "File as issue" opens one issue per note in this repo with the note\'s text, item and project name, after searching the repo for one already filed: an issue with the note\'s hidden marker is linked, and a likely match is offered before anything new is filed. "Mark handled" records issues filed by hand, or none.', 'Not the project\'s repo unless planestro is the project, and never a public tracker you do not own: these notes are model-written and may name your items.', 'When this machine\'s gh login can push to planestro\'s own repo (you maintain planestro), an empty field offers it in one click; no one else is offered it.'] }),
  C({ key: 'orchestrator.may_decide_permissions', tab: 'orchestrator', group: 'What it may decide', label: "May answer workers' permission requests", summary: "It allows ordinary work inside the item's worktree and leaves anything outside it, installs and credentials to you.", control: 'toggle',
    detail: ["Three denials on one item and the rest come to you. planestro's hard rules (no pushes, no pull requests, no protected branches, no force flags) apply before anyone is asked."] }),

  // ---- Workers & permissions
  C({ key: 'hooks.after_worktree_create', runs: true, tab: 'workers', group: 'Worktrees', label: 'Setup commands', summary: 'Run in each new worktree before planning. A failure blocks the item as hook_failed.', control: 'list', mono: true, placeholder: 'npm ci',
    detail: ['Install dependencies, import assets. Not re-run when an item that went to the icebox is queued again and reuses its worktree.'] }),
  C({ key: 'worktrees.byproducts', tab: 'workers', group: 'Worktrees', label: 'Files that are never work', summary: "Untracked files your tools regenerate (Godot's *.import). Clean-tree checks ignore them; cleanup moves them aside.", control: 'list', mono: true, placeholder: '*.import',
    detail: ['No clean-tree check counts them (after a turn, before a sync, finish from worktree, recreate, close as done), engine commits leave them out, and cleanup moves them to .displaced/ before removing the worktree.', 'A pattern without / matches the file name at any depth; one with / matches the path from the worktree root.'] }),
  C({ key: 'worktrees.keep_on_remove', tab: 'workers', group: 'Worktrees', label: 'Keep when a worktree is removed', summary: "Folders whose files are moved to .displaced/ instead of deleted: a worker's raw sources or scratch output.", control: 'list', mono: true, placeholder: 'tmp',
    detail: ['Paths inside a worktree, relative (tmp). Their files go to <worktrees folder>/.displaced/<item>-<time>/ whether git tracks, ignores or does not know them; the Activity log says where.'] }),
  C({ key: 'worktrees.copy_to_checkout', tab: 'workers', group: 'Worktrees', label: 'Copy into the main checkout on merge', summary: "Folders whose files planestro copies into the same folder of your main checkout when an item merges: a sandboxed worker's output it cannot put there itself.", control: 'list', mono: true, placeholder: 'tmp',
    detail: ['Paths inside a worktree, relative (tmp). Only files git does not track are copied, and never over a file that is already there with other content: that one stays only in .displaced/, and the Activity log names it.', 'They are kept on removal too, as Keep when a worktree is removed does. A copy that fails stops the cleanup (cleanup_dirty); nothing is removed.', 'Workers and the orchestrator are told, so a brief never asks a sandboxed worker to copy there itself.'] }),
  C({ key: 'worktrees.generated', runs: true, tab: 'workers', group: 'Worktrees', label: 'Generated files', summary: 'Tracked files a command rebuilds. A sync that conflicts only in these takes the base\'s copy and runs the command, with no session turn.', control: 'commands', mono: true, placeholder: 'resources/i18n/messages.pot',
    detail: ['Each row is a file pattern and the command that regenerates it, run in the worktree (godot --headless --script tools/i18n_export_pot.gd). A pattern without / matches the file name at any depth; one with / matches the path from the worktree root.', 'When a rebase or merge conflicts only in files listed here, planestro takes the base\'s copy, finishes the sync, runs each command once and commits the regenerated files as "<id>: regenerate …". The Activity log says so.', 'If any other file conflicts, a command fails, or it changes a file not listed here, the sync is undone and the conflict goes to the session as before.'] }),
  C({ key: 'worktrees.root', tab: 'workers', group: 'Worktrees', label: 'Worktrees folder', summary: 'Where item worktrees go, relative to the code repository.', control: 'text', mono: true,
    detail: ['Each machine can override it with This machine → Worktrees folder.'] }),
  C({ key: 'worktrees.branch_pattern', tab: 'workers', group: 'Worktrees', label: 'Branch name', summary: 'The branch a worker gets. {{prefix_lower}}, {{number}} and {{slug}} are filled in.', control: 'text', mono: true,
    detail: ['Changing it affects new worktrees only; existing items keep the branch they have.'] }),
  C({ key: 'worktrees.dir_pattern', tab: 'workers', group: 'Worktrees', label: 'Worktree folder name', summary: 'The folder each worktree gets, with the same placeholders.', control: 'text', mono: true }),
  C({ key: 'permissions.allow', runs: true, tab: 'workers', group: 'Commands workers may run', label: 'Always allowed', summary: '"Always allow" on a request adds here. Entries that look like one-off commands are marked.', control: 'list', mono: true, placeholder: 'Bash(npm test*)',
    detail: [
      'Extra allow rules on top of the built-in ones. Rules match each part of a chained or piped command (&&, ||, ;, |), and every part must match. Leading NAME=value assignments and wrappers such as timeout 120 are looked through.',
      'A rule ending in @worktree, such as Bash(npm run *)@worktree, holds only while the command stays in the item\'s worktree: every path it names, and every file it redirects into, is inside the worktree or under /tmp. Loops, assignments and $(…) are read too. Reading, comparing and printing (echo, cat, grep, diff, ls, …) are allowed this way for every project; sed and find are not among them.',
      'That check reads the command\'s text. It catches a wrong path or a stray cd; it does not confine what a script does once it runs.',
      'Pushes, gh pr, protected branches, branch and worktree management, force operations and in-place shell edits (sed -i) are refused in code whatever this list says. Codex workers are governed by their sandbox instead.',
    ] }),
  C({ key: 'permissions.deny', tab: 'workers', group: 'Commands workers may run', label: 'Never allowed', summary: 'Checked before anything else.', control: 'list', mono: true, placeholder: 'Bash(rm -rf *)' }),
  C({ key: 'heavy_runs.enabled', tab: 'workers', group: 'Heavy local runs', label: 'Take turns on heavy runs', summary: "Workers run heavy local commands through planestro's run_heavy: one at a time on this machine, each batch after any CI job on a runner that shares it.", control: 'toggle',
    detail: ['For a machine that is also a self-hosted CI runner: a stress batch started beside another, or under a CI job, makes both slow and flaky. run_heavy waits for the other run and for the CI job, and says in its answer and the Activity log what it waited for and how long.', 'A Bash call matching one of the heavy commands is refused with the way to run it through run_heavy.'] }),
  C({ key: 'heavy_runs.patterns', tab: 'workers', group: 'Heavy local runs', label: 'Heavy commands', summary: 'Command prefixes (or Bash(…) rules) that count as heavy. run_heavy may run them, and Bash may not.', control: 'list', mono: true, placeholder: 'npm run stress' }),
  C({ key: 'heavy_runs.shared_labels', tab: 'workers', group: 'Heavy local runs', label: 'Runner labels on this machine', summary: 'Self-hosted runner labels whose runners share the machine the workers run on.', control: 'list', mono: true, placeholder: 'hh-mac' }),
  C({ key: 'heavy_runs.yield_to_ci', tab: 'workers', group: 'Heavy local runs', label: 'Wait for CI on those runners', summary: 'Off: heavy runs only take turns with each other.', control: 'toggle' }),
  C({ key: 'heavy_runs.poll_s', tab: 'workers', group: 'Heavy local runs', label: 'Check the runners every', summary: 'How often a waiting run reads the runners again.', control: 'number', unit: 's', min: 1 }),
  C({ key: 'heavy_runs.timeout_min', tab: 'workers', group: 'Heavy local runs', label: 'Stop a batch after', summary: 'How long one batch may run.', control: 'number', unit: 'min', min: 1 }),
  C({ key: 'test_runs.patterns', tab: 'workers', group: 'Test runs', label: 'Test commands', summary: "Command prefixes that run tests. Their runs are recorded for each item's efficiency report: whole-suite runs, and runs repeated on unchanged code after a green one.", control: 'list', mono: true, placeholder: 'npm test',
    detail: ['Recorded only, never refused: the report says how many such runs an item made, how long they took and what the turns they fell in cost.'] }),
  C({ key: 'test_runs.filters', tab: 'workers', group: 'Test runs', label: 'Narrowing flags', summary: 'Flags that run part of the suite. A test command with none of them and no names after it is a whole-suite run.', control: 'list', mono: true, placeholder: '--shard' }),
  C({ key: 'test_runs.repeat_flags', tab: 'workers', group: 'Test runs', label: 'Load-pass flags', summary: 'Flags that make a run a repeated load pass, wasted when run again on code unchanged since its green pass.', control: 'list', mono: true, placeholder: '--repeat' }),
  C({ key: 'codex_env_passthrough', tab: 'workers', group: 'Commands workers may run', label: 'Codex environment', summary: "Environment variables a Codex worker's commands may see. Nothing else of planestro's environment reaches them.", control: 'list', mono: true, placeholder: 'HTTPS_PROXY',
    detail: ['A Codex process, exec or app-server, starts with PATH, HOME, USER, SHELL, TMPDIR, LANG and its CODEX_HOME only, so GH_TOKEN, API keys and cloud credentials never reach a command it runs. Name here what the project\'s tools need (a proxy, a toolchain path); a name planestro does not have is skipped.', 'Read at each turn. Codex signs in from its home (codex login), not from OPENAI_API_KEY in planestro\'s environment, unless you list it here.'] }),

  // ---- CI & merging
  C({ key: 'ci.mode', tab: 'ci', group: 'Checks', label: 'What counts as CI', summary: "GitHub Actions, or a local check when Actions can't run (billing, no workflow).", control: 'select',
    options: [{ value: 'github', label: 'GitHub Actions only' }, { value: 'github-or-local', label: 'GitHub, or local when blocked' }] }),
  C({ key: 'ci.local_check_command', runs: true, tab: 'ci', group: 'Checks', label: 'Local check', summary: "Run in the item's worktree when local checks are used.", control: 'text', mono: true, placeholder: 'npm run build' }),
  C({ key: 'ci.flaky_checks', tab: 'ci', group: 'Checks', label: 'Known flaky checks', summary: 'A red run whose log names one of these is re-run once before a session is asked to fix it.', control: 'list', mono: true, placeholder: 'atlas_layout_check',
    detail: ['A check\'s name or a message. The failed jobs are re-run once for that head; a second red is a real red.'] }),
  C({ key: 'ci.infra_patterns', tab: 'ci', group: 'Checks', label: 'Infrastructure failures', summary: "A red run whose failed log matches one of these is the runner's, not the change's: re-run once, with no fix turn.", control: 'list', mono: true, placeholder: 'every check FAIL.*missing \\.out',
    detail: ['Regular expressions, matched line by line. Built in, always on: No space left on device, The runner has received a shutdown signal, lost communication with the server. Not counted as a code failure; the same match on the re-run blocks ci_infra, naming the pattern.'] }),
  C({ key: 'ci.start_timeout_min', tab: 'ci', group: 'Checks', label: 'A run must start within', summary: 'Longer and CI counts as blocked.', control: 'number', unit: 'min', min: 0.01 }),
  C({ key: 'ci.timeout_min', tab: 'ci', group: 'Checks', label: 'A run may take', summary: 'Once it has started; longer counts as ci_timeout. Time queued for a runner is not counted.', control: 'number', unit: 'min', min: 0.01 }),
  C({ key: 'ci.queue_timeout_min', tab: 'ci', group: 'Checks', label: 'A run may wait for a runner', summary: 'Queued with no job started; longer counts as ci_timeout (a queue, not a failure).', control: 'number', unit: 'min', min: 0.01 }),
  C({ key: 'ci.stall_wake_min', tab: 'ci', group: 'Checks', label: 'Wake the orchestrator for a review idle', summary: 'An item in review that nothing has moved for this long (no CI running, no session, no stop) wakes the orchestrator once. 0 turns it off.', control: 'number', unit: 'min', min: 0,
    detail: ['A backstop for a state nobody planned for: HH-383 sat red for 7½ hours after its session reported "no change, re-run it", with nothing coming and no one told.'] }),
  C({ key: 'ci.max_queued_runs', tab: 'ci', group: 'Checks', label: 'Hold new work at a CI queue of', summary: 'While this many runs wait for a runner, no new item starts. 0 turns it off.', control: 'number', unit: 'runs', min: 0,
    detail: ['More parallel items stop paying off once CI is the bottleneck: their runs only queue. Items already in flight carry on; only starts are held.'] }),
  C({ key: 'ci.require_green_base', tab: 'ci', group: 'Merging', label: 'Only merge onto a green base', summary: "Refuse to merge while the base branch's own latest run is red.", control: 'toggle',
    detail: ['Needs a push-event run of the CI workflow on the base; a repository whose workflow only runs on pull requests gives it no signal (every red it sees is stale and ignored).'] }),
  C({ key: 'ci.draft_while_held', tab: 'ci', group: 'Merging', label: 'Held pull requests are drafts', summary: 'CI runs once, on the branch that will merge, after you release the hold.', control: 'toggle',
    detail: ['A pull request held for a person (a review hold, review.hold_into, or your own hold) is opened as a draft and marked ready only after the hold is released and the branch is synced. A hold the orchestrator or a worker puts on waits for a report or a fix, so it holds the merge only: its pull request stays ready and CI runs on every push. Pair it with CI that skips drafts (if: ${{ !github.event.pull_request.draft }} with types: [opened, synchronize, reopened, ready_for_review]).'] }),
  C({ key: 'epics.auto_submit', tab: 'ci', group: 'Merging', label: "Open an epic's PR when its last child merges", summary: 'Off: you open it from the epic.', control: 'toggle' }),
  C({ key: 'review.hold_into', tab: 'ci', group: 'Merging', label: 'Hold pull requests into', summary: 'A pull request into one of these branches opens held for you, whether an item or an epic opened it: for a branch that deploys.', control: 'list', mono: true, placeholder: 'main',
    detail: ['The pull request stays out of the merge queue until you release its hold; its reason says why. CI still runs (a draft while held, if drafts are on).', 'For a branch whose merges go live (a production deploy): the hold is put on when the pull request opens, so nothing depends on anyone noticing it in time.'] }),
  C({ key: 'epics.conflict_budget_usd', tab: 'ci', group: 'Merging', label: "Resolve an epic's merge conflict", summary: "When merging the base into an epic's branch conflicts, a one-shot session on the epic's implementer resolves it, up to this much. 0: block for a person instead.", control: 'number', unit: '$', min: 0,
    detail: ['An epic has no session of its own, so without this a conflict on its integration branch always needed a person at a terminal.', 'The session merges and commits in the epic\'s merge worktree; it never pushes. planestro checks the merge (finished, clean, contains the base and the branch as GitHub has it) and pushes it. Otherwise the worktree goes back to where it was and the epic blocks as sync_conflict, with the session\'s attempt named in the Activity log.', 'The orchestrator can retry a blocked one with resolve_epic_conflict and a hint.'] }),
  C({ key: 'review.max_file_bytes', tab: 'ci', group: 'Review', label: 'Largest changed file', summary: 'A bigger file stops the item as asset_too_large before a pull request exists.', control: 'number', unit: 'MB', per: 1_000_000, min: 0.001 }),
  C({ key: 'review.max_file_bytes_by_ext', tab: 'ci', group: 'Review', label: 'Largest file, by extension', summary: "Limits that replace the one above for kinds of file that are legitimately big (a game's music).", control: 'record', unit: 'MB', per: 1_000_000, min: 0.001, placeholder: '.ogg' }),
  C({ key: 'review.image_scale', tab: 'ci', group: 'Review', label: 'Also show images at', summary: 'Review thumbnails at this integer scale too, nearest-neighbour (pixel art).', control: 'number', unit: '×', min: 1 }),
  C({ key: 'review.nudge_after_min', tab: 'ci', group: 'Review', label: 'Remind about an unread review after', summary: 'Wakes the orchestrator once.', control: 'number', unit: 'min', min: 1 }),

  // ---- Notifications
  C({ key: 'notifications.on_merge', runs: true, tab: 'notifications', group: 'Commands', label: 'When a PR merges', summary: 'Any shell command, run in the code repository.', control: 'text', mono: true, placeholder: 'say "PR merged"' }),
  C({ key: 'notifications.on_needs_you', runs: true, tab: 'notifications', group: 'Commands', label: 'When something needs you', summary: 'Run once per wait: a plan or breakdown ready, a permission request, a worker\'s question, a decision card, a block, a review or hold, a new orchestrator question.', control: 'text', mono: true, placeholder: 'curl -s -d "$PLANESTRO_MESSAGE" -H "Title: $PLANESTRO_TITLE" -H "Click: $PLANESTRO_URL" https://ntfy.sh/<your-topic>',
    detail: ['Besides PLANESTRO_TITLE and PLANESTRO_MESSAGE it gets PLANESTRO_ITEM (the item, when there is one), PLANESTRO_KIND (plan, breakdown, permission, question, review, decision, blocked, hold) and PLANESTRO_URL, an absolute link to it.', 'The example sends a phone alert through ntfy.sh (or your own ntfy server). The link opens planestro only where the server is reachable: your LAN, or a VPN you run.'] }),
  C({ key: 'notifications.base_url', tab: 'notifications', group: 'Commands', label: 'Link address', summary: 'Where PLANESTRO_URL points, e.g. the name your phone reaches this machine by. Unset, the address the server listens on.', control: 'text', mono: true, placeholder: 'http://studio.local:4300' }),
  C({ key: 'notifications.idle_after_min', tab: 'notifications', group: 'Commands', label: 'Hold back while you are here', summary: 'While a planestro tab has been used in this many minutes, a wait is not announced; one you answer meanwhile never is. 0 announces at once.', control: 'number', unit: 'min', min: 0 }),
  C({ key: 'notifications.on_usage_pause', runs: true, tab: 'notifications', group: 'Commands', label: 'When the usage guard pauses', summary: 'Run when automation pauses before a usage limit.', control: 'text', mono: true, placeholder: 'say "planestro paused for usage"',
    detail: ['Every command gets PLANESTRO_TITLE and PLANESTRO_MESSAGE. `planestro notify "$PLANESTRO_TITLE" "$PLANESTRO_MESSAGE"` (from the planestro checkout) shows a desktop notification: osascript on a Mac, under Script Editor\'s icon. For planestro\'s own icon, turn on desktop notifications above in the installed app.'] }),

  // ---- This machine
  L({ key: 'code_repo_path', runs: true, group: 'Paths', label: 'Code repository', summary: 'Where the repository is on this computer, if not where planestro.yml says.', control: 'text', mono: true, restart: true }),
  L({ key: 'worktrees_root', group: 'Paths', label: 'Worktrees folder', summary: 'Where worktrees go on this computer.', control: 'text', mono: true, restart: true }),
  L({ key: 'update.channel', group: 'Updates', label: 'Keep planestro up to date', summary: "With serve --watch: move this machine's planestro checkout to the newest main commit whose CI passed, then restart between turns.", control: 'select',
    options: [{ value: 'off', label: 'Off (update it by hand)' }, { value: 'main-green', label: 'Newest main that passed CI' }],
    detail: ['Only the planestro checkout moves (the folder serve --watch runs from), never your data. It is refused when that checkout has local changes or is not behind origin/main, so a development tree is never touched.', 'Dependencies are reinstalled when the lockfile changed; the restart waits for running turns, as for any update. The Console shows what it is running and what it is waiting for.'] }),
  L({ key: 'update.poll_min', group: 'Updates', label: 'Check every', summary: 'How often to look for a newer commit.', control: 'number', unit: 'min', min: 1 }),
  L({ key: 'update.min_age_hours', group: 'Updates', label: 'Soak time', summary: 'Take a commit only after its CI has been green this long. Give one project a few hours so it trails the other.', control: 'number', unit: 'h', min: 0 }),
  L({ key: 'claude_bin', runs: true, group: 'Programs', label: 'Claude Code', summary: 'Which claude the sessions run. Empty: the newer of the one on PATH and the one the SDK bundles.', control: 'text', mono: true, placeholder: 'claude (on PATH)', restart: true,
    detail: ['A path uses that executable; bundled forces the SDK\'s own. A new model can need a newer CLI; startup logs which one is used.'] }),
  L({ key: 'codex_bin', runs: true, group: 'Programs', label: 'Codex', summary: 'Only used by models with runner codex.', control: 'text', mono: true, placeholder: 'codex (on PATH)', restart: true }),
  // ---- Access (this machine's file too)
  L({ key: 'lan_access', tab: 'access', group: 'Local network', label: 'Local network access', summary: 'A paired phone or laptop on the same network can use planestro while this is on.', control: 'toggle', restart: true,
    detail: ['The server listens on every interface (unless --host says otherwise) so a phone on the same Wi-Fi can open the links in alerts: http://<this machine>.local:<port>. Only the local network is answered: a request from any other address (a port-forward, a public address) gets a 403.', 'A device other than this machine must be paired first (Paired devices, below): without its token every request gets a 401 and a page load goes to /pair.', 'Test the whole chain with the Test button under Notifications → When something needs you, then tap the alert on the phone.'] }),
  L({ key: 'allowed_hosts', tab: 'access', group: 'Local network', label: 'Reachable as', summary: 'Extra names for this machine, e.g. a Tailscale name for your phone.', control: 'list', mono: true, placeholder: 'macbook.tailnet.ts.net', restart: true,
    detail: ['The server answers only requests addressed to localhost, 127.0.0.1, the host it is bound to and these; anything else, and any request from another website, gets a 403.'] }),
  L({ key: 'paired_devices', tab: 'access', group: 'Paired devices', label: 'Paired devices', summary: 'Phones and laptops that may use planestro from another machine. This machine never needs pairing.', control: 'devices',
    detail: ['Pair a device shows a one-time code (also: planestro pair in a terminal here), good for 10 minutes and for one device, with a link and a QR code that open /pair on the device with the code filled in; or enter the code at http://<this machine>:<port>/pair there. A server listening on 127.0.0.1 only cannot be reached from another device: turn on Local network access (above) or start it with --host 0.0.0.0. Its browser keeps a token in a cookie, and the page shows the token once for an MCP client (Authorization: Bearer).', 'Revoke removes the device: its next request gets a 401. Only a hash of each token is stored, in planestro.local.yml.'] }),
  L({ key: 'mcp_servers', tab: 'access', group: 'MCP servers', label: 'MCP servers', summary: 'Services a model may name in its MCP list, with their keys. Add one, import yours from Claude Code or Codex, test it, turn it off.', control: 'mcp', covers: ['mcp_import_skip'],
    detail: ['A stdio server (command, args, env) or an HTTP one (url, headers). Env values and headers are keys: stored only in planestro.local.yml, which is gitignored, and never shown back; leave one empty to keep it.', 'A server reaches a worker only through a model that lists it (Models → Edit). One turned off stops that model\'s items as mcp_missing instead of running them without their tools. Removing an imported one keeps it from being imported again.'] }),
  L({ key: 'engine.mode', group: 'Engine', label: 'Engine mode on this machine', summary: 'Overrides Project → Live or dry-run here only.', control: 'select', restart: true,
    options: [{ value: 'dry-run', label: 'Dry-run' }, { value: 'live', label: 'Live' }] }),

  // ---- Data & releases
  C({ key: 'git.auto_commit', tab: 'data', group: 'Storage', label: 'Commit every change', summary: 'With messages like "HH-12: approve plan".', control: 'toggle' }),
  C({ key: 'git.auto_push', tab: 'data', group: 'Storage', label: 'Push at checkpoints', summary: 'If the data folder has a remote.', control: 'toggle' }),
  C({ key: 'git.checkpoint_interval_min', tab: 'data', group: 'Storage', label: 'Checkpoint every', summary: 'Costs and timestamps are saved this often instead of per change.', control: 'number', unit: 'min', min: 0.01, restart: true }),
  C({ key: 'attachments.managed_max_bytes', tab: 'data', group: 'Storage', label: 'Largest copied attachment', summary: 'Bigger attachments are referenced where they are instead of copied into the data folder.', control: 'number', unit: 'MB', per: 1_000_000, min: 0.001 }),
  C({ key: 'attachments.image_max_bytes', tab: 'data', group: 'Storage', label: 'Largest copied picture', summary: 'Pictures (an art review\'s captures) may be this big; the larger of this and the attachment limit applies.', control: 'number', unit: 'MB', per: 1_000_000, min: 0.001 }),
  C({ key: 'releases.sections', tab: 'data', group: 'Releases', label: 'Release sections', summary: 'The headings a release has, in order.', control: 'sections',
    detail: ['A section can have a character limit to count toward (a store field\'s), start each new release with the previous release\'s text (store copy that rarely changes), and a one-line hint under its heading.'] }),
  C({ key: 'releases.default', tab: 'data', group: 'Releases', label: 'New items target', summary: 'A release version, or next: the earliest planned release. New items (and an epic\'s children, from the epic) start planned for it.', control: 'text', mono: true, placeholder: 'none',
    detail: ['Only when an item is created: changing it never moves existing items. A version that is not a planned or in-progress release is skipped, so the item starts with none.'] }),
];

/** Schema keys the page deliberately leaves out: stamps, runtime state and records written by other controls. */
export const NOT_USER_FACING: Record<SettingFile, readonly string[]> = {
  // permissions.redirect (#203) is a list of {rule, message} edited in the file: Workers & permissions shows it under Rules in effect.
  config: ['schema_version', 'tool_version', 'permissions.redirect'],
  // engine.paused is the header's PAUSE AUTOMATION lever; the rest is what the usage guard recorded; model_unavailable is written by the model cards' Mark unavailable.
  // permissions (#229) is hand-edited, like ~/.planestro/policy.yml: Workers & permissions shows it under Rules in effect.
  // accounts (#242) are hand-edited too: a second login or key per runner, named with where its credential is.
  local: ['engine.paused', 'engine.paused_by', 'engine.provider_guards', 'engine.provider_guard_last', 'engine.disk_guard', 'model_unavailable', 'permissions', 'accounts'],
};

export function settingDef(file: SettingFile, key: string): SettingDef | undefined { return SETTINGS.find((s) => s.file === file && s.key === key); }

export function getPath(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const p of key.split('.')) { if (cur === null || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[p]; }
  return cur;
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

/** The ending of an allow rule that holds only inside the item's worktree (#96). */
export const WORKTREE_SCOPE = '@worktree';

/**
 * The files in a code repository's root that say which tools it is built with, and the commands
 * those tools are run by. Settings offers them as worktree-scoped allow rules; none is on by default,
 * because each runs code the project holds.
 */
export const TOOLCHAINS: readonly { marker: string; commands: string[] }[] = [
  { marker: 'package.json', commands: ['npm run', 'npm test', 'npx tsx', 'npx tsc', 'npx vitest', 'node'] },
  { marker: 'pyproject.toml', commands: ['python3', 'pytest'] },
  { marker: 'requirements.txt', commands: ['python3', 'pytest'] },
  { marker: 'Cargo.toml', commands: ['cargo build', 'cargo check', 'cargo test', 'cargo clippy'] },
  { marker: 'go.mod', commands: ['go build', 'go test', 'go vet'] },
  { marker: 'project.godot', commands: ['godot --headless'] },
  { marker: 'Makefile', commands: ['make'] },
];

/** Allow rules worth offering for the toolchains found, without the ones the list already covers (scoped or not). */
export function suggestedAllowRules(markers: readonly string[], have: readonly string[] = []): string[] {
  const covered = new Set(have.map((r) => r.trim()).map((r) => (r.endsWith(WORKTREE_SCOPE) ? r.slice(0, -WORKTREE_SCOPE.length) : r)));
  const commands = new Set(TOOLCHAINS.filter((t) => markers.includes(t.marker)).flatMap((t) => t.commands));
  return [...commands].map((c) => `Bash(${c} *)`).filter((r) => !covered.has(r)).map((r) => `${r}${WORKTREE_SCOPE}`);
}

/** The short hint beside a dollar figure: sessions run on the CLIs' own logins, so dollars are an API-price yardstick, not a charge. */
export const DOLLAR_HINT = 'API-price estimate, not a charge';
