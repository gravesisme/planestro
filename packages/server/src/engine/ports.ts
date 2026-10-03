import { basename, matchesGlob } from 'node:path';
import type { Runner, RateLimitSnapshot } from '@planestro/shared';
/**
 * Everything that touches the world goes through a port. `Live*` ports act; `DryRun*`
 * ports log `Would …` and keep an in-memory fake world so the pipeline still advances.
 * Lifecycle code never names a branch: every call receives the resolved base.
 */
export interface WorktreeEntry { path: string; head: string; branch?: string; bare?: boolean; prunable?: boolean }
/** `tookBase`: conflicted files the sync resolved by taking the base's copy (a `takeBase` pattern named them, #63). */
export interface RebaseResult { ok: boolean; conflicts: string[]; head: string; tookBase?: string[] }

/** A path pattern as the worktree settings use them: without `/` it matches the file name at any depth, with `/` the path from the root. */
export function matchesPathPattern(path: string, pattern: string): boolean {
  return matchesGlob(pattern.includes('/') ? path : basename(path), pattern);
}

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
  /** A dirty tree split: changes to tracked files, and untracked files one by one (not collapsed to their directory). */
  dirtyDetail(cwd: string): Promise<{ tracked: string[]; untracked: string[] }>;
  /** Which of `paths` exist as files at `ref`. */
  trackedAt(cwd: string, ref: string, paths: string[]): Promise<string[]>;
  /** Move files (relative to cwd) into `dest`, keeping their relative paths: set aside, never deleted. */
  moveAside(cwd: string, paths: string[], dest: string): Promise<void>;
  /** Copy files (relative to cwd) to the same relative paths under `destRoot`, never over a file with other content. Each copy is checked by size. */
  copyInto(cwd: string, paths: string[], destRoot: string): Promise<{ copied: string[]; identical: string[]; collided: string[] }>;
  /** Every file (tracked, ignored or unknown to git) under the given relative directories or files of `cwd`, as relative paths. */
  filesUnder(cwd: string, paths: string[]): Promise<string[]>;
  /** Stage everything in the worktree and commit it; returns the new head. */
  /** `git add -A` and commit, leaving the untracked paths in `leave` out of it. */
  commitAll(cwd: string, message: string, leave?: string[]): Promise<string>;
  aheadBehind(cwd: string, base: string, head: string): Promise<{ ahead: number; behind: number }>;
  /** Rebase `cwd`'s HEAD onto `onto`; on conflict the rebase is aborted and the files listed. */
  /** With `takeBase`, a conflict only in files those patterns match is resolved with the base's copy and the sync goes on. */
  rebase(cwd: string, onto: string, takeBase?: string[]): Promise<RebaseResult>;
  /** Merge `ref` into `cwd`'s HEAD (integration branches merge, never rebase); aborted on conflict. */
  merge(cwd: string, ref: string, takeBase?: string[]): Promise<RebaseResult>;
  /** Put the worktree back on `sha` (its own earlier head, after a sync that has to be undone). */
  resetHard(cwd: string, sha: string): Promise<void>;
  /** Commit only these tracked paths; returns the new head. */
  commitPaths(cwd: string, paths: string[], message: string): Promise<string>;
  inProgressOp(cwd: string): Promise<'rebase' | 'merge' | null>;
  abortInProgress(cwd: string): Promise<void>;
  pushForceWithLease(cwd: string, branch: string, expectedRemoteSha: string | null): Promise<void>;
  pushSetUpstream(cwd: string, branch: string): Promise<void>;
  pushRef(repo: string, srcRef: string, dstBranch: string): Promise<void>;
  remoteBranchSha(repo: string, branch: string): Promise<string | null>;
  remoteHeads(repo: string): Promise<Map<string, string>>;
  deleteRemoteBranch(repo: string, branch: string, expected: string | null): Promise<void>;
  /** Delete the remote branch only while its tip is still `sha` (#135): 'moved' when it is not, nothing deleted; 'gone' when it no longer exists. */
  deleteRemoteBranchAt(repo: string, branch: string, sha: string): Promise<'deleted' | 'moved' | 'gone'>;
  localBranchExists(repo: string, branch: string): Promise<boolean>;
  deleteLocalBranch(repo: string, branch: string, expected: string | null): Promise<void>;
  isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean>;
  log(cwd: string, range: string, n: number): Promise<string>;
  /** What `head` changed since it left `base` (three-dot: against their merge base), with the size of each surviving file. */
  changedFiles(cwd: string, base: string, head: string): Promise<ChangedFile[]>;
  mergeBase(cwd: string, a: string, b: string): Promise<string | null>;
  /** A file's bytes at a ref, or null when it does not exist there. */
  readBlob(cwd: string, ref: string, path: string): Promise<Buffer | null>;
}

/** `skipped`: every run for the head skipped all its jobs (a draft guard): no verdict, never red. */
export type CiState = 'none' | 'pending' | 'success' | 'failure' | 'cancelled' | 'skipped';
/** `attempt` is the run's attempt number: a re-run keeps its run id and counts up. */
/** `queued` (pending only): the run is waiting for a runner and no job has started, so it is not using its time yet (#170). */
export interface CiStatus { state: CiState; runId?: number; url?: string; sha?: string; startedAt?: string; attempt?: number; queued?: boolean }
/** Runs of the CI workflow across the repository that are waiting for a runner, and running (#170). */
export interface CiQueue { queued: number; running: number }
export interface PrInfo { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt?: string; headRefOid: string; headRefName: string; baseRefName: string; mergeCommit?: string; title?: string; isDraft?: boolean; author?: string; updatedAt?: string }

export interface GhPort {
  createPr(repo: string, args: { base: string; head: string; title: string; body: string; draft?: boolean }): Promise<{ number: number; url: string }>;
  /** Mark a PR as a draft (true) or ready for review (false); ready_for_review is what starts CI on a draft. */
  setDraft(repo: string, number: number, draft: boolean): Promise<void>;
  prView(repo: string, number: number): Promise<PrInfo>;
  prList(repo: string, filter: { head?: string; base?: string; state?: 'open' | 'merged' | 'closed' | 'all' }): Promise<PrInfo[]>;
  /** Status of the named workflow for a PR's head sha (other checks such as Vercel are ignored). */
  ciForSha(repo: string, branch: string, sha: string, workflow: string): Promise<CiStatus>;
  runFailedLog(repo: string, runId: number, maxLines: number): Promise<string>;
  isBillingBlocked(repo: string, runId: number): Promise<boolean>;
  /** Re-run only the failed jobs of a completed run (same run id, next attempt). */
  rerunFailed(repo: string, runId: number): Promise<void>;
  /** Re-run every job of a run: a cancelled run, which has no failed jobs to re-run (HH-321). */
  rerunAll(repo: string, runId: number): Promise<void>;
  mergePr(repo: string, number: number, opts: { headSha: string }): Promise<'merged' | 'head_moved'>;
  /** Close a pull request without merging it, with a comment saying why (#135). */
  closePr(repo: string, number: number, comment: string): Promise<void>;
  /** The URL of the newest successful deployment for this commit (a Vercel or Netlify preview), or null (#137). */
  previewUrl(repo: string, sha: string): Promise<string | null>;
  /** How deep the workflow's queue is, repository-wide (#170). Optional: a port without it reports no queue. */
  ciQueue?(repo: string, workflow: string): Promise<CiQueue>;
  /** Latest run of the workflow on a branch (base health). */
  branchCi(repo: string, branch: string, workflow: string): Promise<CiStatus>;
}

export interface ProcPort {
  run(command: string, opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Bytes free to this user on the volume holding `path` (#161), or undefined when it cannot be read. */
  freeBytes?(path: string): Promise<number | undefined>;
}

export type TurnPhase = 'plan' | 'implement' | 'fix';
export interface TurnTools {
  submit_plan(plan: string): Promise<string>;
  /** An epic's plan and its proposed children (a rejection is returned as text for the planner to fix); on a plain item, a flagged plan that says it is really an epic (#69). */
  submit_breakdown(plan: string, children: unknown): Promise<string>;
  add_note(markdown: string, attach?: string[]): Promise<string>;
  append_activity(text: string): Promise<string>;
  /** `hold`: the pull request must not merge yet, and why ("until the release is cut"); it is held out of the merge queue until the user releases it (#97). */
  report_done(summary: string, parts?: unknown, hold?: string, attach?: string[]): Promise<string>;
  report_blocked(reason: string, parts?: unknown): Promise<string>;
  /** Multi-part work: each part's state (accepted | pending | rejected) with the gate reason, replacing the last report. */
  report_progress(parts: unknown): Promise<string>;
  /** Give files from this worktree to another item that waits on this one: they become its attachments and its session is told. */
  hand_off(to: string, paths: string[], note: string): Promise<string>;
  get_item(): Promise<string>;
}
export interface PermissionRequest { tool: string; input: Record<string, unknown> }
export type McpServerSpec = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> } | { type: 'http'; url: string; headers?: Record<string, string> };
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
  /**
   * The running total the resumed conversation last reported, when the caller recorded it. A resumed
   * conversation reports its whole spend again, not the turn's (#64): only what is above this is new.
   */
  resumeTotalUsd?: number;
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
  /** The SDK's own fallback for an overloaded or unavailable model (the next model in the item's fallback chain). */
  fallbackModel?: string;
  /** Servers beyond planestro's own that this session gets, by name, as the SDK takes them. Their tools reach onPermission like any other. */
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Asked once, before a resumed conversation's first request, with the CLI's own quote for reloading
   * it. 'stop' ends the turn there (`resume_declined`), before anything is spent.
   */
  onResumeQuote?(quote: ResumeQuote): 'go' | 'stop';
  /** Decide a permission prompt. Return 'park' to persist + deny + park, 'deny' with a reason, or 'allow'. */
  onPermission(req: PermissionRequest): Promise<{ action: 'allow' } | { action: 'deny'; message: string } | { action: 'park' }>;
  /**
   * The session's last report (submit_plan, report_done, report_blocked) whose call never reached its handler, as soon as
   * the port sees it, and undefined when a later report landed (#167). The engine keeps it in `op_data.outbox`.
   */
  onUndelivered?(report: UndeliveredReport | undefined): void;
}
/** A report the session made whose call was lost on the way to planestro (sdk-notes gotcha 11), with the arguments it was made with. */
export interface UndeliveredReport { tool: 'submit_plan' | 'report_done' | 'report_blocked'; args: Record<string, unknown>; error: string }
export type TurnOptions = AgentTurnOptions & ClaudeTurnExtras;
/** What reloading a conversation costs before it does any work, as the CLI quotes it when it resumes one. */
export interface ResumeQuote {
  /** The window of the conversation's last response: what the first request sends again. */
  contextTokens: number;
  /** Writing that to the prompt cache again, at the conversation's model's price. */
  cacheWriteUsd: number;
  /** The cache has (probably) expired, so the first request pays the write; otherwise it reads, far cheaper. */
  cacheExpired?: boolean;
  secondsSinceLast?: number;
}
export interface TurnResult {
  sessionId?: string;
  subtype: string;            // success | error_max_turns | error_max_budget_usd | error_during_execution | killed | spawn_error | usage_exhausted | resume_declined
  isError: boolean;
  /** What this turn spent. Never the conversation's running total (#64). */
  costUsd: number;
  /** The conversation's running total as its runner reported it, for the next resume to be measured against. */
  sessionTotalUsd?: number;
  /** Tokens in the window of the conversation's last response: what resuming it reloads. */
  contextTokens?: number;
  /** How long the runner's cache writes live, in seconds: a resume within it reads the context instead of writing it. */
  cacheTtlS?: number;
  /** The CLI's quote for this resume, when it gave one. */
  resumeQuote?: ResumeQuote;
  /** Uncached input + output tokens, from runners that report tokens instead of dollars. */
  tokens?: number;
  numTurns: number;
  text: string;
  error?: string;
  planSubmitted?: string;
  done?: string;
  blocked?: string;
  parked?: 'question' | 'permission';
  /** planestro tool calls that came back as errors without reaching their handler (a transport failure). */
  toolFailures?: { tool: string; error: string }[];
  /** The last report the session made that never reached planestro, unless a later one did (#167): the engine applies it. */
  undelivered?: UndeliveredReport;
  /** Set with subtype `usage_exhausted`: the model is out of usage (the provider's message, and its reset time when it gave one). */
  usageLimit?: { message: string; resetsAt?: string };
  /** The most pressing rate-limit reading the turn saw (Claude subscriptions report one per turn): what the usage guard reads. */
  rateLimit?: RateLimitSnapshot;
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
  /** As for worker turns: the running total the resumed conversation last reported. */
  resumeTotalUsd?: number;
  allowedTools: string[];
  mcpTools: CustomToolDef[];
  maxTurns?: number;
  /** As for worker turns: the SDK's own fallback for an overloaded or unavailable model. */
  fallbackModel?: string;
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
