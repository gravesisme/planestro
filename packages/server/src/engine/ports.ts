import type { Runner } from '@planestro/shared';
/**
 * Everything that touches the world goes through a port. `Live*` ports act; `DryRun*`
 * ports log `Would …` and keep an in-memory fake world so the pipeline still advances.
 * Lifecycle code never names a branch: every call receives the resolved base.
 */
export interface WorktreeEntry { path: string; head: string; branch?: string; bare?: boolean; prunable?: boolean }
export interface RebaseResult { ok: boolean; conflicts: string[]; head: string }

export interface ChangedFile { path: string; change: 'added' | 'modified' | 'deleted'; bytes?: number }

export interface GitPort {
  fetch(repo: string): Promise<void>;
  revParse(cwd: string, ref: string): Promise<string>;
  refExists(repo: string, ref: string): Promise<boolean>;
  worktreeAdd(repo: string, path: string, branch: string, startRef: string): Promise<void>;
  /** A worktree on no branch, for sessions that only read (an epic's planner): nothing to merge, nothing to delete but the directory. */
  worktreeAddDetached(repo: string, path: string, ref: string): Promise<void>;
  worktreeRemove(repo: string, path: string, force: boolean): Promise<void>;
  worktreePrune(repo: string): Promise<void>;
  worktreeList(repo: string): Promise<WorktreeEntry[]>;
  status(cwd: string): Promise<{ clean: boolean; dirty: string[] }>;
  aheadBehind(cwd: string, base: string, head: string): Promise<{ ahead: number; behind: number }>;
  /** Rebase `cwd`'s HEAD onto `onto`; on conflict the rebase is aborted and the files listed. */
  rebase(cwd: string, onto: string): Promise<RebaseResult>;
  /** Merge `ref` into `cwd`'s HEAD (integration branches merge, never rebase); aborted on conflict. */
  merge(cwd: string, ref: string): Promise<RebaseResult>;
  inProgressOp(cwd: string): Promise<'rebase' | 'merge' | null>;
  abortInProgress(cwd: string): Promise<void>;
  pushForceWithLease(cwd: string, branch: string, expectedRemoteSha: string | null): Promise<void>;
  pushSetUpstream(cwd: string, branch: string): Promise<void>;
  pushRef(repo: string, srcRef: string, dstBranch: string): Promise<void>;
  remoteBranchSha(repo: string, branch: string): Promise<string | null>;
  remoteHeads(repo: string): Promise<Map<string, string>>;
  deleteRemoteBranch(repo: string, branch: string): Promise<void>;
  localBranchExists(repo: string, branch: string): Promise<boolean>;
  deleteLocalBranch(repo: string, branch: string): Promise<void>;
  isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean>;
  log(cwd: string, range: string, n: number): Promise<string>;
  /** What `head` changed since it left `base` (three-dot: against their merge base), with the size of each surviving file. */
  changedFiles(cwd: string, base: string, head: string): Promise<ChangedFile[]>;
  mergeBase(cwd: string, a: string, b: string): Promise<string | null>;
  /** A file's bytes at a ref, or null when it does not exist there. */
  readBlob(cwd: string, ref: string, path: string): Promise<Buffer | null>;
}

export type CiState = 'none' | 'pending' | 'success' | 'failure' | 'cancelled';
export interface CiStatus { state: CiState; runId?: number; url?: string; sha?: string; startedAt?: string }
export interface PrInfo { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt?: string; headRefOid: string; headRefName: string; baseRefName: string; mergeCommit?: string; title?: string }

export interface GhPort {
  createPr(repo: string, args: { base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  prView(repo: string, number: number): Promise<PrInfo>;
  prList(repo: string, filter: { head?: string; base?: string; state?: 'open' | 'merged' | 'closed' | 'all' }): Promise<PrInfo[]>;
  /** Status of the named workflow for a PR's head sha (other checks such as Vercel are ignored). */
  ciForSha(repo: string, branch: string, sha: string, workflow: string): Promise<CiStatus>;
  runFailedLog(repo: string, runId: number, maxLines: number): Promise<string>;
  isBillingBlocked(repo: string, runId: number): Promise<boolean>;
  mergePr(repo: string, number: number, opts: { deleteBranch: boolean }): Promise<void>;
  /** Latest run of the workflow on a branch (base health). */
  branchCi(repo: string, branch: string, workflow: string): Promise<CiStatus>;
}

export interface ProcPort {
  run(command: string, opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export type TurnPhase = 'plan' | 'implement' | 'fix';
export interface TurnTools {
  submit_plan(plan: string): Promise<string>;
  /** Epics only: the epic-level plan and its proposed children. A rejection is returned as text for the planner to fix. */
  submit_breakdown(plan: string, children: unknown): Promise<string>;
  add_note(markdown: string): Promise<string>;
  append_activity(text: string): Promise<string>;
  report_done(summary: string): Promise<string>;
  report_blocked(reason: string): Promise<string>;
  /** Give files from this worktree to another item that waits on this one: they become its attachments and its session is told. */
  hand_off(to: string, paths: string[], note: string): Promise<string>;
  get_item(): Promise<string>;
}
export interface PermissionRequest { tool: string; input: Record<string, unknown> }
/** What every runner needs for a worker turn. */
export interface AgentTurnOptions {
  itemId: string;
  phase: TurnPhase;
  cwd: string;
  /** The runner's own model id; undefined lets the CLI use its configured default. */
  model?: string;
  prompt: string;
  systemAppend: string;
  resume?: string;
  extraDirs: string[];
  /** Files to attach to the prompt, for runners that take images (absolute paths). */
  images?: string[];
  tools: TurnTools;
  onQuestion(questions: unknown[]): Promise<void>;
  onOutput(text: string): void;
  signal?: AbortSignal;
}
/**
 * What only the Claude runner can honour: a permission mode, a tool allow-list, per-command
 * permission decisions and a dollar budget. A runner typed on `AgentTurnOptions` cannot read these,
 * so ignoring them is a fact of its type rather than an oversight.
 */
export interface ClaudeTurnExtras {
  model: string;
  permissionMode: 'plan' | 'acceptEdits';
  allowedTools: string[];
  maxBudgetUsd?: number;
  /** Decide a permission prompt. Return 'park' to persist + deny + park, 'deny' with a reason, or 'allow'. */
  onPermission(req: PermissionRequest): Promise<{ action: 'allow' } | { action: 'deny'; message: string } | { action: 'park' }>;
}
export type TurnOptions = AgentTurnOptions & ClaudeTurnExtras;
export interface TurnResult {
  sessionId?: string;
  subtype: string;            // success | error_max_turns | error_max_budget_usd | error_during_execution | killed | spawn_error
  isError: boolean;
  costUsd: number;
  /** Uncached input + output tokens, from runners that report tokens instead of dollars. */
  tokens?: number;
  numTurns: number;
  text: string;
  error?: string;
  planSubmitted?: string;
  done?: string;
  blocked?: string;
  parked?: 'question' | 'permission';
}
export interface CustomToolDef {
  name: string;
  description: string;
  /** zod raw shape (loosely typed to keep ports dependency-free). */
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}
export interface CustomTurnOptions {
  label: string;
  cwd: string;
  model: string;
  permissionMode: 'dontAsk' | 'default' | 'plan' | 'acceptEdits';
  prompt: string;
  systemAppend: string;
  resume?: string;
  allowedTools: string[];
  mcpTools: CustomToolDef[];
  maxTurns?: number;
  onOutput(text: string): void;
  signal?: AbortSignal;
}
export interface AgentPort<O extends AgentTurnOptions = TurnOptions> {
  runTurn(opts: O): Promise<TurnResult>;
  /** A turn with an arbitrary tool surface (the orchestrator). Non-planestro tool prompts are denied, never parked. Optional: test doubles may omit it. */
  runCustomTurn?(opts: CustomTurnOptions): Promise<TurnResult>;
}

/** The name the first runner's port had before there were two. */
export type ClaudePort = AgentPort;
export type { Runner };

/**
 * Agents by runner. Claude is always present (it plans, and the orchestrator is a Claude session);
 * another runner is present when its CLI is usable. The engine always passes full `TurnOptions`;
 * each port's own type says how much of it it can see.
 */
export interface AgentPorts { claude: AgentPort; codex?: AgentPort<AgentTurnOptions> }
export interface Ports { git: GitPort; gh: GhPort; proc: ProcPort; agents: AgentPorts; mode: 'live' | 'dry-run' }
