/**
 * Data schema for a planestro data directory. Version bumps go through
 * packages/server/src/migrations. Everything here is project-neutral.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const STATUSES = [
  'NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY',
  'IN_PROGRESS', 'IN_REVIEW', 'MERGED', 'FINISHED', 'ICEBOX',
] as const;
export type Status = (typeof STATUSES)[number];

export const AWAITING = ['plan_approval', 'permission', 'question', 'orchestrator', 'user'] as const;
export type Awaiting = (typeof AWAITING)[number];

export const OPS = [
  'creating_worktree', 'importing', 'planning_turn', 'implement_turn', 'pushing', 'creating_pr',
  'rebasing', 'syncing_base', 'awaiting_ci', 'running_local_checks', 'merging', 'cleaning_up',
] as const;
export type Op = (typeof OPS)[number];

export const KINDS = ['item', 'epic'] as const;
export const MERGE_POLICIES = ['app', 'watch'] as const;
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
  'schema', 'id', 'kind', 'parent', 'title', 'category', 'status', 'rank',
  'planner', 'implementer', 'auto_approve_plan', 'depends_on', 'attachments',
  'merge_policy', 'base_branch_override',
] as const;
export const OPERATIONAL_KEYS = [
  'created_at', 'updated_at', 'queued_at', 'started_at', 'plan_ready_at', 'plan_approved_at',
  'pr_created_at', 'merged_at', 'finished_at', 'iceboxed_at',
  'branch', 'worktree', 'pr', 'session_id', 'awaiting', 'awaiting_data',
  'op', 'op_started_at', 'op_data', 'ci_head_sha', 'ci_result', 'ci_failed_count',
  'merge_order', 'blocked', 'blocked_reason', 'cost_usd', 'turns',
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
  status: z.enum(STATUSES),
  rank: z.number().int().optional(),
  planner: z.string().min(1).optional(),
  implementer: z.string().min(1).optional(),
  auto_approve_plan: z.boolean().optional(),
  depends_on: z.array(id).default([]),
  attachments: z.array(Attachment).default([]),
  merge_policy: z.enum(MERGE_POLICIES).optional(),
  base_branch_override: z.string().min(1).optional(),

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
  awaiting: z.enum(AWAITING).optional(),
  awaiting_data: z.record(z.string(), z.unknown()).optional(),
  op: z.enum(OPS).optional(),
  op_started_at: ts.optional(),
  op_data: z.record(z.string(), z.unknown()).optional(),
  ci_head_sha: z.string().optional(),
  ci_result: z.enum(CI_RESULTS).optional(),
  ci_failed_count: z.number().int().nonnegative().optional(),
  merge_order: z.number().int().optional(),
  blocked: z.boolean().optional(),
  blocked_reason: z.string().optional(),
  cost_usd: z.number().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  imported_from: z.string().optional(),
  dates_estimated: z.boolean().optional(),
}).passthrough();
export type ItemFrontmatter = z.infer<typeof ItemFrontmatter>;

export const SECTION_TITLES = ['Description', 'Notes', 'Plan', 'Activity'] as const;
export type SectionTitle = (typeof SECTION_TITLES)[number];

export const PROMPT_KINDS = ['template', 'action', 'partial'] as const;
export const PROMPT_ROLES = [
  'worker_system', 'plan', 'implement', 'resume_context', 'commit_dirty_tree', 'ci_failed',
  'rebase_conflict', 'cleanup', 'orchestrator_system', 'orch_wake',
] as const;
export const PromptFrontmatter = z.object({
  schema: z.number().int().positive(),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(PROMPT_KINDS),
  role: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
}).passthrough();
export type PromptFrontmatter = z.infer<typeof PromptFrontmatter>;
export const PROMPT_KEY_ORDER: readonly string[] = ['schema', 'name', 'kind', 'role', 'title', 'description', 'model'];

export const ModelDef = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  claude_model: z.string().optional(),
  external: z.boolean().default(false),
});
export type ModelDef = z.infer<typeof ModelDef>;

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
  }).default({ root: '.claude/worktrees', branch_pattern: '{{prefix_lower}}/{{number}}-{{slug}}', dir_pattern: '{{prefix_lower}}-{{number}}-{{slug}}' }),
  hooks: z.object({ after_worktree_create: z.array(z.string()).default([]) }).default({ after_worktree_create: [] }),
  models: z.array(ModelDef).min(1),
  defaults: z.object({ planner: z.string(), implementer: z.string(), category: z.string() }),
  categories: z.array(z.string().min(1)).min(1),
  concurrency: z.object({ max_sessions: z.number().int().positive().default(3), max_godot_jobs: z.number().int().positive().default(1) }).default({ max_sessions: 3, max_godot_jobs: 1 }),
  permissions: z.object({ allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]) }).default({ allow: [], deny: [] }),
  ci: z.object({
    mode: z.enum(['github', 'github-or-local']).default('github'),
    require_green_base: z.boolean().default(true),
    start_timeout_min: z.number().positive().default(10),
    timeout_min: z.number().positive().default(45),
    local_check_command: z.string().optional(),
  }).default({ mode: 'github', require_green_base: true, start_timeout_min: 10, timeout_min: 45 }),
  orchestrator: z.object({
    model: z.string().default('claude-fable-5'),
    may_approve_plans: z.boolean().default(false),
    rotate_after_wakes: z.number().int().positive().default(40),
    rotate_after_days: z.number().positive().default(3),
  }).default({ model: 'claude-fable-5', may_approve_plans: false, rotate_after_wakes: 40, rotate_after_days: 3 }),
  engine: z.object({ mode: z.enum(['live', 'dry-run']).default('dry-run') }).default({ mode: 'dry-run' }),
  notifications: z.object({ on_merge: z.string().optional() }).default({}),
  git: z.object({
    auto_commit: z.boolean().default(true),
    auto_push: z.boolean().default(true),
    checkpoint_interval_min: z.number().positive().default(60),
  }).default({ auto_commit: true, auto_push: true, checkpoint_interval_min: 60 }),
  attachments: z.object({ managed_max_bytes: z.number().int().positive().default(2_000_000) }).default({ managed_max_bytes: 2_000_000 }),
});
export type Config = z.infer<typeof Config>;

/** Machine-local overrides (gitignored planestro.local.yml). */
export const LocalConfig = z.object({
  code_repo_path: z.string().optional(),
  worktrees_root: z.string().optional(),
  godot_bin: z.string().optional(),
  claude_bin: z.string().optional(),
  engine: z.object({ paused: z.boolean().default(false), mode: z.enum(['live', 'dry-run']).optional() }).default({ paused: false }),
}).passthrough();
export type LocalConfig = z.infer<typeof LocalConfig>;
