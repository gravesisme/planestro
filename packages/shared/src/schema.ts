/**
 * Data schema for a planestro data directory. Version bumps go through
 * packages/server/src/migrations. Everything here is project-neutral.
 */
import { z } from 'zod';
import { parseCron, validTimeZone } from './cron.ts';

export const SCHEMA_VERSION = 9;

export const STATUSES = [
  'NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY',
  'IN_PROGRESS', 'IN_REVIEW', 'MERGED', 'FINISHED', 'ICEBOX',
] as const;
export type Status = (typeof STATUSES)[number];

export const AWAITING = ['plan_approval', 'breakdown_approval', 'permission', 'question', 'audition', 'review', 'orchestrator', 'user'] as const;
export type Awaiting = (typeof AWAITING)[number];

export const OPS = [
  'creating_worktree', 'importing', 'planning_turn', 'implement_turn', 'pushing', 'creating_pr',
  'rebasing', 'syncing_base', 'awaiting_ci', 'running_local_checks', 'merging', 'cleaning_up',
] as const;
export type Op = (typeof OPS)[number];

export const KINDS = ['item', 'epic'] as const;
export const MERGE_POLICIES = ['app', 'watch'] as const;
/** An item's priority (#194), the words of the GitHub labels; unset sorts after low, so items without one order as before. */
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const CI_RESULTS = ['pending', 'green', 'red', 'blocked', 'unknown'] as const;
export const ATTACHMENT_KINDS = ['managed', 'reference'] as const;

/** `YYYY-MM-DDTHH:mm:ss±HH:mm` — see timestamps.ts. Parser accepts any ISO 8601. */
export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ts = z.string().regex(TIMESTAMP_RE, 'ISO 8601 timestamp with offset');
export const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const id = z.string().regex(ID_RE, 'item id like HH-143');

export const Attachment = z.object({
  path: z.string().min(1),
  kind: z.enum(ATTACHMENT_KINDS),
  added_at: ts,
});
export type Attachment = z.infer<typeof Attachment>;

/**
 * Field classification (enforced by tests):
 *  - authoritative: user-owned, never derived by the engine
 *  - operational:   engine-owned, persisted because recovery needs it
 *  - derived:       computed in memory, never written to disk
 */
export const AUTHORITATIVE_KEYS = [
  'schema', 'id', 'kind', 'parent', 'title', 'category', 'priority', 'status', 'rank',
  'planner', 'implementer', 'allow_model_fallback', 'auto_approve_plan', 'budget_usd', 'budget_turns', 'budget_tokens', 'mcp_budget', 'depends_on', 'attachments',
  'merge_policy', 'base_branch_override', 'loop', 'source', 'account',
] as const;
export const OPERATIONAL_KEYS = [
  'created_at', 'updated_at', 'queued_at', 'started_at', 'plan_ready_at', 'plan_approved_at',
  'pr_created_at', 'merged_at', 'finished_at', 'iceboxed_at',
  'branch', 'worktree', 'pr', 'session_id', 'agent_sessions', 'session_context', 'awaiting', 'awaiting_data', 'triage', 'resume_after', 'taken_over',
  'op', 'op_started_at', 'op_data', 'plan_revisions', 'ci_head_sha', 'ci_result', 'ci_failed_count',
  'merge_order', 'skip_merge', 'hold_reason', 'hold_waits_on', 'review_hold', 'loop_state', 'delivered', 'parts', 'blocked', 'blocked_reason', 'cost_usd', 'turns', 'agent_turns', 'tokens',
  'imported_from', 'dates_estimated', 'scheduled_from', 'created_by',
] as const;
export const DERIVED_KEYS = ['base_branch', 'lane', 'external', 'children', 'deps_satisfied', 'needs_you'] as const;
/** Canonical frontmatter key order; unknown keys follow, alphabetically. */
export const ITEM_KEY_ORDER: readonly string[] = [...AUTHORITATIVE_KEYS, ...OPERATIONAL_KEYS];

export const ItemFrontmatter = z.object({
  schema: z.number().int().positive(),
  id,
  kind: z.enum(KINDS).default('item'),
  parent: id.optional(),
  title: z.string().min(1),
  category: z.string().min(1),
  /** high | medium | low (#194). Each column orders by it first, then by rank, and the queue admits in that order. */
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(STATUSES),
  rank: z.number().int().optional(),
  planner: z.string().min(1).optional(),
  implementer: z.string().min(1).optional(),
  /** When the planner or implementer is out of usage, run the turn on its model's `fallback` instead of blocking. */
  allow_model_fallback: z.boolean().optional(),
  auto_approve_plan: z.boolean().optional(),
  /** This item's own caps, replacing budget_usd_per_item / budget_turns_per_item / budget_tokens_per_item: a big Opus item, or an eight-row art atlas, outgrows the project default (dogfood p16, p24). */
  budget_usd: z.number().positive().optional(),
  budget_turns: z.number().int().positive().optional(),
  budget_tokens: z.number().int().positive().optional(),
  /** Calls to its implementer's MCP servers (a sound service) this item may make, approved by a person (#157). With none, a model with `mcp` makes none. */
  mcp_budget: z.number().int().nonnegative().optional(),
  depends_on: z.array(id).default([]),
  attachments: z.array(Attachment).default([]),
  merge_policy: z.enum(MERGE_POLICIES).optional(),
  base_branch_override: z.string().min(1).optional(),
  /**
   * Loop until green (#171): the worker iterates (change, regenerate, run the checks) and reports each
   * iteration's tally with `report_iteration`, until every check passes or `max_iterations` is spent —
   * a budget of its own, beside the per-turn and per-item caps. Green ends in a review hold.
   */
  loop: z.object({ max_iterations: z.number().int().positive(), goal: z.string().optional() }).passthrough().optional(),
  /**
   * The GitHub issue it was imported from (#231), in the project's own repo (`code_repo.github`): the key that keeps an
   * issue from being imported twice. `closes`: its PR says `Closes #N`, so merging it closes the issue; only on request.
   */
  source: z.object({ github_issue: z.number().int().positive(), closes: z.boolean().optional() }).passthrough().optional(),
  /** The account (#242, `accounts` in planestro.local.yml) this item's turns run on for that account's runner, over its model row's: the user's "Continue on <account>". */
  account: z.string().min(1).optional(),

  created_at: ts,
  updated_at: ts,
  queued_at: ts.optional(),
  started_at: ts.optional(),
  plan_ready_at: ts.optional(),
  plan_approved_at: ts.optional(),
  pr_created_at: ts.optional(),
  merged_at: ts.optional(),
  finished_at: ts.optional(),
  iceboxed_at: ts.optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  pr: z.number().int().positive().optional(),
  session_id: z.string().optional(),
  /** Conversations by runner and role contract: a Codex thread cannot resume a Claude session or vice versa. */
  agent_sessions: z.record(z.string(), z.object({
    session_id: z.string(), model: z.string().optional(),
    role: z.enum(['plan', 'implement', 'fix']), tool_contract: z.string(),
    transport: z.enum(['exec', 'app-server']).optional(),
    /** The account it ran under (#242), unset for the runner's default login: another account resumes it only from the same store. */
    account: z.string().optional(),
    /** The MCP servers its thread was started with (#366): an app-server thread keeps the tools it started with, so a different set needs a fresh one. */
    mcp: z.array(z.string()).optional(),
  })).optional(),
  /**
   * What the conversation in `session_id` held when its last turn ended (#64): its window, its
   * model, the price the CLI quoted for reloading it and the running total it reported. It names the
   * conversation it describes, so a replaced conversation leaves no stale numbers behind.
   */
  session_context: z.object({ session: z.string(), model: z.string(), tokens: z.number().nonnegative(), at: ts, ttl_s: z.number().positive().optional(), write_usd_per_mtok: z.number().positive().optional(), total_usd: z.number().nonnegative().optional() }).passthrough().optional(),
  awaiting: z.enum(AWAITING).optional(),
  awaiting_data: z.record(z.string(), z.unknown()).optional(),
  /**
   * The item stopped for a person (a block, or a worker's question), and the orchestrator is looking
   * at it first: it resolves what is within its authority, or turns it into one plain decision
   * (`awaiting_data.decision`). While set, the item is not "needs you". Cleared when triage ends,
   * however it ends; `orchestrator.triage_timeout_min` bounds it.
   */
  triage: z.object({ reason: z.string(), started_at: ts }).passthrough().optional(),
  /**
   * The item waits for other items to merge, then its session resumes with `message` (dogfood p14):
   * not blocked, not "needs you". Set by the user or the orchestrator on a stopped item; cleared when
   * the engine resumes it.
   */
  // `prs` (#136): pull requests someone opened by hand, by number; it resumes once every item and every PR has merged.
  resume_after: z.object({ items: z.array(z.string()).default([]), prs: z.array(z.number().int().positive()).optional(), message: z.string(), since: ts }).passthrough().optional(),
  /**
   * A person is finishing this item by hand (dogfood p28): nothing automatic drives it (no turns, no
   * orchestrator, no stall or triage, no merge) until they hand it back. Its status is left as it
   * is; CI is still read. Cleared by the hand-back, or by leaving the board.
   */
  taken_over: z.object({ since: ts, note: z.string().optional() }).passthrough().optional(),
  op: z.enum(OPS).optional(),
  op_started_at: ts.optional(),
  op_data: z.record(z.string(), z.unknown()).optional(),
  /** How many times the orchestrator has sent this item's plan back for fixes; capped by `orchestrator.max_plan_revisions`. */
  plan_revisions: z.number().int().nonnegative().optional(),
  /** The worker's own structured progress on multi-part work (f4): each part accepted, pending or rejected with a reason. */
  parts: z.array(z.object({ name: z.string(), state: z.enum(['accepted', 'pending', 'rejected']), reason: z.string().optional() })).optional(),
  ci_head_sha: z.string().optional(),
  ci_result: z.enum(CI_RESULTS).optional(),
  ci_failed_count: z.number().int().nonnegative().optional(),
  merge_order: z.number().int().optional(),
  /** Held out of the merge queue: its commits are pushed and its CI is read, but it does not merge until the hold is released. */
  skip_merge: z.boolean().optional(),
  /** Why it is held, in the words of whoever held it (the plan, the worker, the orchestrator, the user). Kept only while `skip_merge` is set (#97). */
  hold_reason: z.string().optional(),
  /**
   * Who the hold waits on (#195): a `person` (the user's hold, review.hold_into, a loop's review) drafts the PR under
   * `ci.draft_while_held`; an `agent` (the orchestrator, the worker, a scope check) holds the merge only, so CI runs on
   * every push. Unset on an older hold: read as an agent's. Kept only while `skip_merge` is set.
   */
  hold_waits_on: z.enum(['person', 'agent']).optional(),
  /** The PR goes through sync and CI as usual, then parks (`awaiting: review`) instead of merging, until a person releases it. */
  review_hold: z.boolean().optional(),
  /** The loop's last reported iteration (#171): its tally of checks passing and its one-line note. */
  loop_state: z.object({ iteration: z.number().int().nonnegative(), passing: z.number().int().nonnegative(), total: z.number().int().nonnegative(), line: z.string().optional(), at: ts }).passthrough().optional(),
  /** What this item's branch changed, recorded from git as it merged — so items that waited on it can be told, long after the branch is gone. */
  delivered: z.array(z.object({ path: z.string(), change: z.enum(['added', 'modified', 'deleted']), bytes: z.number().optional(), width: z.number().optional(), height: z.number().optional() })).optional(),
  blocked: z.boolean().optional(),
  blocked_reason: z.string().optional(),
  cost_usd: z.number().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  /** Turns run by a runner that bills in tokens rather than dollars, and the uncached tokens they used. */
  agent_turns: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  imported_from: z.string().optional(),
  dates_estimated: z.boolean().optional(),
  /** `<schedule>:<slot>`: the schedule and slot that filed it (#247), the evidence that the slot is done. */
  scheduled_from: z.string().optional(),
  /** Who filed it, when that was not the user: `operator_mcp` (#232). Never the user's word to start it (#73). */
  created_by: z.string().optional(),
}).passthrough();
export type ItemFrontmatter = z.infer<typeof ItemFrontmatter>;

export const SECTION_TITLES = ['Description', 'Notes', 'Plan', 'Activity'] as const;
export type SectionTitle = (typeof SECTION_TITLES)[number];

export const PROMPT_KINDS = ['template', 'action', 'partial'] as const;
export const PROMPT_ROLES = [
  'worker_system', 'plan', 'implement', 'resume_context', 'commit_dirty_tree', 'ci_failed',
  'rebase_conflict', 'cleanup', 'orchestrator_system', 'orch_wake', 'fresh_brief',
] as const;
export const PromptFrontmatter = z.object({
  schema: z.number().int().positive(),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(PROMPT_KINDS),
  role: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
  /** Pinned to the top of the library and of the "start from a prompt" picker. Absent means no. */
  favorite: z.boolean().optional(),
}).passthrough();
export type PromptFrontmatter = z.infer<typeof PromptFrontmatter>;
export const PROMPT_KEY_ORDER: readonly string[] = ['schema', 'name', 'kind', 'role', 'title', 'description', 'model', 'favorite'];

/**
 * A release: one file per version under `releases/`, holding what the project tells the world
 * when it ships (release notes, store copy) and what the person doing it needs to remember. Its
 * sections are the project's own (`releases.sections`); planestro only counts and carries them.
 */
export const RELEASE_STATUSES = ['planned', 'submitted', 'released', 'cancelled'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
/** A file name as well as a version: `1.5.0`, `2026.09`, `v2-beta.1`. No slashes, no leading dot. */
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ReleaseFrontmatter = z.object({
  schema: z.number().int().positive(),
  // `version: 1.5` hand-written in YAML is a number; take it as the text it was meant to be.
  version: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().regex(VERSION_RE, 'version: letters, digits, dots, dashes')),
  title: z.string().min(1).optional(),
  status: z.enum(RELEASE_STATUSES),
  /** The day it shipped; while planned, the day it is aimed at. */
  date: z.string().regex(DATE_RE, 'date: YYYY-MM-DD').optional(),
  tag: z.string().min(1).optional(),
  /** The backlog items that shipped in it. */
  items: z.array(id).default([]),
  created_at: ts,
  updated_at: ts,
}).passthrough();
export type ReleaseFrontmatter = z.infer<typeof ReleaseFrontmatter>;
export const RELEASE_KEY_ORDER: readonly string[] = ['schema', 'version', 'title', 'status', 'date', 'tag', 'items', 'created_at', 'updated_at'];

/**
 * An orchestrator question for the user: one file per question under `questions/`, so it has an id,
 * a state and a discussion that outlive the wake that asked it (issue #75). Written only by the
 * DataStore; the orchestrator changes one through its tools, the user through the question page.
 */
export const QUESTION_STATUSES = ['open', 'resolved', 'withdrawn'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export const QUESTION_ID_RE = /^Q-\d+$/;
/** Summary is what the user reads first, in plain terms; the Thread is the discussion, oldest first. */
export const QUESTION_SECTIONS = ['Summary', 'Details', 'Recommendation', 'Thread'] as const;
export type QuestionSection = (typeof QUESTION_SECTIONS)[number];
export const QuestionFrontmatter = z.object({
  schema: z.number().int().positive(),
  id: z.string().regex(QUESTION_ID_RE, 'question id like Q-7'),
  status: z.enum(QUESTION_STATUSES),
  /** The item it is about, if any. It resolves by itself when that item is finished or iceboxed. */
  item: id.optional(),
  asked_at: ts,
  updated_at: ts,
  resolved_at: ts.optional(),
  /** How it ended, in a sentence: the answer, why it was withdrawn, or "HH-7 finished". */
  resolution: z.string().min(1).optional(),
  /** The question in one line, as the orchestrator first asked it (`ask_user`'s `question`). */
  headline: z.string().min(1),
}).passthrough();
export type QuestionFrontmatter = z.infer<typeof QuestionFrontmatter>;
export const QUESTION_KEY_ORDER: readonly string[] = ['schema', 'id', 'status', 'item', 'asked_at', 'updated_at', 'resolved_at', 'resolution', 'headline'];

/**
 * A schedule (#247): one file per recurring piece of work under `schedules/`, filing an item from its
 * template at each cron slot. The user's fields come first; `armed_at`, `last_slot` and `history` are
 * planestro's: no slot at or before either is filed, so a sleep, a wake or a restart never files twice.
 */
export const SCHEDULE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SCHEDULE_HISTORY_MAX = 20;
export const ScheduleHistoryEntry = z.object({
  slot: ts,
  at: ts,
  /** The item filed for it. */
  item: id.optional(),
  /** Why nothing was filed: the previous item is still open, or the template would not render. */
  skipped: z.string().min(1).optional(),
}).passthrough();
export type ScheduleHistoryEntry = z.infer<typeof ScheduleHistoryEntry>;
export const ScheduleFrontmatter = z.object({
  schema: z.number().int().positive(),
  name: z.string().regex(SCHEDULE_NAME_RE, 'name: lowercase letters, digits and dashes'),
  /** The filed item's title; `{{date}}`, `{{slot}}` and `{{schedule}}` are filled in, as in its # Description. */
  title: z.string().min(1),
  cron: z.string().min(1).superRefine((v, ctx) => { try { parseCron(v); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); } }),
  tz: z.string().min(1).refine(validTimeZone, 'not a time zone (an IANA name such as Europe/London)'),
  enabled: z.boolean().default(true),
  /** Skip a slot while the item the schedule filed last is not finished (nor iceboxed). */
  skip_if_open: z.boolean().default(false),
  /** Submit what it files. Honoured only when `created_by: user`: the user's word (#73). */
  submit: z.boolean().default(false),
  created_by: z.string().min(1).optional(),
  kind: z.enum(KINDS).default('item'),
  category: z.string().min(1).optional(),
  priority: z.enum(PRIORITIES).optional(),
  created_at: ts,
  updated_at: ts,
  armed_at: ts,
  last_slot: ts.optional(),
  history: z.array(ScheduleHistoryEntry).default([]),
}).passthrough();
export type ScheduleFrontmatter = z.infer<typeof ScheduleFrontmatter>;
export const SCHEDULE_KEY_ORDER: readonly string[] = ['schema', 'name', 'title', 'cron', 'tz', 'enabled', 'skip_if_open', 'submit', 'created_by', 'kind', 'category', 'priority', 'created_at', 'updated_at', 'armed_at', 'last_slot', 'history'];

export const ReleaseSectionDef = z.object({
  title: z.string().min(1).regex(/^[^\n#]+$/, 'a section title is one line without #'),
  /** A store's limit for the field; the page counts toward it. */
  max_chars: z.number().int().positive().optional(),
  /** A new release starts with the previous release's text (store copy that rarely changes). */
  carry: z.boolean().default(false),
  /** One line under the heading on the release page. */
  hint: z.string().optional(),
});
export type ReleaseSectionDef = z.infer<typeof ReleaseSectionDef>;
export const DEFAULT_RELEASE_SECTIONS: ReleaseSectionDef[] = [
  { title: 'Release notes', carry: false, hint: 'What users are told changed.' },
  { title: 'Notes', carry: false, hint: 'Yours: the checklist, what went wrong, what to do differently.' },
];

/**
 * Starting points for `releases.sections` (#376), picked in Settings and then edited like any other. Plain is the
 * default; the store sets show what `max_chars` and `carry` are for.
 */
export const RELEASE_SECTION_PRESETS: { id: string; name: string; summary: string; sections: ReleaseSectionDef[] }[] = [
  { id: 'plain', name: 'Plain', summary: 'Release notes and your own notes.', sections: DEFAULT_RELEASE_SECTIONS },
  { id: 'changelog', name: 'Changelog', summary: 'Keep a Changelog: Added, Changed, Fixed, Removed.', sections: [
    { title: 'Added', carry: false, hint: 'New features.' },
    { title: 'Changed', carry: false, hint: 'Changes to what was already there.' },
    { title: 'Fixed', carry: false, hint: 'Bug fixes.' },
    { title: 'Removed', carry: false, hint: 'Features taken out.' },
    { title: 'Notes', carry: false, hint: 'Yours: the checklist, what went wrong, what to do differently.' },
  ] },
  { id: 'app-store', name: 'iOS App Store', summary: "App Store Connect's fields, with its character limits.", sections: [
    { title: "What's New", max_chars: 4000, carry: false, hint: "App Store Connect → What's New in This Version." },
    { title: 'Subtitle', max_chars: 30, carry: true },
    { title: 'Promotional text', max_chars: 170, carry: true },
    { title: 'Keywords', max_chars: 100, carry: true, hint: 'Comma-separated, no spaces needed.' },
    { title: 'Description', max_chars: 4000, carry: true },
    { title: 'Notes', carry: false, hint: 'Yours: the checklist, what went wrong, what to do differently.' },
  ] },
  { id: 'google-play', name: 'Google Play', summary: "Play Console's store listing fields, with its character limits.", sections: [
    { title: 'Release notes', max_chars: 500, carry: false, hint: "Play Console → the release's notes." },
    { title: 'Short description', max_chars: 80, carry: true },
    { title: 'Full description', max_chars: 4000, carry: true },
    { title: 'Notes', carry: false, hint: 'Yours: the checklist, what went wrong, what to do differently.' },
  ] },
];

/**
 * A preset applied over the sections a project has (#376). Release files keep their text under each heading, so a
 * title the project already has (in any case) keeps its spelling and its text; `dropped` lists the headings the preset
 * leaves out, whose text stays in the files and is shown after the configured sections.
 */
export function applySectionPreset(current: ReleaseSectionDef[], preset: ReleaseSectionDef[]): { sections: ReleaseSectionDef[]; dropped: string[] } {
  const key = (t: string) => t.trim().toLowerCase();
  const sections = preset.map((p) => ({ ...p, title: current.find((c) => key(c.title) === key(p.title))?.title ?? p.title }));
  return { sections, dropped: current.filter((c) => !preset.some((p) => key(p.title) === key(c.title))).map((c) => c.title) };
}

/** The preset a project's sections are, exactly as shipped; undefined once edited. */
export function sectionPresetOf(sections: ReleaseSectionDef[]): string | undefined {
  const same = (a: ReleaseSectionDef, b: ReleaseSectionDef) => a.title === b.title && a.max_chars === b.max_chars && Boolean(a.carry) === Boolean(b.carry) && (a.hint ?? '') === (b.hint ?? '');
  return RELEASE_SECTION_PRESETS.find((p) => p.sections.length === sections.length && p.sections.every((s, i) => same(s, sections[i])))?.id;
}

/** Which agent CLI runs a model's turns. `claude` plans and implements; `codex` implements only. */
export const RUNNERS = ['claude', 'codex'] as const;
export type Runner = typeof RUNNERS[number];

/** Reasoning efforts every model in Codex's catalog offers (`model/list`, 0.154.0). Codex itself accepts any string unchecked. */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type CodexEffort = typeof CODEX_EFFORTS[number];
/** Service tiers: `default` is standard speed; `priority` (Codex's "Fast") is quicker and drains usage faster. */
export const CODEX_TIERS = ['default', 'priority'] as const;
export type CodexTier = typeof CODEX_TIERS[number];

export const ModelDef = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  runner: z.enum(RUNNERS).default('claude'),
  claude_model: z.string().optional(),
  /** Passed to the selected Codex transport; keep explicit for isolated app-server sessions. */
  codex_model: z.string().optional(),
  codex_transport: z.enum(['exec', 'app-server']).optional(),
  /** Reasoning effort for every Codex turn on this row (#245); unset leaves the model's own default. */
  codex_effort: z.enum(CODEX_EFFORTS, { error: 'a reasoning effort is low, medium, high or xhigh' }).optional(),
  /** Service tier for every Codex turn on this row (#245); unset leaves Codex's default. */
  codex_tier: z.enum(CODEX_TIERS, { error: 'a service tier is default or priority (the tiers Codex offers)' }).optional(),
  /** Give this Codex row's workers the project's `.claude/skills` from their worktree, through the turn (#238). Claude rows load them already. */
  skills: z.boolean().optional(),
  /** App-server only: turn the built-in image generator on for this row's implement and fix turns (it is off on every other app-server turn). Exec rows always have it. */
  native_images: z.boolean().optional(),
  /** One line on what the model is for. The epic planner routes children by it. */
  description: z.string().optional(),
  /** Hold this model's pull requests before merge until a person releases them (art is reviewed by eye). */
  hold_for_review: z.boolean().optional(),
  /** Another model id on the same runner. An item that allows fallback runs on it while this one is out of usage. */
  fallback: z.string().min(1).optional(),
  /** MCP servers this model's tool-capable sessions get (names from `mcp_servers` in planestro.local.yml): a sound service, a 3D service. What makes a worker an audio or model worker, with `hold_for_review` for the audition. */
  mcp: z.array(z.string().min(1)).default([]),
  /** How many calls to those servers one item may make in all: a spend cap that planestro can count itself. Past it the calls are refused and the worker is told. */
  mcp_calls_per_item: z.number().int().positive().optional(),
  /** A plan for this model is a person's to approve, never the orchestrator's, and its MCP calls need a budget they set (`mcp_budget` on the item): paid generation (#157). */
  user_approves_plans: z.boolean().optional(),
  /** planestro commits for this model's sessions when they could not (a sandbox that intermittently refuses git's lock files): work left uncommitted after a done report is committed with the summary, and a block on a git refusal is committed and resumed. Git stays planestro's either way. */
  engine_commits: z.boolean().optional(),
  /** The account its turns run on (#242): a name from `accounts` in planestro.local.yml, on this row's runner. Unset: the runner's default login. */
  account: z.string().min(1).optional(),
  external: z.boolean().default(false),
});
export type ModelDef = z.infer<typeof ModelDef>;

/** A model this machine's account cannot use until `until` (a usage limit, or marked by hand). */
export const ModelUnavailable = z.object({
  until: z.string(),
  reason: z.string(),
  since: z.string().optional(),
  /** Set from Settings rather than detected from a failed turn. */
  manual: z.boolean().optional(),
});
export type ModelUnavailable = z.infer<typeof ModelUnavailable>;

/** Transport capabilities, including a scoped planning tool contract and accounting mode. */
export function modelCapabilities(m: Pick<ModelDef, 'runner' | 'external' | 'codex_transport'>) {
  const claude = (m.runner ?? 'claude') === 'claude';
  const tools = claude || m.codex_transport === 'app-server';
  return { workerPrompt: !claude && (m.codex_transport ?? 'exec') === 'exec' ? 'worker-system-codex' : 'worker-system',
    toolContract: claude ? 'claude-v1' : m.codex_transport === 'app-server' ? 'app-server-v1' : 'exec-v1', transport: claude ? undefined : m.codex_transport ?? 'exec', roleBound: !claude && m.codex_transport === 'app-server',
    plan: !m.external && tools, orchestrate: !m.external && tools,
    implement: !m.external, permissions: tools, accounting: claude ? 'dollars' as const : 'tokens' as const,
    /** A resumed Codex thread keeps the developer instructions it started with (#246, verified live): new ones need a fresh conversation. */
    resumeKeepsInstructions: !claude,
    /** And the tools (#366): an app-server thread is resumed without its dynamic tools, so a model's MCP servers are the ones it started with. */
    resumeKeepsTools: !claude && m.codex_transport === 'app-server' };
}
/** What a row asks of a Codex turn beyond its model (#245). Nothing for a Claude row. */
export function runnerTurnSettings(m: Pick<ModelDef, 'runner' | 'codex_effort' | 'codex_tier' | 'skills' | 'native_images'> | undefined): { effort?: CodexEffort; serviceTier?: CodexTier; skills?: true; nativeImages?: true } {
  if (!m || (m.runner ?? 'claude') !== 'codex') return {};
  return { ...(m.codex_effort ? { effort: m.codex_effort } : {}), ...(m.codex_tier ? { serviceTier: m.codex_tier } : {}), ...(m.skills ? { skills: true as const } : {}), ...(m.native_images ? { nativeImages: true as const } : {}) };
}
export function canPlan(m: Pick<ModelDef, 'runner' | 'external' | 'codex_transport'>): boolean { return modelCapabilities(m).plan; }

/** A deny that says what to do instead (#203): a matching call is refused up front with `message`, never parked. */
export const PermissionRedirect = z.object({ rule: z.string().min(1), message: z.string().min(1) });
export type PermissionRedirect = z.infer<typeof PermissionRedirect>;
/** `allow` / `deny` / `redirect` permission rules: a project's `permissions`, this machine's in planestro.local.yml, and `~/.planestro/policy.yml` (#229). */
export const PermissionRules = z.object({ allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]), redirect: z.array(PermissionRedirect).default([]) });
export type PermissionRules = z.infer<typeof PermissionRules>;
/** Where an effective permission rule comes from (#229), in the order they are merged: a deny from any of them wins. */
export type PermissionSource = 'machine' | 'project' | 'local';
export interface SourcedRule { rule: string; list: 'allow' | 'deny' | 'redirect'; sources: PermissionSource[]; /** A redirect's, from the first layer that names it. */ message?: string }

export const Config = z.object({
  schema_version: z.number().int().positive(),
  tool_version: z.string(),
  project: z.object({ name: z.string().min(1), id_prefix: z.string().regex(/^[A-Z][A-Z0-9]*$/) }),
  code_repo: z.object({
    path: z.string().min(1),
    default_branch: z.string().min(1),
    release_branch: z.string().min(1).optional(),
    github: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  }),
  worktrees: z.object({
    root: z.string().default('.claude/worktrees'),
    branch_pattern: z.string().default('{{prefix_lower}}/{{number}}-{{slug}}'),
    dir_pattern: z.string().default('{{prefix_lower}}-{{number}}-{{slug}}'),
    /** Paths inside a worktree (relative, e.g. `tmp`) whose files are set aside, never deleted, when the worktree is removed: a worker's raw sources or scratch output that git ignores (dogfood p40). */
    keep_on_remove: z.array(z.string().min(1)).default([]),
    /** Globs for untracked files the project's tools regenerate in any worktree (`*.import`): never a session's work, so no clean-tree check counts them, engine commits leave them out, and cleanup sets them aside. A pattern without `/` matches the file name at any depth (dogfood p52). */
    byproducts: z.array(z.string().min(1)).default([]),
    /** Paths inside a worktree (relative, e.g. `tmp`) whose untracked files are copied into the same path of the main checkout when the item merges, before the worktree goes: a sandboxed worker cannot write there itself (#72). Never overwrites; they are kept (keep_on_remove) as well. */
    copy_to_checkout: z.array(z.string().min(1)).default([]),
    /** Tracked files a command regenerates (`resources/i18n/messages.pot` → its export command), by path pattern as for `byproducts`. A sync that conflicts only in these takes the base's copy, runs the command and commits what changed, with no session turn (#63). */
    generated: z.record(z.string().min(1), z.string().min(1)).default({}),
  }).default({ root: '.claude/worktrees', branch_pattern: '{{prefix_lower}}/{{number}}-{{slug}}', dir_pattern: '{{prefix_lower}}-{{number}}-{{slug}}', keep_on_remove: [], byproducts: [], copy_to_checkout: [], generated: {} }),
  hooks: z.object({ after_worktree_create: z.array(z.string()).default([]) }).default({ after_worktree_create: [] }),
  models: z.array(ModelDef).min(1),
  defaults: z.object({
    planner: z.string(), implementer: z.string(), category: z.string(),
    /** New items (and an epic's children, unless the epic says otherwise) start with fallback allowed. */
    allow_model_fallback: z.boolean().default(false),
    /** New items start with "let the orchestrator approve the plan" ticked, unless their implementer uses legacy exec or requires human plan approval: see planReviewByDefault. */
    auto_approve_plan: z.boolean().default(false),
  }),
  categories: z.array(z.string().min(1)).min(1),
  /** A background color per category (`#rrggbb`), for its tag on the board; the text on it is chosen to contrast (contrastText). A category missing one is given a suggestion. */
  category_colors: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb color')).default({}),
  /** Per-item spend ceiling across all of its turns; a turn starts with what remains. */
  budget_usd_per_item: z.number().positive().default(25),
  /** What one planning turn may spend: a planner that researches for $97 without handing in a plan (HH-162) is stopped here and asked for the plan it has. */
  budget_usd_per_plan_turn: z.number().positive().default(15),
  /** When reloading an item's conversation would cost more than this, a turn whose prompt stands on its own starts a fresh conversation with a brief instead (#64). 0 turns it off. */
  budget_usd_fresh_above: z.number().min(0).default(10),
  /** The budget for runners that report tokens, not dollars: worker turns per item. */
  budget_turns_per_item: z.number().int().positive().default(20),
  /** …and uncached tokens per item. A live art turn measured 20–35k; the default leaves room for a dozen revisions. */
  budget_tokens_per_item: z.number().int().positive().default(600_000),
  budget_tokens_per_plan_turn: z.number().int().positive().default(100_000),
  /** Environment variables a Codex worker's commands may see, beyond PATH, HOME, USER, SHELL, TMPDIR and LANG; nothing else of planestro's environment reaches them (#228). */
  codex_env_passthrough: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name')).default([]),
  concurrency: z.object({
    max_sessions: z.number().int().positive().default(3), max_local_jobs: z.number().int().positive().default(1),
    /** Simultaneous turns per runner, for runners with their own rate limits (image generation is slow). Unlisted runners are unlimited. */
    runner_limits: z.record(z.string(), z.number().int().positive()).default({ codex: 1 }),
    /** An active item that nothing has driven for this many minutes is stalled: resumed once, then blocked. 0 turns the detector off. */
    stall_after_min: z.number().min(0).default(10),
    /** A turn that failed transiently before it produced anything is retried once after this many seconds (#241). 0 turns it off. */
    transient_retry_after_s: z.number().min(0).default(30),
    /**
     * Guard rails for the concurrency control (#330, concurrency.ts): a raise is recommended one step at a time while
     * none of the last `ci_window` CI results was killed at a timeout and the 5-minute load per core is under
     * `max_load_per_cpu`, and not within `settle_min` of the last raise; above that it needs a confirm. `auto_step_down`
     * (off by default) rolls a raise back on the tick once a check is killed or the 15-minute load per core reaches `step_down_load_per_cpu`.
     */
    guard: z.object({
      ci_window: z.number().int().positive().default(10),
      max_load_per_cpu: z.number().positive().default(1),
      settle_min: z.number().min(0).default(30),
      auto_step_down: z.boolean().default(false),
      step_down_load_per_cpu: z.number().positive().default(2),
    }).default({ ci_window: 10, max_load_per_cpu: 1, settle_min: 30, auto_step_down: false, step_down_load_per_cpu: 2 }),
  }).default({ max_sessions: 3, max_local_jobs: 1, runner_limits: { codex: 1 }, stall_after_min: 10, transient_retry_after_s: 30, guard: { ci_window: 10, max_load_per_cpu: 1, settle_min: 30, auto_step_down: false, step_down_load_per_cpu: 2 } }),
  permissions: PermissionRules.default({ allow: [], deny: [], redirect: [] }),
  /**
   * Heavy local runs (#218): a worker's `run_heavy` runs one at a time across the data dir, and before each batch waits
   * while a CI job runs on a runner carrying one of `shared_labels` (this host's runners). A Bash call matching one of
   * `patterns` (a command prefix, or a `Bash(…)` rule) is redirected to it, and run_heavy may run what they match.
   */
  heavy_runs: z.object({
    enabled: z.boolean().default(false),
    patterns: z.array(z.string().min(1)).default([]),
    shared_labels: z.array(z.string().min(1)).default([]),
    yield_to_ci: z.boolean().default(true),
    /** How often a waiting run reads the runners again. */
    poll_s: z.number().positive().default(30),
    /** How long one batch may run before it is stopped. */
    timeout_min: z.number().positive().default(120),
  }).default({ enabled: false, patterns: [], shared_labels: [], yield_to_ci: true, poll_s: 30, timeout_min: 120 }),
  /**
   * Which worker commands are test runs (#347), read for the efficiency report's wasted runs: whole-suite runs (no names
   * and none of `filters`) and runs repeated on a tree unchanged since the same command's green run. Nothing is refused.
   */
  test_runs: z.object({
    /** Command prefixes that run tests, e.g. `npm test`, `./tools/run_checks.sh`. Empty: nothing is recorded. */
    patterns: z.array(z.string().min(1)).default([]),
    /** Flags that narrow a run to part of the suite; a bare name after the command narrows it too. */
    filters: z.array(z.string().min(1)).default(['-t', '--testNamePattern', '--shard', '--grep', '--only-file']),
    /** Flags that make a run a repeated load pass. */
    repeat_flags: z.array(z.string().min(1)).default(['--repeat', '--stress']),
  }).default({ patterns: [], filters: ['-t', '--testNamePattern', '--shard', '--grep', '--only-file'], repeat_flags: ['--repeat', '--stress'] }),
  ci: z.object({
    mode: z.enum(['github', 'github-or-local']).default('github'),
    require_green_base: z.boolean().default(true),
    start_timeout_min: z.number().positive().default(10),
    /** How long a run may take once it has STARTED. Time a run spends queued for a runner is not counted (#170). */
    timeout_min: z.number().positive().default(45),
    /** How long a run may sit queued, no job started, before CI counts as timed out: a queue, not a failure (#170). */
    queue_timeout_min: z.number().positive().default(720),
    /** Admission control (#170): while this many or more runs of the workflow wait queued for a runner, no new item starts. 0 = off. */
    max_queued_runs: z.number().int().min(0).default(0),
    /** Open a held item's PR as a draft, and mark it ready (which starts CI, when the project's CI skips drafts) only once the hold is released. */
    draft_while_held: z.boolean().default(true),
    local_check_command: z.string().optional(),
    /** Text that marks a CI failure as a known flake (a check name, a message): the failed jobs are re-run once for that head before a fix turn is spent. */
    flaky_checks: z.array(z.string().min(1)).default([]),
    /** Regular expressions that mark a red run's failed log as the infrastructure's (a results dir that vanished, a full disk), beside built-ins: re-run once, never a fix turn or a counted red; matched again, it blocks ci_infra (#219). */
    infra_patterns: z.array(z.string().min(1).refine((v) => { try { new RegExp(v); return true; } catch { return false; } }, 'not a valid regular expression')).default([]),
    /** An item in review that nothing has moved for this long (no CI running, no session, no stop) wakes the orchestrator once per stall (#201). 0 = off. */
    stall_wake_min: z.number().min(0).default(30),
  }).default({ mode: 'github', require_green_base: true, start_timeout_min: 10, timeout_min: 45, queue_timeout_min: 720, max_queued_runs: 0, draft_while_held: true, flaky_checks: [], infra_patterns: [], stall_wake_min: 30 }),
  orchestrator: z.object({
    budget_tokens_per_wake: z.number().int().positive().default(50_000),
    budget_tokens_per_fresh_wake: z.number().int().positive().default(200_000),
    model: z.string().default('claude-opus-5-5'),
    /** When the orchestrator's model is out of usage, wake on its model row's `fallback` instead. */
    allow_model_fallback: z.boolean().default(false),
    may_approve_plans: z.boolean().default(false),
    max_plan_revisions: z.number().int().nonnegative().default(2),
    may_decide_permissions: z.boolean().default(false),
    /** A block or a worker's question goes to the orchestrator first; it resolves it or asks you one plain decision. */
    triage: z.boolean().default(true),
    /** How long an item may sit in triage before it comes to you as it is. */
    triage_timeout_min: z.number().positive().default(10),
    rotate_after_wakes: z.number().int().positive().default(10),
    rotate_after_days: z.number().positive().default(3),
  }).default({ budget_tokens_per_wake: 50_000, budget_tokens_per_fresh_wake: 200_000, model: 'claude-opus-5-5', allow_model_fallback: false, may_approve_plans: false, max_plan_revisions: 2, may_decide_permissions: false, triage: true, triage_timeout_min: 10, rotate_after_wakes: 10, rotate_after_days: 3 }),
  engine: z.object({ mode: z.enum(['live', 'dry-run']).default('dry-run') }).default({ mode: 'dry-run' }),
  epics: z.object({
    auto_submit: z.boolean().default(true),
    /** The cap on a one-shot session that resolves a merge conflict on an epic's integration branch (#71). 0: no such session, the epic blocks as sync_conflict. */
    conflict_budget_usd: z.number().min(0).default(10),
  }).default({ auto_submit: true, conflict_budget_usd: 10 }),
  /** Pause automation before a subscription usage window runs out (see docs/configuration.md, Usage guard). */
  usage_guard: z.object({
    enabled: z.boolean().default(true),
    /** Utilization (0..1) of any rate-limit window at which automation pauses. */
    threshold: z.number().gt(0).max(1).default(0.85),
    /** An `allowed_warning` reading trips it too, whatever the utilization. */
    on_warning: z.boolean().default(true),
    /** Resume a guard-made pause a minute after the window resets. */
    auto_resume: z.boolean().default(false),
  }).default({ enabled: true, threshold: 0.85, on_warning: true, auto_resume: false }),
  /** Pause automation before the disk fills (#161, HH-355): free space on the repo's and worktrees' volume, read once a minute. */
  disk_guard: z.object({
    enabled: z.boolean().default(true),
    /** Below this many GiB free, nothing new starts; running steps finish. */
    min_free_gib: z.number().positive().default(10),
    /** It resumes by itself at this many GiB free (a margin above min_free_gib, so it does not flap). */
    resume_free_gib: z.number().positive().default(15),
  }).default({ enabled: true, min_free_gib: 10, resume_free_gib: 15 }),
  notifications: z.object({
    on_merge: z.string().optional(), on_usage_pause: z.string().optional(),
    /** Run once per wait when an item needs you or the orchestrator asks a question (#224), with PLANESTRO_ITEM, PLANESTRO_KIND and PLANESTRO_URL too. */
    on_needs_you: z.string().optional(),
    /** The address links in notifications start with (`http://studio.local:4300`); unset, the one the server listens on. */
    base_url: z.string().url().optional(),
    /** A wait is announced only once every planestro tab has been idle this long; one answered meanwhile is not. */
    idle_after_min: z.number().min(0).default(2),
  }).default({ idle_after_min: 2 }),
  /** Where the orchestrator's notes about planestro are filed as issues (#231), `owner/repo`; unset, **File as issue** is not offered. Not the project's own repo, unless planestro is the project. */
  /** The operator MCP endpoint (`/mcp`, #175): `allow_writes` lists `create_item`, which files to NOT_YET_SUBMITTED only (#232). */
  operator_mcp: z.object({ allow_writes: z.boolean().default(false) }).default({ allow_writes: false }),
  feedback: z.object({ issue_repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/repo').optional() }).default({}),
  /** Importing the project's GitHub issues as items (#231): with none selected, every open issue with this label is imported. */
  issues: z.object({ import_label: z.string().min(1).optional() }).default({}),
  git: z.object({
    auto_commit: z.boolean().default(true),
    auto_push: z.boolean().default(true),
    checkpoint_interval_min: z.number().positive().default(60),
  }).default({ auto_commit: true, auto_push: true, checkpoint_interval_min: 60 }),
  /** Reviewing what a hold_for_review model made: thumbnails are also shown at `image_scale`× (a pixel-art project sets its display scale), and one changed file over its limit (`max_file_bytes`, or `max_file_bytes_by_ext` for its extension) blocks the item before a PR is opened. */
  review: z.object({
    image_scale: z.number().int().min(1).max(16).default(1), max_file_bytes: z.number().int().positive().default(10_000_000),
    /** Per-extension limits that replace max_file_bytes for those files (`.ogg: 20000000`): a project's music is legitimately bigger than its sprites. */
    max_file_bytes_by_ext: z.record(z.string(), z.number().int().positive()).default({}),
    nudge_after_min: z.number().int().positive().default(240),
    /** Branches a pull request into opens held (skip_merge) for the user, item or epic: a branch that deploys (LM's main is production). The hold, not a model's timing, keeps it out of the merge queue. */
    hold_into: z.array(z.string().min(1)).default([]),
  }).default({ image_scale: 1, max_file_bytes: 10_000_000, max_file_bytes_by_ext: {}, nudge_after_min: 240, hold_into: [] }),
  attachments: z.object({ managed_max_bytes: z.number().int().positive().default(2_000_000) }).default({ managed_max_bytes: 2_000_000 }),
  releases: z.object({ sections: z.array(ReleaseSectionDef).min(1).default(DEFAULT_RELEASE_SECTIONS) }).default({ sections: DEFAULT_RELEASE_SECTIONS }),
});
export type Config = z.infer<typeof Config>;

/** What the usage guard recorded when it paused a provider. */
export const UsageGuardState = z.object({
  window: z.string(),
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  utilization: z.number().optional(),
  resets_at: z.string().optional(),
  tripped_at: z.string(),
  /** When automation resumes on its own (`resets_at` + 60 s), with `usage_guard.auto_resume`. */
  resume_at: z.string().optional(),
});
export type UsageGuardState = z.infer<typeof UsageGuardState>;

/** Machine-local overrides (gitignored planestro.local.yml). */

/**
 * A second login for a runner (#242), by name in planestro.local.yml (machine-local, gitignored). It says where the login
 * is, never what it is: `home` is the account's own config folder (CLAUDE_CONFIG_DIR for Claude, signed in with
 * `CLAUDE_CONFIG_DIR=<home> claude` → /login; CODEX_HOME for Codex, signed in with `CODEX_HOME=<home> codex login`).
 * planestro runs on the CLIs' own logins, never a model API key: `api_key_env` is gone (`readLocalConfig` drops it).
 */
export const AccountDef = z.object({
  runner: z.enum(RUNNERS),
  label: z.string().min(1).optional(),
  home: z.string().min(1, 'an account needs a home: the config folder its CLI is signed in from'),
});
export type AccountDef = z.infer<typeof AccountDef>;

export const LocalConfig = z.object({
  code_repo_path: z.string().optional(),
  /** This machine's own allow / deny rules for this project, merged after the machine policy and the project's (#229). */
  permissions: PermissionRules.optional(),
  worktrees_root: z.string().optional(),
  claude_bin: z.string().optional(),
  codex_bin: z.string().optional(),
  /** Extra names this machine is reached by (a Tailscale name, a DNS alias); the server refuses any other Host. */
  allowed_hosts: z.array(z.string().min(1)).optional(),
  /** Listen on every interface unless `--host` says otherwise, and answer only the local network (#255). There is no login: anyone on this network can use planestro. */
  lan_access: z.boolean().optional(),
  /** MCP servers a model row may name in `mcp`, with their keys: this file is machine-local and gitignored. A stdio server (`command`, `args`, `env`) or an HTTP one (`url`, `headers`). */
  mcp_servers: z.record(z.string(), z.object({
    command: z.string().optional(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}),
    url: z.string().optional(), headers: z.record(z.string(), z.string()).default({}),
    /** Off: kept here, but a model naming it stops as `mcp_missing` (#237). Unset reads as on. */
    enabled: z.boolean().optional(),
    /** Where Settings imported it from (`~/.claude.json`, `~/.codex/config.toml`); unset for one added here or by hand. */
    source: z.string().optional(),
  })).default({}),
  /** Imported MCP servers removed here, as `<source>:<name>`, so an import does not bring them back (#237). */
  mcp_import_skip: z.array(z.string()).optional(),
  /** Other logins per runner (#242), by name ("default" is the runner's own login). Hand-edited here; never committed. */
  accounts: z.record(z.string().regex(/^(?!default$)[a-z0-9][a-z0-9_-]{0,39}$/, 'an account name is lowercase letters, digits, - and _ (and not "default")'), AccountDef).optional(),
  /** Models this machine's account cannot use right now, by model id (`<id>@<account>` for a named account): detected usage limits and ones marked in Settings. */
  model_unavailable: z.record(z.string(), ModelUnavailable).optional(),
  /**
   * `serve --watch` keeping this machine's planestro checkout current (#103): `main-green` moves it to the newest
   * main commit whose CI passed at least `min_age_hours` ago (a soak, so one project can trail another), every
   * `poll_min` minutes, then restarts between turns. `off` leaves it where it is.
   */
  update: z.object({
    channel: z.enum(['off', 'main-green']).default('off'),
    poll_min: z.number().int().min(1).default(15),
    min_age_hours: z.number().min(0).default(0),
  }).default({ channel: 'off', poll_min: 15, min_age_hours: 0 }),
  engine: z.object({
    paused: z.boolean().default(false), mode: z.enum(['live', 'dry-run']).optional(),
    /** Who pulled the global lever; provider usage guards are independent. */
    paused_by: z.enum(['user', 'disk']).optional(),
    /** Set while the disk guard holds automation paused (#161). */
    disk_guard: z.object({ free_gib: z.number(), path: z.string(), tripped_at: z.string() }).optional(),
    /** Each provider whose usage guard is holding its new turns. */
    provider_guards: z.record(z.string(), UsageGuardState).optional(),
    /** The window crossing the guard last tripped on, so it trips once per crossing (a manual resume inside it is respected). */
    provider_guard_last: z.record(z.string(), z.object({ window: z.string(), resets_at: z.string().optional(), tripped_at: z.string() })).optional(),
  }).default({ paused: false }),
}).passthrough();
export type LocalConfig = z.infer<typeof LocalConfig>;
