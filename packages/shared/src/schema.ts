/**
 * Data schema for a planestro data directory. Version bumps go through
 * packages/server/src/migrations. Everything here is project-neutral.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 4;

export const STATUSES = [
  'NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY',
  'IN_PROGRESS', 'IN_REVIEW', 'MERGED', 'FINISHED', 'ICEBOX',
] as const;
export type Status = (typeof STATUSES)[number];

export const AWAITING = ['plan_approval', 'breakdown_approval', 'permission', 'question', 'review', 'orchestrator', 'user'] as const;
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
  'merge_policy', 'base_branch_override', 'loop',
] as const;
export const OPERATIONAL_KEYS = [
  'created_at', 'updated_at', 'queued_at', 'started_at', 'plan_ready_at', 'plan_approved_at',
  'pr_created_at', 'merged_at', 'finished_at', 'iceboxed_at',
  'branch', 'worktree', 'pr', 'session_id', 'agent_sessions', 'session_context', 'awaiting', 'awaiting_data', 'triage', 'resume_after', 'taken_over',
  'op', 'op_started_at', 'op_data', 'plan_revisions', 'ci_head_sha', 'ci_result', 'ci_failed_count',
  'merge_order', 'skip_merge', 'hold_reason', 'hold_waits_on', 'review_hold', 'loop_state', 'delivered', 'parts', 'blocked', 'blocked_reason', 'cost_usd', 'turns', 'agent_turns', 'tokens',
  'imported_from', 'dates_estimated',
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

/** Which agent CLI runs a model's turns. `claude` plans and implements; `codex` implements only. */
export const RUNNERS = ['claude', 'codex'] as const;
export type Runner = typeof RUNNERS[number];

export const ModelDef = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  runner: z.enum(RUNNERS).default('claude'),
  claude_model: z.string().optional(),
  /** Passed to the selected Codex transport; keep explicit for isolated app-server sessions. */
  codex_model: z.string().optional(),
  codex_transport: z.enum(['exec', 'app-server']).optional(),
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
    implement: !m.external, permissions: tools, accounting: claude ? 'dollars' as const : 'tokens' as const };
}
export function canPlan(m: Pick<ModelDef, 'runner' | 'external' | 'codex_transport'>): boolean { return modelCapabilities(m).plan; }

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
  concurrency: z.object({
    max_sessions: z.number().int().positive().default(3), max_local_jobs: z.number().int().positive().default(1),
    /** Simultaneous turns per runner, for runners with their own rate limits (image generation is slow). Unlisted runners are unlimited. */
    runner_limits: z.record(z.string(), z.number().int().positive()).default({ codex: 1 }),
    /** An active item that nothing has driven for this many minutes is stalled: resumed once, then blocked. 0 turns the detector off. */
    stall_after_min: z.number().min(0).default(10),
  }).default({ max_sessions: 3, max_local_jobs: 1, runner_limits: { codex: 1 }, stall_after_min: 10 }),
  permissions: z.object({ allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]) }).default({ allow: [], deny: [] }),
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
    /** An item in review that nothing has moved for this long (no CI running, no session, no stop) wakes the orchestrator once per stall (#201). 0 = off. */
    stall_wake_min: z.number().min(0).default(30),
  }).default({ mode: 'github', require_green_base: true, start_timeout_min: 10, timeout_min: 45, queue_timeout_min: 720, max_queued_runs: 0, draft_while_held: true, flaky_checks: [], stall_wake_min: 30 }),
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
export const LocalConfig = z.object({
  code_repo_path: z.string().optional(),
  worktrees_root: z.string().optional(),
  claude_bin: z.string().optional(),
  codex_bin: z.string().optional(),
  /** Extra names this machine is reached by (a Tailscale name, a DNS alias); the server refuses any other Host. */
  allowed_hosts: z.array(z.string().min(1)).optional(),
  /** Optional Console API key: sessions then bill the API under the Commercial Terms instead of a claude.ai login. Local file only (gitignored). */
  anthropic_api_key: z.string().optional(),
  /** MCP servers a model row may name in `mcp`, with their keys: this file is machine-local and gitignored. A stdio server (`command`, `args`, `env`) or an HTTP one (`url`, `headers`). */
  mcp_servers: z.record(z.string(), z.object({
    command: z.string().optional(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}),
    url: z.string().optional(), headers: z.record(z.string(), z.string()).default({}),
  })).default({}),
  /** Models this machine's account cannot use right now, by model id: detected usage limits and ones marked in Settings. */
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
