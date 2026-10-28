import { randomUUID } from 'node:crypto';
import { mcpServersNamed, runnerTurnSettings, chooseTurnPath, MIN_TURN_USD, WARM_SHARE, type ResumeEstimate, type SessionContext, type Part, serializeItemFile, modelCapabilities, getSection, isoLocal, canPlan, resolveTurnModel, fallbackChain, unavailableEntry, holdShapeOf, usageTurnData, USAGE_TURN, type UsageStage, type UsageRole, type ModelDef, guardKey, unavailableView, sameSessionStore, DEFAULT_ACCOUNT, type Account, type ServerEvent, type Status } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import { DRY_RUN_SESSION_PREFIX } from './ports.ts';
import type { Ports, TurnPhase, TurnResult, TurnTools, McpServerSpec, ResumeQuote, UndeliveredReport, ConnectionDrop, AccountCredentials } from './ports.ts';
import { operatorMcpUrl } from '../routes/mcp.ts';
import { listInstances } from '../instances.ts';
import { makePolicy, allowedByRules, sdkRules, BASE_ALLOWED } from './policy.ts';
import { permissionGrantRefusal } from './parks.ts';
import { commandGrant, commandForms, matchesCommandGrant, type CommandGrant } from './sessions/nativeApproval.ts';
import { hostNote, keptPathsNote, cwdNote } from './hostNote.ts';
import { quietTransientFailure, patchRejected, PATCH_REJECTED_RETRY } from './transient.ts';
import { heavyRedirects } from './heavyRuns.ts';
import { resolveSecretEnv, redactSecretEnv } from './secretEnv.ts';
import { MAX_ORCHESTRATOR_DENIALS } from './orchestratorDenials.ts';
import type { Guards } from './guards.ts';
import type { Triage } from './triage.ts';
import type { ReviewUndo } from './reviewUndo.ts';

/** A turn this engine started (LiveEngine's `turns`): what the board shows of it, and its abort. */
export interface RunningTurn { model: string; phase: TurnPhase; startedAt: string; lastOutput: string; abort: AbortController; waiting?: string; oneShot?: string; lastOutputAt?: number; /** run_heavy calls in flight (#502): quiet by design, not a hung turn. */ heavy?: number }

/**
 * Turn running (#404, seam 9): one turn of an item's session, from the choice of how to start it to what it cost. runTurnFor
 * is the one door every turn goes through: the take-over, pause and worktree checks, the account and the model it falls back
 * to, the budget and the path a turn takes before anything is spent (#64: resume, a fresh conversation with a brief rendered
 * from the item file and git, or a stop; freshBrief, the CLI's own quote), the policy and MCP servers it runs with, its
 * permission parks and questions, the checkpoints around it (#234), and once it ends the cost settlement and session record
 * (session_context, agent_sessions), the usage journal (#236, #345), the budget warning, a lost report applied from its
 * outbox or kept as rejected (#167: recordOutbox, ingestOutbox), a dropped connection (recordDrop, settleDrop), and the
 * quiet failure retried once (#241, #344: blockOrRetry). An epic's one-shot conflict session (#71) is a whole turn, so it is
 * here, and so is what a turn's prompt is told in code (who implements, an epic's breakdown, what was delivered, a loop, a
 * hold). When a turn runs (saved instructions, queued messages, restart recovery) is TurnQueue's; what its end means for the
 * item (the done check, the pull request) stays in LiveEngine, and the slots are Slots'. LiveEngine owns one and delegates to it; this is
 * what it needs from the engine, and nothing more.
 */
export interface TurnRunnerContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'git' | 'agents' | 'mode'>;
  /** The code repo's main checkout. */
  readonly repo: string;
  /** Read live: a turn the engine's stop killed keeps its op and its outbox for the restart. */
  readonly stopping: boolean;
  /** Turns this engine started: a turn registers itself here and leaves when it ends. */
  readonly turns: Map<string, RunningTurn>;
  /** Each item's test-run records still being written, awaited before the turn's usage (#347). */
  readonly testRunWrites: ReadonlyMap<string, Promise<void>>;
  /** Why a live turn was aborted on purpose, and the turns the quiet watchdog stopped: read and spent as the turn ends. */
  readonly stoppedFor: Map<string, string>;
  readonly quietStopped: Map<string, string>;
  /** The pause and drain, a model's outage and the usage a turn reported. */
  readonly guards: Pick<Guards, 'paused' | 'draining' | 'recordUnavailable' | 'usageSeen'>;
  /** A usage stop's own card (#242), and a worker's question to the orchestrator first. */
  readonly triage: Pick<Triage, 'blockExhausted' | 'triageOps'>;
  /** The checkpoints around a worker's turn, and what the next turn is told of an Undo (#234). */
  readonly reviewUndo: Pick<ReviewUndo, 'checkpointTurn' | 'undoneNote'>;
  emit(e: ServerEvent): void;
  now(): string;
  absWorktree(rel: string): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  block(id: string, reason: string, detail: string): void;
  /** The saved instruction a deferred turn goes back to, and a turn queued behind this one (TurnQueue). */
  savePendingTurn(id: string, turn: PendingTurn): void;
  queueTurn(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[], oneShotCommands: string[], opts: TurnOpts): void;
  /** What a turn's end means for the item: the plan's ask-again, the done check and the pull request. */
  afterTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void>;
  phaseFor(status: Status): TurnPhase | null;
  resumeNote(id: string, reason: string): string;
  /** The account a turn runs on (#242), whether its usage guard is up, and what the runner is given for it. */
  accountFor(fm: { account?: string }, def: ModelDef): { account: Account } | { missing: string; why: string };
  guarded(runner: string, account?: string): boolean;
  accountTurnOptions(account: Account): { account?: AccountCredentials; secretDirs?: string[] };
  /** The item's caps, and what resuming its conversation costs now (#64). */
  budgetOf(fm: { budget_usd?: number; budget_turns?: number; budget_tokens?: number }): { usd: number; usdKey: string; turns: number; turnsKey: string; tokens: number; tokensKey: string };
  resumeEstimateFor(fm: { session_id?: string; session_context?: SessionContext }, model?: string): ResumeEstimate | undefined;
  /** Whether planestro commits for the item's implementer, and what the worktree has uncommitted. */
  commitsFor(fm: { implementer?: string }): boolean;
  worktreeDirt(cwd: string): Promise<{ clean: boolean; dirty: string[]; byproducts: string[] }>;
  /** The planestro tools a worker's turn is given, and what its test runs are journaled as (#347). */
  makeTools(id: string): TurnTools;
  recordTestRun(id: string, cwd: string, run: { command: string; ok: boolean; ms: number }, source: 'bash'): Promise<void>;
  /** A permission or question park (#108), and who it goes to. */
  recordPark(id: string, kind: 'permission' | 'question', what: string, asked: 'user' | 'orchestrator'): string;
  permissionsDelegated(): boolean;
  mayAskOrchestrator(fm: { op_data?: Record<string, unknown> }): boolean;
  wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void;
  wakeWhenIdle(id: string, type: string, data?: Record<string, unknown>): void;
  /** Why a report_done is refused while the branch adds debug markers (#240), or undefined. */
  debugMarkersLeft(id: string): Promise<string | undefined>;
  /** A runner's slot (concurrency.runner_limits) and a session slot (max_sessions). */
  withRunnerSlot<T>(runner: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  withSessionSlot<T>(id: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** Turn failures with their own block reason, because the fix is the user's (log in, wait, start over) and not a judgment call. */
const ACTIONABLE_FAILURES = new Set(['auth_required', 'rate_limited', 'session_lost', 'spawn_error', 'cli_too_old']);

/** Spend past this share of a budget is said out loud once (Activity and the log), before the hard stop. */
const BUDGET_WARN_AT = 0.8;

/**
 * How a turn is started. `opener`: the phase's own first prompt. `note`: why the session was parked,
 * said first when it is resumed and left out when the conversation is new. `fresh`: `true` asks for a
 * new conversation with a brief; `'auto'` lets the engine choose one, for a prompt that stands on its
 * own (a CI failure, a conflict, a reminder, an instruction) and never for an answer to something the
 * session itself asked. `carryOn`: the prompt only says "continue", so an interrupted fresh turn keeps
 * the task it was given. `final`: the prompt is already what the agent is to read (a re-run).
 * `syncFirst`: the branch is synced with its base before the turn starts (#217), and the turn told how.
 */
export interface TurnOpts { /** A plan's revision turn: it answers whatever stop the plan's last turn left (#359). */ clearsStop?: true; opener?: boolean; fresh?: true | 'auto'; note?: string; carryOn?: boolean; final?: boolean; estimate?: ResumeEstimate; commandGrant?: CommandGrant; syncFirst?: boolean; ruling?: true }
export interface PendingTurn { key: string; phase: TurnPhase; prompt: string; extraAllowed: string[]; oneShotCommands: string[]; opts: TurnOpts }

/** The CLI's quote as the engine's estimate: the write when the cache has expired, a read of the same window when it has not. */
function quoteEstimate(q: ResumeQuote): ResumeEstimate {
  const cold = Math.round(q.cacheWriteUsd * 100) / 100;
  const warm = Math.round(cold * WARM_SHARE * 100) / 100;
  const isWarm = q.cacheExpired === false;
  return { tokens: q.contextTokens, cold, warm, usd: isWarm ? warm : cold, isWarm, basis: 'quoted' };
}

/**
 * What is known of an item's conversation once a turn has ended: its window, when it was last
 * used, the price the CLI quoted and the running total it reported. What a turn did not say is kept
 * from the record before it, as long as that record is this conversation's.
 */
function sessionContextAfter(before: SessionContext | undefined, session: string | undefined, model: string, result: TurnResult, now: string): SessionContext | undefined {
  if (!session) return undefined;
  const same = before?.session === session ? before : undefined;
  const q = result.resumeQuote;
  // A turn that said nothing of its window (it was killed, or its runner does not report one) still reported a total: that is kept.
  const tokens = result.contextTokens ?? same?.tokens ?? q?.contextTokens ?? 0;
  if (!tokens && result.sessionTotalUsd === undefined) return same;
  // A turn that was declined sent nothing, so the cache is as old as the CLI said it was.
  const at = result.contextTokens ? now : same?.at ?? (q?.secondsSinceLast !== undefined ? isoLocal(new Date(Date.parse(now) - q.secondsSinceLast * 1000)) : now);
  const rate = q ? Math.round(q.cacheWriteUsd / q.contextTokens * 1e6 * 1e4) / 1e4 : same?.model === model ? same.write_usd_per_mtok : undefined;
  const ttl = result.cacheTtlS ?? same?.ttl_s;
  const total = result.sessionTotalUsd ?? same?.total_usd;
  return { session, model: result.contextTokens || !same ? model : same.model, tokens, at, ...(ttl ? { ttl_s: ttl } : {}), ...(rate ? { write_usd_per_mtok: rate } : {}), ...(total !== undefined ? { total_usd: total } : {}) };
}

/** The op_data keys of retries the tick runs once at a due time. */
type TimedRetry = 'transient_retry' | 'usage_retry';

export class TurnRunner {
  constructor(private readonly ctx: TurnRunnerContext) {}

  /** The machine's facts for every session's system prompt (hostNote), read once. */
  private readonly hostNote = hostNote();

  /** What a turn spent, journaled as it ends (#236): the Usage page's facts, never rebuilt from item totals later. */
  private recordUsage(item: string, def: ModelDef, model: string, role: UsageRole, op: string, result: TurnResult, at: { stage: UsageStage; resumed?: boolean }): void {
    const data = usageTurnData({ provider: def.runner ?? 'claude', model, role, op, accounting: modelCapabilities(def).accounting, ...at, result });
    if (data) this.ctx.store.journal.append({ type: USAGE_TURN, item, actor: 'engine', data: { ...data } });
  }

  /**
   * The values `secret_env` hands a worker turn (#501), read from their files now; one that cannot be read is said in
   * Activity by name and file (never a value) and the turn starts without it. Undefined when nothing is handed over.
   */
  secretEnv(id: string): Record<string, string> | undefined {
    const { env, missing } = resolveSecretEnv(this.ctx.store.local.secret_env, this.ctx.repo);
    if (missing.length) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `secret_env not handed to this turn: ${missing.join('; ')}` } }], 'engine');
    return Object.keys(env).length ? env : undefined;
  }

  /**
   * The brief a fresh conversation opens with (#64): the item, its plan, what is committed and what is
   * not, where it last stopped, and the task. All of it from the item file and git, none of it from a
   * conversation (invariant 3).
   */
  private async freshBrief(id: string, task: string, phase: TurnPhase): Promise<string> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    const cwd = this.ctx.absWorktree(fm.worktree!);
    const base = this.ctx.store.derived(item).base_branch!;
    const dirty = await this.ctx.worktreeDirt(cwd).then((d) => d.dirty, () => [] as string[]);
    const commits = await this.ctx.ports.git.log(cwd, `origin/${base}..HEAD`, 30).catch(() => '');
    const inFlight = await this.ctx.ports.git.inProgressOp(cwd).catch(() => null);
    const lines = getSection(item.file, 'Activity').split('\n').filter((l) => l.trim());
    const stopped = [...lines].reverse().find((l) => l.includes('BLOCKED ('));
    const github = this.ctx.store.config.code_repo.github;
    const brief = this.ctx.store.renderPrompt('fresh-brief', item, {
      approval_notes: String(fm.op_data?.approval_notes ?? '').trim() || '(none)',
      brief: {
        task,
        rules: phase === 'plan' ? 'This is read-only planning. Do not edit, commit or implement. Submit your plan with submit_plan, or an epic breakdown with submit_breakdown, then end the turn.' : `Implement the approved task. ${this.ctx.commitsFor(fm) ? 'Planestro commits your changes; report the completed work.' : 'Commit your changes and leave the tree clean.'} Call report_done with the summary, then end the turn.`,
        stopped: stopped ? `It last stopped with: ${stopped.replace(/^[-*\s]+/, '').slice(0, 400)}` : 'It has not been blocked.',
        commits: commits.trim() || '(none yet)',
        dirty: dirty.join('\n') || '(clean)',
        in_progress: fm.op_data?.rebase_continue && inFlight === 'rebase' ? 'planestro left a rebase stopped at a conflict in the worktree; the task says what to do with it (edit the conflicted files only: planestro continues the rebase)' : inFlight ? `a ${inFlight} was left unfinished in the worktree: finish or abort it before anything else` : '(none)',
        pr: fm.pr ? `#${fm.pr}${github ? ` (https://github.com/${github}/pull/${fm.pr})` : ''}, CI ${fm.ci_result ?? 'not run yet'}` : '(no pull request yet)',
        done_summary: String(fm.op_data?.done_summary ?? '').trim().slice(0, 1200) || '(none)',
        activity: lines.slice(-12).join('\n') || '(none)',
      },
    });
    return `${brief}\n\n## Current item record (including notes, attachments, decisions and pending messages)\n\n${serializeItemFile(item.file)}`;
  }

  // ---- turns ----
  async runTurnFor(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[] = [], oneShotCommands: string[] = [], opts: TurnOpts = {}, queued?: PendingTurn): Promise<TurnResult | undefined> {
    const oneShot = new Set(oneShotCommands.map((c) => c.trim()));
    const intent: PendingTurn = queued ?? { key: randomUUID(), phase, prompt, extraAllowed, oneShotCommands, opts };
    const defer = () => {
      const pending = this.ctx.store.requireItem(id).file.frontmatter.op_data?.pending_turn as PendingTurn | undefined;
      // A slot wait can finish after a newer instruction has been queued for this item.
      if (!pending || pending.key === intent.key) this.ctx.savePendingTurn(id, intent);
      return undefined;
    };
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    // The one door every turn goes through: nothing queued before a take-over (a fix, an answer, a resume) starts while a person has the item.
    if (fm.taken_over) {
      const data = { ...fm.op_data };
      if ((data.pending_turn as PendingTurn | undefined)?.key === intent.key) delete data.pending_turn;
      this.ctx.store.mutateItem(id, [{ set: { op_data: data } }, { activity: { actor: 'app', text: `not starting its ${phase} turn: you have this item (taken over)` } }], 'engine');
      return undefined;
    }
    if (this.ctx.stopping || this.ctx.guards.paused || this.ctx.guards.draining) return defer();
    const d = this.ctx.store.derived(item);
    // No worktree, no turn (#439): an epic past planning, or an item whose worktree cleanup removed (HH-357), has no session
    // to run in. Its saved instruction is dropped and said; an active worker item stops as worktree_missing, never engine_error.
    if (!fm.worktree) {
      const data = { ...fm.op_data };
      if ((data.pending_turn as PendingTurn | undefined)?.key === intent.key) delete data.pending_turn;
      const active = d.flavor === 'worker' && this.ctx.phaseFor(fm.status) !== null;
      this.ctx.store.mutateItem(id, [{ set: { op_data: data } }, { activity: { actor: 'app', text: `not starting its ${phase} turn: ${id} has no worktree for a session to run in` } }], 'engine');
      if (active) this.ctx.block(id, 'worktree_missing', `a ${phase} turn was due with no worktree on the item; nothing recreated`);
      return undefined;
    }
    const cwd = this.ctx.absWorktree(fm.worktree);
    const modelId = phase === 'plan' ? fm.planner : fm.implementer;
    const requested = this.ctx.store.config.models.find((m) => m.id === modelId);
    if (!requested) throw new Error(`unknown model ${modelId}`);
    const allowFallback = fm.allow_model_fallback === true;
    // The account the turn runs on (#242): the item's, its model row's, or the runner's own login; its outages are its own.
    const acct = this.ctx.accountFor(fm, requested);
    if ('missing' in acct) { this.ctx.block(id, 'account_missing', `${requested.label}: ${acct.why}`); return undefined; }
    const account = acct.account;
    const pick = resolveTurnModel(this.ctx.store.config, requested, { allow: allowFallback, unavailable: unavailableView(this.ctx.store.local.model_unavailable, account.name), now: new Date(Date.now()) });
    if (pick.exhaustedUntil) {
      this.ctx.triage.blockExhausted(id, requested, account, `${fallbackChain(this.ctx.store.config, requested).map((m) => m.label).join(', ')} ${fallbackChain(this.ctx.store.config, requested).length > 1 ? 'are all' : 'is'} out of usage${account.name !== DEFAULT_ACCOUNT ? ` on account ${account.label}` : ''} until ${pick.exhaustedUntil}`);
      return undefined;
    }
    const def = pick.def;
    if (pick.fellBackFrom) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `${pick.fellBackFrom.label} is unavailable until ${pick.skipped?.until ?? 'later'} (${(pick.skipped?.reason ?? 'usage limit').slice(0, 120)}): this ${phase} turn runs on ${def.label}` } }], 'engine');
    const runner = def.runner ?? 'claude';
    if (phase === 'plan' && !canPlan(def)) { this.ctx.block(id, 'planner_cannot_plan', `${def.label} runs on ${runner}, which cannot plan; pick a model with planning capability`); return undefined; }
    const agent = this.ctx.ports.agents[runner];
    if (!agent) { this.ctx.block(id, 'runner_unavailable', `${def.label} needs the ${runner} runner, which is not available in this engine`); return undefined; }
    const model = runner === 'claude' ? def.claude_model : def[`${runner}_model`];
    if (runner === 'claude' && !model) throw new Error(`model ${def.id} has no claude_model`);
    // Runners that report tokens instead of dollars are budgeted in worker turns.
    const metered = modelCapabilities(def).accounting === 'dollars';
    if (this.ctx.guarded(runner, account.name)) return defer();
    const budget = this.ctx.budgetOf(fm);
    // A turn that only carries a permission ruling continues the turn that parked, which was charged (#295, HH-439).
    if (!metered && !opts.ruling && (fm.agent_turns ?? 0) >= budget.turns) { this.ctx.block(id, 'turn_budget', `${def.label} has used ${fm.agent_turns} of ${budget.turns} turns on this item (${budget.turnsKey}); raise it on the item and unblock, or take the item over by hand`); return undefined; }
    if (!metered && (fm.tokens ?? 0) >= budget.tokens) { this.ctx.block(id, 'token_budget', `${def.label} has used ${(fm.tokens ?? 0).toLocaleString()} of ${budget.tokens.toLocaleString()} tokens on this item (${budget.tokensKey}); raise it on the item and unblock, or take the item over by hand`); return undefined; }
    // A turn with less than MIN_TURN_USD left ends at error_max_budget_usd before it can finish
    // anything (HH-125's $0.50 conflict fix, HH-122's CI fix): say what the item needs instead.
    const usdLeft = budget.usd - (fm.cost_usd ?? 0);
    const contract = modelCapabilities(def).toolContract;
    const saved = fm.agent_sessions?.[runner];
    // A conversation kept in another account's store (its own config folder, #242) is not there to resume.
    // The MCP servers this turn offers (f5). Planning is read-only: a planner reads what the implementer will have in its
    // prompt (withImplementer) and makes no paid call (#366; an app-server planner was refused them outright).
    const offeredMcp = phase === 'plan' || !modelCapabilities(def).permissions ? [] : [...def.mcp].sort();
    const toolsMoved = Boolean(saved && modelCapabilities(def).resumeKeepsTools && (saved.mcp ?? []).join('\n') !== offeredMcp.join('\n'));
    // A dry-run conversation is not there for the live CLI to resume: the getting-started path queues an item in dry-run
    // before switching to live. (The dry-run fakes resume any id, so the other way round needs nothing.)
    const fromDryRun = this.ctx.ports.mode === 'live' && Boolean((metered ? fm.session_id : saved?.session_id)?.startsWith(DRY_RUN_SESSION_PREFIX));
    const incompatible = fromDryRun || saved && (saved.tool_contract !== contract || (modelCapabilities(def).roleBound && (saved.role === 'plan') !== (phase === 'plan')) || !sameSessionStore(this.ctx.store.local, saved.account, account.name) || toolsMoved);
    let resumeId = incompatible ? undefined : metered ? fm.session_id : saved?.session_id;
    // What the turn costs before it does anything (#64): a resume sends the whole conversation again.
    // One the item cannot pay for, or whose reload is above budget_usd_fresh_above, becomes a fresh
    // conversation with a brief when the turn's prompt stands on its own; only when nothing fits is it
    // stopped, and then before anything is spent (HH-184 spent a +$15 raise on the reload alone).
    const briefIntent = fm.op_data?.fresh_brief as { task?: string; from_session?: string; role?: 'plan' } | undefined;
    const pending = briefIntent?.role && phase !== briefIntent.role ? undefined : briefIntent;
    const freshPlan = phase === 'plan' && fm.op_data?.fresh_plan === true;
    const mayBeFresh = freshPlan || Boolean(pending) || Boolean(incompatible) || (phase !== 'plan' && !opts.opener);
    const estimate = opts.estimate ?? (metered && resumeId ? this.ctx.resumeEstimateFor(fm, model as string) : undefined);
    const path = chooseTurnPath({ left: metered ? usdLeft : Infinity, estimate, hasSession: Boolean(resumeId || pending || incompatible || freshPlan), fresh: !mayBeFresh ? undefined : pending || incompatible || freshPlan || opts.fresh === true ? true : opts.fresh, freshAboveUsd: this.ctx.store.config.budget_usd_fresh_above, contextTokens: estimate?.tokens ?? (resumeId && fm.session_context?.session === resumeId ? fm.session_context.tokens : undefined), freshAboveTokens: this.ctx.store.config.fresh_above_context_tokens });
    if (path.path === 'stop') {
      this.ctx.block(id, 'over_budget', usdLeft < MIN_TURN_USD
        ? `this item has spent $${(fm.cost_usd ?? 0).toFixed(2)} of its $${budget.usd} budget (${budget.usdKey}), too little for a ${phase} turn; raise the budget on the item and unblock, or take the item over by hand`
        : `this item has $${usdLeft.toFixed(2)} left of its $${budget.usd} budget (${budget.usdKey}) and ${path.why}, so its ${phase} turn was not started and nothing was spent. A fresh conversation with a brief needs far less (unblock_item with fresh: true). The turn was for: ${prompt.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
      return undefined;
    }
    const asked = prompt;
    let replaced: string | undefined;
    if (path.path === 'fresh' && !opts.final) {
      // The brief is rendered from the item file and git (invariant 3). The intent is persisted before the
      // turn: one that dies before its conversation has an id is still a fresh turn after a restart.
      const task = (opts.carryOn && pending?.task) || prompt;
      replaced = pending?.from_session ?? resumeId ?? saved?.session_id; resumeId = undefined;
      prompt = await this.freshBrief(id, task, phase);
      if (phase === 'plan') prompt += '\n\nThis is a planning turn. Do not implement. Submit the plan or epic breakdown, then end the turn.';
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), fresh_brief: { ...pending, task, from_session: replaced } } } }, { activity: { actor: 'app', text: `starting a fresh ${def.label} conversation with a brief instead of resuming ${replaced?.slice(0, 8) ?? 'its own'}: ${toolsMoved ? `that thread was started with MCP servers ${(saved?.mcp ?? []).join(', ') || 'none'} and ${def.label} now has ${offeredMcp.join(', ') || 'none'}; a resumed thread keeps the tools it started with` : path.why}` } }], 'engine');
    } else if (path.path === 'fresh') { replaced = resumeId; resumeId = undefined; }
    else if (opts.note && !opts.final) prompt = `${this.ctx.resumeNote(id, opts.note)}\n\n${prompt}`;
    // "Continue where you left off" presumes a conversation to continue. When there is none — the
    // opening turn died before the agent heard the task, or the thread was lost — a fresh conversation
    // gets the phase's full prompt first, and the resume note after it.
    if (!resumeId && !replaced && !opts.opener && !opts.final && (phase === 'plan' || phase === 'implement')) {
      const opener = phase === 'plan' ? this.withImplementer(id, this.withDelivered(id, 'plan-item', this.ctx.store.renderPrompt('plan-item', item))) : this.withLoopNote(id, this.withDelivered(id, 'implement-plan', this.ctx.store.renderPrompt('implement-plan', item, { approval_notes: String(fm.op_data?.approval_notes ?? '').trim() || '(none)' })));
      prompt = `${opener}\n\n---\n\n${prompt}`;
      this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `no ${def.label} conversation to resume: starting a fresh one with the full ${phase} prompt` } }], 'engine');
    }
    const images = fm.attachments.map((a) => this.ctx.store.attachmentAbsPath(a)).filter((p) => /\.(png|jpe?g|webp|gif)$/i.test(p));
    // The machine policy, the project's rules and this machine's (#229), read once for the turn: a deny from any of them wins.
    // A heavy command (#218) is redirected to run_heavy, so it never runs beside another or under a CI job on this host.
    const effective = this.ctx.store.permissionRules();
    const rules = { ...effective, redirect: [...effective.redirect, ...heavyRedirects(this.ctx.store.config)] };
    // What the user's secret_env hands an implement or fix turn (#501), read now; a planner gets none. The deny list's refusal names them.
    const secretEnv = phase === 'plan' ? undefined : this.secretEnv(id);
    const policy = makePolicy(this.ctx.store.config, d.base_branch!, cwd, { env: Object.keys(secretEnv ?? {}) }, rules);
    // Tools from outside (f5): the model row names MCP servers, the machine-local file holds them with
    // their keys. A name with no server on this machine is a stop, not a session without its tools.
    const mcpServers: Record<string, McpServerSpec> = {};
    for (const name of offeredMcp) {
      const spec = this.ctx.store.local.mcp_servers[name];
      if (!spec || (!spec.command && !spec.url)) { this.ctx.block(id, 'mcp_missing', `${def.label} names the MCP server "${name}", which planestro.local.yml on this machine does not define (mcp_servers.${name} needs a command or a url)`); return undefined; }
      if (spec.enabled === false) { this.ctx.block(id, 'mcp_missing', `${def.label} names the MCP server "${name}", which is turned off on this machine: turn it on in Settings → MCP servers, or take it off the model's mcp list`); return undefined; }
      // Workers never touch planning state (invariant 1): a planestro server's operator endpoint is not a worker's tool (#175).
      if (spec.url && operatorMcpUrl(spec.url, listInstances({ prune: false }).live, this.ctx.store.local.allowed_hosts)) { this.ctx.block(id, 'mcp_missing', `${def.label} names the MCP server "${name}", whose url (${spec.url}) is a planestro server's operator endpoint; workers never get that one: remove it from the model's mcp list`); return undefined; }
      mcpServers[name] = spec.url ? { type: 'http', url: spec.url, headers: spec.headers } : { command: spec.command!, args: spec.args, env: spec.env };
    }
    // A person's budget for this item first (#157); a model whose plans are theirs to approve makes no paid call without one.
    const mcpCap = fm.mcp_budget ?? (def.user_approves_plans ? 0 : def.mcp_calls_per_item);
    const capWhat = fm.mcp_budget !== undefined ? 'the budget approved for this item (mcp_budget)' : def.user_approves_plans ? 'no budget approved for this item yet (mcp_budget)' : `mcp_calls_per_item on ${def.label}`;
    const op = phase === 'plan' ? 'planning_turn' : 'implement_turn';
    // Where the branch stood, so a turn that fails after committing is still checked (below).
    const headBefore = phase === 'plan' ? undefined : await this.ctx.ports.git.revParse(cwd, 'HEAD').catch(() => undefined);
    const abort = new AbortController();
    // The turn that answers a park carries it, so its cost is that park's cost (#108).
    const resumesPark = typeof this.ctx.store.requireItem(id).file.frontmatter.op_data?.resume_park === 'string' ? String(this.ctx.store.requireItem(id).file.frontmatter.op_data!.resume_park) : undefined;
    const opId = this.ctx.store.journal.begin(op, id, { phase, model: model ?? def.label, runner, ...(pick.fellBackFrom ? { fell_back_from: pick.fellBackFrom.id } : {}), ...(resumesPark ? { resumes_park: resumesPark } : {}) });
    if (resumesPark) { const { resume_park: _done, ...rest } = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}; this.ctx.store.mutateItem(id, [{ set: { op_data: rest } }], 'engine'); }
    this.ctx.store.mutateItem(id, [{ set: { op, op_started_at: this.ctx.now(), op_data: { ...this.ctx.store.requireItem(id).file.frontmatter.op_data, active_turn: intent } } }], 'engine');
    // Registered before the runner slot is won (it owns the item from here), but not a running agent until then.
    const waiting = this.ctx.store.config.concurrency.runner_limits?.[runner] !== undefined ? runner : undefined;
    this.ctx.turns.set(id, { model: model ?? def.label, phase, startedAt: this.ctx.now(), lastOutput: '', abort, waiting });
    const admitted = () => {
      const data = { ...this.ctx.store.requireItem(id).file.frontmatter.op_data };
      if ((data.pending_turn as PendingTurn | undefined)?.key === intent.key) delete data.pending_turn;
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...data, active_turn: intent } } }], 'engine');
      const t = this.ctx.turns.get(id); if (t?.waiting) { t.waiting = undefined; t.startedAt = this.ctx.now(); } if (t) t.lastOutputAt = Date.now(); this.ctx.emit({ type: 'session.started', id, session_id: fm.session_id }); };
    const budgetLeft = Math.max(MIN_TURN_USD, usdLeft);
    // A planning turn is capped on its own (dogfood p41): past the cap it is asked for the plan it has, not for more research.
    // The cap is for the work: what the resume reloads first is on top of it.
    const turnCap = phase === 'plan' ? Math.min(budgetLeft, this.ctx.store.config.budget_usd_per_plan_turn + (resumeId ? estimate?.usd ?? 0 : 0)) : budgetLeft;
    const known = metered && resumeId && fm.session_context?.session === resumeId ? fm.session_context : undefined;
    let declined: ResumeEstimate | undefined;
    let result: TurnResult;
    // A worker's implement and fix turns are bracketed by checkpoints of its worktree (#234), numbered once it is admitted.
    const checkpoints = phase !== 'plan' && d.flavor === 'worker';
    let checkpointN: number | undefined;
    const beforeRun = async () => {
      if (!checkpoints) return;
      checkpointN = await this.ctx.reviewUndo.checkpointTurn(id, cwd, undefined, 'before');
      const note = this.ctx.reviewUndo.undoneNote(id);
      if (note) prompt = `${note}\n\n${prompt}`;
    };
    try {
      result = await this.ctx.withRunnerSlot(runner, () => this.ctx.withSessionSlot(id, () => { if (abort.signal.aborted && !this.ctx.stopping) return Promise.resolve<TurnResult>({ subtype: 'killed', isError: false, costUsd: 0, numTurns: 0, text: '' });
        if (this.ctx.stopping || this.ctx.guards.paused || this.ctx.guards.draining || this.ctx.guarded(runner, account.name)) return Promise.resolve<TurnResult>({ subtype: 'deferred', isError: false, costUsd: 0, numTurns: 0, text: '' }); admitted(); return beforeRun().then(() => agent.runTurn({
        itemId: id, phase, cwd, model: model as string,
        transport: modelCapabilities(def).transport, ...runnerTurnSettings(def), ...this.ctx.accountTurnOptions(account), ...(secretEnv ? { env: secretEnv } : {}),
        maxTokens: metered ? undefined : Math.min(budget.tokens - (fm.tokens ?? 0), phase === 'plan' ? fm.op_data?.plan_retry_turns ? 10_000 : this.ctx.store.config.budget_tokens_per_plan_turn : Infinity),
        onApproval: async (req) => {
          if (abort.signal.aborted || this.ctx.store.requireItem(id).file.frontmatter.taken_over) return;
          if (modelCapabilities(def).transport === 'app-server' && opts.commandGrant?.cwd === cwd && matchesCommandGrant(opts.commandGrant, req)) {
            for (const command of commandForms(opts.commandGrant.command)) {
              const why = policy.deny({ tool: 'Bash', input: { command } });
              if (why) throw new Error(why);
            }
            // Persist consumption BEFORE replying to the runner. A crash after this write may require
            // another decision, but can never replay an already accepted command on restart.
            delete opts.commandGrant;
            delete intent.opts.commandGrant;
            const data = { ...this.ctx.store.requireItem(id).file.frontmatter.op_data };
            for (const key of ['active_turn', 'pending_turn']) {
              const saved = data[key] as PendingTurn | undefined;
              if (saved?.key === intent.key) { const { commandGrant: _grant, ...kept } = saved.opts; data[key] = { ...saved, opts: kept }; }
            }
            this.ctx.store.mutateItem(id, [{ set: { op_data: data } }, { activity: { actor: 'app', text: 'one-shot command approval consumed' } }], 'engine', { commit: `${id}: consume command approval` });
            return 'allow';
          }
          // A person's allow rule answers an app-server runner's command as it answers a Claude worker's Bash (HH-535: seven Blender
          // renders, each a park, an orchestrator wake and a card). Only one complete local command in this worktree, its
          // shell launcher unwrapped, nothing denying any form of it, and only rules a person wrote: planestro's defaults
          // are for commands a sandbox would run anyway, and this one runs outside it.
          const native = modelCapabilities(def).transport === 'app-server' ? commandGrant(req) : undefined;
          if (native && native.cwd === cwd) {
            const forms = commandForms(native.command);
            const rule = forms.some((command) => policy.deny({ tool: 'Bash', input: { command } })) ? undefined
              : this.ctx.store.permissionRules().allow.find((r) => allowedByRules({ tool: 'Bash', input: { command: forms.at(-1)! } }, [r], cwd, { readOnly: phase === 'plan' }));
            if (rule) {
              this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `allowed by rule ${rule}: ${forms.at(-1)!.slice(0, 300)}` } }], 'engine');
              return 'allow';
            }
          }
          const park = this.ctx.recordPark(id, 'permission', String(req.input.command ?? req.tool), this.ctx.permissionsDelegated() ? 'orchestrator' : 'user');
          this.ctx.store.mutateItem(id, [{ set: { awaiting: 'permission', awaiting_data: { tool: req.tool, input: req.input, grantable: !permissionGrantRefusal(req), requested_at: this.ctx.now(), park } } }, { activity: { actor: 'app', text: 'Runner permission request recorded; turn ended for a decision' } }], 'engine', { commit: `${id}: awaiting permission` });
        }, permissionMode: phase === 'plan' ? 'plan' : 'acceptEdits', prompt, resume: resumeId, images,
        ...(known?.total_usd !== undefined ? { resumeTotalUsd: known.total_usd } : {}),
        // The CLI's own quote, before the first request: the same choice as above, on its numbers. It is
        // what stops a conversation nothing was recorded for (every one that predates the record).
        onResumeQuote: (q) => {
          const quoted = quoteEstimate(q);
          const again = chooseTurnPath({ left: usdLeft, estimate: quoted, hasSession: true, fresh: !mayBeFresh ? undefined : opts.fresh, freshAboveUsd: this.ctx.store.config.budget_usd_fresh_above, freshAboveTokens: this.ctx.store.config.fresh_above_context_tokens });
          if (again.path === 'resume') return 'go';
          declined = quoted;
          return 'stop';
        },
        systemAppend: `${this.ctx.store.renderPrompt(modelCapabilities(def).workerPrompt, item)}\n\n${this.hostNote}${metered ? cwdNote(cwd) : ''}${keptPathsNote(this.ctx.store.config.worktrees.copy_to_checkout, this.ctx.repo)}`,
        ...(pick.sdkFallback ? { fallbackModel: pick.sdkFallback } : {}),
        ...(Object.keys(mcpServers).length ? { mcpServers, operatorHosts: this.ctx.store.local.allowed_hosts } : {}),
        // Scoped rules (…@worktree) are planestro's to judge in onPermission; the SDK's allow-list never sees them.
        allowedTools: sdkRules([...BASE_ALLOWED[phase], ...rules.allow, ...extraAllowed], rules),
        extraDirs: [this.ctx.store.dataDir], maxBudgetUsd: turnCap,
        tools: this.heldConnection(id, this.ctx.makeTools(id)),
        onUndelivered: (r) => this.recordOutbox(id, r),
        onConnectionDrop: (d) => this.recordDrop(id, d),
        onCommandRan: (r) => this.ctx.recordTestRun(id, cwd, r, 'bash'),
        onPermission: async (req) => {
          // The turn is being stopped under a person who took the item over: nothing may park on them or wake anyone.
          if (this.ctx.store.requireItem(id).file.frontmatter.taken_over) return { action: 'deny', message: 'Not allowed: the user has taken this item over and is finishing it by hand. Stop now and end your turn.' };
          // A call to one of the model's own servers: allowed while the item's call cap holds, counted on the item.
          const server = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(req.tool)?.[1];
          if (server && mcpServers[server]) {
            const cur = this.ctx.store.requireItem(id).file.frontmatter;
            const calls = { ...((cur.op_data?.mcp_calls as Record<string, number> | undefined) ?? {}) };
            calls[server] = (calls[server] ?? 0) + 1;
            if (mcpCap !== undefined && calls[server] > mcpCap) {
              if (calls[server] === mcpCap + 1) this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), mcp_calls: calls } } }, { activity: { actor: 'app', text: `${server}: the item's ${mcpCap} calls (${capWhat}) are spent; further calls are refused` } }], 'engine');
              return { action: 'deny', message: mcpCap === 0 ? `Not allowed: no ${server} budget has been approved for this item. Stop and report_blocked saying how many ${server} calls the work needs; the user sets the budget.` : `Not allowed: this item has used its ${mcpCap} ${server} calls (${capWhat}). Finish with what you have, or report_blocked saying how many more you need.` };
            }
            this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), mcp_calls: calls } } }], 'engine');
            return { action: 'allow' };
          }
          const why = policy.deny(req);
          if (why) { this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `denied ${req.tool}: ${why}` } }], 'engine'); return { action: 'deny', message: `Not allowed: ${why}` }; }
          if (req.tool === 'Bash' && oneShot.delete(String(req.input.command ?? '').trim())) { this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: 'one-shot approval consumed' } }], 'engine'); return { action: 'allow' }; }
          if (allowedByRules(req, [...BASE_ALLOWED[phase], ...this.ctx.store.permissionRules().allow, ...extraAllowed], cwd, { readOnly: phase === 'plan' })) return { action: 'allow' };
          const ask = this.ctx.permissionsDelegated() && this.ctx.mayAskOrchestrator(this.ctx.store.requireItem(id).file.frontmatter);
          // The safety valve tripped: say so on the card, or the stream of requests reaching the user is a mystery (#95).
          const tripped = !ask && this.ctx.permissionsDelegated();
          const park = this.ctx.recordPark(id, 'permission', req.tool === 'Bash' ? String(req.input.command ?? '') : req.tool, ask ? 'orchestrator' : 'user');
          this.ctx.store.mutateItem(id, [{ set: { awaiting: ask ? 'orchestrator' : 'permission', awaiting_data: { ...(ask ? { kind: 'permission' } : {}), ...(tripped ? { escalated: 'orchestrator_denials' } : {}), tool: req.tool, input: req.input, requested_at: this.ctx.now(), park } } }, { activity: { actor: 'app', text: `parked: permission for ${req.tool} ${String(req.input.command ?? req.input.file_path ?? '').slice(0, 80)}${ask ? ' (asking the orchestrator)' : tripped ? ` (to you: the orchestrator denied its last ${MAX_ORCHESTRATOR_DENIALS} requests)` : ''}` } }], 'engine', { commit: `${id}: awaiting permission` });
          if (ask) this.ctx.wakeOrchestrator('permission_request', id);
          return { action: 'park' };
        },
        onQuestion: async (questions) => {
          if (this.ctx.store.requireItem(id).file.frontmatter.taken_over) return;
          const triage = this.ctx.triage.triageOps(this.ctx.store.requireItem(id).file.frontmatter, 'question');
          const park = this.ctx.recordPark(id, 'question', String((questions as { question?: string }[])[0]?.question ?? 'a question'), triage.on ? 'orchestrator' : 'user');
          this.ctx.store.mutateItem(id, [{ set: { awaiting: 'question', awaiting_data: { questions, requested_at: this.ctx.now(), park } } }, { activity: { actor: 'app', text: `parked: agent asked ${questions.length} question(s)` } }, ...triage.ops], 'engine', { commit: `${id}: awaiting answers` });
          if (triage.on) this.ctx.wakeWhenIdle(id, 'worker_question');
        },
        onOutput: (raw) => { const text = redactSecretEnv(raw, secretEnv); const t = this.ctx.turns.get(id); if (t) { t.lastOutput = text.slice(-400); t.lastOutputAt = Date.now(); } this.ctx.emit({ type: 'session.output', id, text }); },
        signal: abort.signal,
      })); }, abort.signal), abort.signal);
    } finally {
      if (checkpointN !== undefined) await this.ctx.reviewUndo.checkpointTurn(id, cwd, checkpointN, 'after');
      this.ctx.turns.delete(id);
    }
    // The turn's test runs are journaled before its usage, so the report puts them in this turn (#347).
    await this.ctx.testRunWrites.get(id);
    // What ran without a park, once per turn: the drift report's record of what the allow rules still match (#203).
    if (result.ran?.length) this.ctx.store.journal.append({ type: 'tools.ran', item: id, actor: 'engine', data: { phase, runner, ran: result.ran } });
    // A worker turn once the PR is open is a fix (CI or review) for the efficiency report (#346).
    this.recordUsage(id, def, model ?? def.label, phase === 'plan' ? 'planner' : 'worker', op, result, { stage: phase === 'plan' ? 'planning' : fm.status === 'IN_REVIEW' ? 'fix' : 'implementation', resumed: Boolean(resumeId) });
    if (result.subtype === 'deferred') {
      defer();
      const { active_turn: _active, ...data } = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {};
      this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { op_data: data } }], 'engine');
      this.ctx.store.journal.end(opId, id, 'ok', { subtype: 'deferred', reason: 'admission paused; instruction saved' });
      return undefined;
    }
    // A turn that did something, or ended well, ends the run of one automatic retry (#241).
    if (!quietTransientFailure(result)) this.dropTransientRetry(id);
    // So does one that ran on a model with usage for a retry at its reset (#296): a later usage stop may wait again.
    if (result.subtype !== 'usage_exhausted' && result.subtype !== 'killed') this.dropTransientRetry(id, 'usage_retry');
    const completedData = { ...this.ctx.store.requireItem(id).file.frontmatter.op_data };
    if (!(result.subtype === 'killed' && this.ctx.stopping) && (completedData.active_turn as PendingTurn | undefined)?.key === intent.key) {
      delete completedData.active_turn;
      this.ctx.store.mutateItem(id, [{ set: { op_data: completedData } }], 'engine');
    }
    const after = this.ctx.store.requireItem(id).file.frontmatter;
    // A resumed thread kept the servers it started with; a new one has this turn's (#366).
    const threadMcp = resumeId && result.sessionId === resumeId ? saved?.mcp ?? [] : offeredMcp;
    const sessionNow = metered ? result.sessionId ?? after.session_id : result.sessionId ?? after.agent_sessions?.[runner]?.session_id;
    // A fresh conversation has its id: it is the item's from here on, and the brief's marker has done its work.
    const started = path.path === 'fresh' && result.sessionId !== undefined && result.sessionId !== replaced;
    const { fresh_brief: _brief, ...opDataAfter } = after.op_data ?? {};
    if (phase === 'plan' && started) delete opDataAfter.fresh_plan;
    const context = metered ? sessionContextAfter(after.session_context, sessionNow, model as string, result, this.ctx.now()) : undefined;
    this.ctx.store.mutateItem(id, [
      { set: {
        ...(metered ? { session_id: sessionNow } : {}),
        ...(result.sessionId ? { agent_sessions: { ...(after.agent_sessions ?? {}), [runner]: { session_id: result.sessionId, model: def.id, role: phase, tool_contract: contract, ...(modelCapabilities(def).transport ? { transport: modelCapabilities(def).transport } : {}), ...(account.name !== DEFAULT_ACCOUNT ? { account: account.name } : {}), ...(modelCapabilities(def).resumeKeepsTools ? { mcp: threadMcp } : {}) } } } : {}),
        ...(context ? { session_context: context } : {}),
        ...(started && (after.op_data?.fresh_brief || freshPlan) ? { op_data: opDataAfter } : {}),
        cost_usd: Math.round(((after.cost_usd ?? 0) + result.costUsd) * 10000) / 10000, turns: (after.turns ?? 0) + result.numTurns,
        ...(metered || result.numTurns === 0 || opts.ruling ? {} : { agent_turns: (after.agent_turns ?? 0) + 1 }),
        ...(result.tokens ? { tokens: (after.tokens ?? 0) + result.tokens } : {}),
      } },
      ...(started ? [{ activity: { actor: 'app', text: `this item's conversation is now ${result.sessionId!.slice(0, 8)}; the one before it (${replaced}) was not resumed and is kept on disk` } } as ItemOp] : []),
      // A turn killed by stop() keeps its op: that is what resumeInterrupted looks for at the next
      // start. Cleared, the item sat in its phase with nothing to resume it, holding a session slot.
      ...(after.op === op && !(result.subtype === 'killed' && this.ctx.stopping) ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
    ], 'engine');
    this.warnOnBudget(id, after, this.ctx.store.requireItem(id).file.frontmatter);
    // The quote beside what the turn really cost, so an estimate that drifts from the bill is seen (HH-247's resume was quoted nowhere).
    this.ctx.store.journal.end(opId, id, result.isError ? 'failed' : 'ok', { subtype: result.subtype, cost: result.costUsd, parked: result.parked, ...(result.sessionTotalUsd !== undefined ? { session_total: result.sessionTotalUsd } : {}), ...(result.contextTokens ? { context_tokens: result.contextTokens } : {}), ...(result.resumeQuote ? { quoted_reload_usd: result.resumeQuote.cacheWriteUsd, quoted_tokens: result.resumeQuote.contextTokens, quoted_cache_expired: result.resumeQuote.cacheExpired } : {}), ...(replaced !== undefined ? { fresh: true, replaced_session: replaced } : {}) });
    if (started) this.ctx.store.journal.append({ type: 'session.replaced', item: id, actor: 'engine', data: { from: replaced, to: result.sessionId, why: path.path === 'fresh' ? path.why : 'fresh' } });
    this.ctx.guards.usageSeen(result.rateLimit, guardKey(runner, account.name));
    this.ctx.emit({ type: 'session.ended', id, subtype: result.subtype });
    for (const f of result.toolFailures ?? []) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `planestro tool ${f.tool} failed before reaching planestro (nothing was recorded): ${f.error}` } }], 'engine');
    // A report lost on its way here is applied now (#167); a turn the engine's stop killed keeps it for the restart, one a person stopped drops it.
    if (result.subtype !== 'killed') { await this.ingestOutbox(id, result); if (this.settleDrop(id, phase, result)) return result; }
    else if (!this.ctx.stopping) this.recordOutbox(id, undefined);
    const stoppedFor = this.ctx.stoppedFor.get(id); this.ctx.stoppedFor.delete(id);
    if (result.subtype === 'killed') {
      this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: stoppedFor && !this.ctx.stopping ? `turn stopped: ${stoppedFor}` : 'turn interrupted (engine stopping); resumable' } }], 'engine');
      const quiet = this.ctx.quietStopped.get(id); this.ctx.quietStopped.delete(id);
      if (quiet && !this.ctx.stopping) this.ctx.block(id, 'turn_quiet', `the turn was stopped: ${quiet}. Its conversation resumes from where it stopped.`);
      return result;
    }
    if (result.subtype === 'resume_declined') {
      // Nothing was sent and nothing spent. The same turn again, on the CLI's numbers: a fresh conversation if it may have one, else the stop.
      const q = result.resumeQuote;
      this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `did not resume this item's conversation: the CLI quoted ${q ? `$${q.cacheWriteUsd.toFixed(2)} to reload its ${Math.round(q.contextTokens / 1000)}k tokens${q.cacheExpired === false ? ' (cache still warm)' : ''}` : 'a reload it cannot pay for'}, with $${usdLeft.toFixed(2)} left` } }], 'engine');
      if (!declined || opts.estimate) { this.ctx.block(id, 'over_budget', `this item has $${usdLeft.toFixed(2)} left of its $${budget.usd} budget (${budget.usdKey}) and its conversation costs more than that to reload; nothing was spent`); return result; }
      return this.runTurnFor(id, phase, asked, extraAllowed, oneShotCommands, { ...opts, estimate: declined });
    }
    if (result.subtype === 'usage_exhausted') {
      // Remember the outage for every item on this machine, then run the same turn again: with
      // fallback allowed it resolves to the next model in the chain; without, it blocks.
      const until = this.ctx.guards.recordUnavailable(def, result.usageLimit, false, account.name);
      if (allowFallback && !this.ctx.stopping && fallbackChain(this.ctx.store.config, requested).some((m) => m.id !== def.id && !unavailableEntry(unavailableView(this.ctx.store.local.model_unavailable, account.name), m.id, new Date(Date.now())))) {
        this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `${def.label} is out of usage until ${until}; retrying this ${phase} turn on its fallback` } }], 'engine');
        return this.runTurnFor(id, phase, prompt, extraAllowed, oneShotCommands, { ...opts, final: true, ...(replaced !== undefined ? { fresh: true as const } : {}) });
      }
      this.ctx.triage.blockExhausted(id, requested, account, `${def.label} is out of usage${account.name !== DEFAULT_ACCOUNT ? ` on account ${account.label}` : ''} until ${until}${allowFallback ? ' and has no available fallback' : ' (this item does not allow a fallback model)'}: ${result.usageLimit?.message ?? ''}`);
      return result;
    }
    if (result.isError && phase !== 'plan' && result.subtype !== 'session_lost' && !result.blocked) {
      // The turn failed (often its budget ran out) after the work was done: it reported done, or it
      // moved the branch. The deterministic check decides from git what happens next, as for a turn
      // that ended cleanly; blocking on the error left finished work stranded (HH-125).
      const headAfter = headBefore === undefined ? undefined : await this.ctx.ports.git.revParse(cwd, 'HEAD').catch(() => undefined);
      const moved = headAfter !== undefined && headAfter !== headBefore;
      if (result.done || moved) {
        this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `turn ended in ${result.subtype} after ${result.done ? 'reporting done' : `moving the branch to ${headAfter!.slice(0, 7)}`}; checking the work anyway` } }], 'engine');
        await this.ctx.afterTurn(id, phase, result);
        return result;
      }
    }
    // A planning turn that ran out of its cap with no plan is not an error to judge: it is asked for the plan (afterTurn).
    if (result.isError && phase === 'plan' && ['error_max_budget_usd', 'token_cap'].includes(result.subtype) && !result.planSubmitted) { await this.ctx.afterTurn(id, phase, result); return result; }
    if (result.isError) {
      // A failure the person can act on keeps its own name; the rest are turn errors for the orchestrator to judge.
      const reason = ACTIONABLE_FAILURES.has(result.subtype) ? result.subtype : 'turn_error';
      if (result.subtype === 'session_lost' && !metered) { const { [runner]: _gone, ...rest } = this.ctx.store.requireItem(id).file.frontmatter.agent_sessions ?? {}; this.ctx.store.mutateItem(id, [{ set: { agent_sessions: rest } }], 'engine'); }
      this.blockOrRetry(id, reason, `${result.subtype}: ${result.error ?? result.text.slice(-300)}`, result);
      return result;
    }
    await this.ctx.afterTurn(id, phase, result);
    return result;
  }

  /**
   * A turn that failed before it did anything (#241) is retried once by itself after `concurrency.transient_retry_after_s`,
   * through retryOp, instead of waking triage for a turn that only needs running again. The stop is recorded as any
   * other, with the due time in `op_data.transient_retry` (driven from the tick, so a restart or a pause only delays it);
   * the retried turn's own failure, or any other, blocks as it always did.
   */
  private blockOrRetry(id: string, reason: string, detail: string, result: TurnResult): void {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const after = this.ctx.store.config.concurrency.transient_retry_after_s;
    const prior = fm.op_data?.transient_retry;
    if (!prior && after > 0 && !fm.taken_over && quietTransientFailure(result)) {
      const due = new Date(Date.now() + after * 1000).toISOString();
      // A patch the runner rejected (#344) is retried with what went wrong, since the turn had done things before it.
      const patch = patchRejected(result);
      this.ctx.store.mutateItem(id, [
        { set: { blocked: true, blocked_reason: reason, op_data: { ...(fm.op_data ?? {}), transient_retry: { due_at: due, reason, subtype: result.subtype, ...(patch ? { message: PATCH_REJECTED_RETRY } : {}) } } } },
        ...(fm.op ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
        { activity: { actor: 'app', text: `BLOCKED (${reason}): ${detail.replace(/\s+/g, ' ').slice(0, 500)}. ${patch ? 'The runner ended the turn over a rejected patch' : 'The turn produced nothing'}, so planestro retries it once in ${after}s (concurrency.transient_retry_after_s)` } },
      ], 'engine', { commit: `${id}: blocked (${reason}), retrying once` });
      this.ctx.store.journal.append({ type: 'turn.transient_retry', item: id, actor: 'engine', data: { reason, subtype: result.subtype, error: (result.error ?? '').slice(0, 300), due_at: due } });
      this.ctx.note('warn', `${id}: ${reason} (${result.subtype}) before the turn did anything; retrying once in ${after}s`);
      return;
    }
    if (prior) this.dropTransientRetry(id);
    this.ctx.block(id, reason, detail);
  }

  dropTransientRetry(id: string, key: TimedRetry = 'transient_retry'): void {
    const cur = this.ctx.store.getItem(id)?.file.frontmatter;
    if (cur?.op_data?.[key] === undefined) return;
    const { [key]: _gone, ...rest } = cur.op_data;
    this.ctx.store.mutateItem(id, [{ set: { op_data: rest } }], 'engine');
  }

  /** The session's lost report as the port saw it (#167), kept in op_data so a restart can still apply it; undefined drops it. */
  private recordOutbox(id: string, r: UndeliveredReport | undefined): void {
    const cur = this.ctx.store.getItem(id)?.file.frontmatter;
    if (!cur) return;
    if (r) {
      // A newly observed report may retry the same arguments after the user fixed
      // their rejection. Only replay of the old delivery is suppressed.
      const { rejected_report: _rejected, ...data } = cur.op_data ?? {};
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...data, outbox: { ...r, at: this.ctx.now() } } } }], 'engine'); return;
    }
    if (cur.op_data?.outbox === undefined) return;
    const { outbox: _gone, ...rest } = cur.op_data;
    this.ctx.store.mutateItem(id, [{ set: { op_data: rest } }], 'engine');
  }

  /** The session lost its line to planestro mid-turn (#167, HH-377): said on the item at once, with the first error and its time. */
  private recordDrop(id: string, d: ConnectionDrop): void {
    const cur = this.ctx.store.getItem(id)?.file.frontmatter;
    if (!cur) return;
    this.ctx.store.mutateItem(id, [
      { set: { op_data: { ...(cur.op_data ?? {}), mcp_drop: d } } },
      { activity: { actor: 'app', text: `the session lost its connection to planestro at ${d.at}${d.tool ? ` (on ${d.tool})` : ''}: ${d.error}. Its planestro calls and permission requests may not arrive until a new turn` } },
    ], 'engine');
  }

  /**
   * The turn's tools, the first of which to answer clears a drop an earlier turn left: its connection is shown to work, so
   * the card no longer says "lost connection" beside "implementing…" until the turn ends (HH-621). A drop this turn made
   * stays until it is settled (settleDrop).
   */
  private heldConnection(id: string, tools: TurnTools): TurnTools {
    const earlier = (this.ctx.store.getItem(id)?.file.frontmatter.op_data?.mcp_drop as { at?: string } | undefined)?.at;
    if (earlier === undefined) return tools;
    let checked = false;
    const clear = () => {
      if (checked) return;
      checked = true;
      const fm = this.ctx.store.getItem(id)?.file.frontmatter;
      if (!fm?.op_data || (fm.op_data.mcp_drop as { at?: string } | undefined)?.at !== earlier) return;
      const { mcp_drop: _gone, ...rest } = fm.op_data;
      this.ctx.store.mutateItem(id, [{ set: { op_data: rest } }, { activity: { actor: 'app', text: "the session's connection to planestro answered this turn; the earlier drop is cleared" } }], 'engine');
    };
    const held = {} as Record<string, unknown>;
    for (const [k, f] of Object.entries(tools)) held[k] = typeof f === 'function' ? async (...a: unknown[]) => { const r = await (f as (...x: unknown[]) => Promise<unknown>)(...a); clear(); return r; } : f;
    return held as unknown as TurnTools;
  }

  /**
   * The turn's connection to planestro, settled as it ends (#167, HH-377). A turn that ran with no drop clears an earlier flag.
   * A drop the turn did not recover from (no report landed, none could be applied from the outbox, and it did not park) stops
   * the item as `connection_lost` with the session's last message, which the orchestrator reads to recover the report. A
   * planning turn keeps its own ask-again and `no_plan` (afterTurn). True when it stopped the item.
   */
  private settleDrop(id: string, phase: TurnPhase, result: TurnResult): boolean {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (!result.connectionDrop) {
      if (fm.op_data?.mcp_drop !== undefined && result.numTurns > 0) {
        const { mcp_drop: _gone, ...rest } = fm.op_data;
        this.ctx.store.mutateItem(id, [{ set: { op_data: rest } }, { activity: { actor: 'app', text: "the session's connection to planestro held this turn; the earlier drop is cleared" } }], 'engine');
      }
      return false;
    }
    if (phase === 'plan' || result.done || result.planSubmitted || result.blocked || result.parked || result.requeued || fm.taken_over || fm.blocked) return false;
    const d = result.connectionDrop;
    const last = (result.lastMessage ?? '').trim().slice(-4000);
    this.ctx.store.mutateItem(id, [
      { set: { op_data: { ...(fm.op_data ?? {}), mcp_drop: { ...d, final_message: last } } } },
      { activity: { actor: 'app', text: last ? `the session's last message, as it ended without a report that reached planestro:\n${last.slice(-1500)}` : 'the session ended with no message of its own and no report that reached planestro' } },
    ], 'engine');
    this.blockOrRetry(id, 'connection_lost', `the session lost its connection to planestro at ${d.at}${d.tool ? ` (on ${d.tool})` : ''}: ${d.error}. The turn ended with no report that reached planestro, and none could be applied from the outbox. Its last message: ${last ? last.slice(-1500) : '(none)'}`, result);
    return true;
  }

  /**
   * A report the session made that never reached planestro (#167, sdk-notes gotcha 11): applied now through the same
   * tool, with the arguments the session gave it, so finished work lands without a retry turn or an orchestrator wake.
   * The tools are idempotent, so a call that did land after all is not recorded twice. Sets the result's
   * planSubmitted / done / blocked as the call would have.
   */
  async ingestOutbox(id: string, result: TurnResult): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const box = (fm.op_data?.outbox as UndeliveredReport | undefined) ?? result.undelivered;
    if (!box || fm.taken_over) return;
    const rejected = fm.op_data?.rejected_report as { report?: UndeliveredReport } | undefined;
    if (rejected?.report?.tool === box.tool && JSON.stringify(rejected.report.args) === JSON.stringify(box.args)) return;
    const reject = (reason: string) => {
      const { outbox: _box, ...data } = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {};
      this.ctx.store.mutateItem(id, [
        { set: { op_data: { ...data, rejected_report: { report: box, reason, at: this.ctx.now() } } } },
        { activity: { actor: 'app', text: `the session's ${box.tool} could not be recovered: ${reason}; report kept for inspection, not replayed` } },
      ], 'engine');
      // Terminal items need no new turn. Active work gets an explicit recovery decision,
      // never an idle slot or unbounded attempts to apply the same rejected report.
      if (this.ctx.phaseFor(this.ctx.store.requireItem(id).file.frontmatter.status))
        this.ctx.block(id, 'connection_lost', `Could not recover ${box.tool}: ${reason}. The report and its arguments are saved in rejected_report; inspect it before continuing.`);
    };
    const a = box.args ?? {};
    const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
    const text = ['submit_plan', 'submit_breakdown'].includes(box.tool) ? str(a.plan) : box.tool === 'report_done' ? str(a.summary) : str(a.reason);
    const fits = ['submit_plan', 'submit_breakdown'].includes(box.tool) ? fm.status === 'PLAN_IN_PROGRESS' || fm.status === 'PLAN_READY' : fm.status === 'IN_PROGRESS' || fm.status === 'IN_REVIEW' || (box.tool === 'report_blocked' && fm.status === 'PLAN_IN_PROGRESS');
    if (!text || !fits) { reject(!text ? 'it carried nothing to record' : `the item is ${fm.status} now`); return; }
    // A done refused for its debug markers (#240) is a refusal in words, not a lost connection: kept as rejected (so it is not
    // replayed again), and the session is resumed with the refusal to remove them and call report_done again.
    const marked = box.tool === 'report_done' ? await this.ctx.debugMarkersLeft(id) : undefined;
    const phase = this.ctx.phaseFor(fm.status);
    if (marked && phase) {
      const { outbox: _box, ...data } = fm.op_data ?? {};
      this.ctx.store.mutateItem(id, [
        { set: { op_data: { ...data, rejected_report: { report: box, reason: marked, at: this.ctx.now() } } } },
        { activity: { actor: 'app', text: `the session's report_done never reached planestro (${box.error}); applied from the turn's record it is refused: the branch still adds debug markers. Resuming the session to remove them` } },
      ], 'engine');
      result.requeued = marked;
      this.ctx.queueTurn(id, phase, `Your report_done never reached planestro (${box.error}). Applied from your turn's record, it was refused:\n\n${marked}`, [], [], { fresh: 'auto' });
      return;
    }
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `the session's ${box.tool} never reached planestro (${box.error}); applying it from the turn's record` } }], 'engine');
    const tools = this.ctx.makeTools(id);
    try {
      const answer = box.tool === 'submit_plan' ? await tools.submit_plan(text)
        : box.tool === 'submit_breakdown' ? await tools.submit_breakdown(text, a.children)
        : box.tool === 'report_done' ? await tools.report_done(text, a.parts, str(a.hold), list(a.attach), str(a.review), a.flags)
        : await tools.report_blocked(text, a.parts);
      if (answer.startsWith('Rejected')) { reject(answer); return; }
      if (box.tool === 'submit_plan' || box.tool === 'submit_breakdown') result.planSubmitted = text;
      else if (box.tool === 'report_done') result.done = text;
      else result.blocked = text;
      this.recordOutbox(id, undefined);
    } catch (e) { reject((e as Error).message.slice(0, 1000)); }
  }

  /**
   * Say once, when a turn carries an item past BUDGET_WARN_AT of a cap, that the stop is near (dogfood
   * p16, p24: HH-120 stopped one step from done, HH-118 crossed its token cap with a pack half drawn).
   * A raised cap starts the warning over.
   */
  private warnOnBudget(id: string, before: { cost_usd?: number; tokens?: number; agent_turns?: number }, after: { cost_usd?: number; tokens?: number; agent_turns?: number; budget_usd?: number; budget_turns?: number; budget_tokens?: number; parts?: Part[]; op_data?: Record<string, unknown> }): void {
    const b = this.ctx.budgetOf(after);
    const crossed = (was: number, now: number, cap: number) => was / cap < BUDGET_WARN_AT && now / cap >= BUDGET_WARN_AT;
    const lines: string[] = [];
    if (crossed(before.cost_usd ?? 0, after.cost_usd ?? 0, b.usd)) lines.push(`$${(after.cost_usd ?? 0).toFixed(2)} of its $${b.usd} budget (${b.usdKey}) is spent`);
    if (crossed(before.tokens ?? 0, after.tokens ?? 0, b.tokens)) lines.push(`${(after.tokens ?? 0).toLocaleString()} of its ${b.tokens.toLocaleString()} tokens (${b.tokensKey}) are used`);
    if (crossed(before.agent_turns ?? 0, after.agent_turns ?? 0, b.turns)) lines.push(`${after.agent_turns} of its ${b.turns} turns (${b.turnsKey}) are used`);
    // The forecast (f4): parts accepted so far against what they cost projects the whole. Said once per cap.
    const parts = after.parts ?? [];
    const accepted = parts.filter((p) => p.state === 'accepted').length;
    if (accepted > 0 && accepted < parts.length) {
      const key = `${b.usd}/${b.tokens}`;
      const spentUsd = after.cost_usd ?? 0, spentTok = after.tokens ?? 0;
      const projUsd = spentUsd / accepted * parts.length, projTok = spentTok / accepted * parts.length;
      const over = (spentUsd > 0 && projUsd > b.usd) || (spentTok > 0 && projTok > b.tokens);
      if (over && after.op_data?.parts_forecast_warned !== key) {
        lines.push(`at this rate the remaining parts will not fit: ${accepted} of ${parts.length} accepted so far${spentUsd > 0 ? ` for $${spentUsd.toFixed(2)}, all ${parts.length} project to ~$${projUsd.toFixed(0)} against $${b.usd}` : ''}${spentTok > 0 ? ` for ${spentTok.toLocaleString()} tokens, all ${parts.length} project to ~${Math.round(projTok).toLocaleString()} against ${b.tokens.toLocaleString()}` : ''}`);
        this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(after.op_data ?? {}), parts_forecast_warned: key } } }], 'engine');
      }
    }
    if (!lines.length) return;
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `budget warning: ${lines.join('; ')}. Raise it on the item page if the work is worth it, before it stops.` } }], 'engine');
    this.ctx.note('warn', `${id}: ${lines.join('; ')}`);
  }

  /**
   * Resolve a merge conflict on an epic's integration branch with a one-shot session (#71). Worker items
   * hand a conflict to their own session; an epic has none, so HH-205 (append-only LICENSES.md rows) and
   * LM-1 (main.ts split while LM-3 changed it) could only be resolved by a person at a terminal. The
   * session runs in the epic's merge worktree on its implementer, from a prompt rendered from persisted
   * state (invariant 3), under its own cap (epics.conflict_budget_usd); it merges and commits, never
   * pushes. planestro then checks the merge (finished, clean, contains origin/<base> and what GitHub has
   * of the branch: merges only, never rewritten) and pushes it plainly. Anything short of that puts the
   * worktree back where it was and says why; the session's attempt stays findable by its sha.
   * Returns 'resolved', or why not.
   */
  async resolveEpicConflict(id: string, cwd: string, base: string, baseSha: string, files: string[], hint?: string): Promise<string> {
    const cap = this.ctx.store.config.epics.conflict_budget_usd;
    if (!(cap > 0)) return 'conflict sessions are off (epics.conflict_budget_usd is 0)';
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) return 'you have taken this epic over';
    const branch = fm.branch!;
    const requested = this.ctx.store.config.models.find((m) => m.id === (fm.implementer ?? this.ctx.store.config.defaults.implementer));
    if (!requested) return `its implementer ${fm.implementer ?? this.ctx.store.config.defaults.implementer} is not a model row`;
    const acct = this.ctx.accountFor(fm, requested);
    if ('missing' in acct) return acct.why;
    const account = acct.account;
    const pick = resolveTurnModel(this.ctx.store.config, requested, { allow: fm.allow_model_fallback === true, unavailable: unavailableView(this.ctx.store.local.model_unavailable, account.name), now: new Date(Date.now()) });
    if (pick.exhaustedUntil) return `${requested.label} is out of usage until ${pick.exhaustedUntil}`;
    const def = pick.def;
    const runner = def.runner ?? 'claude';
    if (this.ctx.guards.paused || this.ctx.guarded(runner, account.name)) return `${runner} is paused`;
    const agent = this.ctx.ports.agents[runner];
    if (!agent) return `${def.label} needs the ${runner} runner, which is not available here`;
    const model = runner === 'claude' ? def.claude_model : def[`${runner}_model`];
    const remainingTokens = this.ctx.budgetOf(fm).tokens - (fm.tokens ?? 0);
    const tokenAccounting = modelCapabilities(def).accounting === 'tokens';
    const limitLabel = tokenAccounting ? `up to ${remainingTokens.toLocaleString()} remaining item tokens` : `up to $${cap}, epics.conflict_budget_usd`;
    if (tokenAccounting && (remainingTokens <= 0 || (fm.agent_turns ?? 0) >= this.ctx.budgetOf(fm).turns)) return 'the item token or turn budget is exhausted';
    const before = await this.ctx.ports.git.revParse(cwd, 'HEAD');
    const remote = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch);
    const desc = getSection(item.file, 'Description').trim();
    const prompt = [
      `You are resolving one merge conflict for planestro, in one session, and nothing else.`,
      `Epic ${id} — "${fm.title}". Its integration branch ${branch} is checked out in this worktree (${cwd}). Merging origin/${base} (${baseSha.slice(0, 12)}, already fetched) into it conflicts in:\n${files.map((f) => `- ${f}`).join('\n')}`,
      ...(desc ? [`What the epic is for:\n${desc.slice(0, 1200)}`] : []),
      ...(hint?.trim() ? [`The orchestrator's hint for this conflict:\n${hint.trim()}`] : []),
      [
        'Do exactly this:',
        `1. \`git merge --no-edit origin/${base}\`, then resolve every conflict so both sides' intent survives: what the epic's children built, and what landed on ${base}. An append-only file (licences, lists, changelogs, docs rows) keeps both sides' lines.`,
        '2. Check only as far as the conflict needs; the full checks run on the pull request after the push.',
        '3. `git add` what you resolved and `git commit --no-edit` to finish the merge.',
        '4. report_done with one line on how you resolved it, and end your turn.',
      ].join('\n'),
      `Never rebase, reset, push or force: ${branch} is shared, and planestro pushes it after checking your merge. If a conflict needs a decision the code cannot settle (two changes that truly contradict), run \`git merge --abort\` and report_blocked with that decision in one or two sentences.`,
    ].join('\n\n');
    const opId = this.ctx.store.journal.begin('conflict_session', id, { base, base_sha: baseSha, files, model: model ?? def.label });
    this.ctx.store.mutateItem(id, [{ set: { op: 'syncing_base', op_started_at: this.ctx.now() } }, { activity: { actor: 'app', text: `merging origin/${base} (${baseSha.slice(0, 7)}) into ${branch} conflicted in ${files.join(', ')}; a one-shot ${def.label} session resolves it in ${cwd} (${limitLabel})${hint?.trim() ? ` with the hint: ${hint.trim().slice(0, 200)}` : ''}` } }], 'engine', { commit: `${id}: conflict session` });
    const reported: { done?: string; blocked?: string } = {};
    const none = async () => 'not available in a conflict session: resolve the merge, then report_done or report_blocked';
    const tools: TurnTools = {
      submit_plan: none, submit_breakdown: none, add_note: none, report_progress: none, report_iteration: none, hand_off: none, request_audition: none,
      append_activity: async (t) => { this.ctx.store.mutateItem(id, [{ activity: { actor: 'worker', text: `[conflict session] ${String(t).slice(0, 500)}` } }], 'engine'); return 'appended'; },
      report_done: async (s) => { reported.done = String(s); return 'recorded: planestro checks your merge and pushes it. End your turn now.'; },
      report_blocked: async (r) => { reported.blocked = String(r); return 'recorded. End your turn now.'; },
      get_item: async () => `${id} "${fm.title}" (epic) — integration branch ${branch}, base ${base}`,
    };
    const rules = this.ctx.store.permissionRules();
    const allowed = [...BASE_ALLOWED.fix, 'Bash(git merge *)', ...rules.allow];
    const policy = makePolicy(this.ctx.store.config, base, cwd, {}, rules);
    const abort = new AbortController();
    const waiting = ((fm.op_data?.pending_messages as string[] | undefined) ?? []).length;
    this.ctx.turns.set(id, { model: model ?? def.label, phase: 'fix', startedAt: this.ctx.now(), lastOutput: '', abort, oneShot: 'conflict session', lastOutputAt: Date.now() });
    let result: TurnResult;
    try {
      result = await this.ctx.withRunnerSlot(runner, () => this.ctx.withSessionSlot(id, async () => {
        // A pause may arrive while this turn is waiting for another runner to release its slot.
        if (this.ctx.guards.paused || this.ctx.guards.draining || this.ctx.stopping || abort.signal.aborted || this.ctx.guarded(runner, account.name))
          return { subtype: 'killed', isError: false, costUsd: 0, numTurns: 0, text: '' };
        return agent.runTurn({
        itemId: id, phase: 'fix', cwd, model: model as string, transport: modelCapabilities(def).transport, ...runnerTurnSettings(def), ...this.ctx.accountTurnOptions(account), maxTokens: remainingTokens, permissionMode: 'acceptEdits', prompt,
        systemAppend: `${this.ctx.store.renderPrompt(modelCapabilities(def).workerPrompt, item)}\n\n${this.hostNote}${runner === 'claude' ? cwdNote(cwd) : ''}`,
        ...(pick.sdkFallback ? { fallbackModel: pick.sdkFallback } : {}),
        allowedTools: sdkRules(allowed, rules), extraDirs: [this.ctx.store.dataDir], maxBudgetUsd: cap, tools,
        // One shot, so nothing parks: what the rules do not allow is refused with a way forward.
        onPermission: async (req) => {
          const why = policy.deny(req);
          if (why) return { action: 'deny', message: `Not allowed: ${why}` };
          if (allowedByRules(req, allowed, cwd)) return { action: 'allow' };
          return { action: 'deny', message: 'Not allowed in a conflict session: resolve the merge with git and file edits. If you need something else, git merge --abort and report_blocked saying what.' };
        },
        onApproval: async (req) => { this.ctx.store.journal.append({ type: 'permission.declined', item: id, actor: 'engine', data: { ...req, reason: 'conflict session' } }); },
        onQuestion: async (questions) => { this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `conflict session question: ${JSON.stringify(questions)}` } }], 'engine', { commit: `${id}: record conflict question` }); },
        onOutput: (text) => { const t = this.ctx.turns.get(id); if (t) { t.lastOutput = text.slice(-400); t.lastOutputAt = Date.now(); } this.ctx.emit({ type: 'session.output', id, text }); },
        signal: abort.signal,
      });
      }, abort.signal), abort.signal);
    } finally { this.ctx.turns.delete(id); }
    this.recordUsage(id, def, model ?? def.label, 'worker', 'conflict_session', result, { stage: 'conflict', resumed: false });
    const after = this.ctx.store.requireItem(id).file.frontmatter;
    this.ctx.store.mutateItem(id, [{ set: { cost_usd: Math.round(((after.cost_usd ?? 0) + result.costUsd) * 10000) / 10000, turns: (after.turns ?? 0) + result.numTurns, tokens: (after.tokens ?? 0) + (result.tokens ?? 0), agent_turns: (after.agent_turns ?? 0) + (result.numTurns > 0 ? 1 : 0) } }, { unset: ['op', 'op_started_at'] }], 'engine');
    this.ctx.guards.usageSeen(result.rateLimit, guardKey(runner, account.name));
    const spendLabel = tokenAccounting ? `${(result.tokens ?? 0).toLocaleString()} tokens; dollar cost not reported` : `$${result.costUsd.toFixed(2)}`;
    const fail = async (why: string): Promise<string> => {
      await this.ctx.ports.git.abortInProgress(cwd).catch(() => undefined);
      const attempt = await this.ctx.ports.git.revParse(cwd, 'HEAD').catch(() => before);
      if (attempt !== before) await this.ctx.ports.git.resetHard(cwd, before);
      this.ctx.store.journal.end(opId, id, 'failed', { reason: why, attempt });
      this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `the conflict session did not resolve it: ${why}${attempt !== before ? `; its attempt is ${attempt.slice(0, 12)} (git show it), the worktree is back on ${before.slice(0, 7)}` : ''} (${spendLabel})` } }], 'engine', { commit: `${id}: conflict session failed` });
      return why;
    };
    // A one-shot session is never resumed, so what was said to it while it ran (#210) never reached it: its merge is not pushed over that word.
    const queued = ((this.ctx.store.requireItem(id).file.frontmatter.op_data?.pending_messages as string[] | undefined) ?? []);
    const arrived = queued.slice(waiting);
    if (arrived.length) {
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), pending_messages: queued.slice(0, waiting) } } }], 'engine');
      return fail(`messages arrived while it ran, and a one-shot session cannot read them: ${arrived.map((m) => `"${m.slice(0, 200)}"`).join('; ')}`);
    }
    if (result.subtype === 'killed') return fail('the session was stopped');
    const blocked = reported.blocked ?? result.blocked;
    if (blocked) return fail(`it needs a decision: ${blocked}`);
    const done = reported.done ?? result.done;
    if (!done) return fail(`it ended without reporting done (${result.subtype}${result.error ? `: ${result.error.slice(0, 160)}` : ''})`);
    // Positive evidence before the push (invariant 7's spirit): a finished merge, nothing left over, both histories in it.
    if (await this.ctx.ports.git.inProgressOp(cwd)) return fail('it reported done with the merge unfinished');
    const { clean, dirty } = await this.ctx.worktreeDirt(cwd);
    if (!clean) return fail(`it left uncommitted changes (${dirty.slice(0, 5).join(', ')})`);
    // The tip it merged, not origin/<base> now (#485): a base that moved while the session worked is the next sync's.
    if (!(await this.ctx.ports.git.isAncestor(cwd, baseSha, 'HEAD'))) return fail(`the result does not contain origin/${base} (${baseSha.slice(0, 7)})`);
    if (remote && !(await this.ctx.ports.git.isAncestor(cwd, remote, 'HEAD'))) return fail(`the result does not contain origin/${branch} (${remote.slice(0, 7)}): the branch was rewritten`);
    try { await this.ctx.ports.git.pushSetUpstream(cwd, branch); } catch (e) { return fail(`the push was refused (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)})`); }
    const head = await this.ctx.ports.git.revParse(cwd, 'HEAD');
    this.ctx.store.journal.end(opId, id, 'ok', { head, cost: result.costUsd });
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `the conflict session resolved the merge ("${done.slice(0, 300)}"); checked it (finished, clean, contains origin/${base} and origin/${branch}) and pushed ${head.slice(0, 7)} (${spendLabel})` } }], 'engine', { commit: `${id}: conflict resolved` });
    return 'resolved';
  }

  /**
   * Who will carry the plan out, said in code rather than in plan-item (data dirs keep their own
   * copies of it): a planner writing for an image-generating runner asked how it was meant to draw images
   * itself, and proposed drawing them procedurally (HH-114).
   */
  withImplementer(id: string, rendered: string): string {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const impl = this.ctx.store.config.models.find((m) => m.id === fm.implementer);
    if (!impl || fm.kind === 'epic') return rendered;
    const runner = impl.runner ?? 'claude';
    const lines = [`## Who implements this plan`, '', `${impl.label} (\`${impl.id}\`, ${runner} runner) carries out the approved plan, not you.${impl.description ? ` ${impl.description}` : ''}`];
    // Paid tools (#157): the plan states what they will cost in calls, and a person approves that number.
    if (impl.mcp.length) lines.push('', `It has ${impl.mcp.join(', ')} (MCP), and each call there costs money. State in the plan, under a line that starts \`MCP budget:\`, how many ${impl.mcp.join(' / ')} calls the work needs in all, generations and retries included, with a sentence of why. ${impl.user_approves_plans ? 'The user approves that number with the plan; past it the calls are refused.' : 'Past it the calls are refused.'}`);
    // A request that names a server its implementer lacks (#366, HH-538: "generate the takes with ElevenLabs" planned for a
    // worker with no ElevenLabs): the planner says which tools it calls, so approval can see the implementer cannot.
    const known = [...new Set([...Object.keys(this.ctx.store.local.mcp_servers ?? {}), ...this.ctx.store.config.models.flatMap((m) => m.mcp)])];
    const lacking = mcpServersNamed(`${getSection(this.ctx.store.requireItem(id).file, 'Description')}\n${getSection(this.ctx.store.requireItem(id).file, 'Notes')}`, known).filter((s) => !impl.mcp.some((x) => x.toLowerCase() === s.toLowerCase()));
    if (lacking.length) lines.push('', `The request names ${lacking.join(', ')} (MCP), which ${impl.label} does not have. If the work calls ${lacking.length > 1 ? 'them' : 'it'}, name each tool it calls in the plan as \`mcp__<server>__<tool>\` and state, under a line that starts \`MCP budget:\`, how many calls the work needs in all: approval then shows that the implementer must change to a model that has ${lacking.length > 1 ? 'them' : 'it'}. Do not plan around ${lacking.length > 1 ? 'them' : 'it'} (no placeholder assets, no other route to the service).`);
    if (fm.planner !== fm.implementer) lines.push('', `You are writing the brief it follows. Plan for what ${impl.label} can do${runner === 'claude' ? '' : ', and do not plan to do its work yourself (for example drawing images in code because you cannot generate them)'}: name the files it must produce, the checks that prove them, and anything it must not touch.`);
    return `${rendered}\n\n${lines.join('\n')}`;
  }

  /**
   * How a plain item's planner says "this is an epic", in code rather than in plan-item (data dirs keep
   * their own copies of it): HH-198 and HH-199 were planned as full breakdowns and handed in as plans,
   * approved as items, and each went to one implementer (#69). A child of an epic is not told: epics do not nest.
   */
  withEpicCheck(id: string, rendered: string): string {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (fm.kind === 'epic' || fm.parent) return rendered;
    return `${rendered}\n\n## If this is really an epic\n\nOne item is one piece of work that one implementer finishes in one pull request. If the request is really several separately shippable pieces (for example images an image model makes plus the code that uses them, or parts that each deserve their own worker and pull request), do not plan it as one item: call \`submit_breakdown\` instead of \`submit_plan\`, with \`plan\` (the approach and the seams between the pieces) and \`children\` (each \`{ "title", "description", "implementer", "depends_on": [indexes] }\`). Implementers:\n${this.implementersList()}\n\nplanestro records it as this item's plan, marked as an epic, and the user converts the item to an epic; your breakdown becomes the request its epic planner starts from. Then end your turn.`;
  }

  /** The models a breakdown can route children to, with what each is for. */
  implementersList(): string {
    return this.ctx.store.config.models.filter((m) => !m.external).map((m) => `- \`${m.id}\` — ${m.label} (runner ${m.runner ?? 'claude'}): ${m.description ?? (canPlan(m) ? 'general software work: code, tests, docs. Cannot generate images.' : 'no description configured')}`).join('\n');
  }

  /** A project whose copy of a template predates `{{dependencies.delivered}}` still gets the facts, appended. */
  withDelivered(id: string, template: string, rendered: string): string {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (!fm.depends_on.length || (this.ctx.store.getPrompt(template)?.file.body ?? '{{dependencies.delivered}}').includes('dependencies.delivered')) return rendered;
    return `${rendered}\n\n## Delivered by the items this one waited on\n\n${this.ctx.store.deliveredText(fm.depends_on)}`;
  }

  /** A loop item's rules (#171), from the `loop-until-green` partial: in code, so a data dir's older implement-plan still gets them. */
  withLoopNote(id: string, rendered: string): string {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (!fm.loop) return rendered;
    const st = fm.loop_state;
    const loop = { max_iterations: fm.loop.max_iterations, used: st?.iteration ?? 0, tally: st ? `${st.passing}/${st.total} passing` : 'none yet', goal: fm.loop.goal?.trim() || 'every check passes: the ones the plan names, and the project\'s full suite' };
    return `${rendered}\n\n${this.ctx.store.renderPrompt('loop-until-green', item, { loop })}`;
  }

  /**
   * What the implementer is told about a hold, in code rather than in implement-plan (data dirs keep
   * their own copies of it): it does the work as usual and never waits for the hold itself.
   */
  withHoldNote(id: string, rendered: string): string {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.skip_merge) return `${rendered}\n\n## Merge hold\n\nThis item's pull request is held out of the merge queue${fm.hold_reason ? `: ${fm.hold_reason}` : ''}. Do the work and report it done as usual: planestro opens the pull request, shows its CI, and does not merge it until the user releases the hold. Do not wait for anything yourself; there is no need to pass \`hold\`.`;
    const stated = fm.op_data?.hold_waived ? holdShapeOf(getSection(item.file, 'Plan')) : null;
    if (stated) return `${rendered}\n\n## Merge hold\n\nThe plan says "${stated.quote}" The user approved it without that hold: the pull request merges as usual, so do not ask for a hold when you report the work done.`;
    return rendered;
  }
}
