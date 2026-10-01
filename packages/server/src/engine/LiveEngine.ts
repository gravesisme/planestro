import { join, relative, isAbsolute, extname, basename, matchesGlob } from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resumeEstimate, resumeRates, chooseTurnPath, minRaiseUsd, MIN_TURN_USD, FRESH_FLOOR_USD, WARM_SHARE, type DecisionOption, type ResumeEstimate, type SessionContext, type ItemFrontmatter, validateParts, partsSummary, type Part, serializeItemFile, getSection, idNumber, slugify, isoLocal, renderPrompt, findTransition, waitsFor, canPlan, resolveTurnModel, fallbackChain, unavailableEntry, markUnavailable, unavailableUntil, validateBreakdown, dependencyOrder, validateDecision, decisionOf, isDone, findModel, epicFlagOf, epicShapeOf, holdShapeOf, kindConversionRefusal, type EpicFlag, type ProposedChild, type BreakdownChild, type DecisionInput, type DecisionAction, type Decision, type ServerEvent, type Status, usageGuardTrips, usageWindowLabel, usagePercent, localClock, type RateLimitSnapshot, type UsageGuardState, demoteH1 } from '@planestro/shared';
import type { DataStore, StoredItem, ItemOp } from '../store/DataStore.ts';
import type { Engine, SessionView } from './Engine.ts';
import { matchesPathPattern, type Ports, type TurnPhase, type TurnResult, type TurnTools, type PermissionRequest, type McpServerSpec, type RebaseResult, type ResumeQuote } from './ports.ts';
import { makePolicy, ruleFor, allowedByRules, sdkRules, BASE_ALLOWED } from './policy.ts';
import { commandShape } from './parks.ts';
import { hostNote, keptPathsNote, cwdNote } from './hostNote.ts';
import { Orchestrator } from './orchestrator.ts';
import { pngSize } from './placeholderPng.ts';
import { findWorkflow, prSkippedByPaths } from './ciFilters.ts';
import type { ReviewImage } from './Engine.ts';

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg)$/i;
/** What a person reviews by eye or ear (f5): images, sounds a sound worker made, models a 3D worker made. */
const AUDIO_FILE = /\.(mp3|wav|ogg|flac|m4a|aac)$/i;
const MODEL_FILE = /\.(glb|gltf|obj|fbx)$/i;
const reviewKind = (path: string): 'image' | 'audio' | 'model' | undefined => IMAGE_FILE.test(path) ? 'image' : AUDIO_FILE.test(path) ? 'audio' : MODEL_FILE.test(path) ? 'model' : undefined;

/** `schedule` runs `fn` after `ms` and returns a cancel (tests capture it instead of waiting). */
export interface EngineOptions { sleep?: (ms: number) => Promise<void>; tickMs?: number; now?: () => string; ciWorkflow?: string; schedule?: (fn: () => void, ms: number) => () => void }

const RESUMABLE_TURN_OPS = new Set(['planning_turn', 'implement_turn']);
/** How many of one item's permission requests the orchestrator may refuse before they go to the user instead. */
const MAX_ORCHESTRATOR_DENIALS = 3;
const JUDGMENT_BLOCKS = ['turn_error', 'no_plan', 'no_commits', 'dirty_tree', 'sync_conflict', 'ci_red', 'ci_timeout', 'ci_blocked', 'ci_disagree', 'base_red', 'pr_closed_externally', 'merge_unverified', 'agent_blocked', 'engine_error'] as const;
const ACTIVE_FOR_SLOTS: Status[] = ['PLAN_IN_PROGRESS', 'IN_PROGRESS'];
/** Turn failures with their own block reason, because the fix is the user's (log in, wait, start over) and not a judgment call. */
const ACTIONABLE_FAILURES = new Set(['auth_required', 'rate_limited', 'session_lost', 'spawn_error', 'cli_too_old']);
/** Spend past this share of a budget is said out loud once (Activity and the log), before the hard stop. */
const BUDGET_WARN_AT = 0.8;
/** What a sandbox says when it refused git's own files (the worktree's index.lock lives outside the worktree). */
const GIT_REFUSAL = /index\.lock|\.git\/worktrees|EPERM|Operation not permitted|Permission denied/i;
/** A block that is about committing ("planestro needs to commit this", "complete but uncommitted", "nothing added to commit"). */
const ASKS_COMMIT = /commit|\bstag(e|ing)\b/i;
/** How many stops of one item, in one status, the orchestrator triages before the rest go straight to the user (a fix that keeps failing is a conversation for a person). */
const MAX_TRIAGE_ROUNDS = 4;
/**
 * How a turn is started. `opener`: the phase's own first prompt. `note`: why the session was parked,
 * said first when it is resumed and left out when the conversation is new. `fresh`: `true` asks for a
 * new conversation with a brief; `'auto'` lets the engine choose one, for a prompt that stands on its
 * own (a CI failure, a conflict, a reminder, an instruction) and never for an answer to something the
 * session itself asked. `carryOn`: the prompt only says "continue", so an interrupted fresh turn keeps
 * the task it was given. `final`: the prompt is already what the agent is to read (a re-run).
 */
interface TurnOpts { opener?: boolean; fresh?: true | 'auto'; note?: string; carryOn?: boolean; final?: boolean; estimate?: ResumeEstimate }

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

/** What `set_item_fields` may touch: the item's own wiring, never its lifecycle, sessions or history. */
const ORCHESTRATOR_FIELDS = ['parent', 'depends_on', 'base_branch_override', 'skip_merge', 'implementer', 'allow_model_fallback'] as const;

/**
 * The Phase 3 lifecycle: one worker item at a time through
 * QUEUED → worktree → plan → (approval) → implement → PR → rebase → CI → merge → cleanup → FINISHED.
 * Deterministic; every step persists `op` before acting and journals begin/end.
 */
/** How long a just-pushed head may still read as the old sha from `gh pr view` before it counts as a real move. */
const HEAD_PROPAGATION_GRACE_MS = 90_000;
/** How often a held (skip_merge) pull request's branch and CI are looked at: one `ls-remote` and one run listing per item. */
const HELD_POLL_MS = 60_000;
/**
 * Polls in a row (10 s apart) that find only skipped runs for a ready PR's head before planestro
 * sends ready_for_review again. GitHub starts the event's run within seconds; a minute of nothing
 * but skipped runs means the event landed on another head, and no run is coming by itself.
 */
const SKIPPED_REFIRE_POLLS = 6;
/** Polls in a row that the head's newest run stays cancelled before planestro re-runs it (about a minute at the start). */
const CANCELLED_RERUN_POLLS = 6;
/** Held polls (one a minute) a new head's preview deployment is looked for before planestro stops asking. */
const PREVIEW_TRIES = 10;
/** What a worker may put on its item for the user to see (#137): pictures and videos. */
const ATTACHABLE = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov)$/i;
/** Looks (5 s apart) at a just-pushed PR's head before it is marked ready anyway. */
const READY_AFTER_PUSH_POLLS = 6;
/** A guard-made pause resumes this long after its window's reset, so the first turn lands in the fresh window. */
const USAGE_RESUME_GRACE_MS = 60_000;
/** Two readings of one window whose resets differ by less than this are the same crossing. */
const SAME_CROSSING_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What a sync with the base did (LiveEngine.syncBranch). */
type SyncOutcome =
  | { kind: 'current'; base: string; baseSha: string }
  | { kind: 'synced'; base: string; baseSha: string; head: string; pushed: boolean; integration: boolean }
  | { kind: 'dirty'; base: string; behind: number; files: string[] }
  | { kind: 'diverged'; base: string; local: string; remote: string }
  | { kind: 'conflict'; base: string; baseSha: string; files: string[]; integration: boolean; cwd: string };

export class LiveEngine implements Engine {
  readonly mode: 'live' | 'dry-run';
  log: ServerEvent[] = [];
  private _paused: boolean;
  private jobs = new Map<string, Promise<void>>();
  /** Turns this engine started. `waiting` names the slot the turn is still queued for, a runner's (concurrency.runner_limits) or `session` (max_sessions): no process yet. */
  private turns = new Map<string, { model: string; phase: TurnPhase; startedAt: string; lastOutput: string; abort: AbortController; waiting?: string }>();
  /** Agent turns holding one of `concurrency.max_sessions` slots, and the turns queued for one (withSessionSlot). */
  private sessionTurns = 0;
  private sessionWaiters: Array<() => void> = [];
  private mergeChain: Promise<void> = Promise.resolve();
  /** The machine's facts for every session's system prompt (hostNote), read once. */
  private readonly hostNote = hostNote();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private cancelGuardResume?: () => void;
  private readonly now: () => string;
  private readonly ciWorkflow: string;
  private localJobs = 0;
  private runnerTurns = new Map<string, number>();
  private runnerWaiters = new Map<string, (() => void)[]>();
  private localJobWaiters: (() => void)[] = [];
  readonly orchestrator: Orchestrator;

  constructor(private readonly store: DataStore, private readonly ports: Ports, private readonly emit: (e: ServerEvent) => void, private readonly opts: EngineOptions = {}) {
    this.mode = ports.mode;
    this._paused = store.local.engine.paused;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.schedule = opts.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    this.now = opts.now ?? isoLocal;
    this.ciWorkflow = opts.ciWorkflow ?? 'CI';
    this.orchestrator = new Orchestrator(store, ports, {
      message: (id, text) => this.message(id, text, 'orchestrator'),
      approvePlan: (id, notes, hold) => this.approvePlan(id, notes, 'orchestrator', { hold }),
      holdMerge: (id, reason) => this.orchestratorHolds(id, reason),
      convertKind: (id, to, why) => this.convertKind(id, to, 'orchestrator', why).catch((e) => (e as Error).message),
      planEpic: (id, why) => this.planEpic(id, why),
      actionRefusal: (action) => this.actionRefusal(action),
      submitForUser: (id, why) => this.submitAsUser(id, why),
      requestPlanChanges: (id, m) => this.orchestratorRequestsPlanChanges(id, m),
      amendPlan: (id, m) => this.orchestratorAmendsPlan(id, m),
      planDelegated: (id) => this.planDelegated(this.store.requireItem(id).file.frontmatter),
      handPlanToUser: (id, reason) => this.handPlanToUser(id, `the orchestrator left it to you: ${reason}`),
      planReviewEnded: (id) => this.handPlanToUser(id, 'the orchestrator reviewed it without deciding'),
      permissionsDelegated: () => this.permissionsDelegated(),
      decidePermission: (id, decision, reason) => this.orchestratorDecidesPermission(id, decision, reason),
      permissionReviewEnded: (id) => this.handPermissionToUser(id, 'the orchestrator looked at it without deciding'),
      handOff: (from, to, paths, note) => this.handOff(from, to, paths, note, 'orchestrator'),
      unblock: (id, message, syncFirst, fresh) => this.orchestratorUnblocks(id, message, syncFirst, fresh),
      commitPaths: (id, paths, message) => this.commitPaths(id, paths, message, 'orchestrator'),
      budgetLine: (id) => this.budgetLine(id),
      syncWithBase: (id) => this.syncWithBase(id, { by: 'orchestrator' }),
      resolveEpicConflict: (id, hint) => this.retryEpicConflict(id, hint, 'orchestrator'),
      answerQuestion: (id, answers) => this.orchestratorAnswers(id, answers),
      setItemFields: (id, fields) => this.orchestratorSetsFields(id, fields),
      recreateWorktree: (id, message) => this.recreateWorktree(id, message),
      retryOp: (id) => this.retryOp(id),
      rerunCi: (id) => this.rerunCi(id, 'orchestrator'),
      acceptScope: (id) => this.acceptScope(id),
      busyWith: (id) => this.busyWith(id),
      resumeAfter: (id, items, message, prs) => this.resumeAfter(id, items, message, 'orchestrator', prs ?? []),
      finishFromWorktree: (id) => this.finishFromWorktree(id, 'orchestrator'),
      askUserDecision: (id, input) => this.askUserDecision(id, input),
      withdrawDecision: (id, reason) => this.withdrawDecision(id, reason),
      triageEnded: (id) => this.endTriage(id, 'the orchestrator looked at it without resolving it'),
      poke: () => this.poke(),
      usageSeen: (r) => this.usageSeen(r),
    }, emit, (l, m) => this.note(l, m), () => this._paused || this.draining);
  }

  /** Fire-and-forget judgment wake (invariant 4: never for anything a state machine can know). */
  private wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void {
    if (item && this.store.getItem(item)?.file.frontmatter.taken_over) return; // a person has it: nothing to judge
    this.orchestrator.wake({ type, item, data });
  }

  get paused(): boolean { return this._paused; }
  private get repo(): string { return this.store.codeRepoPath(); }
  private get github(): string { const g = this.store.config.code_repo.github; if (!g) throw new Error('code_repo.github is not configured'); return g; }

  // ---- lifecycle ----
  private reconcileTimer?: NodeJS.Timeout;

  async start(): Promise<void> {
    this.note('info', `engine ${this.mode} starting${this._paused ? ' (paused)' : ''}`);
    await this.reconcile('startup').catch((e) => this.note('error', `reconcile: ${(e as Error).message}`));
    await this.resumeInterrupted();
    for (const q of this.orchestrator.resumeQuestions()) this.note('info', `${q}: answering the message a restart left unanswered`);
    this.armGuardResume();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 10_000);
    this.timer.unref?.();
    this.reconcileTimer = setInterval(() => void this.reconcile('periodic').catch(() => undefined), 5 * 60_000);
    this.reconcileTimer.unref?.();
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.orchestrator.stop();
    this.cancelGuardResume?.(); this.cancelGuardResume = undefined;
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const t of this.turns.values()) t.abort.abort();
    await Promise.allSettled([...this.jobs.values()]);
  }
  /** The lever by hand. A manual pause is the user's: the usage guard never resumes it. */
  pause(): void { this.setPaused(true, 'user'); this.note('warn', 'AUTOMATION PAUSED — running steps finish, nothing new starts'); }
  /** By hand this also dismisses a usage-guard pause (and its timer) for the rest of that window crossing. */
  resume(message = 'automation resumed'): void { this.setPaused(false); this.note('info', message); this.orchestrator.kick(); void this.tick(); }
  private setPaused(paused: boolean, by?: 'user' | 'usage_guard', guard?: UsageGuardState): void {
    this.cancelGuardResume?.(); this.cancelGuardResume = undefined;
    this._paused = paused;
    this.store.updateLocal({ engine: { ...this.store.local.engine, paused, paused_by: paused ? by : undefined, usage_guard: guard, ...(guard ? { usage_guard_last: { window: guard.window, ...(guard.resets_at ? { resets_at: guard.resets_at } : {}), tripped_at: guard.tripped_at } } : {}) } });
    this.emit({ type: 'engine.paused', paused, ...(paused && by ? { by } : {}) });
  }

  // ---- usage guard: pause before a subscription window runs out, resume once it resets ----
  /** Read after every Claude turn and orchestrator wake. Trips once per window crossing, and never over a pause already in place. */
  private usageSeen(r: RateLimitSnapshot | undefined): void {
    const cfg = this.store.config.usage_guard;
    if (!r || this.stopping || this._paused || !usageGuardTrips(cfg, r)) return;
    const last = this.store.local.engine.usage_guard_last;
    if (last && last.window === r.window && (r.resetsAt && last.resets_at ? Math.abs(Date.parse(r.resetsAt) - Date.parse(last.resets_at)) < SAME_CROSSING_MS : !r.resetsAt && !last.resets_at && Date.now() - Date.parse(last.tripped_at) < 3_600_000)) return;
    const resumeAt = cfg.auto_resume && r.resetsAt ? new Date(Date.parse(r.resetsAt) + USAGE_RESUME_GRACE_MS).toISOString() : undefined;
    const guard: UsageGuardState = { window: r.window, status: r.status, ...(r.utilization !== undefined ? { utilization: r.utilization } : {}), ...(r.resetsAt ? { resets_at: r.resetsAt } : {}), tripped_at: new Date(Date.now()).toISOString(), ...(resumeAt ? { resume_at: resumeAt } : {}) };
    this.setPaused(true, 'usage_guard', guard);
    this.store.journal.append({ type: 'usage.guard_tripped', actor: 'engine', data: { ...guard, threshold: cfg.threshold } });
    this.note('warn', `USAGE GUARD: ${usageWindowLabel(r.window)} window ${usagePercent(r.utilization) ? `at ${usagePercent(r.utilization)}` : r.status === 'rejected' ? 'is exhausted' : 'sent a usage warning'} — automation paused ${resumeAt ? `until ${localClock(resumeAt)}` : r.resetsAt ? `(the window resets at ${localClock(r.resetsAt)}; resume by hand)` : 'until you resume it'}; running turns finish, nothing new starts`);
    this.announce('on_usage_pause', 'planestro paused', `Automation paused: the ${usageWindowLabel(r.window)} usage window ${usagePercent(r.utilization) ? `is at ${usagePercent(r.utilization)}` : 'is near its limit'}`);
    this.armGuardResume();
  }

  /**
   * An event worth hearing about away from the browser (#70): journaled as a `notification`, which an open
   * planestro tab shows as a desktop notification if this device opted in (under planestro's own icon once the
   * web app is installed), and the project's notifications.* command run with PLANESTRO_TITLE / PLANESTRO_MESSAGE.
   */
  private announce(event: 'on_merge' | 'on_usage_pause', title: string, message: string, item?: string): void {
    this.store.journal.append({ type: 'notification', ...(item ? { item } : {}), actor: 'engine', data: { event, title, message } });
    const cmd = this.store.config.notifications[event];
    if (cmd) void this.ports.proc.run(cmd, { cwd: this.repo, timeoutMs: 30_000, env: { PLANESTRO_TITLE: title, PLANESTRO_MESSAGE: message } }).catch(() => undefined);
  }

  async testNotification(event: 'on_merge' | 'on_usage_pause'): Promise<{ code: number; output: string }> {
    const cmd = this.store.config.notifications[event];
    if (!cmd) throw new Error(`notifications.${event} is not set`);
    const r = await this.ports.proc.run(cmd, { cwd: this.repo, timeoutMs: 30_000, env: { PLANESTRO_TITLE: 'planestro', PLANESTRO_MESSAGE: `a test of notifications.${event}` } });
    return { code: r.code, output: `${r.stdout}${r.stderr}`.trim().slice(0, 2000) };
  }

  /** (Re)arm the guard's resume from local config — at trip and at startup; one already due resumes now. */
  private armGuardResume(): void {
    this.cancelGuardResume?.(); this.cancelGuardResume = undefined;
    const due = this.guardResumeDue();
    if (due === undefined || this.stopping) return;
    const ms = due - Date.now();
    if (ms <= 0) { this.guardResume(); return; }
    this.cancelGuardResume = this.schedule(() => { this.cancelGuardResume = undefined; if (ms > MAX_TIMER_MS) this.armGuardResume(); else this.guardResume(); }, Math.min(ms, MAX_TIMER_MS));
  }
  /** When a guard-made pause is due to resume (epoch ms), or undefined when nothing will resume it. */
  private guardResumeDue(): number | undefined {
    const e = this.store.local.engine;
    if (!this._paused || e.paused_by !== 'usage_guard' || !e.usage_guard?.resume_at || !this.store.config.usage_guard.auto_resume) return undefined;
    const t = Date.parse(e.usage_guard.resume_at);
    return Number.isFinite(t) ? t : undefined;
  }
  private guardResume(): void {
    if (this.stopping || this.guardResumeDue() === undefined) return;
    const g = this.store.local.engine.usage_guard!;
    this.store.journal.append({ type: 'usage.guard_resumed', actor: 'engine', data: { window: g.window, resets_at: g.resets_at } });
    this.resume(`automation resumed: the ${usageWindowLabel(g.window)} usage window has reset`);
  }
  /**
   * Getting ready for a restart (f3). Like PAUSE AUTOMATION, nothing new starts (no admissions, no
   * merge steps, no orchestrator wakes) and what runs finishes, but it is not persisted: planestro
   * comes back from the restart running. Items in triage keep waiting (the wake after the restart
   * picks them up). restartReadiness says when nothing is left running.
   */
  private draining = false;
  /** Who asked: the Console's button (`user`), or `serve --watch` restarting onto new planestro code (`update`, #90). */
  private drainedBy: 'user' | 'update' = 'user';
  drain(by: 'user' | 'update' = 'user'): void {
    this.draining = true; this.drainedBy = by;
    this.emit({ type: 'engine.paused', paused: this._paused });
    this.note('warn', by === 'update' ? 'updating planestro: running steps finish, nothing new starts, then it restarts and carries on' : 'preparing to restart: running steps finish, nothing new starts');
  }
  undrain(): void { this.draining = false; this.drainedBy = 'user'; this.emit({ type: 'engine.paused', paused: this._paused }); this.note('info', 'restart preparation cancelled; carrying on'); this.orchestrator.kick(); void this.tick(); }
  /**
   * What still runs (turns, engine steps, ops in flight, an orchestrator wake): empty means a restart loses nothing.
   * A wait for CI (`op: awaiting_ci`) is not counted: it is GitHub's to finish, and the next start picks the wait
   * up where it was (watchCi leaves the op for exactly that). Counting it held every restart for a whole CI run,
   * and a drain starts no poll, so an item waiting when the drain began kept it from ever being idle (#90).
   */
  restartReadiness(): { draining: boolean; by?: 'user' | 'update'; idle: boolean; running: string[] } {
    const waitingCi = (id: string) => this.store.getItem(id)?.file.frontmatter.op === 'awaiting_ci';
    const running = [
      ...[...this.turns.entries()].map(([id, t]) => `${id}: ${t.phase} turn`),
      ...[...this.jobs.keys()].filter((id) => !this.turns.has(id) && !waitingCi(id)).map((id) => `${id}: engine step`),
      ...this.store.listItems().filter((i) => i.file.frontmatter.op && i.file.frontmatter.op !== 'awaiting_ci' && !this.jobs.has(i.id) && !this.turns.has(i.id)).map((i) => `${i.id}: ${i.file.frontmatter.op}`),
      ...(this.orchestrator.busy ? ['orchestrator: a wake'] : []),
    ];
    return { draining: this.draining, ...(this.draining ? { by: this.drainedBy } : {}), idle: running.length === 0, running };
  }
  poke(): void { void this.tick(); }
  sessions(): SessionView[] {
    return [...this.turns.entries()].map(([item, t]) => ({ item, session_id: this.store.getItem(item)?.file.frontmatter.session_id, model: t.model, op: t.waiting ? `${t.phase}: waiting for a ${t.waiting} slot` : t.phase, started_at: t.startedAt, busy: !t.waiting, last_output: t.lastOutput }));
  }

  /** Run one scheduling pass. Idempotent; safe to call often. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    // Before the pause check: while automation is paused the orchestrator is not woken, so nothing may sit in triage.
    if (this.draining) return;
    try { this.driveTriage(); } catch (e) { this.note('error', `triage: ${(e as Error).message}`); }
    // A backstop for the guard's timer (a machine that slept through it): resume once the reset has passed.
    const due = this.guardResumeDue();
    if (due !== undefined && due <= Date.now()) { this.guardResume(); return; }
    if (this._paused) return;
    try {
      this.admit();
      this.nudgeStaleReviews();
      this.driveStaleBlocks();
      this.drivePlanReviews();
      this.drivePermissionReviews();
      await this.driveEpics();
      await this.driveExternal();
      this.driveInReview();
      this.driveHeld();
      await this.driveStalls();
      this.driveResumeAfter();
    } catch (e) { this.note('error', `tick: ${(e as Error).message}`); }
  }

  /** A review nobody has looked at for `review.nudge_after_min` wakes the orchestrator once — to remind, never to approve. */
  private nudgeStaleReviews(): void {
    const after = this.store.config.review.nudge_after_min * 60_000;
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.awaiting !== 'review' || fm.taken_over || fm.op_data?.review_nudged || Date.now() - new Date(fm.updated_at).getTime() < after) continue;
      this.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), review_nudged: true } } }], 'engine');
      this.wakeOrchestrator('review_pending', item.id, { waiting_min: Math.round((Date.now() - new Date(fm.updated_at).getTime()) / 60_000) });
    }
  }

  /**
   * An item holds a session slot while something is driving it: a live turn, an engine step, or an
   * op in flight. An item that only sits in an active status does not (HH-109 idled five days after
   * a messageless unblock and held a slot throughout), and an epic never does: its children do the work.
   */
  private holdsSlot(i: StoredItem): boolean {
    const fm = i.file.frontmatter;
    if (this.turns.has(i.id)) return true;
    if (fm.kind === 'epic' || !ACTIVE_FOR_SLOTS.includes(fm.status)) return false;
    return this.jobs.has(i.id) || Boolean(fm.op);
  }

  private admit(): void {
    const items = this.store.listItems();
    const active = items.filter((i) => this.holdsSlot(i)).length;
    let free = this.store.config.concurrency.max_sessions - active;
    for (const item of items) {
      if (free <= 0) break;
      const fm = item.file.frontmatter;
      if (fm.status !== 'QUEUED' || this.jobs.has(item.id) || fm.taken_over) continue;
      let d = this.store.derived(item);
      if (d.flavor !== 'worker' || !d.deps_satisfied) continue;
      if (fm.parent) {
        const parent = this.store.getItem(fm.parent);
        if (!parent) continue;
        if (parent.file.frontmatter.status === 'NOT_YET_SUBMITTED') { this.runJob(fm.parent, () => this.openEpic(fm.parent!)); continue; }
        if (parent.file.frontmatter.status !== 'IN_PROGRESS') continue;
        d = this.store.derived(item);
      }
      if (!d.base_branch) continue;
      free -= 1;
      this.runJob(item.id, () => this.startItem(item.id));
    }
  }

  /**
   * Stall detection (f1). An item planning or in progress with no live turn, no engine step, no op,
   * not waiting on anyone (a person, the orchestrator, or other items to merge: resume_after) and not blocked has nothing driving it. Past `stall_after_min` it is carried
   * on once: committed work goes to its pull request, otherwise the session is resumed (an item that
   * never had a conversation, like HH-123 orphaned between its setup and its first turn, gets the full prompt).
   * A second stall within the hour is not retried again: it blocks as `stalled` for triage.
   */
  private idleSince = new Map<string, number>();
  private async driveStalls(): Promise<void> {
    const after = this.store.config.concurrency.stall_after_min * 60_000;
    if (!after) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (!ACTIVE_FOR_SLOTS.includes(fm.status) || fm.kind === 'epic' || this.store.derived(item).flavor !== 'worker') continue;
      // Parked with resume_after, it waits for other items to merge (HH-265 on HH-272, whose PR was held): the resume is
      // theirs to trigger. Carried on, it re-reported the same block and woke the orchestrator for nothing.
      if (this.turns.has(item.id) || this.jobs.has(item.id) || this.followUps.has(item.id) || fm.op || fm.awaiting || fm.blocked || fm.triage || fm.taken_over || fm.resume_after) continue;
      seen.add(item.id);
      const since = this.idleSince.get(item.id) ?? now;
      this.idleSince.set(item.id, since);
      if (now - since < after) continue;
      this.idleSince.delete(item.id);
      const idleMin = Math.round((now - since) / 60_000);
      const last = Date.parse(String(fm.op_data?.stall_resumed_at ?? ''));
      if (Number.isFinite(last) && now - last < 60 * 60_000) { this.block(item.id, 'stalled', `nothing has driven this item for ${idleMin} min, again within an hour of being carried on; look at its worktree and Activity`); continue; }
      this.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), stall_resumed_at: this.now() } } }, { activity: { actor: 'app', text: `stalled: nothing has driven this item for ${idleMin} min; carrying on from where it stopped` } }], 'engine', { commit: `${item.id}: stalled, carried on` });
      this.runJob(item.id, () => this.carryOnStalled(item.id));
    }
    for (const id of this.idleSince.keys()) if (!seen.has(id)) this.idleSince.delete(id);
  }

  /** Carry an idle item on from where it stands: committed work goes to its pull request, otherwise the session resumes. `from` says who found it idle, and why. */
  private async carryOnStalled(id: string, from: { why: string; who: string; say: string } = { why: 'stalled', who: 'planestro (it found this item idle)', say: 'Nothing was driving this item: your last turn ended without finishing the step. Check your worktree and continue where you left off.' }): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const dir = fm.worktree ? this.absWorktree(fm.worktree) : undefined;
    const exists = dir ? (await this.ports.git.worktreeList(this.repo)).some((w) => w.path === dir && !w.prunable) : false;
    // A missing worktree is triage's to judge (recreate_worktree, or retry_op's requeue), not a stall's.
    if (!exists) { this.block(id, 'worktree_missing', `${from.why} with its worktree ${fm.worktree ?? '(none)'} missing; nothing recreated`); return; }
    if (fm.status === 'IN_PROGRESS') {
      const { clean } = await this.worktreeDirt(dir!);
      const base = this.store.derived(item).base_branch;
      const ahead = clean && base ? (await this.ports.git.aheadBehind(dir!, `origin/${base}`, 'HEAD')).ahead : 0;
      if (ahead > 0) { await this.afterWorkTurn(id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done: String(fm.op_data?.done_summary ?? '') || undefined }); return; }
    }
    const phase = this.phaseFor(fm.status)!;
    await this.runTurnFor(id, phase, from.say, [], [], { fresh: 'auto', note: from.who, carryOn: true });
  }

  /**
   * An IN_PROGRESS worker item that is agent_blocked yet carries a done_summary finished after its
   * block (report_blocked drops any earlier summary), but nothing cleared the flag, so no turn end
   * ever ran the done check. Clear it and run that check: clean tree + commits ahead → pull request.
   */
  private driveStaleBlocks(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.status !== 'IN_PROGRESS' || !fm.blocked || fm.blocked_reason !== 'agent_blocked' || (fm.awaiting && fm.awaiting !== 'user')) continue;
      const done = fm.op_data?.done_summary as string | undefined;
      if (!done || !fm.worktree || fm.taken_over || this.store.derived(item).flavor !== 'worker' || this.jobs.has(item.id) || this.turns.has(item.id)) continue;
      this.store.mutateItem(item.id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: 'app', text: 'cleared a stale agent_blocked flag (the session reported done after it); checking the work' } }], 'engine', { commit: `${item.id}: clear stale block` });
      this.runJob(item.id, () => this.afterWorkTurn(item.id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done }));
    }
  }

  // ---- plan approval delegated to the orchestrator ----
  /** The item opted in, the project allows it, and there is an orchestrator to ask. Never an epic's breakdown. */
  private planDelegated(fm: { kind?: string; auto_approve_plan?: boolean; implementer?: string }): boolean {
    // A paid-tool model's plan carries a budget a person approves (#157): never delegated.
    if (findModel(this.store.config, fm.implementer)?.user_approves_plans) return false;
    return Boolean(fm.auto_approve_plan) && fm.kind !== 'epic' && this.store.config.orchestrator.may_approve_plans && this.orchestrator.enabled;
  }

  /**
   * A delegated plan is parked on the orchestrator (`awaiting: orchestrator`, which is not "needs
   * you"), and nothing about that may depend on memory: the wake queue does not survive a restart,
   * the box can be ticked after the plan arrived, and it can be unticked while the review runs.
   */
  private drivePlanReviews(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.status !== 'PLAN_READY' || fm.blocked || fm.taken_over || fm.awaiting_data?.kind === 'permission') continue;
      if (fm.awaiting === 'orchestrator') {
        if (!this.planDelegated(fm)) this.handPlanToUser(item.id, 'its approval is no longer delegated to the orchestrator');
        else if (!this.orchestrator.reviewing(item.id)) this.wakeOrchestrator('plan_review', item.id);
      } else if (fm.awaiting === 'plan_approval' && this.planDelegated(fm) && !fm.op_data?.plan_handed_back) {
        this.store.mutateItem(item.id, [{ set: { awaiting: 'orchestrator' } }, { activity: { actor: 'app', text: 'plan approval delegated to the orchestrator' } }], 'engine', { commit: `${item.id}: delegate plan approval` });
        this.wakeOrchestrator('plan_review', item.id);
      }
    }
  }

  // ---- permission requests delegated to the orchestrator ----
  /** A project-wide choice: the hard deny rules have already run by the time anything is asked. */
  private permissionsDelegated(): boolean { return this.store.config.orchestrator.may_decide_permissions && this.orchestrator.enabled; }

  /** Same shape as plan reviews: nothing here may depend on a wake queue that a restart empties, or on a setting that can change while a request waits. */
  private drivePermissionReviews(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.blocked || fm.taken_over || !this.phaseFor(fm.status)) continue;
      if (fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission') {
        if (!this.permissionsDelegated()) this.handPermissionToUser(item.id, 'permission requests are no longer delegated to the orchestrator');
        else if (!this.orchestrator.reviewing(item.id)) this.wakeOrchestrator('permission_request', item.id);
      } else if (fm.awaiting === 'permission' && this.permissionsDelegated() && !fm.awaiting_data?.handed_back && this.mayAskOrchestrator(fm)) {
        this.store.mutateItem(item.id, [{ set: { awaiting: 'orchestrator', awaiting_data: { ...(fm.awaiting_data ?? {}), kind: 'permission' } } }, { activity: { actor: 'app', text: 'permission request passed to the orchestrator' } }], 'engine', { commit: `${item.id}: delegate permission` });
        this.wakeOrchestrator('permission_request', item.id);
      }
    }
  }

  /** A worker that keeps asking for what the orchestrator keeps refusing is a conversation for a person. */
  private mayAskOrchestrator(fm: { op_data?: Record<string, unknown> }): boolean { return Number(fm.op_data?.orchestrator_denials ?? 0) < MAX_ORCHESTRATOR_DENIALS; }

  private handPermissionToUser(id: string, why: string): void {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.awaiting !== 'orchestrator' || fm.awaiting_data?.kind !== 'permission') return;
    this.store.mutateItem(id, [{ set: { awaiting: 'permission', awaiting_data: { ...fm.awaiting_data, handed_back: true } } }, { activity: { actor: 'app', text: `permission needs your decision: ${why}` } }], 'engine', { commit: `${id}: permission handed to the user` });
    this.note('info', `${id}: permission needs your decision — ${why}`);
  }

  private async orchestratorDecidesPermission(id: string, decision: 'allow' | 'deny' | 'ask_user', reason: string): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.awaiting !== 'orchestrator' || fm.awaiting_data?.kind !== 'permission') return `nothing to decide: ${id} is not waiting on you for a permission`;
    if (!this.permissionsDelegated()) { this.handPermissionToUser(id, 'permission requests are no longer delegated to the orchestrator'); return 'not permitted: the user decides permission requests'; }
    if (decision === 'ask_user') { this.handPermissionToUser(id, `the orchestrator left it to you: ${reason}`); return 'handed to the user'; }
    await this.respond(id, { kind: 'permission', decision, reason }, 'orchestrator');
    return decision === 'allow' ? 'allowed once; the session resumes' : 'denied; the session resumes with your reason';
  }

  /** The decision goes back to the person, once per submitted plan: the flag stops the tick delegating it again. */
  /**
   * Ask the orchestrator to review a plan that came back to the user (#153): its review could not decide (a wake that
   * failed, as every one did while dontAsk refused its tools), and `plan_handed_back` keeps it from being delegated
   * again. The user's word sends it once more. Returns what happened, or why not.
   */
  reviewPlanAgain(id: string): string {
    const item = this.store.requireItem(id); const fm = item.file.frontmatter;
    if (fm.status !== 'PLAN_READY' || fm.awaiting !== 'plan_approval') return `not possible: ${id} has no plan waiting for your approval`;
    if (fm.kind === 'epic') return `not possible: an epic's breakdown is yours to approve`;
    if (findModel(this.store.config, fm.implementer)?.user_approves_plans) return `not possible: ${fm.implementer}'s plans and their MCP budget are yours to approve`;
    if (!this.store.config.orchestrator.may_approve_plans || !this.orchestrator.enabled) return 'not possible: this project does not let the orchestrator approve plans (orchestrator.may_approve_plans)';
    const { plan_handed_back: _spent, ...od } = fm.op_data ?? {};
    this.store.mutateItem(id, [{ set: { auto_approve_plan: true, awaiting: 'orchestrator', op_data: od } }, { activity: { actor: 'user', text: 'asked the orchestrator to review the plan again' } }], 'user', { commit: `${id}: plan review again` });
    this.wakeOrchestrator('plan_review', id);
    return `the orchestrator is reviewing ${id}'s plan`;
  }

  private handPlanToUser(id: string, why: string): void {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.status !== 'PLAN_READY' || fm.awaiting !== 'orchestrator') return;
    this.store.mutateItem(id, [{ set: { awaiting: 'plan_approval', op_data: { ...(fm.op_data ?? {}), plan_handed_back: true } } }, { activity: { actor: 'app', text: `plan needs your approval: ${why}` } }], 'engine', { commit: `${id}: plan approval handed to the user` });
    this.note('info', `${id}: plan needs your approval — ${why}`);
  }

  /** The orchestrator's fixes are bounded: past the limit it may still approve, but it cannot send the plan round again. */
  private async orchestratorRequestsPlanChanges(id: string, message: string): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const used = fm.plan_revisions ?? 0; const max = this.store.config.orchestrator.max_plan_revisions;
    if (used >= max) {
      if (fm.awaiting === 'orchestrator') this.handPlanToUser(id, `the orchestrator still wanted changes after ${used} fix round${used === 1 ? '' : 's'}: ${message}`);
      else this.store.mutateItem(id, [{ activity: { actor: 'orchestrator', text: `would still change the plan (its ${max} fix round${max === 1 ? ' is' : 's are'} used): ${message}` } }], 'orchestrator');
      return `not sent: all ${max} fix rounds for ${id} are used. The user decides this plan now; your feedback is on the item.`;
    }
    await this.rejectPlan(id, message, 'orchestrator');
    return `sent back to planning (fix round ${used + 1} of ${max}); you will review the revised plan`;
  }

  /**
   * "Approve with amendments" (dogfood f7): the stipulation is not left in a note the user misses and
   * the planner never sees. It goes back to the planner as an amendment, outside the fix-round
   * count, and the revised plan comes back to whoever approves it.
   */
  private async orchestratorAmendsPlan(id: string, amendments: string): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.status !== 'PLAN_READY') return `not possible: ${id} is ${fm.status}, not waiting for plan approval`;
    if (!amendments.trim()) return 'not sent: say what to amend';
    await this.rejectPlan(id, amendments.trim(), 'orchestrator', { amend: true });
    return `sent back to be amended; you will review the revised plan${this.planDelegated(fm) ? '' : ' (its approval stays with the user)'}`;
  }

  /**
   * Every IN_REVIEW item the pipeline may move. One whose head is waiting for CI is watched outside
   * the chain (watchCi); the rest enter the serial chain in merge order, where a head already green
   * on the base tip merges without waiting again (a released hold's kept green, too).
   */
  private driveInReview(): void {
    const candidates = this.store.listItems().filter((item) => {
      const fm = item.file.frontmatter;
      if (fm.status !== 'IN_REVIEW' || fm.blocked || fm.awaiting || fm.skip_merge || fm.taken_over || this.jobs.has(item.id) || this.turns.has(item.id)) return false;
      if (fm.ci_result === 'red' || fm.op_data?.needs_session_rebase) return false;
      const flavor = this.store.derived(item).flavor;
      if (flavor === 'external' && (fm.merge_policy ?? 'watch') === 'watch') return false; // watched: driveExternal observes it
      return true;
    }).sort((a, b) => {
      const fa = a.file.frontmatter, fb = b.file.frontmatter;
      return (fa.merge_order ?? Infinity) - (fb.merge_order ?? Infinity) || (fa.rank ?? Infinity) - (fb.rank ?? Infinity) || (fa.pr_created_at ?? '').localeCompare(fb.pr_created_at ?? '');
    });
    // mergeChain keeps the syncs and merges strictly serial, in this order; CI waits run beside it.
    for (const item of candidates) this.runJob(item.id, () => item.file.frontmatter.op === 'awaiting_ci' ? this.watchCi(item.id) : this.mergeJob(item.id));
  }

  /**
   * A held pull request (skip_merge) stays out of the merge queue, not out of sight. Its session's
   * fix commits are pushed, so the PR and CI show them, and its CI is read, so a red run reaches
   * the fix path and a green one is for the head it names. None of it waits inside the serial merge
   * chain: only the push goes through it, and CI is polled once per HELD_POLL_MS from the tick.
   */
  private heldPolledAt = new Map<string, number>();
  private driveHeld(): void {
    const now = Date.now();
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      // A taken-over PR is polled the same way, for its CI only: it is shown, never acted on.
      const owned = Boolean(fm.taken_over);
      // An epic's PR is held and polled too (#116): HH-242 was held "to play it", went red, and nothing read its CI.
      const epic = this.store.derived(item).flavor === 'epic' && !owned;
      if (fm.status !== 'IN_REVIEW' || !(fm.skip_merge || owned) || fm.blocked || fm.awaiting || !fm.pr || !fm.branch || (!fm.worktree && !owned && !epic)) continue;
      if (this.jobs.has(item.id) || this.turns.has(item.id) || fm.op || (fm.op_data?.needs_session_rebase && !owned)) continue;
      if (this.store.derived(item).flavor !== 'worker' && !epic) continue;
      if (now - (this.heldPolledAt.get(item.id) ?? 0) < HELD_POLL_MS) continue;
      this.heldPolledAt.set(item.id, now);
      this.runJob(item.id, () => owned ? this.readOwnedCi(item.id) : this.heldStep(item.id));
    }
  }

  /**
   * CI of a pull request a person has taken over (dogfood p28), for whatever head is on GitHub,
   * whoever pushed it: recorded so the board shows it, and nothing else. No push, no fix turn, no
   * merge; the hand-back sends it through the pipeline, which reuses this run for an unchanged head.
   */
  private async readOwnedCi(id: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const remote = await this.ports.git.remoteBranchSha(this.repo, fm.branch!);
    if (!remote) return;
    const ci = await this.ports.gh.ciForSha(this.github, fm.branch!, remote, this.ciWorkflow);
    const result = ci.state === 'success' ? 'green' : ci.state === 'failure' ? 'red' : 'pending';
    const cur = this.store.requireItem(id).file.frontmatter;
    if (!cur.taken_over || (cur.ci_result === result && cur.ci_head_sha === remote)) return;
    this.store.mutateItem(id, [
      { set: { ci_result: result, ci_head_sha: remote, ...(ci.runId ? { op_data: { ...(cur.op_data ?? {}), ci: { runId: ci.runId, url: ci.url } } } : {}) } },
      ...(result !== 'pending' ? [{ activity: { actor: 'app' as const, text: `CI is ${result} for ${remote.slice(0, 7)}${ci.url ? ` ${ci.url}` : ''} (you have this item: nothing is fixed or merged until you hand it back)` } }] : []),
    ], 'engine');
  }

  /**
   * The preview a held PR is played on (#137, LM-38): the newest successful deployment for its head, as GitHub
   * records it (Vercel, Netlify and the like post one). Read with the held poll, for each new head until found or
   * PREVIEW_TRIES polls have passed, kept in `op_data.preview`, and said once in Activity.
   */
  private async readPreview(id: string, head: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const seen = fm.op_data?.preview as { sha?: string; url?: string; tries?: number } | undefined;
    if (seen?.sha === head && (seen.url || (seen.tries ?? 0) >= PREVIEW_TRIES)) return;
    const url = await this.ports.gh.previewUrl(this.github, head).catch(() => null);
    const tries = (seen?.sha === head ? seen.tries ?? 0 : 0) + 1;
    const cur = this.store.requireItem(id).file.frontmatter;
    this.store.mutateItem(id, [
      { set: { op_data: { ...(cur.op_data ?? {}), preview: { sha: head, tries, ...(url ? { url } : {}) } } } },
      ...(url ? [{ activity: { actor: 'app' as const, text: `preview for ${head.slice(0, 7)}: ${url}` } }] : []),
    ], 'engine');
  }

  private async heldStep(id: string): Promise<void> {
    let fm = this.store.requireItem(id).file.frontmatter;
    if (this.store.config.ci.draft_while_held && !fm.op_data?.pr_draft) {
      // A hold put on after the PR opened: back to draft, so pushes during the hold run no CI.
      await this.ports.gh.setDraft(this.github, fm.pr!, true);
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pr_draft: true } } }, { activity: { actor: 'app', text: `held: PR #${fm.pr} is back to a draft, so CI waits until the hold is released` } }], 'engine');
      fm = this.store.requireItem(id).file.frontmatter;
    }
    // An epic has no session of its own: nothing of its is pushed from here, only its CI is read, and a red run goes to triage.
    const epic = fm.kind === 'epic';
    const cwd = epic ? '' : this.absWorktree(fm.worktree!);
    const [local, remote] = await Promise.all([epic ? Promise.resolve('') : this.ports.git.revParse(cwd, 'HEAD'), this.ports.git.remoteBranchSha(this.repo, fm.branch!)]);
    if (!epic && remote && local !== remote) {
      // Commits the session made while the item was held. Pushed only when they build on what the
      // PR has; a remote that moved on its own is someone else's work and is left alone.
      if (await this.ports.git.isAncestor(cwd, remote, local)) { await this.mergeJob(id, { hold: true }); return; }
      if (fm.op_data?.held_diverged !== remote) this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), held_diverged: remote } } }, { activity: { actor: 'app', text: `held: the worktree (${local.slice(0, 7)}) and the PR branch (${remote.slice(0, 7)}) have diverged; not pushing either way` } }], 'engine');
      return;
    }
    if (!remote) return;
    await this.readPreview(id, remote);
    const ci = await this.ports.gh.ciForSha(this.github, fm.branch!, remote, this.ciWorkflow);
    const cur = this.store.requireItem(id).file.frontmatter;
    if (ci.runId && (cur.op_data?.ci as { runId?: number } | undefined)?.runId !== ci.runId) this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci: { runId: ci.runId, url: ci.url } } } }], 'engine');
    if (ci.state === 'success') {
      if (cur.ci_result !== 'green' || cur.ci_head_sha !== remote) this.store.mutateItem(id, [{ set: { ci_result: 'green', ci_head_sha: remote } }, { activity: { actor: 'app', text: `held: CI is green for ${remote.slice(0, 7)} (not merging until the hold is released)` } }], 'engine');
      return;
    }
    if (ci.state === 'failure') {
      if (ci.runId && await this.ports.gh.isBillingBlocked(this.github, ci.runId)) return;
      const lastRed = cur.op_data?.last_red as { runId?: number; sha?: string } | undefined;
      if (cur.ci_result === 'red' || (lastRed?.runId === ci.runId && lastRed?.sha === remote)) return;
      this.store.mutateItem(id, [{ set: { ci_head_sha: remote } }], 'engine');
      await this.onCiRed(id, this.store.journal.begin('held_ci', id, { pr: fm.pr, sha: remote }), remote, undefined, 'github', !epic);
      return;
    }
    // Still running, or not started: a green (or red) from another head is not this head's verdict.
    if (cur.ci_head_sha !== remote || cur.ci_result === 'green' || cur.ci_result === 'red') this.store.mutateItem(id, [{ set: { ci_result: 'pending', ci_head_sha: remote } }], 'engine');
  }

  /**
   * Messages queued for an item's session while something other than a turn drove it: sent now as the item's next
   * job, when nothing else is queued and nothing waits on an answer. Returns whether it did (HH-263).
   */
  private deliverQueued(id: string, when: string): boolean {
    const item = this.store.getItem(id);
    if (!item) return false;
    const fm = item.file.frontmatter;
    const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
    const phase = this.phaseFor(fm.status);
    if (!pending.length || !phase || fm.taken_over || fm.blocked || fm.awaiting || this.turns.has(id) || this.followUps.has(id)) return false;
    if (this.store.derived(item).flavor !== 'worker' || this.stopping) return false;
    this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: [] } } }, { activity: { actor: 'app', text: `sending ${pending.length} queued message${pending.length === 1 ? '' : 's'} to the session ${when}` } }], 'engine');
    const review = fm.status === 'IN_REVIEW' ? '\n\nYour pull request is open and was about to merge: it waits for what you do with these. Commit any change; planestro pushes it and runs CI again.' : '';
    this.queueFollowUp(id, () => this.runTurnFor(id, phase, `Messages from the user while you were working:\n\n${pending.map((m) => `- ${m}`).join('\n')}${review}`));
    return true;
  }

  private followUps = new Map<string, () => Promise<unknown>>();
  /** Why a live turn was aborted on purpose (a take-over, a move into review), for the line its end writes. */
  private stoppedFor = new Map<string, string>();
  /** Triage wakes held until the item's step (the turn that stopped) has finished: the orchestrator must find it idle to act on it. */
  private pendingWakes = new Map<string, { type: string; data?: Record<string, unknown> }>();

  private runJob(id: string, fn: () => Promise<unknown>): void {
    if (this.jobs.has(id)) return;
    const p = fn().then(() => undefined, (e) => { this.block(id, 'engine_error', (e as Error).message); }).finally(() => {
      this.jobs.delete(id);
      const next = this.followUps.get(id);
      if (next) { this.followUps.delete(id); this.runJob(id, next); }
      // A message queued while a job that is not a turn ran (a CI wait, a merge step) has no turn to end and deliver it.
      else if (this.deliverQueued(id, 'its job ended')) { /* queued as the next job */ }
      else { const wake = this.pendingWakes.get(id); if (wake) { this.pendingWakes.delete(id); this.wakeOrchestrator(wake.type, id, wake.data); } }
    });
    this.jobs.set(id, p);
  }

  /** Run `fn` as the item's next job — immediately if idle, otherwise right after the current job (never dropped). */
  private queueFollowUp(id: string, fn: () => Promise<unknown>): void {
    if (this.jobs.has(id)) this.followUps.set(id, fn); else this.runJob(id, fn);
  }

  // ---- item lifecycle ----
  private async startItem(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    const base = d.base_branch!;
    const ctx = { prefix_lower: this.store.config.project.id_prefix.toLowerCase(), number: String(idNumber(id)), slug: slugify(fm.title) };
    const branch = renderPrompt(this.store.config.worktrees.branch_pattern, ctx);
    const dir = join(this.store.worktreesRoot(), renderPrompt(this.store.config.worktrees.dir_pattern, ctx));
    const worktreeRel = isAbsolute(dir) ? relative(this.repo, dir) : dir;
    const opId = this.store.journal.begin('creating_worktree', id, { branch, dir, base });
    this.store.mutateItem(id, [
      { transition: { to: 'PLAN_IN_PROGRESS', actor: 'engine' } },
      { set: { branch, worktree: worktreeRel, op: 'creating_worktree', op_started_at: this.now(), ci_failed_count: 0 } },
      { activity: { actor: 'app', text: `creating worktree ${worktreeRel} on ${branch} from origin/${base}` } },
    ], 'engine', { commit: `${id}: begin planning` });
    await this.ports.git.fetch(this.repo);
    // An item that went to the icebox (or back to the backlog) and is queued again still owns the
    // worktree it made the first time: `git worktree add` over it fails, so pick it up as it is.
    const kept = (await this.ports.git.worktreeList(this.repo)).find((w) => w.path === dir && !w.prunable);
    if (kept && kept.branch !== branch) { this.store.journal.end(opId, id, 'failed', { reason: 'worktree_taken' }); this.block(id, 'worktree_taken', `${worktreeRel} already exists on ${kept.branch ?? 'a detached HEAD'}, not ${branch}; remove it by hand or move it aside`); return; }
    if (kept) this.store.mutateItem(id, [{ activity: { actor: 'app', text: `reusing the worktree this item already has (${worktreeRel}); setup hooks not re-run` } }], 'engine');
    else await this.ports.git.worktreeAdd(this.repo, dir, branch, `origin/${base}`);
    if (kept) this.store.mutateItem(id, [{ set: { op: 'importing', op_started_at: this.now() } }], 'engine');
    else if (!(await this.runSetupHooks(id, dir, opId))) return;
    this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
    this.store.journal.end(opId, id, 'ok');
    await this.runTurnFor(id, 'plan', this.withEpicCheck(id, this.withImplementer(id, this.withDelivered(id, 'plan-item', this.store.renderPrompt('plan-item', this.store.requireItem(id))))), [], [], { opener: true });
  }

  /**
   * `asItem`: the user read a plan that reads as an epic breakdown (epicFlagOf) and approves it as one
   * item anyway, deliberately. Nobody else can: the orchestrator converts it or leaves it to the user.
   * `hold`: the pull request this opens stays out of the merge queue until it is released, for this
   * reason (#97). A plan that states a hold (holdShapeOf) is held when the orchestrator approves it,
   * with or without the argument; the user chooses, and approving without it is on the record.
   */
  async approvePlan(id: string, notes?: string, by: 'user' | 'orchestrator' = 'user', { asItem = false, hold, mcpBudget }: { asItem?: boolean; hold?: string; mcpBudget?: number } = {}): Promise<void> {
    const item = this.store.requireItem(id);
    const impl = findModel(this.store.config, item.file.frontmatter.implementer);
    if (impl?.user_approves_plans && by !== 'user') throw new Error(`${id} is implemented by ${impl.label}, whose plans and their MCP budget are the user's to approve`);
    if (mcpBudget !== undefined && by !== 'user') throw new Error('an MCP budget is set by the user');
    if (item.file.frontmatter.kind === 'epic') { if (by !== 'user') throw new Error(`${id} is an epic: its breakdown is the user's to approve`); await this.approveBreakdown(id); return; }
    if (item.file.frontmatter.status !== 'PLAN_READY') throw new Error(`${id} is ${item.file.frontmatter.status}, not PLAN_READY`);
    // An epic approved as an item goes to one implementer, who has to stop and ask (#69, HH-198).
    const epicShaped = epicFlagOf(item.file.frontmatter);
    if (epicShaped && !(asItem && by === 'user')) throw new Error(`${id} is not approved: ${epicShaped.reason}, so it is an epic, not one item. Convert it to an epic (its plan becomes the breakdown request)${by === 'user' ? ', request plan changes, or approve it as one item deliberately' : ' or leave it to the user'}.`);
    // LM-22's plan said its PR stays held, and nothing held it (#97). Read from the plan as it stands, not from when it was handed in.
    const stated = holdShapeOf(getSection(item.file, 'Plan'));
    const holdFor = hold?.trim() || (by === 'orchestrator' ? stated?.reason : undefined);
    const waived = Boolean(stated && !holdFor && !item.file.frontmatter.skip_merge);
    const { plan_handed_back: _spent, plan_amended: _folded, looks_like_epic: _overruled, hold_waived: _earlier, ...opData } = item.file.frontmatter.op_data ?? {};
    this.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: by } },
      { set: { op_data: { ...opData, approval_notes: notes ?? '', ...(waived ? { hold_waived: true } : {}) } } },
      ...(mcpBudget !== undefined ? [{ set: { mcp_budget: mcpBudget } } as ItemOp, { activity: { actor: 'user' as const, text: `MCP budget approved: ${mcpBudget} call${mcpBudget === 1 ? '' : 's'} to ${impl?.mcp.join(', ') || 'its MCP servers'}` } }] : []),
      ...(holdFor ? this.holdOps(holdFor, by) : []),
      ...(waived ? [{ activity: { actor: by, text: `approved without the hold its plan states: "${stated!.quote}"` } }] : []),
      ...(epicShaped ? [{ activity: { actor: by, text: `approved as one item although ${epicShaped.reason}` } }] : []),
      ...(by === 'orchestrator' ? [{ activity: { actor: by, text: `approved the plan on your behalf${notes ? `: ${notes}` : ''}` } }] : notes ? [{ activity: { actor: by, text: `approval notes: ${notes}` } }] : []),
    ], by, { commit: `${id}: approve plan${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    // queued, not dropped: the orchestrator can decide while the planner's turn is still ending
    this.queueFollowUp(id, () => this.runTurnFor(id, 'implement', this.withHoldNote(id, this.withDelivered(id, 'implement-plan', this.store.renderPrompt('implement-plan', this.store.requireItem(id), { approval_notes: notes?.trim() || '(none)' }))), [], [], { opener: true }));
  }

  async rejectPlan(id: string, message: string, by: 'user' | 'orchestrator' = 'user', { amend = false }: { amend?: boolean } = {}): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.status !== 'PLAN_READY') throw new Error(`${id} is ${fm.status}, not PLAN_READY`);
    const round = (fm.plan_revisions ?? 0) + 1;
    const counted = by === 'orchestrator' && !amend;   // an amendment is a stipulation the orchestrator accepts with, not one of its fix rounds
    const { plan_amended: _old, ...opData } = fm.op_data ?? {};
    this.store.mutateItem(id, [
      { transition: { to: 'PLAN_IN_PROGRESS', actor: by } },
      ...(counted ? [{ set: { plan_revisions: round } } as ItemOp] : []),
      { set: { op_data: amend ? { ...opData, plan_amended: message } : opData } },
      { activity: { actor: by, text: amend ? `plan sent back to be amended: ${message}` : counted ? `plan changes requested (fix round ${round} of ${this.store.config.orchestrator.max_plan_revisions}): ${message}` : `plan changes requested: ${message}` } },
    ], by, { commit: `${id}: ${amend ? 'amend plan' : 'request plan changes'}${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    const tool = item.file.frontmatter.kind === 'epic' ? 'submit_breakdown' : 'submit_plan';
    const ask = amend
      ? `The orchestrator approves your plan with these amendments. Fold them into the plan (do not just append them) and submit the whole plan again with the ${tool} tool, then end your turn:\n\n${message}`
      : `Changes requested on your plan:\n\n${message}\n\nRevise it accordingly and submit it again with the ${tool} tool, then end your turn.`;
    this.queueFollowUp(id, () => this.runTurnFor(id, 'plan', `${this.resumeNote(id, 'your plan review')}\n\n${ask}`));
  }

  async message(id: string, text: string, by: 'user' | 'orchestrator' = 'user'): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) throw new Error(`${id} has no session to message in status ${fm.status}`);
    if (fm.taken_over) throw new Error(`${id} is yours (taken over): hand it back before messaging its session`);
    // Past its breakdown an epic has no session and no worktree: its children do the work. The user's
    // word goes to the orchestrator, which instructs them; resuming a session there blocked the epic
    // with engine_error on every message (HH-256, HH-259).
    if (fm.kind === 'epic' && phase !== 'plan') {
      if (by === 'orchestrator') throw new Error(`epic ${id} has no session past its breakdown; message its children (${this.store.derived(item).children.join(', ') || 'none yet'}) or annotate_item the epic`);
      this.store.mutateItem(id, [{ activity: { actor: 'user', text: `message: ${text}` } }, { activity: { actor: 'app', text: 'an epic has no session of its own past its breakdown: passed to the orchestrator for its children' } }], 'user', { commit: `${id}: message` });
      this.wakeOrchestrator('epic_message', id, { message: text });
      return;
    }
    if (this.turns.has(id) || this.jobs.has(id)) {
      const pending = [...((fm.op_data?.pending_messages as string[] | undefined) ?? []), text];
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: pending } } }, { activity: { actor: 'user', text: `message queued: ${text}` } }], 'user');
      return;
    }
    // A session parked on its question (or a permission) takes the message with the answer (#128, HH-259): a designer
    // decision that changes the brief is not held back until someone answers, and does not wake it a second time.
    const parked = fm.awaiting === 'question' || fm.awaiting === 'permission' || (fm.awaiting === 'orchestrator' && ['question', 'permission'].includes(String(fm.awaiting_data?.kind ?? '')));
    if (parked) {
      const pending = [...((fm.op_data?.pending_messages as string[] | undefined) ?? []), text];
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: pending } } }, { activity: { actor: by === 'orchestrator' ? 'orchestrator' : 'user', text: `message queued: ${text} (it reaches the session with the answer to its ${fm.awaiting === 'question' || fm.awaiting_data?.kind === 'question' ? 'question' : 'permission request'})` } }], by === 'orchestrator' ? 'orchestrator' : 'user');
      return;
    }
    if (fm.awaiting && fm.awaiting !== 'user') throw new Error(`${id} is awaiting ${fm.awaiting}; answer that first`);
    // A message that resumes a blocked session is the answer to the block (unblock-with-message
    // by another door). Leaving the flag set made afterTurn skip the finished turn, so a worker
    // that then reported done sat IN_PROGRESS as "blocked" forever and no PR was ever opened.
    this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data', 'triage', ...(fm.blocked ? ['blocked', 'blocked_reason'] : [])] }, { activity: { actor: 'user', text: `message: ${text}` } }], 'user');
    this.runJob(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'a message from the user')}\n\nMessage from the user:\n\n${text}`));
  }

  async respond(id: string, payload: Record<string, unknown>, by: 'user' | 'orchestrator' = 'user'): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) throw new Error(`${id} is not in a session phase`);
    if (fm.taken_over) throw new Error(`${id} is yours (taken over): hand it back first`);
    if (payload.kind === 'question') {
      if (fm.awaiting !== 'question') throw new Error(`${id} is not awaiting a question`);
      const answers = payload.answers as Record<string, string>;
      const text = Object.entries(answers).map(([q, a]) => `- Q: ${q}\n  A: ${a}`).join('\n');
      this.recordAnswer(id, fm, by, 'answered');
      // Messages queued while it waited go with the answer (#128), and leave the queue with it.
      const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
      const also = pending.length ? `\n\nAlso, from the user while you waited (these may change the brief):\n\n${pending.map((m) => `- ${m}`).join('\n')}` : '';
      this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data', 'triage'] }, ...(pending.length ? [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: [] } } } as ItemOp] : []), { activity: { actor: by, text: `answered: ${Object.values(answers).join(' / ')}${pending.length ? ` (with ${pending.length} queued message${pending.length === 1 ? '' : 's'})` : ''}` } }], by, { commit: `${id}: answer questions${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
      this.queueFollowUp(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'your questions')}\n\nAnswers to your questions:\n\n${text}${also}\n\nContinue.`));
      return;
    }
    if (payload.kind === 'permission') {
      // The user may always decide, including while the orchestrator is still looking at it.
      if (fm.awaiting !== 'permission' && !(fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission')) throw new Error(`${id} is not awaiting a permission decision`);
      const req = fm.awaiting_data as unknown as PermissionRequest;
      const decision = payload.decision as 'allow' | 'always' | 'deny';
      if (by === 'orchestrator' && decision === 'always') throw new Error('only the user adds allow rules');
      const rule = ruleFor(req);
      const who = by === 'orchestrator' ? 'The orchestrator' : 'The user';
      const ops: ItemOp[] = [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: by, text: `permission ${decision}${by === 'orchestrator' && payload.reason ? ` (${String(payload.reason).slice(0, 300)})` : ''}: ${rule.slice(0, 400)}` } }];
      // Consecutive denials (#95): any approval, the user's included, means the worker adapted, and the item's requests go back to the
      // orchestrator. Counted for the item's life, HH-253's three reasonable denials sent every later request to the designer's phone.
      if (by === 'orchestrator' && decision === 'deny') ops.push({ set: { op_data: { ...(fm.op_data ?? {}), orchestrator_denials: Number(fm.op_data?.orchestrator_denials ?? 0) + 1 } } });
      else if (decision !== 'deny' && Number(fm.op_data?.orchestrator_denials ?? 0) > 0) ops.push({ set: { op_data: { ...(fm.op_data ?? {}), orchestrator_denials: 0 } } });
      if (decision === 'always' && !this.store.config.permissions.allow.includes(rule)) this.store.updateConfig((doc) => { doc.setIn(['permissions', 'allow'], [...this.store.config.permissions.allow, rule]); }, `config: always allow ${rule.slice(0, 60)}`);
      this.store.mutateItem(id, ops, by, { commit: `${id}: permission ${decision}${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
      this.recordAnswer(id, fm, by, decision);   // after: those ops write op_data from the snapshot, which would drop the resume tag
      const desc = req.tool === 'Bash' ? `\`${String(req.input.command)}\`` : `${req.tool} ${JSON.stringify(req.input).slice(0, 200)}`;
      const msg = decision === 'deny'
        ? `${this.resumeNote(id, 'a permission decision')}\n\n${who} denied ${desc}${payload.reason ? `: ${payload.reason}` : ''}. Continue without it, or call report_blocked if you cannot.`
        : `${this.resumeNote(id, 'a permission decision')}\n\n${who} approved ${desc}. It is now allowed; continue.`;
      // A chained/heredoc command can't be expressed as a matchable allow rule (the SDK's
      // matcher and segment matching both refuse it), so an approval is also carried into the
      // turn as a one-shot exact-command pass (consumed on first use).
      const oneShot = decision !== 'deny' && req.tool === 'Bash' ? [String(req.input.command ?? '')] : [];
      // queued, not dropped: the orchestrator can answer while the turn that asked is still ending
      this.queueFollowUp(id, () => this.runTurnFor(id, phase, msg, decision === 'deny' ? [] : [rule], oneShot));
      return;
    }
    throw new Error(`unknown response kind ${String(payload.kind)}`);
  }

  /** A park begins (#108): journaled with what was asked, its kind of command and who it went to. Returns its id. */
  private recordPark(id: string, kind: 'permission' | 'question', what: string, asked: 'user' | 'orchestrator'): string {
    const park = `park-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const shape = kind === 'permission' ? commandShape(what) : undefined;
    this.store.journal.append({ type: 'permission.parked', item: id, actor: 'engine', data: { park, kind, what: what.slice(0, 300), ...(shape ? { shape } : {}), asked } });
    return park;
  }

  /** A park is answered (#108): who, how, after how long; the turn it resumes is tagged with it (runTurnFor). */
  private recordAnswer(id: string, fm: ItemFrontmatter, by: string, decision: string): void {
    const park = typeof fm.awaiting_data?.park === 'string' ? fm.awaiting_data.park : undefined;
    if (!park) return;
    const since = Date.parse(String(fm.awaiting_data?.requested_at ?? ''));
    this.store.journal.append({ type: 'permission.answered', item: id, actor: by, data: { park, by, decision, waited_ms: Number.isFinite(since) ? Math.max(0, Date.now() - since) : 0 } });
    this.store.mutateItem(id, [{ set: { op_data: { ...(this.store.requireItem(id).file.frontmatter.op_data ?? {}), resume_park: park } } }], 'engine');
  }

  private phaseFor(status: Status): TurnPhase | null {
    if (status === 'PLAN_IN_PROGRESS' || status === 'PLAN_READY') return 'plan';
    if (status === 'IN_PROGRESS') return 'implement';
    if (status === 'IN_REVIEW') return 'fix';
    return null;
  }

  private resumeNote(id: string, reason: string): string {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const parkedAt = (fm.awaiting_data?.requested_at as string | undefined) ?? fm.updated_at;
    const mins = Math.max(0, Math.round((Date.parse(this.now()) - Date.parse(parkedAt)) / 60_000));
    try { return this.store.renderPrompt('resume-context', item, { resume_reason: reason, parked_for: `${mins} min` }); }
    catch { return `[planestro] Your session was parked while waiting on ${reason} and has now been resumed.`; }
  }

  /** What resuming this item's conversation on `model` costs now; a conversation never quoted borrows the rate last quoted for its model. */
  private resumeEstimateFor(fm: { session_id?: string; session_context?: SessionContext }, model?: string): ResumeEstimate | undefined {
    return resumeEstimate(fm, { now: new Date(Date.parse(this.now())), model, rates: resumeRates(this.store.listItems().map((i) => i.file.frontmatter.session_context)) });
  }

  /**
   * The brief a fresh conversation opens with (#64): the item, its plan, what is committed and what is
   * not, where it last stopped, and the task. All of it from the item file and git, none of it from a
   * conversation (invariant 3).
   */
  private async freshBrief(id: string, task: string): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    const dirty = await this.worktreeDirt(cwd).then((d) => d.dirty, () => [] as string[]);
    const commits = await this.ports.git.log(cwd, `origin/${base}..HEAD`, 30).catch(() => '');
    const inFlight = await this.ports.git.inProgressOp(cwd).catch(() => null);
    const lines = getSection(item.file, 'Activity').split('\n').filter((l) => l.trim());
    const stopped = [...lines].reverse().find((l) => l.includes('BLOCKED ('));
    const github = this.store.config.code_repo.github;
    return this.store.renderPrompt('fresh-brief', item, {
      approval_notes: String(fm.op_data?.approval_notes ?? '').trim() || '(none)',
      brief: {
        task,
        stopped: stopped ? `It last stopped with: ${stopped.replace(/^[-*\s]+/, '').slice(0, 400)}` : 'It has not been blocked.',
        commits: commits.trim() || '(none yet)',
        dirty: dirty.join('\n') || '(clean)',
        in_progress: inFlight ? `a ${inFlight} was left unfinished in the worktree: finish or abort it before anything else` : '(none)',
        pr: fm.pr ? `#${fm.pr}${github ? ` (https://github.com/${github}/pull/${fm.pr})` : ''}, CI ${fm.ci_result ?? 'not run yet'}` : '(no pull request yet)',
        done_summary: String(fm.op_data?.done_summary ?? '').trim().slice(0, 1200) || '(none)',
        activity: lines.slice(-12).join('\n') || '(none)',
      },
    });
  }

  // ---- turns ----
  private async runTurnFor(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[] = [], oneShotCommands: string[] = [], opts: TurnOpts = {}): Promise<TurnResult | undefined> {
    const oneShot = new Set(oneShotCommands.map((c) => c.trim()));
    if (this.stopping) return undefined;
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    // The one door every turn goes through: nothing queued before a take-over (a fix, an answer, a resume) starts while a person has the item.
    if (fm.taken_over) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `not starting its ${phase} turn: you have this item (taken over)` } }], 'engine'); return undefined; }
    const d = this.store.derived(item);
    const cwd = this.absWorktree(fm.worktree!);
    const modelId = phase === 'plan' ? fm.planner : fm.implementer;
    const requested = this.store.config.models.find((m) => m.id === modelId);
    if (!requested) throw new Error(`unknown model ${modelId}`);
    const allowFallback = fm.allow_model_fallback === true;
    const pick = resolveTurnModel(this.store.config, requested, { allow: allowFallback, unavailable: this.store.local.model_unavailable, now: new Date(Date.now()) });
    if (pick.exhaustedUntil) {
      this.block(id, 'usage_exhausted', `${fallbackChain(this.store.config, requested).map((m) => m.label).join(', ')} ${fallbackChain(this.store.config, requested).length > 1 ? 'are all' : 'is'} out of usage until ${pick.exhaustedUntil}`);
      return undefined;
    }
    const def = pick.def;
    if (pick.fellBackFrom) this.store.mutateItem(id, [{ activity: { actor: 'app', text: `${pick.fellBackFrom.label} is unavailable until ${pick.skipped?.until ?? 'later'} (${(pick.skipped?.reason ?? 'usage limit').slice(0, 120)}): this ${phase} turn runs on ${def.label}` } }], 'engine');
    const runner = def.runner ?? 'claude';
    if (phase === 'plan' && !canPlan(def)) { this.block(id, 'planner_cannot_plan', `${def.label} runs on ${runner}, which cannot plan; pick a Claude model as the planner`); return undefined; }
    const agent = this.ports.agents[runner];
    if (!agent) { this.block(id, 'runner_unavailable', `${def.label} needs the ${runner} runner, which is not available in this engine`); return undefined; }
    const model = runner === 'claude' ? def.claude_model : def[`${runner}_model`];
    if (runner === 'claude' && !model) throw new Error(`model ${def.id} has no claude_model`);
    // Runners that report tokens instead of dollars are budgeted in worker turns.
    const metered = runner === 'claude';
    const budget = this.budgetOf(fm);
    if (!metered && (fm.agent_turns ?? 0) >= budget.turns) { this.block(id, 'turn_budget', `${def.label} has used ${fm.agent_turns} of ${budget.turns} turns on this item (${budget.turnsKey}); raise it on the item and unblock, or take the item over by hand`); return undefined; }
    if (!metered && (fm.tokens ?? 0) >= budget.tokens) { this.block(id, 'token_budget', `${def.label} has used ${(fm.tokens ?? 0).toLocaleString()} of ${budget.tokens.toLocaleString()} tokens on this item (${budget.tokensKey}); raise it on the item and unblock, or take the item over by hand`); return undefined; }
    // A turn with less than MIN_TURN_USD left ends at error_max_budget_usd before it can finish
    // anything (HH-125's $0.50 conflict fix, HH-122's CI fix): say what the item needs instead.
    const usdLeft = budget.usd - (fm.cost_usd ?? 0);
    let resumeId = metered ? fm.session_id : fm.agent_sessions?.[runner];
    // What the turn costs before it does anything (#64): a resume sends the whole conversation again.
    // One the item cannot pay for, or whose reload is above budget_usd_fresh_above, becomes a fresh
    // conversation with a brief when the turn's prompt stands on its own; only when nothing fits is it
    // stopped, and then before anything is spent (HH-184 spent a +$15 raise on the reload alone).
    const pending = fm.op_data?.fresh_brief as { task?: string; from_session?: string } | undefined;
    const mayBeFresh = phase !== 'plan' && !opts.opener;
    const estimate = opts.estimate ?? (metered && resumeId ? this.resumeEstimateFor(fm, model as string) : undefined);
    const path = chooseTurnPath({ left: metered ? usdLeft : Infinity, estimate, hasSession: Boolean(resumeId), fresh: !mayBeFresh ? undefined : pending || opts.fresh === true ? true : opts.fresh, freshAboveUsd: this.store.config.budget_usd_fresh_above });
    if (path.path === 'stop') {
      this.block(id, 'over_budget', usdLeft < MIN_TURN_USD
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
      replaced = resumeId; resumeId = undefined;
      prompt = await this.freshBrief(id, task);
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), fresh_brief: { task, from_session: replaced } } } }, { activity: { actor: 'app', text: `starting a fresh ${def.label} conversation with a brief instead of resuming ${replaced?.slice(0, 8) ?? 'its own'}: ${path.why}` } }], 'engine');
    } else if (path.path === 'fresh') { replaced = resumeId; resumeId = undefined; }
    else if (opts.note && !opts.final) prompt = `${this.resumeNote(id, opts.note)}\n\n${prompt}`;
    // "Continue where you left off" presumes a conversation to continue. When there is none — the
    // opening turn died before the agent heard the task, or the thread was lost — a fresh conversation
    // gets the phase's full prompt first, and the resume note after it.
    if (!resumeId && !replaced && !opts.opener && !opts.final && (phase === 'plan' || phase === 'implement')) {
      const opener = phase === 'plan' ? this.withImplementer(id, this.withDelivered(id, 'plan-item', this.store.renderPrompt('plan-item', item))) : this.withDelivered(id, 'implement-plan', this.store.renderPrompt('implement-plan', item, { approval_notes: String(fm.op_data?.approval_notes ?? '').trim() || '(none)' }));
      prompt = `${opener}\n\n---\n\n${prompt}`;
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `no ${def.label} conversation to resume: starting a fresh one with the full ${phase} prompt` } }], 'engine');
    }
    const images = fm.attachments.map((a) => this.store.attachmentAbsPath(a)).filter((p) => /\.(png|jpe?g|webp|gif)$/i.test(p));
    const policy = makePolicy(this.store.config, d.base_branch!, cwd);
    // Tools from outside (f5): the model row names MCP servers, the machine-local file holds them with
    // their keys. A name with no server on this machine is a stop, not a session without its tools.
    const mcpServers: Record<string, McpServerSpec> = {};
    for (const name of metered ? def.mcp : []) {
      const spec = this.store.local.mcp_servers[name];
      if (!spec || (!spec.command && !spec.url)) { this.block(id, 'mcp_missing', `${def.label} names the MCP server "${name}", which planestro.local.yml on this machine does not define (mcp_servers.${name} needs a command or a url)`); return undefined; }
      mcpServers[name] = spec.url ? { type: 'http', url: spec.url, headers: spec.headers } : { command: spec.command!, args: spec.args, env: spec.env };
    }
    // A person's budget for this item first (#157); a model whose plans are theirs to approve makes no paid call without one.
    const mcpCap = fm.mcp_budget ?? (def.user_approves_plans ? 0 : def.mcp_calls_per_item);
    const capWhat = fm.mcp_budget !== undefined ? 'the budget approved for this item (mcp_budget)' : def.user_approves_plans ? 'no budget approved for this item yet (mcp_budget)' : `mcp_calls_per_item on ${def.label}`;
    const op = phase === 'plan' ? 'planning_turn' : 'implement_turn';
    // Where the branch stood, so a turn that fails after committing is still checked (below).
    const headBefore = phase === 'plan' ? undefined : await this.ports.git.revParse(cwd, 'HEAD').catch(() => undefined);
    const abort = new AbortController();
    // The turn that answers a park carries it, so its cost is that park's cost (#108).
    const resumesPark = typeof this.store.requireItem(id).file.frontmatter.op_data?.resume_park === 'string' ? String(this.store.requireItem(id).file.frontmatter.op_data!.resume_park) : undefined;
    const opId = this.store.journal.begin(op, id, { phase, model: model ?? def.label, runner, ...(pick.fellBackFrom ? { fell_back_from: pick.fellBackFrom.id } : {}), ...(resumesPark ? { resumes_park: resumesPark } : {}) });
    if (resumesPark) { const { resume_park: _done, ...rest } = this.store.requireItem(id).file.frontmatter.op_data ?? {}; this.store.mutateItem(id, [{ set: { op_data: rest } }], 'engine'); }
    this.store.mutateItem(id, [{ set: { op, op_started_at: this.now() } }], 'engine');
    // Registered before the runner slot is won (it owns the item from here), but not a running agent until then.
    const waiting = this.store.config.concurrency.runner_limits?.[runner] !== undefined ? runner : undefined;
    this.turns.set(id, { model: model ?? def.label, phase, startedAt: this.now(), lastOutput: '', abort, waiting });
    const admitted = () => { const t = this.turns.get(id); if (t?.waiting) { t.waiting = undefined; t.startedAt = this.now(); } this.emit({ type: 'session.started', id, session_id: fm.session_id }); };
    const budgetLeft = Math.max(MIN_TURN_USD, usdLeft);
    // A planning turn is capped on its own (dogfood p41): past the cap it is asked for the plan it has, not for more research.
    // The cap is for the work: what the resume reloads first is on top of it.
    const turnCap = phase === 'plan' ? Math.min(budgetLeft, this.store.config.budget_usd_per_plan_turn + (resumeId ? estimate?.usd ?? 0 : 0)) : budgetLeft;
    const known = resumeId && fm.session_context?.session === resumeId ? fm.session_context : undefined;
    let declined: ResumeEstimate | undefined;
    let result: TurnResult;
    try {
      result = await this.withRunnerSlot(runner, () => this.withSessionSlot(id, () => { if (abort.signal.aborted) return Promise.resolve<TurnResult>({ subtype: 'killed', isError: false, costUsd: 0, numTurns: 0, text: '' }); admitted(); return agent.runTurn({
        itemId: id, phase, cwd, model: model as string, permissionMode: phase === 'plan' ? 'plan' : 'acceptEdits', prompt, resume: resumeId, images,
        ...(known?.total_usd !== undefined ? { resumeTotalUsd: known.total_usd } : {}),
        // The CLI's own quote, before the first request: the same choice as above, on its numbers. It is
        // what stops a conversation nothing was recorded for (every one that predates the record).
        onResumeQuote: (q) => {
          const quoted = quoteEstimate(q);
          const again = chooseTurnPath({ left: usdLeft, estimate: quoted, hasSession: true, fresh: !mayBeFresh ? undefined : opts.fresh, freshAboveUsd: this.store.config.budget_usd_fresh_above });
          if (again.path === 'resume') return 'go';
          declined = quoted;
          return 'stop';
        },
        systemAppend: `${this.store.renderPrompt(metered ? 'worker-system' : `worker-system-${runner}`, item)}\n\n${this.hostNote}${metered ? cwdNote(cwd) : ''}${keptPathsNote(this.store.config.worktrees.copy_to_checkout, this.repo)}`,
        ...(pick.sdkFallback ? { fallbackModel: pick.sdkFallback } : {}),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        // Scoped rules (…@worktree) are planestro's to judge in onPermission; the SDK's allow-list never sees them.
        allowedTools: sdkRules([...BASE_ALLOWED[phase], ...this.store.config.permissions.allow, ...extraAllowed]),
        extraDirs: [this.store.dataDir], maxBudgetUsd: turnCap,
        tools: this.makeTools(id),
        onPermission: async (req) => {
          // The turn is being stopped under a person who took the item over: nothing may park on them or wake anyone.
          if (this.store.requireItem(id).file.frontmatter.taken_over) return { action: 'deny', message: 'Not allowed: the user has taken this item over and is finishing it by hand. Stop now and end your turn.' };
          // A call to one of the model's own servers: allowed while the item's call cap holds, counted on the item.
          const server = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(req.tool)?.[1];
          if (server && mcpServers[server]) {
            const cur = this.store.requireItem(id).file.frontmatter;
            const calls = { ...((cur.op_data?.mcp_calls as Record<string, number> | undefined) ?? {}) };
            calls[server] = (calls[server] ?? 0) + 1;
            if (mcpCap !== undefined && calls[server] > mcpCap) {
              if (calls[server] === mcpCap + 1) this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), mcp_calls: calls } } }, { activity: { actor: 'app', text: `${server}: the item's ${mcpCap} calls (${capWhat}) are spent; further calls are refused` } }], 'engine');
              return { action: 'deny', message: mcpCap === 0 ? `Not allowed: no ${server} budget has been approved for this item. Stop and report_blocked saying how many ${server} calls the work needs; the user sets the budget.` : `Not allowed: this item has used its ${mcpCap} ${server} calls (${capWhat}). Finish with what you have, or report_blocked saying how many more you need.` };
            }
            this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), mcp_calls: calls } } }], 'engine');
            return { action: 'allow' };
          }
          const why = policy.deny(req);
          if (why) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `denied ${req.tool}: ${why}` } }], 'engine'); return { action: 'deny', message: `Not allowed: ${why}` }; }
          if (req.tool === 'Bash' && oneShot.delete(String(req.input.command ?? '').trim())) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'one-shot approval consumed' } }], 'engine'); return { action: 'allow' }; }
          if (allowedByRules(req, [...BASE_ALLOWED[phase], ...this.store.config.permissions.allow, ...extraAllowed], cwd, { readOnly: phase === 'plan' })) return { action: 'allow' };
          const ask = this.permissionsDelegated() && this.mayAskOrchestrator(this.store.requireItem(id).file.frontmatter);
          // The safety valve tripped: say so on the card, or the stream of requests reaching the user is a mystery (#95).
          const tripped = !ask && this.permissionsDelegated();
          const park = this.recordPark(id, 'permission', req.tool === 'Bash' ? String(req.input.command ?? '') : req.tool, ask ? 'orchestrator' : 'user');
          this.store.mutateItem(id, [{ set: { awaiting: ask ? 'orchestrator' : 'permission', awaiting_data: { ...(ask ? { kind: 'permission' } : {}), ...(tripped ? { escalated: 'orchestrator_denials' } : {}), tool: req.tool, input: req.input, requested_at: this.now(), park } } }, { activity: { actor: 'app', text: `parked: permission for ${req.tool} ${String(req.input.command ?? req.input.file_path ?? '').slice(0, 80)}${ask ? ' (asking the orchestrator)' : tripped ? ` (to you: the orchestrator denied its last ${MAX_ORCHESTRATOR_DENIALS} requests)` : ''}` } }], 'engine', { commit: `${id}: awaiting permission` });
          if (ask) this.wakeOrchestrator('permission_request', id);
          return { action: 'park' };
        },
        onQuestion: async (questions) => {
          if (this.store.requireItem(id).file.frontmatter.taken_over) return;
          const triage = this.triageOps(this.store.requireItem(id).file.frontmatter, 'question');
          const park = this.recordPark(id, 'question', String((questions as { question?: string }[])[0]?.question ?? 'a question'), triage.on ? 'orchestrator' : 'user');
          this.store.mutateItem(id, [{ set: { awaiting: 'question', awaiting_data: { questions, requested_at: this.now(), park } } }, { activity: { actor: 'app', text: `parked: agent asked ${questions.length} question(s)` } }, ...triage.ops], 'engine', { commit: `${id}: awaiting answers` });
          if (triage.on) this.wakeWhenIdle(id, 'worker_question');
        },
        onOutput: (text) => { const t = this.turns.get(id); if (t) t.lastOutput = text.slice(-400); this.emit({ type: 'session.output', id, text }); },
        signal: abort.signal,
      }); }));
    } finally {
      this.turns.delete(id);
    }
    const after = this.store.requireItem(id).file.frontmatter;
    const sessionNow = metered ? result.sessionId ?? after.session_id : result.sessionId ?? after.agent_sessions?.[runner];
    // A fresh conversation has its id: it is the item's from here on, and the brief's marker has done its work.
    const started = replaced !== undefined && result.sessionId !== undefined && result.sessionId !== replaced;
    const { fresh_brief: _brief, ...opDataAfter } = after.op_data ?? {};
    const context = metered ? sessionContextAfter(after.session_context, sessionNow, model as string, result, this.now()) : undefined;
    this.store.mutateItem(id, [
      { set: {
        ...(metered ? { session_id: sessionNow } : result.sessionId ? { agent_sessions: { ...(after.agent_sessions ?? {}), [runner]: result.sessionId } } : {}),
        ...(context ? { session_context: context } : {}),
        ...(started && after.op_data?.fresh_brief ? { op_data: opDataAfter } : {}),
        cost_usd: Math.round(((after.cost_usd ?? 0) + result.costUsd) * 10000) / 10000, turns: (after.turns ?? 0) + result.numTurns,
        ...(metered || result.subtype === 'resume_declined' ? {} : { agent_turns: (after.agent_turns ?? 0) + 1 }),
        ...(result.tokens ? { tokens: (after.tokens ?? 0) + result.tokens } : {}),
      } },
      ...(started ? [{ activity: { actor: 'app', text: `this item's conversation is now ${result.sessionId!.slice(0, 8)}; the one before it (${replaced}) was not resumed and is kept on disk` } } as ItemOp] : []),
      // A turn killed by stop() keeps its op: that is what resumeInterrupted looks for at the next
      // start. Cleared, the item sat in its phase with nothing to resume it, holding a session slot.
      ...(after.op === op && !(result.subtype === 'killed' && this.stopping) ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
    ], 'engine');
    this.warnOnBudget(id, after, this.store.requireItem(id).file.frontmatter);
    // The quote beside what the turn really cost, so an estimate that drifts from the bill is seen (HH-247's resume was quoted nowhere).
    this.store.journal.end(opId, id, result.isError ? 'failed' : 'ok', { subtype: result.subtype, cost: result.costUsd, parked: result.parked, ...(result.sessionTotalUsd !== undefined ? { session_total: result.sessionTotalUsd } : {}), ...(result.contextTokens ? { context_tokens: result.contextTokens } : {}), ...(result.resumeQuote ? { quoted_reload_usd: result.resumeQuote.cacheWriteUsd, quoted_tokens: result.resumeQuote.contextTokens, quoted_cache_expired: result.resumeQuote.cacheExpired } : {}), ...(replaced !== undefined ? { fresh: true, replaced_session: replaced } : {}) });
    if (started) this.store.journal.append({ type: 'session.replaced', item: id, actor: 'engine', data: { from: replaced, to: result.sessionId, why: path.path === 'fresh' ? path.why : 'fresh' } });
    this.usageSeen(result.rateLimit);
    this.emit({ type: 'session.ended', id, subtype: result.subtype });
    for (const f of result.toolFailures ?? []) this.store.mutateItem(id, [{ activity: { actor: 'app', text: `planestro tool ${f.tool} failed before reaching planestro (nothing was recorded): ${f.error}` } }], 'engine');
    const stoppedFor = this.stoppedFor.get(id); this.stoppedFor.delete(id);
    if (result.subtype === 'killed') { this.store.mutateItem(id, [{ activity: { actor: 'app', text: stoppedFor && !this.stopping ? `turn stopped: ${stoppedFor}` : 'turn interrupted (engine stopping); resumable' } }], 'engine'); return result; }
    if (result.subtype === 'resume_declined') {
      // Nothing was sent and nothing spent. The same turn again, on the CLI's numbers: a fresh conversation if it may have one, else the stop.
      const q = result.resumeQuote;
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `did not resume this item's conversation: the CLI quoted ${q ? `$${q.cacheWriteUsd.toFixed(2)} to reload its ${Math.round(q.contextTokens / 1000)}k tokens${q.cacheExpired === false ? ' (cache still warm)' : ''}` : 'a reload it cannot pay for'}, with $${usdLeft.toFixed(2)} left` } }], 'engine');
      if (!declined || opts.estimate) { this.block(id, 'over_budget', `this item has $${usdLeft.toFixed(2)} left of its $${budget.usd} budget (${budget.usdKey}) and its conversation costs more than that to reload; nothing was spent`); return result; }
      return this.runTurnFor(id, phase, asked, extraAllowed, oneShotCommands, { ...opts, estimate: declined });
    }
    if (result.subtype === 'usage_exhausted') {
      // Remember the outage for every item on this machine, then run the same turn again: with
      // fallback allowed it resolves to the next model in the chain; without, it blocks.
      const until = this.recordUnavailable(def, result.usageLimit);
      if (allowFallback && !this.stopping && fallbackChain(this.store.config, requested).some((m) => m.id !== def.id && !unavailableEntry(this.store.local.model_unavailable, m.id, new Date(Date.now())))) {
        this.store.mutateItem(id, [{ activity: { actor: 'app', text: `${def.label} is out of usage until ${until}; retrying this ${phase} turn on its fallback` } }], 'engine');
        return this.runTurnFor(id, phase, prompt, extraAllowed, oneShotCommands, { ...opts, final: true, ...(replaced !== undefined ? { fresh: true as const } : {}) });
      }
      this.block(id, 'usage_exhausted', `${def.label} is out of usage until ${until}${allowFallback ? ' and has no available fallback' : ' (this item does not allow a fallback model)'}: ${result.usageLimit?.message ?? ''}`);
      return result;
    }
    if (result.isError && phase !== 'plan' && result.subtype !== 'session_lost' && !result.blocked) {
      // The turn failed (often its budget ran out) after the work was done: it reported done, or it
      // moved the branch. The deterministic check decides from git what happens next, as for a turn
      // that ended cleanly; blocking on the error left finished work stranded (HH-125).
      const headAfter = headBefore === undefined ? undefined : await this.ports.git.revParse(cwd, 'HEAD').catch(() => undefined);
      const moved = headAfter !== undefined && headAfter !== headBefore;
      if (result.done || moved) {
        this.store.mutateItem(id, [{ activity: { actor: 'app', text: `turn ended in ${result.subtype} after ${result.done ? 'reporting done' : `moving the branch to ${headAfter!.slice(0, 7)}`}; checking the work anyway` } }], 'engine');
        await this.afterTurn(id, phase, result);
        return result;
      }
    }
    // A planning turn that ran out of its cap with no plan is not an error to judge: it is asked for the plan (afterTurn).
    if (result.isError && phase === 'plan' && result.subtype === 'error_max_budget_usd' && !result.planSubmitted) { await this.afterTurn(id, phase, result); return result; }
    if (result.isError) {
      // A failure the person can act on keeps its own name; the rest are turn errors for the orchestrator to judge.
      const reason = ACTIONABLE_FAILURES.has(result.subtype) ? result.subtype : 'turn_error';
      if (result.subtype === 'session_lost' && !metered) { const { [runner]: _gone, ...rest } = this.store.requireItem(id).file.frontmatter.agent_sessions ?? {}; this.store.mutateItem(id, [{ set: { agent_sessions: rest } }], 'engine'); }
      this.block(id, reason, `${result.subtype}: ${result.error ?? result.text.slice(-300)}`);
      return result;
    }
    await this.afterTurn(id, phase, result);
    return result;
  }

  private async afterTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void> {
    let fm = this.store.requireItem(id).file.frontmatter;
    // A permission request followed by report_done/submit_plan in the same turn is stale:
    // the worker proceeded without it. Clear it instead of stalling on a moot prompt. Not while the
    // tree is dirty and nobody commits for it: then the request (often the `rm` of stray files) is
    // what cleans it, and clearing it judged the tree before it could run (dogfood p54, HH-222).
    const pendingPermission = fm.awaiting === 'permission' || (fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission');
    const neededToClean = pendingPermission && result.done && phase !== 'plan' && fm.worktree && !this.commitsFor(fm) && !(await this.worktreeDirt(this.absWorktree(fm.worktree))).clean;
    if (pendingPermission && (result.done || result.planSubmitted) && !neededToClean) {
      this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: 'app', text: 'cleared a stale permission request (the turn finished its work without it)' } }], 'engine');
      fm = this.store.requireItem(id).file.frontmatter;
    }
    // Same for an agent_blocked flag the worker outlived: it was resumed, did not block again this
    // turn and reported done. Whatever door resumed it, the block is answered.
    if (fm.blocked && fm.blocked_reason === 'agent_blocked' && result.done && !result.blocked) {
      this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: 'app', text: 'cleared a stale agent_blocked flag (the resumed session reported done)' } }], 'engine');
      fm = this.store.requireItem(id).file.frontmatter;
    }
    // A model whose commits are planestro's (dogfood p11: its sandbox sometimes cannot write git's
    // lock) blocked with work in the tree: planestro commits it, whatever the block says (#55). A
    // block about git or committing is then answered, so it is cleared and the session resumed to
    // say so; any other block stands, and whoever looks at it finds the work committed.
    if (fm.blocked && fm.blocked_reason === 'agent_blocked' && result.blocked && phase !== 'plan' && this.commitsFor(fm) && fm.worktree) {
      const aboutGit = GIT_REFUSAL.test(result.blocked) || ASKS_COMMIT.test(result.blocked);
      const head = await this.commitForWorker(id, aboutGit ? `work committed by planestro: the session could not write git (${result.blocked.slice(0, 120)})` : result.blocked);
      if (head && aboutGit) {
        this.pendingWakes.delete(id);
        this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: 'app', text: `the session blocked on committing its work; planestro committed it (${head.slice(0, 7)}) and resumes it` } }], 'engine', { commit: `${id}: committed for the session` });
        await this.runTurnFor(id, phase, `${this.resumeNote(id, 'planestro')}\n\nYour work is committed now (${head.slice(0, 7)}): planestro commits for you when your sandbox cannot write git. Do not try git again. If the work is complete, report done; otherwise carry on and report done when it is.`);
        return;
      }
      if (head) this.store.mutateItem(id, [{ activity: { actor: 'app', text: `committed the session's work (${head.slice(0, 7)}) before its block, so nothing is left only in the tree (engine_commits); the block stands` } }], 'engine', { commit: `${id}: committed for the session` });
    }
    if (fm.awaiting || fm.blocked) return;                       // parked or agent-blocked: nothing to drive
    // This turn parked and was answered before it had finished ending (the orchestrator can be
    // that quick): the answer's turn is queued behind this one, and it, not this, decides what is done.
    if (result.parked && !result.done && !result.planSubmitted) return;
    const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
    if (pending.length) {
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: [] } } }], 'engine');
      await this.runTurnFor(id, phase, `Messages from the user while you were working:\n\n${pending.map((m) => `- ${m}`).join('\n')}`);
      return;
    }
    if (phase === 'plan') {
      if (fm.status !== 'PLAN_IN_PROGRESS' || result.planSubmitted) return;
      // A planning turn without a plan is asked for one, once, before anyone is woken (dogfood p18,
      // p35, p41): the hand-in was lost in transport (sdk-notes gotcha 11), the turn hit its cap
      // while still researching, or the model simply stopped. Only a second miss is a block.
      const tool = fm.kind === 'epic' ? 'submit_breakdown' : 'submit_plan';
      const failed = result.toolFailures?.find((f) => f.tool === 'submit_plan' || f.tool === 'submit_breakdown');
      const capped = result.subtype === 'error_max_budget_usd';
      const cap = `$${this.store.config.budget_usd_per_plan_turn}`;
      const retried = Number(fm.op_data?.plan_retry_turns ?? 0);
      const why = failed ? `its ${failed.tool} call failed in transport (${failed.error})` : capped ? `it hit the ${cap} planning-turn cap (budget_usd_per_plan_turn) while still working` : 'it ended without calling submit_plan';
      if (retried < 1) {
        this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), plan_retry_turns: retried + 1 } } }, { activity: { actor: 'app', text: `no plan yet: ${why}; asking the session for it now` } }], 'engine');
        await this.runTurnFor(id, phase, failed
          ? `Your ${failed.tool} call failed before it reached planestro (${failed.error}); nothing was recorded. This is a transport failure, not a problem with your plan or budget. Call ${failed.tool} again with the same plan, then end your turn.`
          : `Your planning turn ended without a plan: ${why}. Do not research further. Write the plan now from what you already know, as concretely as you can, and put anything still unknown in it as an open question for the user; then call ${tool} and end your turn.`);
        return;
      }
      this.block(id, 'no_plan', `${why}, and again after being asked for the plan${failed ? '; not a budget or plan problem — unblocking resumes the session' : ''}`);
      return;
    }
    await this.afterWorkTurn(id, phase, result);
  }

  /**
   * Why no turn of this phase can be started for the item on what it has left, or undefined when one
   * can (resumed, or fresh). The same choice runTurnFor makes, for a caller that must know before it
   * spends something on the turn. Only Claude turns are paid for in dollars.
   */
  private cannotStart(fm: ItemFrontmatter, phase: TurnPhase, fresh?: true | 'auto'): string | undefined {
    const def = this.store.config.models.find((m) => m.id === (phase === 'plan' ? fm.planner : fm.implementer));
    if (!def || (def.runner ?? 'claude') !== 'claude') return undefined;
    const path = chooseTurnPath({ left: this.budgetOf(fm).usd - (fm.cost_usd ?? 0), estimate: fm.session_id ? this.resumeEstimateFor(fm, def.claude_model) : undefined, hasSession: Boolean(fm.session_id), fresh: phase === 'plan' ? undefined : fresh, freshAboveUsd: this.store.config.budget_usd_fresh_above });
    return path.path === 'stop' ? path.why : undefined;
  }

  /** Whether planestro commits for this item's implementer (engine_commits on its model row). */
  private commitsFor(fm: { implementer?: string }): boolean { return Boolean(this.store.config.models.find((m) => m.id === fm.implementer)?.engine_commits); }

  /** Stage and commit the worktree with the worker's own words as the message. Undefined when there was nothing to commit or it failed (said in Activity). */
  private async commitForWorker(id: string, summary: string): Promise<string | undefined> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const cwd = this.absWorktree(fm.worktree!);
    const { clean, byproducts } = await this.worktreeDirt(cwd);
    if (clean) return undefined;
    const label = this.store.config.models.find((m) => m.id === fm.implementer)?.label ?? fm.implementer;
    const first = summary.split('\n')[0].slice(0, 72);
    try { return await this.ports.git.commitAll(cwd, `${id}: ${first}\n\n${summary}\n\nCommitted by planestro for ${label} (engine_commits).`, byproducts); }
    catch (e) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `could not commit the session's work for it: ${(e as Error).message.slice(0, 200)}` } }], 'engine'); return undefined; }
  }

  /**
   * op_data without the dirty-tree reminder count (the same object when there is none). The count is
   * spent per stretch of dirty turns: a clean turn, an unblock, a retry or a hand-back starts it again,
   * or one more turn end re-blocked an item seconds after it was unblocked (dogfood p54, HH-215).
   */
  private static withoutDirtyCount<T extends Record<string, unknown> | undefined>(opData: T): T {
    if (opData?.dirty_tree_turns === undefined) return opData;
    const { dirty_tree_turns: _spent, ...rest } = opData;
    return rest as T;
  }

  /** Deterministic "is it really done": clean tree + commits ahead of the base. */
  private async afterWorkTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) return; // the person decides what is done now; the hand-back runs this check again
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    let { clean, dirty } = await this.worktreeDirt(cwd);
    // It reported done and left the work uncommitted, and its model's commits are planestro's (p11).
    const summary = result.done ?? (fm.op_data?.done_summary as string | undefined);
    if (!clean && summary && this.commitsFor(fm)) {
      const head = await this.commitForWorker(id, summary);
      if (head) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `committed the session's work for it (${head.slice(0, 7)}, ${dirty.length} file${dirty.length === 1 ? '' : 's'}): its model's commits are planestro's (engine_commits)` } }], 'engine'); ({ clean, dirty } = await this.worktreeDirt(cwd)); }
    }
    // A turn that parked on a permission or question is not judged: its answer's turn, queued
    // behind it, is the one that can clean the tree, so no reminder is spent on it (dogfood p54, HH-222).
    if (!clean && result.parked) return;
    if (!clean) {
      // A reminder the item cannot pay for is not spent (HH-247: it was sent at the instant the budget
      // stopped the item, so it could never act). The stop says which files, for whoever can commit them without a turn.
      const cannot = this.cannotStart(fm, phase, 'auto');
      if (cannot) { this.block(id, 'over_budget', `the worktree has ${dirty.length} uncommitted file${dirty.length === 1 ? '' : 's'} (${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}) and the item cannot pay for a turn to commit them: ${cannot}. Nothing was started. commit_paths commits the ones that belong without a turn; finish_from_worktree (retry_op in review) carries on from there`); return; }
      const tries = Number(fm.op_data?.dirty_tree_turns ?? 0) + 1;
      if (tries > 2) { this.block(id, 'dirty_tree', `the worktree still has uncommitted changes after ${tries - 1} reminders: ${dirty.slice(0, 5).join(', ')}`); return; }
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), dirty_tree_turns: tries } } }, { activity: { actor: 'app', text: `worktree dirty after turn (${dirty.length} files); asking the session to commit` } }], 'engine');
      await this.runTurnFor(id, phase, this.store.renderPrompt('commit-dirty-tree', item, { dirty_files: dirty.join('\n') }), [], [], { fresh: 'auto' });
      return;
    }
    const opData = LiveEngine.withoutDirtyCount(fm.op_data);
    if (opData !== fm.op_data) this.store.mutateItem(id, [{ set: { op_data: opData } }], 'engine'); // clean: the next dirty turn gets its reminders afresh
    await this.ports.git.fetch(this.repo);
    const { ahead } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    if (fm.status === 'IN_PROGRESS') {
      if (ahead === 0) { this.block(id, 'no_commits', 'the session reported done but the branch has no commits ahead of its base'); return; }
      if (await this.blockOversize(id)) return;
      // Only after a turn: retry_op, finish_from_worktree and a restart's carry-on come here with no turn (numTurns 0) and open the PR as they are.
      if (!summary && result.numTurns > 0) {
        // Its report is what the reviewer reads (#99): HH-248 and HH-249 committed and ended without it, so the check tally
        // and the capture paths their approval notes asked for were lost. One short follow-up asks for it, right away while
        // the conversation is warm; then the pull request opens with or without it.
        const cannot = fm.op_data?.report_nudged ? 'asked once already' : this.cannotStart(fm, phase, 'auto');
        if (!cannot) {
          this.store.mutateItem(id, [{ set: { op_data: { ...(this.store.requireItem(id).file.frontmatter.op_data ?? {}), report_nudged: true } } }, { activity: { actor: 'app', text: 'turn ended with commits but without report_done; asking the session for its report before the pull request' } }], 'engine');
          await this.runTurnFor(id, phase, this.reportNudge(fm), [], [], { fresh: 'auto' });
          return;
        }
        this.store.mutateItem(id, [{ activity: { actor: 'app', text: `turn ended with commits but without report_done (${cannot}); proceeding to a pull request` } }], 'engine');
      }
      await this.openPr(id, summary);
      return;
    }
    if (fm.status === 'IN_REVIEW') {
      if (await this.blockOversize(id)) return;
      const head = await this.ports.git.revParse(cwd, 'HEAD');
      const moved = head !== fm.ci_head_sha;
      const held = Boolean(fm.skip_merge);
      this.store.mutateItem(id, [
        { set: { ci_result: 'pending', op_data: { ...(opData ?? {}), needs_session_rebase: false } } },
        { activity: { actor: 'app', text: moved ? `session updated the branch (${head.slice(0, 7)}); ${held ? 'held, so it is pushed for CI and review but not merged' : 're-entering the merge pipeline'}` : 'session finished without changing the branch; re-checking' } },
      ], 'engine');
      this.heldPolledAt.delete(id);
      void this.tick();
    }
  }

  /** The one follow-up for a turn that committed without report_done (#99): the report, and nothing else. */
  private reportNudge(fm: ItemFrontmatter): string {
    const notes = String(fm.op_data?.approval_notes ?? '').trim();
    return [
      'Your work is committed, but you ended your turn without calling report_done, so there is no report for the reviewer.',
      'Call report_done now with your summary: what you changed and why, the result of the checks you ran (the tally), and anything a reviewer should know (choices you made, what you left out).',
      ...(notes ? [`The approval notes asked for this in your report as well:\n${notes.slice(0, 1500)}`] : []),
      'Do not change or commit anything else. Then end your turn.',
    ].join('\n\n');
  }

  private async openPr(id: string, summary?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'not opening a pull request: you have this item (taken over)' } }], 'engine'); return; }
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    const implementer = this.store.config.models.find((m) => m.id === fm.implementer);
    const held = Boolean(implementer?.hold_for_review);
    const holdInto = this.holdIntoReason(base, fm.skip_merge);
    // A held PR opens as a draft: no CI while it waits for a person, one run once it is released (dogfood f6).
    const draft = this.store.config.ci.draft_while_held && (held || Boolean(fm.review_hold) || Boolean(fm.skip_merge) || Boolean(holdInto));
    const opId = this.store.journal.begin('creating_pr', id, { branch: fm.branch, base });
    this.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.now() } }], 'engine');
    await this.ports.git.pushSetUpstream(cwd, fm.branch!);
    this.store.mutateItem(id, [{ set: { op: 'creating_pr', op_started_at: this.now() } }], 'engine');
    const existing = (await this.ports.gh.prList(this.github, { head: fm.branch!, state: 'open' }))[0];
    if (existing && draft && !existing.isDraft) await this.ports.gh.setDraft(this.github, existing.number, true);
    const pr = existing ? { number: existing.number, url: existing.url } : await this.ports.gh.createPr(this.github, {
      base, head: fm.branch!, title: `${fm.title} (${id})`, draft,
      body: `${summary ?? getSection(item.file, 'Description').slice(0, 1500)}\n\n---\nplanestro item **${id}** · plan:\n\n${getSection(item.file, 'Plan').slice(0, 3000)}\n\n🤖 Opened by planestro`,
    });
    this.store.mutateItem(id, [
      { transition: { to: 'IN_REVIEW', actor: 'engine' } },
      { set: { pr: pr.number, ci_result: 'pending', ...(held ? { review_hold: true } : {}), ...(draft ? { op_data: { ...(this.store.requireItem(id).file.frontmatter.op_data ?? {}), pr_draft: true } } : {}) } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `opened PR #${pr.number} → ${base} (${pr.url})${draft ? ' as a draft: it is held, so CI waits until the hold is released' : ''}` } },
      ...(held ? [{ activity: { actor: 'app' as const, text: `will wait for your review before merging: ${implementer!.label} is a hold_for_review model` } }] : []),
      ...(holdInto ? this.holdOps(holdInto, 'app') : []),
    ], 'engine', { commit: `${id}: open PR #${pr.number}` });
    this.store.journal.end(opId, id, 'ok', { pr: pr.number });
    this.note('info', `${id}: PR #${pr.number} opened against ${base}`);
    this.wakeOrchestrator('pr_opened', id);
    void this.tick();
  }

  // ---- merge pipeline: the serial chain syncs and merges; CI is waited for outside it ----
  private mergeJob(id: string, opts: { hold?: boolean } = {}): Promise<void> {
    const run = this.mergeChain.then(() => this.mergeStep(id, opts));
    this.mergeChain = run.catch(() => undefined);
    return run;
  }

  /**
   * One pass through the serial merge chain: sync with the base, then merge if CI is already green
   * for the head that is there. Nothing in here waits on CI (dogfood p15: HH-117 sat in the chain
   * for twenty minutes of CI, only to stop at its review hold, while three approved PRs whose CI
   * was green queued behind it). A head that is not green yet leaves the chain as `op: awaiting_ci`;
   * watchCi polls it outside and brings it back once it is green. With `hold`, for a held item whose
   * session committed: sync and push only, then leave, so the PR shows the work and CI runs;
   * driveHeld reads the verdict.
   */
  private async mergeStep(id: string, { hold = false }: { hold?: boolean } = {}): Promise<void> {
    if (this._paused || this.draining || this.stopping) return;
    let item = this.store.requireItem(id);
    let fm = item.file.frontmatter;
    if (fm.status !== 'IN_REVIEW' || fm.blocked || fm.awaiting || fm.taken_over) return;
    if (hold && !fm.skip_merge) return;
    const d = this.store.derived(item);
    const base = d.base_branch!;
    const integration = fm.kind === 'epic';
    const canFix = d.flavor === 'worker';
    // Never merge over a message still queued for the session (HH-263): the designer's ruling "ship the Crawler" sat in
    // the queue through a 14-minute CI wait, then the PR merged without it. It goes to the session now; the PR comes back after.
    if (canFix && this.deliverQueued(id, 'before its pull request merges')) return;
    if (!fm.worktree) {
      // epics and app-policy external items have no session worktree: make a temporary one from the remote branch
      const dir = join(this.store.worktreesRoot(), `merge-${id.toLowerCase()}`);
      await this.ports.git.fetch(this.repo);
      await this.ports.git.worktreeAdd(this.repo, dir, fm.branch!, `origin/${fm.branch}`);
      this.store.mutateItem(id, [{ set: { worktree: dir } }, { activity: { actor: 'app', text: `temporary worktree ${dir} for the merge pipeline` } }], 'engine');
      item = this.store.requireItem(id); fm = item.file.frontmatter;
    }
    const cwd = this.absWorktree(fm.worktree!);
    const cfg = this.store.config.ci;
    const opId = this.store.journal.begin(hold ? 'held_sync' : 'merge', id, { pr: fm.pr, base });

    if (cfg.require_green_base && !hold) {
      const health = await this.ports.gh.branchCi(this.github, base, this.ciWorkflow);
      // A verdict only counts if it is about the CURRENT base tip. Since push-triggered
      // runs on the default branch were removed (PRs gate it), the latest push run can be
      // arbitrarily stale — a red from last week must not block today's merges.
      const baseTip = await this.ports.git.revParse(this.repo, `origin/${base}`).catch(() => null);
      const current = !health.sha || !baseTip || health.sha === baseTip;
      if (health.state === 'failure' && current) { this.store.journal.end(opId, id, 'aborted', { reason: 'base_red' }); this.block(id, 'base_red', `the base branch ${base} is red at its tip (${health.url ?? 'no run url'}); fix the base or disable ci.require_green_base`); return; }
      if (health.state === 'failure' && !current) this.store.mutateItem(id, [{ activity: { actor: 'app', text: `ignoring a stale red on ${base} (run is for ${health.sha?.slice(0, 7)}, tip is ${baseTip?.slice(0, 7)})` } }], 'engine');
    }

    // 1. sync with the base — worker branches rebase, integration branches merge (never rewritten)
    this.store.mutateItem(id, [{ set: { op: integration ? 'syncing_base' : 'rebasing', op_started_at: this.now(), op_data: { ...(fm.op_data ?? {}), base_sha: null } } }], 'engine');
    await this.ports.git.fetch(this.repo);
    const inTheWay = await this.clearForSync(id, cwd, base);
    if (inTheWay.length) { this.store.journal.end(opId, id, 'aborted', { reason: 'dirty' }); this.block(id, 'dirty_tree', `the worktree has uncommitted changes, so it cannot be synced: ${inTheWay.slice(0, 5).join(', ')}${inTheWay.length > 5 ? ` and ${inTheWay.length - 5} more` : ''}`); return; }
    const baseSha = await this.ports.git.revParse(this.repo, `origin/${base}`);
    const expected = await this.ports.git.remoteBranchSha(this.repo, fm.branch!);
    // An integration branch moves on GitHub whenever a child merges into it: take that in before merging
    // the base, or the push is refused as non-fast-forward, and a retry refuses the same way (dogfood p53, HH-172).
    if (integration && expected && !(await this.ports.git.isAncestor(cwd, expected, 'HEAD'))) {
      const own = await this.ports.git.merge(cwd, `origin/${fm.branch}`);
      if (!own.ok) {
        this.store.journal.end(opId, id, 'aborted', { reason: 'conflict', files: own.conflicts });
        this.block(id, 'sync_conflict', `merging origin/${fm.branch} into its local copy in ${fm.worktree} conflicted in ${own.conflicts.join(', ')}; resolve by hand`);
        return;
      }
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `took in origin/${fm.branch} (${expected.slice(0, 7)}) before syncing: it had moved on GitHub` } }], 'engine');
    }
    const localHead = await this.ports.git.revParse(cwd, 'HEAD');
    const { behind } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    let headSha: string;
    let synced: string;
    let pushed = false;
    if (hold && expected === localHead) {
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
      this.store.journal.end(opId, id, 'aborted', { reason: 'nothing_to_push' });
      return;
    }
    if (behind === 0 && expected === localHead) {
      // Already on the base tip and the remote matches: there is nothing to sync, and the CI
      // run for this head is still the truth. Re-pushing the same commit bought nothing, and
      // rebasing here whenever an item merely entered the pipeline is what made every open
      // PR re-run CI after every merge.
      headSha = localHead;
      synced = `already on ${base}@${baseSha.slice(0, 7)}; no sync needed, reusing CI for ${headSha.slice(0, 7)}`;
    } else {
      const sync = await this.syncOnto(id, cwd, base, integration);
      if (!sync.ok) {
        this.store.mutateItem(id, [
          { unset: ['op', 'op_started_at'] },
          { set: { ci_result: 'unknown', op_data: { ...(fm.op_data ?? {}), needs_session_rebase: canFix } } },
          { activity: { actor: 'app', text: `${integration ? 'merge of' : 'rebase onto'} origin/${base} (${baseSha.slice(0, 7)}) conflicted in ${sync.conflicts.join(', ')}${sync.note ? ` (${sync.note})` : ''}${canFix ? '; handing to the session' : ''}` } },
        ], 'engine', { commit: `${id}: ${integration ? 'merge' : 'rebase'} conflict` });
        this.store.journal.end(opId, id, 'aborted', { reason: 'conflict', files: sync.conflicts });
        if (canFix) this.queueFollowUp(id, () => this.runTurnFor(id, 'fix', this.store.renderPrompt('rebase-conflict', this.store.requireItem(id), { conflict_files: sync.conflicts.join('\n'), base_sha: baseSha.slice(0, 12) }), [], [], { fresh: 'auto' }));
        else if (integration && this.store.config.epics.conflict_budget_usd > 0) {
          // An epic has no session of its own: a one-shot one resolves the merge (#71), as the item's next job, outside the
          // serial merge chain (a session inside it would hold every other merge). Resolved, it is pushed and the chain picks the epic up again.
          const conflicts = sync.conflicts;
          this.queueFollowUp(id, async () => {
            const r = await this.resolveEpicConflict(id, cwd, base, baseSha, conflicts);
            if (r !== 'resolved') this.block(id, 'sync_conflict', `merging ${base} into ${fm.branch} conflicted in ${conflicts.join(', ')}: ${r}; resolve it by hand in ${cwd}, or have the orchestrator retry with resolve_epic_conflict and a hint`);
          });
        }
        else this.block(id, 'sync_conflict', `conflicts with ${base} in ${sync.conflicts.join(', ')} and no session to hand them to; resolve by hand`);
        return;
      }

      // 2. push (integration branches push plainly; worker branches force-with-lease their rebase)
      this.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.now() } }, ...(sync.note ? [{ activity: { actor: 'app', text: sync.note } } as ItemOp] : [])], 'engine');
      if (integration) await this.ports.git.pushSetUpstream(cwd, fm.branch!);
      else await this.ports.git.pushForceWithLease(cwd, fm.branch!, expected);
      headSha = sync.head;
      pushed = true;
      if (hold) {
        this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_head_sha: headSha, ci_result: 'pending' } }, { activity: { actor: 'app', text: `held: rebased onto ${base}@${baseSha.slice(0, 7)} and pushed ${headSha.slice(0, 7)} so the PR and CI show the session's commits; not merging` } }], 'engine');
        this.store.journal.end(opId, id, 'ok', { held: true, head: headSha });
        return;
      }
      synced = `rebased onto ${base}@${baseSha.slice(0, 7)} and pushed ${headSha.slice(0, 7)}`;
    }

    // 2b. a draft PR: while it is held for review, the review comes first and CI waits; once
    // released, it is marked ready here, after the sync, so CI runs once, on the head that merges.
    const drafted = this.store.requireItem(id).file.frontmatter;
    let readied = false;
    if (this.store.config.ci.draft_while_held && drafted.op_data?.pr_draft) {
      if (drafted.review_hold && !drafted.skip_merge) {
        this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { awaiting: 'review', ci_head_sha: headSha, ci_result: 'pending' } }, { activity: { actor: 'app', text: `synced ${headSha.slice(0, 7)}; the PR is a draft, so CI runs once you approve it; waiting for your review before merging` } }], 'engine', { commit: `${id}: awaiting review` });
        this.store.journal.end(opId, id, 'aborted', { reason: 'awaiting_review' });
        return;
      }
      // ready_for_review runs CI on the head GitHub shows at that moment: right after a push that can
      // still be the replaced one, whose run is then cancelled while the pushed head's was skipped as
      // a draft's (HH-180). A few seconds' look first; refireReady covers a head that never shows.
      if (pushed) for (let i = 0; i < READY_AFTER_PUSH_POLLS && (await this.ports.gh.prView(this.github, fm.pr!)).headRefOid !== headSha; i++) await this.sleep(5_000);
      await this.ports.gh.setDraft(this.github, fm.pr!, false);
      this.store.mutateItem(id, [{ set: { op_data: { ...(drafted.op_data ?? {}), pr_draft: false } } }, { activity: { actor: 'app', text: `marked PR #${fm.pr} ready for review: CI runs on ${headSha.slice(0, 7)}` } }], 'engine');
      readied = true;
    }

    // 3. CI. Green for this exact head merges now. Anything else (a fresh push, a run still going,
    // a red, a head GitHub has not caught up with) leaves the chain for watchCi, so the next item
    // is not held up by this one's CI. `expected` is the head the push replaced: GitHub keeps
    // reporting it for a few seconds, and the watcher must read that as lag, not a moved head.
    if (pushed || readied || !(await this.greenFor(id, fm.branch!, headSha, fm.pr!))) {
      const cur = this.store.requireItem(id).file.frontmatter;
      // watchCi saw this very head green and this look says otherwise (greenFor trusts that record,
      // so only a PR head that moved gets here). Once goes back to the watcher, which reads the move;
      // a second time for the same head is not bounced between the two again: it is a stop to judge.
      const seen = cur.op_data?.ci_disagree as { sha?: string; count?: number } | undefined;
      const disagree = !pushed && !readied && cur.op_data?.ci_green === headSha ? (seen?.sha === headSha ? seen.count ?? 0 : 0) + 1 : 0;
      if (disagree >= 2) { this.store.journal.end(opId, id, 'aborted', { reason: 'ci_disagree', head: headSha }); this.block(id, 'ci_disagree', `watchCi saw CI green for ${headSha.slice(0, 7)} but the merge step did not, ${disagree} times; check the PR's head and its run, then unblock`); return; }
      this.store.mutateItem(id, [{ set: { op: 'awaiting_ci', op_started_at: this.now(), ci_head_sha: headSha, ci_result: 'pending', op_data: { ...(cur.op_data ?? {}), ci_replaced: pushed ? expected : null, ...(disagree ? { ci_disagree: { sha: headSha, count: disagree } } : {}) } } }, { activity: { actor: 'app', text: `${synced}; waiting for CI outside the merge queue` } }], 'engine');
      this.store.journal.end(opId, id, 'ok', { awaiting_ci: headSha });
      this.queueFollowUp(id, () => this.watchCi(id));
      return;
    }
    this.store.mutateItem(id, [{ set: { ci_head_sha: headSha, ci_result: 'green' } }, { activity: { actor: 'app', text: `${synced}; CI is green for it` } }], 'engine');
    if (this.parkIfHeld(id, opId)) return;
    await this.merge(id, opId, base);
  }

  /**
   * One look, no waiting: is CI green for exactly this head, with the PR on that head? What watchCi
   * or the local gate already found green for this sha is the answer, not a second poll: a status API
   * that briefly says otherwise would bounce the item between the chain and the watcher.
   */
  private async greenFor(id: string, branch: string, sha: string, pr: number): Promise<boolean> {
    const view = await this.ports.gh.prView(this.github, pr);
    if (view.state === 'MERGED') return true;
    if (view.headRefOid !== sha) return false;
    const od = this.store.requireItem(id).file.frontmatter.op_data;
    if (od?.ci_green === sha || od?.local_green === sha) return true;
    return (await this.ports.gh.ciForSha(this.github, branch, sha, this.ciWorkflow)).state === 'success';
  }

  /**
   * CI for a head the chain left waiting (`op: awaiting_ci`), polled outside the serial merge chain
   * the way driveHeld polls a held item's, so one item's CI never holds up another's merge. Red,
   * a timeout and a blocked Actions take the same paths as ever; green goes back into the chain,
   * which merges it if the head is still on the base tip, and re-syncs it if another merge moved
   * the base in the meantime.
   */
  private async watchCi(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.status !== 'IN_REVIEW' || fm.op !== 'awaiting_ci' || fm.blocked || fm.awaiting || !fm.ci_head_sha || !fm.pr || !fm.branch) return;
    const headSha = fm.ci_head_sha;
    const canFix = this.store.derived(item).flavor === 'worker';
    const cfg = this.store.config.ci;
    const opId = this.store.journal.begin('ci_wait', id, { pr: fm.pr, sha: headSha });
    let verdict = await this.waitForCi(id, fm.branch, headSha, fm.pr, (fm.op_data?.ci_replaced as string | null | undefined) ?? null);
    // A known flake is re-run once, for this same head, before anything else happens to it.
    if (verdict === 'red' && canFix) {
      const attempt = await this.rerunIfFlaky(id, headSha);
      if (attempt) verdict = await this.waitForCi(id, fm.branch, headSha, fm.pr, null, attempt);
    }
    if (verdict === 'moved') { this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }], 'engine'); this.store.journal.end(opId, id, 'aborted', { reason: 'head_moved' }); void this.tick(); return; }
    // The engine is stopping, which says nothing about CI: leave `op: awaiting_ci` on the item, and the next start re-enters the pipeline.
    if (verdict === 'stopping') { this.store.journal.end(opId, id, 'aborted', { reason: 'engine_stopping' }); return; }
    if (verdict === 'taken_over') { this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { activity: { actor: 'app', text: 'stopped waiting for CI to merge: you took this item over (its CI is still read)' } }], 'engine'); this.store.journal.end(opId, id, 'aborted', { reason: 'taken_over' }); return; }
    if (verdict === 'skipped') { this.store.journal.end(opId, id, 'aborted', { reason: 'ci_skipped', head: headSha }); this.block(id, 'ci_skipped', (await this.ports.gh.prView(this.github, fm.pr)).isDraft ? `every CI run for ${headSha.slice(0, 7)} skipped its jobs because PR #${fm.pr} is a draft; mark it ready for review, then unblock` : `every CI run for ${headSha.slice(0, 7)} skipped its jobs, again after planestro sent ready for review once more; check the workflow's job conditions, start a run by hand, then unblock`); return; }
    if (verdict === 'timeout') { this.store.journal.end(opId, id, 'aborted', { reason: 'ci_timeout' }); this.block(id, 'ci_timeout', `CI for ${headSha.slice(0, 7)} did not finish within ${cfg.timeout_min} min`); return; }
    if (verdict === 'blocked') {
      if (cfg.mode === 'github-or-local' && cfg.local_check_command) {
        this.store.mutateItem(id, [{ set: { op: 'running_local_checks', op_started_at: this.now() } }, { activity: { actor: 'app', text: `GitHub Actions is blocked; running local gate: ${cfg.local_check_command}` } }], 'engine');
        const r = await this.withLocalJobSlot(() => this.ports.proc.run(cfg.local_check_command!, { cwd: this.absWorktree(fm.worktree!), timeoutMs: cfg.timeout_min * 60_000 }));
        if (r.code !== 0) { await this.onCiRed(id, opId, headSha, `local checks exited ${r.code}\n${(r.stdout + r.stderr).split('\n').filter((l) => /FAIL|Error/i.test(l)).slice(-40).join('\n')}`, 'local'); return; }
        // Remembered for this head, so the chain's own look at it counts the local gate as its green.
        const cur = this.store.requireItem(id).file.frontmatter;
        this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), local_green: headSha } } }, { activity: { actor: 'app', text: 'local checks passed (used as the CI gate)' } }], 'engine');
      } else { this.store.journal.end(opId, id, 'aborted', { reason: 'ci_blocked' }); this.block(id, 'ci_blocked', 'GitHub Actions did not run (billing blocked or workflow missing); set ci.mode to github-or-local with a local_check_command, or re-run by hand'); return; }
    }
    if (verdict === 'red') { await this.onCiRed(id, opId, headSha, undefined, 'github', canFix); return; }
    // Green for this exact head, recorded as such: the chain's look at it reads this, never a fresh poll that could disagree.
    const cur = this.store.requireItem(id).file.frontmatter;
    this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'green', op_data: { ...(cur.op_data ?? {}), ci_green: headSha } } }], 'engine');
    if (this.parkIfHeld(id, opId)) return;
    this.store.mutateItem(id, [{ activity: { actor: 'app', text: `CI is green for ${headSha.slice(0, 7)}; back in the merge queue` } }], 'engine');
    this.store.journal.end(opId, id, 'ok', { green: headSha });
    await this.mergeJob(id);
  }

  /** Green, but a hold, block or question landed while CI ran: the verdict is kept and nothing merges. Returns whether it parked. */
  private parkIfHeld(id: string, opId: string): boolean {
    const latest = this.store.requireItem(id).file.frontmatter;
    if (latest.review_hold && !latest.skip_merge && !latest.blocked && !latest.awaiting) {
      // Synced and green: everything a machine can check has passed. What is left is a person's eye.
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'green', awaiting: 'review' } }, { activity: { actor: 'app', text: 'CI is green; waiting for your review before merging' } }], 'engine', { commit: `${id}: awaiting review` });
      this.store.journal.end(opId, id, 'aborted', { reason: 'awaiting_review' });
      return true;
    }
    if (latest.skip_merge || latest.blocked || latest.awaiting || latest.taken_over) {
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'green' } }, { activity: { actor: 'app', text: `CI is green but the item is held (${latest.taken_over ? 'taken over' : latest.skip_merge ? 'skip_merge' : latest.blocked ? 'blocked' : 'awaiting ' + latest.awaiting}); not merging` } }], 'engine');
      this.store.journal.end(opId, id, 'aborted', { reason: 'held_after_ci' });
      return true;
    }
    return false;
  }

  /** 4. merge, inside the chain, on a head the chain has just seen green on the base tip. */
  private async merge(id: string, opId: string, base: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    // Commits made after the review touch something the reviewer never saw: held for the orchestrator to accept or send back (#74).
    const extra = fm.ci_head_sha ? await this.outsideApprovedScope(id, fm.ci_head_sha) : [];
    if (extra.length) {
      const list = extra.slice(0, 8).join(', ') + (extra.length > 8 ? `, and ${extra.length - 8} more` : '');
      const why = `commits after your approval touched ${extra.length} path${extra.length === 1 ? '' : 's'} the approved change did not: ${list}`;
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, ...this.holdOps(why, 'app')], 'engine', { commit: `${id}: held (changed after approval)` });
      this.store.journal.end(opId, id, 'aborted', { reason: 'outside_approved_scope', paths: extra.slice(0, 50) });
      this.wakeOrchestrator('scope_changed', id, { paths: extra.slice(0, 50).join('\n'), policy: 'Release the hold (unskip_merge) if these belong to the change: that approves them. Otherwise message_session to revert them, and the PR is checked again before it merges.' });
      return;
    }
    // Record what this branch changed while it still exists: dependents are told from this, not from a summary.
    const delivered = await this.deliveredBy(id).catch(() => undefined);
    this.store.mutateItem(id, [{ set: { op: 'merging', op_started_at: this.now(), ci_result: 'green', ...(delivered ? { delivered } : {}) } }], 'engine');
    await this.ports.gh.mergePr(this.github, fm.pr!, { deleteBranch: true });
    const view = await this.ports.gh.prView(this.github, fm.pr!);
    if (view.state !== 'MERGED') { this.store.journal.end(opId, id, 'failed', { state: view.state }); this.block(id, 'merge_unverified', `gh reported the merge but PR #${fm.pr} is ${view.state}`); return; }
    this.store.mutateItem(id, [
      { transition: { to: 'MERGED', actor: 'engine' } },
      { set: { merged_at: view.mergedAt ? isoLocal(new Date(view.mergedAt)) : this.now(), op_data: { ...(fm.op_data ?? {}), merge_commit: view.mergeCommit } } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `merged PR #${fm.pr} into ${base}${view.mergeCommit ? ` (${view.mergeCommit.slice(0, 7)})` : ''}` } },
    ], 'engine', { commit: `${id}: merge` });
    this.store.journal.end(opId, id, 'ok', { merged: true });
    this.note('info', `${id}: PR #${fm.pr} merged into ${base}`);
    this.wakeOrchestrator('pr_merged', id);
    this.announce('on_merge', `${id} merged`, `PR #${fm.pr} merged into ${base}: ${fm.title}`, id);
    await this.cleanup(id);
  }

  /**
   * A known flake gets one re-run of its failed jobs for this head before a session is paid to "fix"
   * it (HH-122's atlas_layout_check: an 80 ms wall-clock bound on a 2-vCPU runner). Returns the
   * attempt to wait for, or undefined when this red is to be handled as a red.
   */
  private async rerunIfFlaky(id: string, headSha: string): Promise<number | undefined> {
    const patterns = this.store.config.ci.flaky_checks;
    const fm = this.store.requireItem(id).file.frontmatter;
    const ci = fm.op_data?.ci as { runId?: number; attempt?: number } | undefined;
    if (!patterns.length || !ci?.runId || (fm.op_data?.flake_rerun as { sha?: string } | undefined)?.sha === headSha) return undefined;
    const log = await this.ports.gh.runFailedLog(this.github, ci.runId, 120);
    const known = patterns.find((c) => log.includes(c));
    if (!known) return undefined;
    try { await this.ports.gh.rerunFailed(this.github, ci.runId); }
    catch (e) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `could not re-run the failed jobs of run ${ci.runId}: ${(e as Error).message.slice(0, 200)}` } }], 'engine'); return undefined; }
    const attempt = (ci.attempt ?? 1) + 1;
    this.store.mutateItem(id, [
      { set: { op_data: { ...(fm.op_data ?? {}), flake_rerun: { sha: headSha, runId: ci.runId, attempt, check: known } } } },
      { activity: { actor: 'app', text: `CI red for ${headSha.slice(0, 7)} on a known flaky check (${known}, ci.flaky_checks); re-running the failed jobs once before handing it to the session` } },
    ], 'engine', { commit: `${id}: re-run flaky CI` });
    return attempt;
  }

  /** An untracked file `worktrees.byproducts` names: something the project's tools regenerate in any worktree (Godot's `.import` sidecars), never a session's work. */
  private isByproduct(path: string): boolean {
    return this.store.config.worktrees.byproducts.some((p) => matchesGlob(p.includes('/') ? path : basename(path), p));
  }

  /** The worktree's uncommitted work: what `git status` lists, less untracked byproducts (dogfood p52). */
  private async worktreeDirt(cwd: string): Promise<{ clean: boolean; dirty: string[]; byproducts: string[] }> {
    if (!this.store.config.worktrees.byproducts.length) return { ...(await this.ports.git.status(cwd)), byproducts: [] };
    const { tracked, untracked } = await this.ports.git.dirtyDetail(cwd);
    const byproducts = untracked.filter((f) => this.isByproduct(f));
    const dirty = [...tracked, ...untracked.filter((f) => !this.isByproduct(f))];
    return { clean: dirty.length === 0, dirty, byproducts };
  }

  /**
   * Clear the way for a sync, and return what is still in it (empty: go on). The one dirty tree the
   * sync may clear by itself (dogfood p17): every change is an untracked file that the base now
   * tracks under the same path. Those are artefacts regenerated in this worktree (a Godot import run
   * leaves .import sidecars) that collide with the copies another item just merged. They are moved
   * aside to a folder outside the worktree, never deleted (invariant 7), and the Activity log names
   * them and where they went. Untracked byproducts are not in the way unless they collide too.
   * Anything else leaves the tree as it is.
   */
  private async clearForSync(id: string, cwd: string, base: string): Promise<string[]> {
    const { tracked, untracked } = await this.ports.git.dirtyDetail(cwd);
    const work = untracked.filter((f) => !this.isByproduct(f));
    if (tracked.length) return [...tracked, ...work];
    if (!untracked.length) return [];
    await this.ports.git.fetch(this.repo);
    const colliding = await this.ports.git.trackedAt(cwd, `origin/${base}`, untracked);
    const hit = new Set(colliding);
    const stays = work.filter((f) => !hit.has(f));
    if (stays.length) return stays;
    if (!colliding.length) return [];
    const dest = join(this.store.worktreesRoot(), '.displaced', `${id.toLowerCase()}-${this.now().replace(/[:+]/g, '-')}`);
    await this.ports.git.moveAside(cwd, colliding, dest);
    const left = (await this.worktreeDirt(cwd)).dirty;
    if (left.length) return left;
    this.store.mutateItem(id, [{ activity: { actor: 'app', text: `moved ${colliding.length} untracked file${colliding.length === 1 ? '' : 's'} that ${base} now tracks out of the way (regenerated copies; nothing deleted) to ${dest}: ${colliding.slice(0, 12).join(', ')}${colliding.length > 12 ? ', …' : ''}` } }], 'engine', { commit: `${id}: set regenerated files aside` });
    return [];
  }

  private async onCiRed(id: string, opId: string, headSha: string, logText: string | undefined, source: 'github' | 'local', canFix = true): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const ci = fm.op_data?.ci as { runId?: number; url?: string } | undefined;
    // The same completed run re-observed (e.g. a manual re-run was just requested and the
    // run hasn't flipped to in_progress yet) is the SAME verdict, not a second failure.
    const lastRed = fm.op_data?.last_red as { runId?: number; sha?: string } | undefined;
    if (source === 'github' && lastRed && lastRed.runId === ci?.runId && lastRed.sha === headSha) {
      this.store.mutateItem(id, [
        { unset: ['op', 'op_started_at'] },
        { set: { ci_result: 'pending' } },
        { activity: { actor: 'app', text: `same red run ${ci?.runId} re-observed for ${headSha.slice(0, 7)}; not counted again (waiting for a re-run or a new push)` } },
      ], 'engine');
      this.store.journal.end(opId, id, 'aborted', { reason: 'same_red_run' });
      await this.sleep(30_000);
      void this.tick();
      return;
    }
    const count = (fm.ci_failed_count ?? 0) + 1;
    const log = logText ?? (ci?.runId ? await this.ports.gh.runFailedLog(this.github, ci.runId, 120) : '(no run id)');
    this.store.mutateItem(id, [
      { unset: ['op', 'op_started_at'] },
      { set: { ci_result: 'red', ci_failed_count: count, op_data: { ...(fm.op_data ?? {}), last_red: { runId: ci?.runId, sha: headSha } } } },
      { activity: { actor: 'app', text: `CI red (${source}, attempt ${count}) for ${headSha.slice(0, 7)}${ci?.url ? ` ${ci.url}` : ''}` } },
    ], 'engine', { commit: `${id}: CI red (${count})` });
    this.store.journal.end(opId, id, 'failed', { reason: 'ci_red', count });
    if (this.store.requireItem(id).file.frontmatter.taken_over) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'no fix turn: you have this item (taken over)' } }], 'engine'); return; }
    if (!canFix) { this.block(id, 'ci_red', 'CI is red and there is no session to hand the failure to; investigate by hand'); return; }
    if (count >= 2) { this.block(id, 'ci_red_twice', `CI failed ${count} times`); this.wakeOrchestrator('ci_red_again', id, { failed_log: log.slice(0, 3000) }); return; }
    this.queueFollowUp(id, () => this.runTurnFor(id, 'fix', this.store.renderPrompt('ci-failed', this.store.requireItem(id), { ci: { attempt: String(count), run_url: ci?.url ?? '(local run)', failed_log: log } }), [], [], { fresh: 'auto' }));
  }

  private ciSkipCache = new Map<string, string | null>();
  /** Why the project's CI workflow runs nothing for this head's pull request (prSkippedByPaths), or null; read once per head, from the head itself. */
  private async ciSkipsHead(id: string, sha: string): Promise<string | null> {
    const key = `${id}@${sha}`;
    if (this.ciSkipCache.has(key)) return this.ciSkipCache.get(key)!;
    let why: string | null = null;
    try {
      const item = this.store.requireItem(id); const fm = item.file.frontmatter; const base = this.store.derived(item).base_branch;
      if (fm.worktree && base) {
        const cwd = this.absWorktree(fm.worktree);
        const paths = (await this.ports.git.trackedAt(cwd, sha, ['.github/workflows'])).filter((p) => /\.ya?ml$/.test(p));
        const texts = await Promise.all(paths.map(async (path) => ({ path, text: (await this.ports.git.readBlob(cwd, sha, path))?.toString('utf8') ?? '' })));
        const wf = findWorkflow(texts, this.ciWorkflow);
        if (wf) {
          const r = prSkippedByPaths(wf.doc, (await this.ports.git.changedFiles(cwd, `origin/${base}`, sha)).map((f) => f.path));
          why = r ? `${wf.path} ${r}` : null;
        }
      }
    } catch { why = null; }   // cannot tell: wait for a run as before
    this.ciSkipCache.set(key, why);
    return why;
  }

  /**
   * Poll the named workflow for `sha`. 10 s cadence for the first 2 min, then 30 s.
   *
   * `previousSha` is the head the pipeline's own push replaced. GitHub's API lags a push by a
   * few seconds, so the first `gh pr view` after a force-push still reports that sha; reading
   * it as "someone moved the head" aborted the merge in ~4 s, released the merge chain, and
   * the next item rebased and pushed too — one merge fired a fresh CI run for every open PR.
   * Within HEAD_PROPAGATION_GRACE_MS the old sha is lag and we keep polling; anything else is
   * a real move. 'stopping' is the engine shutting down, which says nothing about CI.
   */
  private async waitForCi(id: string, branch: string, sha: string, pr: number, previousSha: string | null = null, minAttempt = 0): Promise<'green' | 'red' | 'blocked' | 'moved' | 'timeout' | 'stopping' | 'taken_over' | 'skipped'> {
    const cfg = this.store.config.ci;
    // The project's CI runs nothing for this change (its own path filters): there is nothing to wait for, and nothing to stand in for (HH-324).
    const notRun = await this.ciSkipsHead(id, sha);
    if (notRun) {
      const cur = this.store.requireItem(id).file.frontmatter;
      if (cur.op_data?.ci_not_run !== sha) this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci_not_run: sha } } }, { activity: { actor: 'app', text: `CI does not run for ${sha.slice(0, 7)}: ${notRun}; nothing to check, so it counts as green` } }], 'engine');
      return 'green';
    }
    const started = Date.now();
    let sawRun = false;
    let skippedPolls = 0;
    let cancelledPolls = 0;
    // A re-run asked for by rerun_ci (#139) keeps its run id: only its new attempt is the verdict, whoever waits.
    const asked = this.store.getItem(id)?.file.frontmatter.op_data?.ci_rerun as { sha?: string; attempt?: number } | undefined;
    let need = Math.max(minAttempt, asked?.sha === sha ? asked.attempt ?? 0 : 0);
    while (true) {
      if (this.stopping) return 'stopping';
      // A person took the item over while its CI ran: the merge chain is not held for them.
      if (this.store.getItem(id)?.file.frontmatter.taken_over) return 'taken_over';
      const view = await this.ports.gh.prView(this.github, pr);
      if (view.state === 'MERGED') return 'green';
      if (view.headRefOid !== sha) {
        const lagging = previousSha !== null && view.headRefOid === previousSha && Date.now() - started < HEAD_PROPAGATION_GRACE_MS;
        if (!lagging) return 'moved';
        await this.sleep(10_000);
        continue;
      }
      const ci = await this.ports.gh.ciForSha(this.github, branch, sha, this.ciWorkflow);
      const elapsedMin = (Date.now() - started) / 60_000;
      if (ci.runId && ci.state !== 'skipped') { sawRun = true; const cur = this.store.requireItem(id).file.frontmatter; const seen = cur.op_data?.ci as { runId?: number; attempt?: number } | undefined; if (seen?.runId !== ci.runId || seen?.attempt !== ci.attempt) this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci: { runId: ci.runId, url: ci.url, ...(ci.attempt ? { attempt: ci.attempt } : {}) } } } }], 'engine'); }
      if (ci.state === 'success') return 'green';
      // A re-run keeps its run id: until its attempt shows up, the completed run is the old verdict.
      const stale = need > 0 && (ci.attempt ?? 0) < need;
      if (ci.state === 'failure' && !stale) return (ci.runId && await this.ports.gh.isBillingBlocked(this.github, ci.runId)) ? 'blocked' : 'red';
      // Cancelled is usually superseded: a newer run for this head takes its place, and ciForSha reads the newest.
      // When the newest stays cancelled nothing is coming (HH-321: a concurrency group cancelled it, and two
      // 45-minute waits followed). Its jobs are re-run once per head, and that attempt is what is waited for.
      cancelledPolls = ci.state === 'cancelled' && !stale ? cancelledPolls + 1 : 0;
      if (cancelledPolls >= CANCELLED_RERUN_POLLS && ci.runId) {
        cancelledPolls = 0;
        const cur = this.store.requireItem(id).file.frontmatter;
        if (cur.op_data?.ci_cancel_rerun !== sha) {
          let note: string;
          try { await this.ports.gh.rerunAll(this.github, ci.runId); need = (ci.attempt ?? 1) + 1; note = `CI run ${ci.runId} for ${sha.slice(0, 7)} was cancelled and no other run replaced it; re-running it`; }
          catch (e) { note = `CI run ${ci.runId} for ${sha.slice(0, 7)} was cancelled and could not be re-run (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}); waiting for a new run`; }
          this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci_cancel_rerun: sha } } }, { activity: { actor: 'app', text: note } }], 'engine');
        }
      }
      // Only skipped runs (a draft guard skipped every job) checked nothing: not red, and on a ready PR
      // not coming by itself either, when ready_for_review landed on the head the push replaced.
      skippedPolls = ci.state === 'skipped' ? skippedPolls + 1 : 0;
      if (skippedPolls >= SKIPPED_REFIRE_POLLS && !view.isDraft) { await this.refireReady(id, pr, sha); skippedPolls = 0; }
      // p48: still only skipped once ready_for_review was sent again (or the PR is a draft, so it is never sent) is its own
      // stop, not ci_blocked: Actions did run, and the local gate is no answer to a job condition that skips everything.
      if (ci.state === 'skipped' && !sawRun && elapsedMin > cfg.start_timeout_min && (view.isDraft || this.store.requireItem(id).file.frontmatter.op_data?.ci_refired === sha)) return 'skipped';
      if (ci.state === 'none' && !sawRun && elapsedMin > cfg.start_timeout_min) return 'blocked';
      if (elapsedMin > cfg.timeout_min) return 'timeout';
      await this.sleep(elapsedMin < 2 ? 10_000 : 30_000);
    }
  }

  /**
   * Every run for this ready PR's head skipped its jobs: the ready_for_review event landed on another
   * head (HH-180: marked ready while GitHub still showed the head the push replaced), so no run is
   * coming. Draft and ready again sends the event for this head, once per head: a head that is still
   * only skipped after that waits out ci.start_timeout_min, then blocks as ci_skipped (p48).
   */
  private async refireReady(id: string, pr: number, sha: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.op_data?.ci_refired === sha) return;
    await this.ports.gh.setDraft(this.github, pr, true);
    await this.ports.gh.setDraft(this.github, pr, false);
    const cur = this.store.requireItem(id).file.frontmatter;
    this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci_refired: sha } } }, { activity: { actor: 'app', text: `every CI run for ${sha.slice(0, 7)} skipped its jobs (the PR was a draft when they started) and no other run came; sent ready for review again so CI runs on it` } }], 'engine');
  }

  /**
   * Before a worktree goes: what `worktrees.keep_on_remove` names is set aside (dogfood p40: a merge
   * removed HH-161's worktree and the art worker's raw sources in its git-ignored tmp/ with it).
   * Moved, never deleted (invariant 7), to a folder the Activity log names. Returns that line.
   */
  private async setAsideBeforeRemove(id: string, cwd: string): Promise<string | undefined> {
    const keep = this.keptPaths();
    const byproducts = this.store.config.worktrees.byproducts.length ? (await this.worktreeDirt(cwd).catch(() => ({ byproducts: [] as string[] }))).byproducts : [];
    if (!keep.length && !byproducts.length) return undefined;
    // Only what git does not track: a tracked file (HH's tmp/.gdignore) moved away is a deletion,
    // which leaves the worktree dirty and `git worktree remove` refuses it (dogfood p46). The
    // branch is merged, so its tracked files are safe in history anyway.
    const under = keep.length ? await this.ports.git.filesUnder(cwd, keep).catch(() => [] as string[]) : [];
    const tracked = new Set(under.length ? await this.ports.git.trackedAt(cwd, 'HEAD', under).catch(() => under) : []);
    const files = under.filter((f) => !tracked.has(f));
    // Byproducts are untracked by definition; `git worktree remove` refuses a tree that has them.
    const regenerated = byproducts.filter((f) => !files.includes(f));
    if (!files.length && !regenerated.length) return undefined;
    const dest = join(this.store.worktreesRoot(), '.displaced', `${id.toLowerCase()}-${this.now().replace(/[:+]/g, '-')}`);
    await this.ports.git.moveAside(cwd, [...files, ...regenerated], dest);
    const n = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`;
    const what = [
      ...(files.length ? [`${n(files.length, 'file')} under ${keep.join(', ')} (worktrees.keep_on_remove)`] : []),
      ...(regenerated.length ? [`${n(regenerated.length, 'byproduct')} (worktrees.byproducts)`] : []),
    ];
    return `set aside ${what.join(' and ')} before removing the worktree: ${dest}`;
  }

  /** What is set aside when a worktree goes: keep_on_remove, and what copy_to_checkout copies (a copy keeps its original too). */
  private keptPaths(): string[] {
    const w = this.store.config.worktrees;
    return [...new Set([...w.keep_on_remove, ...w.copy_to_checkout])];
  }

  /**
   * After a merge, before the worktree goes (#72): the untracked files under `worktrees.copy_to_checkout`
   * are copied to the same paths in the main checkout. A sandboxed worker (the art runner) cannot write
   * there, and every art brief's "copy the raws into the main tmp/" step waited on a person. Never
   * over a file with other content: that one stays only in .displaced/. Throws when a copy fails.
   */
  private async copyToCheckout(cwd: string): Promise<string | undefined> {
    const paths = this.store.config.worktrees.copy_to_checkout;
    if (!paths.length) return undefined;
    const under = await this.ports.git.filesUnder(cwd, paths);
    const tracked = new Set(under.length ? await this.ports.git.trackedAt(cwd, 'HEAD', under) : []);
    const files = under.filter((f) => !tracked.has(f) && !this.isByproduct(f));
    if (!files.length) return undefined;
    const { copied, identical, collided } = await this.ports.git.copyInto(cwd, files, this.repo);
    const n = (k: number) => `${k} file${k === 1 ? '' : 's'}`;
    return [
      `copied ${n(copied.length)} under ${paths.join(', ')} into the main checkout (worktrees.copy_to_checkout)`,
      ...(identical.length ? [`${n(identical.length)} already there`] : []),
      ...(collided.length ? [`${n(collided.length)} not copied because the checkout has a different file at that path, kept only in .displaced/: ${collided.slice(0, 10).join(', ')}${collided.length > 10 ? ', …' : ''}`] : []),
    ].join('; ');
  }

  private async cleanup(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    // A person may be standing in the worktree: it and the branch stay until the item is handed back.
    if (fm.taken_over) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'merged; its worktree and branch stay until you hand the item back' } }], 'engine'); return; }
    const d = this.store.derived(item);
    if (d.flavor === 'external' && (fm.merge_policy ?? 'watch') === 'watch') {
      this.store.mutateItem(id, [{ transition: { to: 'FINISHED', actor: 'engine' } }, { activity: { actor: 'app', text: 'externally driven: no local resources to clean (the remote branch is not planestro\'s to delete)' } }], 'engine', { commit: `${id}: finish` });
      return;
    }
    const base = d.base_branch!;
    const cwd = this.absWorktree(fm.worktree!);
    const opId = this.store.journal.begin('cleaning_up', id, { branch: fm.branch });
    this.store.mutateItem(id, [{ set: { op: 'cleaning_up', op_started_at: this.now() } }], 'engine');
    // invariant 7: positive evidence before anything is deleted
    await this.ports.git.fetch(this.repo);
    const view = await this.ports.gh.prView(this.github, fm.pr!);
    // The proof covers exactly what is about to be deleted — the worktree's HEAD and the
    // local and remote branch tips, whichever still exist — never a remembered sha: a branch
    // pushed or merged outside planestro leaves ci_head_sha stale (dogfood p39). When all
    // three are already gone (removed by hand), a merged PR leaves nothing to prove.
    const tips: Array<[string, string]> = [];
    const worktrees = await this.ports.git.worktreeList(this.repo).catch(() => []);
    if (worktrees.some((w) => w.path === cwd)) tips.push(['worktree HEAD', await this.ports.git.revParse(cwd, 'HEAD')]);
    if (fm.branch && await this.ports.git.localBranchExists(this.repo, fm.branch)) tips.push([fm.branch, await this.ports.git.revParse(this.repo, `refs/heads/${fm.branch}`)]);
    const remoteTip = fm.branch ? await this.ports.git.remoteBranchSha(this.repo, fm.branch) : null;
    if (remoteTip) tips.push([`origin/${fm.branch}`, remoteTip]);
    const stranded: string[] = [];
    for (const [what, sha] of tips) if (!await this.ports.git.isAncestor(this.repo, sha, `origin/${base}`)) stranded.push(`${what} ${sha.slice(0, 7)}`);
    if (view.state !== 'MERGED' || stranded.length) { this.store.journal.end(opId, id, 'aborted', { reason: 'unverifiable', stranded }); this.block(id, 'cleanup_unverifiable', view.state !== 'MERGED' ? `PR #${fm.pr} is ${view.state}; nothing was deleted` : `cannot prove ${stranded.join(', ')} reachable from origin/${base}; nothing was deleted`); return; }
    const { clean } = await this.worktreeDirt(cwd).catch(() => ({ clean: true }));
    if (!clean) { this.store.journal.end(opId, id, 'aborted', { reason: 'dirty' }); this.block(id, 'cleanup_dirty', 'the worktree has uncommitted changes after the merge; remove it by hand or discard them'); return; }
    let copied: string | undefined;
    try { copied = await this.copyToCheckout(cwd); }
    catch (e) { this.store.journal.end(opId, id, 'aborted', { reason: 'copy_failed' }); this.block(id, 'cleanup_dirty', `copying ${this.store.config.worktrees.copy_to_checkout.join(', ')} into the main checkout failed (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)}); nothing was removed`); return; }
    if (copied) this.store.mutateItem(id, [{ activity: { actor: 'app', text: copied } }], 'engine');
    const kept = await this.setAsideBeforeRemove(id, cwd);
    if (kept) this.store.mutateItem(id, [{ activity: { actor: 'app', text: kept } }], 'engine');
    await this.ports.git.worktreeRemove(this.repo, cwd, false);
    await this.ports.git.worktreePrune(this.repo);
    await this.ports.git.deleteLocalBranch(this.repo, fm.branch!);
    if (d.flavor !== 'external' && await this.ports.git.remoteBranchSha(this.repo, fm.branch!)) await this.ports.git.deleteRemoteBranch(this.repo, fm.branch!);
    this.store.mutateItem(id, [
      { transition: { to: 'FINISHED', actor: 'engine' } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `removed worktree and branch ${fm.branch} (local + remote)` } },
    ], 'engine', { commit: `${id}: finish` });
    this.store.journal.end(opId, id, 'ok');
    this.note('info', `${id}: finished`);
  }

  // ---- reconciliation (Phase 5): cross-check persisted state against the world ----
  /**
   * Never assumes an operation completed and never deletes on its own authority
   * (invariant 7 — deletions still go through cleanup's positive-evidence checks).
   * Every correction is logged to the item's Activity as `reconcile: …`.
   */
  async reconcile(source: 'startup' | 'periodic' | 'manual'): Promise<string[]> {
    const corrections: string[] = [];
    const correct = (id: string, text: string, ops: ItemOp[] = []) => {
      corrections.push(`${id}: ${text}`);
      this.store.mutateItem(id, [...ops, { activity: { actor: 'app', text: `reconcile: ${text}` } }], 'engine');
    };
    await this.ports.git.fetch(this.repo).catch(() => undefined);
    const worktrees = await this.ports.git.worktreeList(this.repo).catch(() => []);
    const remoteHeads = await this.ports.git.remoteHeads(this.repo).catch(() => new Map<string, string>());
    const github = this.store.config.code_repo.github;
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      const id = item.id;
      const d = this.store.derived(item);
      const wtAbs = fm.worktree ? this.absWorktree(fm.worktree) : undefined;
      const wtEntry = wtAbs ? worktrees.find((w) => w.path === wtAbs) : undefined;
      try {
        // stale in-flight ops (turn ops are handled by resumeInterrupted)
        if (fm.op && !RESUMABLE_TURN_OPS.has(fm.op) && !this.jobs.has(id) && !this.turns.has(id)) {
          if (fm.op === 'rebasing' || fm.op === 'syncing_base') {
            // A sync between turns (syncWithBase) has no CI verdict to reset; the merge step's does.
            const pendingCi: ItemOp[] = fm.status === 'IN_REVIEW' ? [{ set: { ci_result: 'pending' } }] : [];
            if (wtAbs && wtEntry && await this.ports.git.inProgressOp(wtAbs)) { await this.ports.git.abortInProgress(wtAbs); correct(id, `aborted a half-done ${fm.op} left by a crash`, [{ unset: ['op', 'op_started_at'] }, ...pendingCi]); }
            else correct(id, `cleared stale op ${fm.op}`, [{ unset: ['op', 'op_started_at'] }, ...pendingCi]);
          } else if (fm.op === 'pushing' || fm.op === 'creating_pr') {
            const pr = github && fm.branch ? (await this.ports.gh.prList(github, { head: fm.branch, state: 'open' }))[0] : undefined;
            if (pr && fm.status === 'IN_PROGRESS') correct(id, `adopted PR #${pr.number} opened before the crash`, [{ transition: { to: 'IN_REVIEW', actor: 'engine' } }, { set: { pr: pr.number, ci_result: 'pending' } }, { unset: ['op', 'op_started_at'] }]);
            else correct(id, `cleared stale op ${fm.op}; the pipeline will retry`, [{ unset: ['op', 'op_started_at'] }]);
          } else if (fm.op === 'merging' || fm.op === 'cleaning_up' || fm.op === 'awaiting_ci' || fm.op === 'running_local_checks') {
            correct(id, `cleared stale op ${fm.op}`, [{ unset: ['op', 'op_started_at'] }, ...(fm.status === 'IN_REVIEW' ? [{ set: { ci_result: 'pending' as const } }] : [])]);
          } else if (fm.op === 'creating_worktree' || fm.op === 'importing') {
            correct(id, `restart during ${fm.op}; re-running setup`, [{ unset: ['op', 'op_started_at'] }]);
            if (fm.status === 'PLAN_IN_PROGRESS' && !wtEntry) this.store.mutateItem(id, [{ transition: { to: 'QUEUED', actor: 'engine' } }], 'engine');
          }
        }
        // pull request truth
        // Not while a job or turn drives the item: the merge queue merging it is not "merged outside planestro".
        if (fm.pr && github && (fm.status === 'IN_REVIEW' || fm.status === 'MERGED' || fm.status === 'IN_PROGRESS') && !this.jobs.has(id) && !this.turns.has(id)) {
          const pr = await this.ports.gh.prView(github, fm.pr).catch(() => undefined);
          // The item as it is after that wait, not as it was read before it: LM-22's merge job moved it to MERGED in the
          // same second, and the stale IN_REVIEW read tried MERGED → MERGED and blocked a finished item as engine_error.
          const now = this.store.getItem(id)?.file.frontmatter;
          if (!now || now.status !== fm.status || this.jobs.has(id) || this.turns.has(id)) continue;
          if (pr?.state === 'MERGED' && (fm.status === 'IN_REVIEW' || fm.status === 'IN_PROGRESS')) {
            if (fm.status === 'IN_PROGRESS') this.store.mutateItem(id, [{ transition: { to: 'IN_REVIEW', actor: 'engine' } }], 'engine');
            correct(id, `PR #${fm.pr} was merged outside planestro`, [{ transition: { to: 'MERGED', actor: 'engine' } }, { set: { merged_at: pr.mergedAt ? isoLocal(new Date(pr.mergedAt)) : this.now(), ci_result: 'green' } }]);
            this.runJob(id, () => this.cleanup(id));
          } else if (pr?.state === 'CLOSED' && fm.status === 'IN_REVIEW' && !fm.blocked && !fm.taken_over) {
            this.block(id, 'pr_closed_externally', `PR #${fm.pr} was closed without merging`);
            corrections.push(`${id}: PR #${fm.pr} closed externally`);
          } else if (pr?.state === 'OPEN' && fm.status === 'IN_REVIEW' && fm.ci_head_sha && pr.headRefOid !== fm.ci_head_sha && fm.ci_result !== 'pending') {
            correct(id, `branch tip moved (${pr.headRefOid.slice(0, 7)}); CI verdict discarded`, [{ set: { ci_result: 'pending' } }]);
          }
        }
        // worktree truth (never recreate silently: local commits could be lost). Not while a job owns the item or
        // its worktree is being made, and only on a fresh read: the list and `fm` above can predate the
        // `git worktree add` of startItem / recreateWorktree / planEpic (dogfood p55, LM-12).
        const gone = d.flavor === 'worker' && wtAbs && !wtEntry && !this.jobs.has(id) && !(await this.ports.git.worktreeList(this.repo).catch(() => worktrees)).some((w) => w.path === wtAbs);
        const cur = gone && !this.jobs.has(id) ? this.store.getItem(id)?.file.frontmatter : undefined;
        if (cur && cur.worktree === fm.worktree && cur.op !== 'creating_worktree' && cur.op !== 'importing' && ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'].includes(cur.status) && !cur.blocked && !cur.taken_over) {
          this.block(id, 'worktree_missing', `the worktree ${fm.worktree} no longer exists; status preserved, nothing recreated`);
          corrections.push(`${id}: worktree missing`);
        }
        // MERGED but never finished, or FINISHED leftovers
        if (fm.status === 'MERGED' && !fm.op && !this.jobs.has(id) && !fm.blocked && !fm.taken_over) { corrections.push(`${id}: resuming cleanup`); this.runJob(id, () => this.cleanup(id)); }
        if (fm.status === 'FINISHED' && fm.branch && d.flavor !== 'external' && remoteHeads.has(fm.branch)) correct(id, `remote branch ${fm.branch} still exists after finish (left in place; delete by hand or re-run cleanup)`);
      } catch (e) { corrections.push(`${id}: reconcile error ${(e as Error).message}`); }
    }
    // orphans: worktrees under our root that no item references
    const root = this.store.worktreesRoot();
    const referenced = new Set(this.store.listItems().map((i) => i.file.frontmatter.worktree && this.absWorktree(i.file.frontmatter.worktree!)).filter(Boolean));
    // A worktree inside an item's worktree is that item's (a project tool made it: LM-24's look-compare baseline), not an orphan (#100).
    const inReferenced = (p: string) => [...referenced].some((r) => p.startsWith(`${r}/`));
    const orphans = worktrees.filter((w) => w.path.startsWith(root + '/') && !referenced.has(w.path) && !inReferenced(w.path));
    if (orphans.length) {
      corrections.push(`orphan worktrees: ${orphans.map((o) => o.path).join(', ')}`);
      // Wake the orchestrator only for an orphan it has not been told about: a wake per reconcile pass would re-ask the same
      // question every five minutes, and one per change re-asked about LM's four July worktrees whenever a fifth came and went.
      const key = orphans.map((o) => o.path).sort().join('|');
      const last = this.store.journal.read({ type: 'reconcile.orphans_reported', limit: 1 })[0];
      const told = new Set(String(last?.data?.key ?? '').split('|').filter(Boolean));
      if (orphans.some((o) => !told.has(o.path))) {
        this.store.journal.append({ type: 'reconcile.orphans_reported', actor: 'engine', data: { key, count: orphans.length } });
        this.wakeOrchestrator('orphans_found', undefined, { worktrees: orphans.map((o) => `${o.path} (${o.branch ?? o.head})`).join('\n') });
      }
    }
    this.store.journal.append({ type: 'reconcile.done', actor: 'engine', data: { source, corrections } });
    if (corrections.length) this.note('warn', `reconcile (${source}): ${corrections.length} correction(s): ${corrections.slice(0, 5).join(' | ')}`);
    else if (source === 'manual') this.note('info', 'reconcile: everything matches');
    return corrections;
  }

  // ---- restart recovery (Phase 3 subset; Phase 5 adds the full reconciler) ----
  private async resumeInterrupted(): Promise<void> {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (!fm.op) continue;
      if (RESUMABLE_TURN_OPS.has(fm.op)) {
        const phase = this.phaseFor(fm.status);
        this.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }, { activity: { actor: 'app', text: `turn (${fm.op}) was interrupted by a restart; ${fm.taken_over ? 'not resumed: you have this item' : 'resuming'}` } }], 'engine');
        if (phase && !fm.awaiting && !fm.blocked && !fm.taken_over) this.runJob(item.id, () => this.runTurnFor(item.id, phase, 'Your previous turn was interrupted before it finished. Check the state of your worktree and continue where you left off.', [], [], { fresh: 'auto', note: 'a planestro restart', carryOn: true }));
      } else if (fm.op === 'awaiting_ci') {
        this.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }, { activity: { actor: 'app', text: 'restart while waiting for CI; re-entering the merge pipeline' } }], 'engine');
      } else {
        this.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }], 'engine');
        this.block(item.id, `interrupted_${fm.op}`, `planestro restarted during ${fm.op}; verify the repo state and unblock (the Phase 5 reconciler will do this automatically)`);
      }
    }
  }

  // ---- epics ----
  /** Push the integration branch from the epic's base and open the epic (auto when a child queues, or via API). */
  // ---- epics planned by the planner: it proposes the children, the user approves, the engine creates them
  private epicPlanDir(id: string): string { return join(this.store.worktreesRoot(), `${this.store.config.project.id_prefix.toLowerCase()}-${idNumber(id)}-plan`); }

  async planEpic(id: string, why?: string): Promise<void> { this.startEpicPlan(id, why); }

  /**
   * planEpic in one synchronous step. An epic with a step running is refused before its status moves:
   * runJob drops a second job, which would leave the epic planning with no planner (#73).
   */
  private startEpicPlan(id: string, why?: string): void {
    const busy = this.busyWith(id);
    if (busy) throw new Error(busy);
    this.runJob(id, this.beginEpicPlan(id, why));
  }

  /** planEpic's persisted half; returns its planning turn, for whoever holds the item's job slot (a conversion already does: #69). */
  private beginEpicPlan(id: string, why?: string): () => Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic') throw new Error(`${id} is not an epic`);
    if (fm.status !== 'NOT_YET_SUBMITTED') throw new Error(`${id} is ${fm.status}; only an epic that has not started can be planned`);
    const base = this.store.derived(item).base_branch;
    if (!base) throw new Error(this.store.derived(item).base_branch_error ?? `${id} has no base branch`);
    const dir = this.epicPlanDir(id);
    const worktreeRel = isAbsolute(dir) ? relative(this.repo, dir) : dir;
    this.store.mutateItem(id, [
      { transition: { to: 'PLAN_IN_PROGRESS', actor: 'user' } },
      // The integration branch gets its name now (the planner's rules speak of it); it is created on approval.
      { set: { worktree: worktreeRel, branch: fm.branch ?? `feature/${slugify(fm.title)}`, op: 'creating_worktree', op_started_at: this.now() } },
      { activity: { actor: 'app', text: `${why ? `${why}: ` : ''}planning the breakdown in a read-only checkout of origin/${base} (${worktreeRel})` } },
    ], 'user', { commit: `${id}: plan the breakdown` });
    return async () => {
      await this.ports.git.fetch(this.repo);
      if (!(await this.ports.git.worktreeList(this.repo)).some((w) => w.path === dir && !w.prunable)) await this.ports.git.worktreeAddDetached(this.repo, dir, `origin/${base}`);
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
      await this.runTurnFor(id, 'plan', this.store.renderPrompt('plan-epic', this.store.requireItem(id), { implementers: this.implementersList(), categories: this.store.config.categories.join(', ') }), [], [], { opener: true });
    };
  }

  /** Create the approved children (as edited by the user), drop the planning checkout, open the epic, and queue what can start. */
  async approveBreakdown(id: string, edited?: BreakdownChild[], opts: { queue?: boolean } = {}): Promise<string[]> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic' || fm.status !== 'PLAN_READY') throw new Error(`${id} has no breakdown waiting for approval`);
    const children = edited ?? (fm.awaiting_data?.children as BreakdownChild[] | undefined) ?? [];
    const problem = validateBreakdown(children, this.store.config.models, this.store.config.categories);
    if (problem) throw new Error(problem);
    // dependencies first, so every depends_on can name an item that already exists
    const ids = new Map<number, string>();
    for (const i of dependencyOrder(children)) {
      const c = children[i];
      // A child is planned by the model the breakdown names, else by the epic's own planner (not the project default: an outage of that one should not reach every child).
      const child = this.store.createItem({ title: c.title.trim(), description: c.description.trim(), category: c.category ?? fm.category, implementer: c.implementer, planner: c.planner ?? fm.planner, allow_model_fallback: fm.allow_model_fallback === true, parent: id, depends_on: (c.depends_on ?? []).map((d) => ids.get(d)!), ...(c.hold_for_review ? { extra: { review_hold: true } } : {}) }, 'user');
      ids.set(i, child.id);
    }
    const created = children.map((_c, i) => ids.get(i)!);
    const dir = fm.worktree ? this.absWorktree(fm.worktree) : undefined;
    this.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: 'user' } },
      { unset: ['worktree'] },
      { activity: { actor: 'user', text: `breakdown approved: created ${created.join(', ')}` } },
    ], 'user', { commit: `${id}: approve breakdown (${created.length} children)` });
    this.runJob(id, async () => {
      // The planning checkout is detached and was only ever read: a clean tree is the whole proof it holds nothing.
      if (dir) {
        const st = await this.ports.git.status(dir).catch(() => undefined);
        if (st?.clean) { await this.ports.git.worktreeRemove(this.repo, dir, false); await this.ports.git.worktreePrune(this.repo); }
        else if (st) this.store.mutateItem(id, [{ activity: { actor: 'app', text: `left the planning checkout ${dir} in place: it has uncommitted changes` } }], 'engine');
      }
      await this.ensureEpicBranch(id);
      if (opts.queue !== false) for (const cid of created) this.store.transition(cid, 'QUEUED', 'user');
      void this.tick();
    });
    return created;
  }

  async openEpic(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic' || fm.status !== 'NOT_YET_SUBMITTED') return;
    const base = this.store.derived(item).base_branch!;
    const branch = fm.branch ?? `feature/${slugify(fm.title)}`;
    const opId = this.store.journal.begin('open_epic', id, { branch, base });
    await this.ports.git.fetch(this.repo);
    if (!(await this.ports.git.remoteBranchSha(this.repo, branch))) await this.ports.git.pushRef(this.repo, `origin/${base}`, branch);
    this.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: 'engine' } },
      { set: { branch } },
      { activity: { actor: 'app', text: `opened integration branch ${branch} from origin/${base}` } },
    ], 'engine', { commit: `${id}: open epic` });
    this.store.journal.end(opId, id, 'ok');
    this.note('info', `${id}: epic open on ${branch}`);
  }

  /** The integration branch of an epic that is already IN_PROGRESS (a planned epic gets there by approval, not by openEpic). */
  private async ensureEpicBranch(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const base = this.store.derived(item).base_branch!;
    const branch = fm.branch ?? `feature/${slugify(fm.title)}`;
    await this.ports.git.fetch(this.repo);
    if (!(await this.ports.git.remoteBranchSha(this.repo, branch))) await this.ports.git.pushRef(this.repo, `origin/${base}`, branch);
    this.store.mutateItem(id, [{ set: { branch } }, { activity: { actor: 'app', text: `opened integration branch ${branch} from origin/${base}` } }], 'engine', { commit: `${id}: open epic` });
    this.note('info', `${id}: epic open on ${branch}`);
  }

  /** Epic completion: every child merged → open the epic PR into its base. */
  private async driveEpics(): Promise<void> {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.kind !== 'epic' || fm.status !== 'IN_PROGRESS' || fm.blocked || this.jobs.has(item.id)) continue;
      const d = this.store.derived(item);
      if (!d.children.length) continue;
      const children = d.children.map((c) => this.store.requireItem(c).file.frontmatter);
      if (!children.every((c) => c.status === 'MERGED' || c.status === 'FINISHED')) {
        // Iceboxed is "not now", not "not in this epic": it still waits on them, and says so once (#135).
        const iced = children.filter((c) => c.status === 'ICEBOX').map((c) => c.id);
        const note = iced.join(',');
        if (iced.length && children.every((c) => c.status === 'MERGED' || c.status === 'FINISHED' || c.status === 'ICEBOX') && fm.op_data?.epic_iceboxed_noted !== note) this.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), epic_iceboxed_noted: note } } }, { activity: { actor: 'app', text: `every other child has merged; still waiting on ${iced.join(', ')} (iceboxed). Discard ${iced.length === 1 ? 'it' : 'them'} to let the epic finish without ${iced.length === 1 ? 'it' : 'them'}, or bring ${iced.length === 1 ? 'it' : 'them'} back` } }], 'engine');
        continue;
      }
      if (!this.store.config.epics.auto_submit) { if (!fm.op_data?.epic_ready_noted) this.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), epic_ready_noted: true } } }, { activity: { actor: 'app', text: 'all children merged — submit the epic PR when ready (epics.auto_submit is off)' } }], 'engine'); continue; }
      this.runJob(item.id, () => this.submitEpic(item.id));
    }
  }

  async submitEpic(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic' || fm.status !== 'IN_PROGRESS') return;
    const base = this.store.derived(item).base_branch!;
    const children = this.store.derived(item).children.map((c) => this.store.requireItem(c).file.frontmatter);
    const opId = this.store.journal.begin('creating_pr', id, { branch: fm.branch, base });
    this.store.mutateItem(id, [{ set: { op: 'creating_pr', op_started_at: this.now() } }], 'engine');
    const existing = (await this.ports.gh.prList(this.github, { head: fm.branch!, state: 'open' }))[0];
    const pr = existing ? { number: existing.number, url: existing.url } : await this.ports.gh.createPr(this.github, {
      base, head: fm.branch!, title: `${fm.title} (${id})`,
      body: `Integration branch for epic **${id}**. Child pull requests:\n\n${children.map((c) => `- ${c.id}: ${c.title}${c.pr ? ` (#${c.pr})` : ''}`).join('\n')}\n\n🤖 Opened by planestro`,
    });
    this.store.mutateItem(id, [
      { transition: { to: 'IN_REVIEW', actor: 'engine' } },
      { set: { pr: pr.number, ci_result: 'pending' } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `opened epic PR #${pr.number} → ${base} (${pr.url})` } },
      ...(() => { const why = this.holdIntoReason(base, fm.skip_merge); return why ? this.holdOps(why, 'app') : []; })(),
    ], 'engine', { commit: `${id}: open PR #${pr.number}` });
    this.store.journal.end(opId, id, 'ok', { pr: pr.number });
    // As for an item's PR: the orchestrator hears of it before it can merge (LM-2's went to main unseen).
    this.wakeOrchestrator('pr_opened', id);
    void this.tick();
  }

  /** The epic page's "Sync with base": the general sync (syncWithBase), which merges origin/<base> into an integration branch. */
  async syncBase(id: string): Promise<void> {
    const r = await this.syncWithBase(id, { by: 'user' });
    if (/^(not now|not possible|refused)/.test(r)) throw new Error(r);
  }

  // ---- externally driven items (watched) ----
  private lastExternalPoll = 0;
  private async driveExternal(): Promise<void> {
    const externals = this.store.listItems().filter((i) => { const fm = i.file.frontmatter; return this.store.derived(i).flavor === 'external' && (fm.merge_policy ?? 'watch') === 'watch' && !fm.blocked && (fm.status === 'IN_PROGRESS' || fm.status === 'IN_REVIEW'); });
    if (!externals.length || Date.now() - this.lastExternalPoll < 60_000) return;
    this.lastExternalPoll = Date.now();
    for (const item of externals) {
      const fm = item.file.frontmatter;
      try {
        let pr = fm.pr ? await this.ports.gh.prView(this.github, fm.pr) : undefined;
        if (!pr && fm.branch) pr = (await this.ports.gh.prList(this.github, { head: fm.branch, state: 'all' }))[0];
        if (!pr) continue;
        if (fm.status === 'IN_PROGRESS') {
          this.store.mutateItem(item.id, [
            { transition: { to: 'IN_REVIEW', actor: 'engine' } },
            { set: { pr: pr.number, branch: fm.branch ?? pr.headRefName, ci_result: 'pending' } },
            { activity: { actor: 'app', text: `linked PR #${pr.number} (${pr.url})` } },
          ], 'engine', { commit: `${item.id}: link PR #${pr.number}` });
        }
        if (pr.state === 'MERGED' && this.store.requireItem(item.id).file.frontmatter.status === 'IN_REVIEW') {
          this.store.mutateItem(item.id, [
            { transition: { to: 'MERGED', actor: 'engine' } },
            { set: { merged_at: pr.mergedAt ? isoLocal(new Date(pr.mergedAt)) : this.now(), ci_result: 'green' } },
            { activity: { actor: 'app', text: `observed merge of PR #${pr.number} into ${pr.baseRefName}` } },
          ], 'engine', { commit: `${item.id}: merge (observed)` });
          this.announce('on_merge', `${item.id} merged`, `PR #${pr.number} merged into ${pr.baseRefName}: ${item.file.frontmatter.title}`, item.id);
          await this.cleanup(item.id);
        } else if (pr.state === 'CLOSED') {
          this.block(item.id, 'pr_closed_externally', `PR #${pr.number} was closed without merging`);
        }
      } catch (e) { this.note('warn', `${item.id}: external poll failed: ${(e as Error).message}`); }
    }
  }

  // ---- helpers ----
  private makeTools(id: string): TurnTools {
    const s = this.store;
    /** A plain item's plan, recorded; `epic` says it reads as an epic breakdown, which approval then refuses (#69, HH-198). */
    const handIn = (plan: string, epic?: EpicFlag): string => {
      const cur = s.requireItem(id).file.frontmatter;
      const ops: ItemOp[] = [{ section: 'Plan', body: plan }];
      // The planner went on without the permission it had asked for: that request is moot, and must not be mistaken for the plan's own wait.
      if (cur.awaiting === 'permission' || cur.awaiting_data?.kind === 'permission') ops.push({ unset: ['awaiting', 'awaiting_data'] });
      // A late submit cures a no_plan block (e.g. after an MCP transport failure ate the first attempt).
      if (cur.blocked && cur.blocked_reason === 'no_plan') ops.push({ unset: ['blocked', 'blocked_reason', 'triage'] });
      const delegated = cur.status === 'PLAN_IN_PROGRESS' && this.planDelegated(cur);
      if (cur.status === 'PLAN_IN_PROGRESS') ops.push({ transition: { to: 'PLAN_READY', actor: 'engine' } });
      // A new plan is a new decision: whoever had it last time, it starts with the orchestrator again if delegated,
      // and whether it reads as an epic is judged again from this plan alone.
      const { plan_handed_back: _spent, plan_retry_turns: _retried, looks_like_epic: _earlier, ...opData } = cur.op_data ?? {};
      if (cur.op_data?.plan_handed_back || cur.op_data?.plan_retry_turns || cur.op_data?.looks_like_epic || epic) ops.push({ set: { op_data: { ...opData, ...(epic ? { looks_like_epic: epic } : {}) } } });
      if (delegated) ops.push({ set: { awaiting: 'orchestrator' } });
      if (epic) ops.push({ activity: { actor: 'app', text: `this reads as an epic, not one item: ${epic.reason}. Approval is refused; convert it to an epic` } });
      const stated = epic ? null : holdShapeOf(plan);
      if (stated) ops.push({ activity: { actor: 'app', text: `its plan states a merge hold: "${stated.quote}". Approving it can hold its pull request` } });
      s.mutateItem(id, ops, 'engine', { commit: `${id}: submit plan` });
      this.note(epic ? 'warn' : 'info', `${id}: plan submitted — ${epic ? `it reads as an epic (${epic.reason}): convert it rather than approve it` : delegated ? 'the orchestrator decides (you asked it to)' : 'needs your approval'}`);
      this.wakeOrchestrator('plan_review', id);
      return epic?.source === 'breakdown'
        ? 'Breakdown recorded by planestro as this item\'s plan, flagged as an epic: the user decides whether to convert it. End your turn now.'
        : 'Plan recorded by planestro. End your turn now; you will be resumed once it is approved.';
    };
    return {
      submit_breakdown: async (plan, children) => {
        const cur = s.requireItem(id).file.frontmatter;
        // A plain item's planner that finds an epic says so with the breakdown itself: the plan is recorded and
        // flagged, so nobody approves it as one item, and the user converts it (#69, HH-198).
        if (cur.kind !== 'epic') {
          if (cur.parent) return `Rejected: this item is a child of epic ${cur.parent}, and epics do not nest. Plan it as one item with submit_plan, or report_blocked if it cannot be one.`;
          const list = (Array.isArray(children) ? children : []).filter((c): c is ProposedChild => typeof c?.title === 'string' && c.title.trim() !== '');
          if (list.length < 2) return 'Rejected: a breakdown needs at least two children, each with a title. If this is one piece of work, hand in your plan with submit_plan.';
          const proposed = list.map((c) => ({ title: c.title.trim(), ...(typeof c.description === 'string' ? { description: c.description.trim() } : {}), ...(typeof c.implementer === 'string' && c.implementer ? { implementer: c.implementer } : {}), ...(Array.isArray(c.depends_on) && c.depends_on.length ? { depends_on: c.depends_on } : {}) }));
          return handIn(plan, { reason: `its planner handed in a breakdown of ${list.length} child items instead of one plan`, source: 'breakdown', children: proposed });
        }
        const problem = validateBreakdown(children, s.config.models, s.config.categories);
        if (problem) { s.mutateItem(id, [{ activity: { actor: 'app', text: `breakdown rejected back to the planner: ${problem}` } }], 'engine'); return `Rejected: ${problem}. Fix that and call submit_breakdown again.`; }
        const ops: ItemOp[] = [{ section: 'Plan', body: plan }];
        if (cur.blocked && cur.blocked_reason === 'no_plan') ops.push({ unset: ['blocked', 'blocked_reason', 'triage'] });
        if (cur.status === 'PLAN_IN_PROGRESS') ops.push({ transition: { to: 'PLAN_READY', actor: 'engine' } });
        ops.push({ set: { awaiting_data: { children, requested_at: this.now() } } });
        s.mutateItem(id, ops, 'engine', { commit: `${id}: submit breakdown` });
        this.note('info', `${id}: breakdown of ${(children as unknown[]).length} children submitted — needs your approval`);
        return 'Breakdown recorded by planestro. End your turn now; the user will review the children.';
      },
      submit_plan: async (plan) => {
        const cur = s.requireItem(id).file.frontmatter;
        if (cur.kind === 'epic') return 'Rejected: this is an epic. Hand in its children with submit_breakdown.';
        // A retry of a hand-in that did land (the transport failed on the way back): no second commit or review wake.
        if (cur.status === 'PLAN_READY' && getSection(s.requireItem(id).file, 'Plan').trim() === demoteH1(plan).trim()) return 'Plan already recorded by planestro. End your turn now; you will be resumed once it is approved.';
        const shape = epicShapeOf(plan);
        return handIn(plan, shape ? { reason: shape, source: 'plan' } : undefined);
      },
      add_note: async (markdown, attach) => { const cur = getSection(s.requireItem(id).file, 'Notes'); s.mutateItem(id, [{ section: 'Notes', body: cur ? `${cur}\n\n${markdown}` : markdown }], 'engine', { commit: `${id}: worker note` }); const att = this.attachFromWorktree(id, attach); return `Note recorded.${att ? ` ${att}` : ''}`; },
      append_activity: async (text) => { s.mutateItem(id, [{ activity: { actor: 'worker', text } }], 'engine'); return 'Recorded.'; },
      report_progress: async (parts) => this.recordParts(id, parts) ?? 'Recorded.',
      report_done: async (summary, parts, hold, attach) => {
        const bad = parts === undefined ? undefined : this.recordParts(id, parts);
        const att = this.attachFromWorktree(id, attach);
        const cur = s.requireItem(id).file.frontmatter;
        const ops: ItemOp[] = [{ set: { op_data: { ...(cur.op_data ?? {}), done_summary: summary } } }, { activity: { actor: 'worker', text: `done: ${summary.slice(0, 300)}` } }];
        // The worker that knows its pull request must wait says so (#97). Recorded here, with the done: the pull
        // request is opened from the item as persisted, and no drive path sees the item before this turn ends.
        const asked = typeof hold === 'string' && cur.kind !== 'epic' && (cur.status === 'IN_PROGRESS' || cur.status === 'IN_REVIEW') && !cur.skip_merge ? hold.trim() : '';
        const held = asked !== '' && !cur.op_data?.hold_waived;
        if (held) ops.push(...this.holdOps(asked, 'worker'));
        // A hold the user released, or left out at approval, is not put back by a later turn.
        else if (asked) ops.push({ activity: { actor: 'app', text: `the worker asked for a hold (${asked.slice(0, 200)}); not held: you released this item's hold, or approved its plan without one` } });
        s.mutateItem(id, ops, 'engine', held ? { commit: `${id}: skip merge` } : {});
        if (held) this.note('info', `${id}: its worker asked for the pull request to be held: ${asked.slice(0, 200)}`);
        return `Recorded${held ? ': planestro keeps the pull request out of the merge queue until the user releases the hold' : ''}${bad ? `, but ${bad}` : '.'}${att ? ` ${att}` : ''} End your turn now.`;
      },
      report_blocked: async (reason, parts) => {
        if (parts !== undefined) this.recordParts(id, parts);
        const cur = s.requireItem(id).file.frontmatter;
        if (cur.op_data?.done_summary !== undefined) { const { done_summary: _withdrawn, ...rest } = cur.op_data; s.mutateItem(id, [{ set: { op_data: rest } }], 'engine'); }
        this.block(id, 'agent_blocked', reason, 'user'); return 'Recorded. End your turn now; planestro will resume you with the answer.';
      },
      hand_off: async (to, paths, note) => this.handOff(id, to, paths, note, 'worker'),
      get_item: async () => serializeItemFile(s.requireItem(id).file),
    };
  }

  /**
   * What a worker shows the user (#137, LM-38): images and videos from its worktree, its ignored cache included,
   * copied onto the item as managed attachments (the item page shows them). Only files inside the worktree, of a
   * picture or video type, within attachments.managed_max_bytes. Returns what it did and skipped, for the worker.
   */
  private attachFromWorktree(id: string, paths: string[] | undefined): string {
    if (!paths?.length) return '';
    const fm = this.store.requireItem(id).file.frontmatter;
    if (!fm.worktree) return 'Nothing attached: this item has no worktree.';
    const root = this.absWorktree(fm.worktree);
    const done: string[] = []; const skipped: string[] = [];
    for (const p of paths.slice(0, 12)) {
      const abs = join(root, p); const rel = relative(root, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) { skipped.push(`${p} (outside your worktree)`); continue; }
      if (!ATTACHABLE.test(p)) { skipped.push(`${p} (not an image or video)`); continue; }
      try {
        const data = readFileSync(abs);
        this.store.addManagedAttachment(id, rel.replace(/[\/\\]/g, '-'), data, 'engine');
        done.push(p);
      } catch (e) { skipped.push(`${p} (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 120)})`); }
    }
    if (paths.length > 12) skipped.push(`${paths.length - 12} more (at most 12 a call)`);
    return [done.length ? `Attached for the user: ${done.join(', ')}.` : '', skipped.length ? `Not attached: ${skipped.join('; ')}.` : ''].filter(Boolean).join(' ');
  }

  // ---- hand-off: one item's files, given to another before any branch merges ----
  /**
   * The receiving item must already be tied to the giver (it waits on it, or they share an epic):
   * a hand-off is a delivery along a dependency, not a message to anyone. planestro does the
   * copying (invariant 1: a worker writes only its worktree), the files become the receiver's
   * attachments — which every one of its turns lists — and its session, if it has one, is told.
   */
  async handOff(from: string, to: string, paths: string[], note: string, by: 'worker' | 'orchestrator' | 'user' = 'worker'): Promise<string> {
    const giver = this.store.requireItem(from);
    const receiver = this.store.getItem(to);
    if (!receiver) return `Rejected: no item ${to}.`;
    if (to === from) return 'Rejected: an item cannot hand files to itself.';
    const rfm = receiver.file.frontmatter; const gfm = giver.file.frontmatter;
    if (this.store.derived(receiver).lane !== 'board') return `Rejected: ${to} is ${rfm.status}; only an item on the board can receive files.`;
    const related = rfm.depends_on.includes(from) || (gfm.parent !== undefined && gfm.parent === rfm.parent) || rfm.parent === from;
    if (!related) return `Rejected: ${to} does not wait on ${from} (its depends_on does not name it) and they share no epic. Ask the user to add the dependency, or report_blocked with what you need.`;
    if (!gfm.worktree) return `Rejected: ${from} has no worktree to hand files from.`;
    const root = realpathSync(this.absWorktree(gfm.worktree));
    const max = this.store.config.attachments.managed_max_bytes;
    const copied: string[] = [];
    for (const p of paths) {
      if (isAbsolute(p)) return `Rejected: "${p}" — paths are relative to your worktree.`;
      let abs: string;
      try { abs = realpathSync(join(root, p)); } catch { return `Rejected: "${p}" does not exist in the worktree.`; }
      if (abs !== root && !abs.startsWith(root + '/')) return `Rejected: "${p}" is outside the worktree.`;
      if (!statSync(abs).isFile()) return `Rejected: "${p}" is not a file.`;
      const data = readFileSync(abs);
      if (data.length > max) return `Rejected: "${p}" is ${data.length} bytes; a hand-off file may be at most ${max} (attachments.managed_max_bytes). Hand off the deliverable itself, not previews or scratch.`;
      copied.push(this.store.addManagedAttachment(to, p.replace(/\//g, '__'), data, 'engine').path);
    }
    const absPaths = copied.map((rel) => join(this.store.dataDir, rel));
    const who = by === 'worker' ? `${from}'s worker` : by === 'orchestrator' ? `the orchestrator, from ${from}` : `the user, from ${from}`;
    const noteText = note.trim();
    const memo = `Hand-off from ${from} (${isoLocal().slice(0, 16).replace('T', ' ')}): ${copied.length} file${copied.length === 1 ? '' : 's'} attached to this item — ${absPaths.join(', ')}${noteText ? `\n\n${noteText}` : ''}`;
    const curNotes = getSection(this.store.requireItem(to).file, 'Notes');
    this.store.mutateItem(to, [{ section: 'Notes', body: curNotes ? `${curNotes}\n\n${memo}` : memo }, { activity: { actor: 'app', text: `received ${copied.length} file${copied.length === 1 ? '' : 's'} from ${who}: ${paths.join(', ')}` } }], 'engine', { commit: `${to}: hand-off from ${from}` });
    this.store.mutateItem(from, [{ activity: { actor: by === 'worker' ? 'worker' : by, text: `handed ${copied.length} file${copied.length === 1 ? '' : 's'} to ${to}: ${paths.join(', ')}` } }], 'engine');
    this.store.journal.append({ type: 'item.handoff', item: to, actor: 'engine', data: { from, files: copied, note: noteText.slice(0, 500) } });
    // Tell the receiver's session. Parked on something other than the user → it reads this at its next turn; idle → that turn starts now.
    const phase = this.phaseFor(rfm.status);
    let told = 'it has no session yet; the files and your note are in its attachments and notes for when it starts';
    if (phase) {
      const text = `${from} handed off ${copied.length} file${copied.length === 1 ? '' : 's'} to you, now attached to your item:\n${absPaths.map((p) => `- ${p}`).join('\n')}${noteText ? `\n\n${noteText}` : ''}`;
      const cur = this.store.requireItem(to).file.frontmatter;
      if (cur.taken_over) told = 'the user has taken it over; the files and your note are in its attachments and notes';
      else if (this.turns.has(to) || this.jobs.has(to) || (cur.awaiting && cur.awaiting !== 'user')) {
        const pending = [...((cur.op_data?.pending_messages as string[] | undefined) ?? []), text];
        this.store.mutateItem(to, [{ set: { op_data: { ...(cur.op_data ?? {}), pending_messages: pending } } }], 'engine');
        told = cur.awaiting && cur.awaiting !== 'user' ? `its session is parked (awaiting ${cur.awaiting}) and will read the hand-off when it resumes` : 'its session is busy and will read the hand-off at its next turn';
      } else {
        this.store.mutateItem(to, [{ unset: ['awaiting', 'awaiting_data'] }], 'engine');
        this.queueFollowUp(to, () => this.runTurnFor(to, phase, `${this.resumeNote(to, `a hand-off from ${from}`)}\n\n${text}`));
        told = 'its session has been resumed with the hand-off';
      }
    }
    return `Delivered to ${to}: ${copied.length} file${copied.length === 1 ? '' : 's'} attached; ${told}.`;
  }

  /** Mark a model out of usage on this machine until its reset (or the default window); returns the time, for messages. */
  recordUnavailable(def: { id: string; label: string }, limit: TurnResult['usageLimit'], manual = false): string {
    const now = new Date(Date.now());
    const until = unavailableUntil(limit?.resetsAt, now);
    this.store.updateLocal({ model_unavailable: markUnavailable(this.store.local.model_unavailable, def.id, { until, reason: limit?.message ?? 'usage limit', manual }, now) });
    this.store.journal.append({ type: 'model.unavailable', actor: manual ? 'user' : 'engine', data: { model: def.id, until: until.toISOString(), reason: limit?.message ?? '' } });
    this.note('warn', `${def.label} is out of usage until ${until.toISOString()}`);
    return until.toISOString();
  }

  private block(id: string, reason: string, detail: string, awaiting: 'user' | undefined = 'user'): void {
    try {
      const cur = this.store.requireItem(id).file.frontmatter;
      // The person who has the item is already looking at it: a stop is said, not raised (dogfood p28: a worker still
      // running under a take-over blocked HH-136, by then in review with its PR, as agent_blocked).
      if (cur.taken_over) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `not blocked (${reason}), since you have this item: ${detail.replace(/\s+/g, ' ').slice(0, 300)}` } }], 'engine'); return; }
      // A stop for a person goes to the orchestrator first (triage); it resolves it or asks one plain question.
      const triage = this.triageOps(cur, reason);
      // A card that was waiting for an answer is about a stop that no longer exists: this block replaces it (HH-162, dogfood p42).
      const { decision: staleCard, ...restData } = cur.awaiting_data ?? {};
      this.store.mutateItem(id, [
        { set: { blocked: true, blocked_reason: reason, ...(awaiting ? { awaiting } : {}) } },
        ...(staleCard ? [(Object.keys(restData).length ? { set: { awaiting_data: restData } } : { unset: ['awaiting_data'] }) as ItemOp, { activity: { actor: 'app', text: 'the decision card it had is withdrawn: this block replaces it' } } as ItemOp] : []),
        ...(cur.op ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
        { activity: { actor: 'app', text: `BLOCKED (${reason}): ${detail.replace(/\s+/g, ' ').slice(0, 500)}` } },
        ...triage.ops,
      ], 'engine', { commit: `${id}: blocked (${reason})` });
      this.note('warn', `${id} blocked: ${reason} — ${detail.slice(0, 200)}${triage.on ? ' (the orchestrator is triaging it)' : ''}`);
      if (triage.on) this.wakeWhenIdle(id, `blocked_${reason}`, { detail: detail.slice(0, 2000) });
      else if ((JUDGMENT_BLOCKS as readonly string[]).includes(reason)) this.wakeOrchestrator(`blocked_${reason}`, id, { detail: detail.slice(0, 2000) });
    } catch (e) { this.note('error', `could not record block on ${id}: ${(e as Error).message}`); }
  }

  // ---- needs-you triage: the orchestrator looks at a stop before the user does ----
  /** On in config, an orchestrator to ask, and automation running (a paused orchestrator is never woken). */
  private triageAvailable(): boolean { return this.store.config.orchestrator.triage && this.orchestrator.enabled && !this._paused && !this.stopping; }

  /** A stop usually happens inside the turn that is still ending: wake once it has, so every tool finds the item idle. */
  private wakeWhenIdle(id: string, type: string, data?: Record<string, unknown>): void {
    if (this.jobs.has(id) || this.turns.has(id)) this.pendingWakes.set(id, { type, data });
    else this.wakeOrchestrator(type, id, data);
  }

  /** The ops that put a stop into triage, or none (with a note why) when it goes straight to the user. */
  private triageOps(fm: { status: Status; op_data?: Record<string, unknown> }, reason: string): { on: boolean; ops: ItemOp[] } {
    if (!this.triageAvailable()) return { on: false, ops: [] };
    const rounds = fm.op_data?.triage_status === fm.status ? Number(fm.op_data?.triage_rounds ?? 0) : 0;
    if (rounds >= MAX_TRIAGE_ROUNDS) return { on: false, ops: [{ activity: { actor: 'app', text: `not triaged: the orchestrator has already looked at ${rounds} stops of this item in ${fm.status}; it needs you` } }] };
    return { on: true, ops: [
      { set: { triage: { reason, started_at: this.now() }, op_data: { ...(fm.op_data ?? {}), triage_status: fm.status, triage_rounds: rounds + 1 } } },
      { activity: { actor: 'app', text: `the orchestrator is triaging this (${reason}) before it comes to you` } },
    ] };
  }

  /**
   * Nothing waits in triage on memory (invariant 2/3): a restart drops the wake queue, the switch can
   * be turned off, automation can be paused, and a wake can hang. Each of those ends in today's
   * behaviour — the item needs you — or, for a dropped wake, a new one.
   */
  private driveTriage(): void {
    const timeoutMs = this.store.config.orchestrator.triage_timeout_min * 60_000;
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (!fm.triage) continue;
      // A step is running: the stop's own turn still ending (its wake follows), or a repair, which ends by unblocking or by blocking again.
      if (this.jobs.has(item.id) || this.turns.has(item.id) || this.pendingWakes.has(item.id)) continue;
      if (!this.triageAvailable()) this.endTriage(item.id, this._paused ? 'automation is paused' : 'the orchestrator is not available');
      else if (Date.now() - Date.parse(fm.triage.started_at) > timeoutMs) this.endTriage(item.id, `triage took longer than ${this.store.config.orchestrator.triage_timeout_min} min (orchestrator.triage_timeout_min)`);
      else if (!this.orchestrator.reviewing(item.id)) this.wakeOrchestrator(fm.triage.reason === 'decision' ? 'decision_answered' : fm.triage.reason === 'question' ? 'worker_question' : `blocked_${fm.triage.reason}`, item.id, { note: 'woken again: the earlier wake was lost (a restart)' });
    }
  }

  /** Triage is over without a resolution: the item is the user's, exactly as it stopped. */
  private endTriage(id: string, why: string): void {
    const fm = this.store.getItem(id)?.file.frontmatter;
    if (!fm?.triage || this.jobs.has(id)) return;
    this.store.mutateItem(id, [{ unset: ['triage'] }, { activity: { actor: 'app', text: `needs you: ${why}` } }], 'engine', { commit: `${id}: triage ended` });
    this.note('info', `${id}: needs you — ${why}`);
  }

  private busyWith(id: string): string | undefined { return this.jobs.has(id) || this.turns.has(id) ? `${id} has a step running; let it finish first` : undefined; }

  private async orchestratorUnblocks(id: string, message?: string, syncFirst = false, fresh = false): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (!fm.blocked && fm.awaiting !== 'user') return `nothing to unblock: ${id} is not blocked${fm.awaiting ? ` (it is awaiting ${fm.awaiting}; answer that instead)` : ''}`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const noFresh = fresh ? this.freshRefusal(fm, message) : undefined;
    if (noFresh) return `not possible: ${noFresh}`;
    // Sync first (p29): the branch takes in what merged since it was cut before the session resumes; a refusal leaves it blocked.
    if (syncFirst) return this.syncWithBase(id, { by: 'orchestrator', unblock: { message: message?.trim() || undefined, fresh } });
    await this.unblock(id, message?.trim() || undefined, 'orchestrator', { fresh });
    return message?.trim() && this.phaseFor(fm.status) ? (fresh ? 'unblocked; a fresh session starts with a brief and your message as its task' : 'unblocked; the session resumes with your message') : 'unblocked; the pipeline retries from where it stopped';
  }

  /**
   * Commit named files in an item's worktree, with no model turn (#64): HH-247 resumed a long
   * conversation for $46 to run two `git add … && git commit` that had already been approved. Which
   * files belong to the change is a judgment, so whoever calls this names them; that they are there to
   * commit is checked here (each must be one of the worktree's own dirty files). It never pushes and
   * never unblocks: finish_from_worktree, or retry_op for an item in review, carries on from the commit.
   */
  async commitPaths(id: string, paths: string[], message: string, by: 'user' | 'orchestrator' = 'orchestrator'): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (this._paused || this.draining || this.stopping) return `not now: automation is ${this._paused ? 'paused' : 'stopping'}; nothing was committed`;
    if (this.store.derived(item).flavor !== 'worker' || (fm.status !== 'IN_PROGRESS' && fm.status !== 'IN_REVIEW')) return `not possible: ${id} is ${fm.status}; only a worker item in progress or in review has work to commit`;
    if (fm.taken_over) return `not now: the user has taken ${id} over`;
    if (!fm.worktree || !fm.branch) return `not possible: ${id} has no worktree or branch`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    if (fm.op) return `not now: ${id} is ${fm.op.replace(/_/g, ' ')}; let it finish first`;
    if (fm.awaiting && fm.awaiting !== 'user') return `not now: ${id} is awaiting ${fm.awaiting.replace(/_/g, ' ')}; answer that first`;
    const cwd = this.absWorktree(fm.worktree);
    if (!(await this.ports.git.worktreeList(this.repo)).some((w) => w.path === cwd && !w.prunable)) return `not possible: the worktree ${fm.worktree} is missing; use recreate_worktree`;
    const inFlight = await this.ports.git.inProgressOp(cwd);
    if (inFlight) return `refused: a ${inFlight} is unfinished in ${fm.worktree}; a commit now would be part of it. It needs a session (unblock_item) or a person`;
    const subject = message.trim().split('\n')[0];
    if (!subject) return 'refused: the commit needs a message';
    const named = [...new Set(paths.map((p) => p.trim().replace(/^\.\//, '')).filter(Boolean))];
    if (!named.length) return 'refused: name the files to commit';
    const bad = named.find((p) => isAbsolute(p) || p.startsWith('-') || p.split('/').some((part) => part === '..' || part === '.git'));
    if (bad) return `refused: "${bad}" is not a path inside the worktree (relative paths only, no "..", nothing under .git)`;
    const detail = await this.ports.git.dirtyDetail(cwd);
    const dirty = new Set([...detail.tracked, ...detail.untracked]);
    const absent = named.filter((p) => !dirty.has(p));
    if (absent.length) return `refused: ${absent.slice(0, 5).join(', ')} ${absent.length === 1 ? 'is' : 'are'} not among the worktree's uncommitted files (${[...dirty].slice(0, 8).join(', ') || 'it is clean'}); name files exactly as listed, one by one`;
    const byproduct = named.find((p) => detail.untracked.includes(p) && this.store.config.worktrees.byproducts.some((g) => matchesPathPattern(p, g)));
    if (byproduct) return `refused: ${byproduct} is a byproduct the project's tools regenerate (worktrees.byproducts), never part of a change`;
    const opId = this.store.journal.begin('commit_paths', id, { paths: named, by });
    let head: string;
    try { head = await this.ports.git.commitPaths(cwd, named, `${subject}${message.trim().includes('\n') ? `\n${message.trim().split('\n').slice(1).join('\n')}` : ''}\n\nCommitted by planestro for ${by === 'orchestrator' ? 'the orchestrator' : 'the user'}, without a session turn.`); }
    catch (e) { this.store.journal.end(opId, id, 'failed', { error: (e as Error).message.slice(0, 300) }); return `failed: git would not commit them: ${(e as Error).message.slice(0, 300)}`; }
    this.store.journal.end(opId, id, 'ok', { head, paths: named });
    const left = (await this.worktreeDirt(cwd)).dirty;
    this.store.mutateItem(id, [{ activity: { actor: by, text: `committed ${named.length} file${named.length === 1 ? '' : 's'} without a session turn (${head.slice(0, 7)} "${subject.slice(0, 72)}"): ${named.slice(0, 8).join(', ')}${named.length > 8 ? ', …' : ''}${left.length ? `; still uncommitted: ${left.slice(0, 5).join(', ')}` : '; the tree is clean'}` } }], by, { commit: `${id}: commit paths${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    const next = fm.status === 'IN_PROGRESS' ? 'finish_from_worktree opens the pull request from here' : 'retry_op sends it back through the merge pipeline, which pushes the commit';
    return `committed ${head.slice(0, 7)}: ${named.length} file${named.length === 1 ? '' : 's'}. ${left.length ? `Still uncommitted: ${left.slice(0, 8).join(', ')} (commit what belongs the same way; the rest needs a session or a person).` : `The tree is clean: ${next}.`} Nothing was pushed and ${id} is as ${fm.blocked ? 'blocked' : 'it was'}.`;
  }

  private async orchestratorAnswers(id: string, answers: Record<string, string>): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.awaiting !== 'question') return `nothing to answer: ${id} is not waiting on a question`;
    if (!Object.keys(answers ?? {}).length) return 'give at least one answer';
    await this.respond(id, { kind: 'question', answers }, 'orchestrator');
    return 'answered; the session resumes with your answers';
  }

  private orchestratorSetsFields(id: string, fields: Record<string, unknown>): string {
    const item = this.store.requireItem(id);
    const refused = Object.keys(fields ?? {}).filter((k) => !(ORCHESTRATOR_FIELDS as readonly string[]).includes(k));
    if (refused.length) return `not permitted: ${refused.join(', ')}. You may set only ${ORCHESTRATOR_FIELDS.join(', ')}; nothing was changed.`;
    if (!Object.keys(fields ?? {}).length) return 'no fields given';
    const set: Record<string, unknown> = {}; const unset: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) { if (k === 'depends_on') set.depends_on = []; else unset.push(k); continue; }
      if (k === 'parent') {
        const p = this.store.getItem(String(v));
        if (!p || p.file.frontmatter.kind !== 'epic') return `not changed: ${String(v)} is not an epic`;
        if (item.file.frontmatter.kind === 'epic') return `not changed: ${id} is an epic; epics do not nest`;
        set.parent = p.id;
      } else if (k === 'depends_on') {
        if (!Array.isArray(v) || v.some((d) => typeof d !== 'string')) return 'not changed: depends_on is a list of item ids';
        const missing = (v as string[]).filter((d) => d === id || !this.store.getItem(d));
        if (missing.length) return `not changed: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not another item`;
        set.depends_on = v;
      } else if (k === 'implementer') {
        if (!this.store.config.models.some((m) => m.id === v)) return `not changed: ${String(v)} is not a model id (${this.store.config.models.map((m) => m.id).join(', ')})`;
        set.implementer = v;
      } else if (k === 'base_branch_override') {
        if (typeof v !== 'string' || !v.trim()) return 'not changed: base_branch_override is a branch name, or null';
        set.base_branch_override = v.trim();
      } else {
        if (typeof v !== 'boolean') return `not changed: ${k} is true, false or null`;
        set[k] = v;
      }
    }
    const said = [...Object.entries(set).map(([k, v]) => `${k} = ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`), ...unset.map((k) => `${k} cleared`)].join(', ');
    this.store.mutateItem(id, [...(Object.keys(set).length ? [{ set } as ItemOp] : []), ...(unset.length ? [{ unset } as ItemOp] : []), { activity: { actor: 'orchestrator', text: `set ${said}` } }], 'orchestrator', { commit: `${id}: fields (orchestrator)` });
    const d = this.store.derived(this.store.requireItem(id));
    this.poke();
    return `set ${said}. Base branch is now ${d.base_branch ?? `unresolved (${d.base_branch_error})`}${item.file.frontmatter.worktree && ('parent' in fields || 'base_branch_override' in fields) ? '; the existing worktree was not moved (recreate_worktree does that)' : ''}.`;
  }

  /** The base a worktree was cut from, as its creation was journalled (the item's base may have changed since). */
  private journalledBase(id: string): string | undefined {
    const begin = this.store.journal.read({ item: id, type: 'op.begin' }).reverse().find((e) => e.data?.op === 'creating_worktree' && typeof e.data?.base === 'string');
    return begin?.data?.base as string | undefined;
  }

  /**
   * Replace a worktree that holds no work with a fresh one from the item's current base (invariant 7:
   * positive evidence first — a clean tree, and every commit on the branch, local and pushed, already
   * on the old or the new base). The removal and setup run as the item's job; it ends by unblocking.
   */
  async recreateWorktree(id: string, message?: string): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    if (d.flavor !== 'worker') return `not possible: ${id} is not a worker item with a session worktree`;
    if (fm.taken_over) return `not possible: the user has taken ${id} over`;
    if (!['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'].includes(fm.status)) return `not possible: ${id} is ${fm.status}; only an item still planning or implementing gets a new worktree`;
    if (fm.pr) return `not possible: ${id} already has pull request #${fm.pr}`;
    if (!fm.worktree || !fm.branch) return `not possible: ${id} has no worktree recorded`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const base = d.base_branch;
    if (!base) return `not possible: ${d.base_branch_error ?? 'the base branch cannot be resolved'}`;
    const dir = this.absWorktree(fm.worktree);
    const branch = fm.branch;
    const bases = [...new Set([base, this.journalledBase(id)].filter((b): b is string => Boolean(b)))];
    let entry: { path: string } | undefined;
    try {
      await this.ports.git.fetch(this.repo);
      entry = (await this.ports.git.worktreeList(this.repo)).find((w) => w.path === dir && !w.prunable);
      if (entry) {
        const { clean, dirty } = await this.worktreeDirt(dir);
        if (!clean) return `refused: ${fm.worktree} has uncommitted changes (${dirty.slice(0, 5).join(', ')}); nothing was touched`;
        let empty = false;
        for (const b of bases) if ((await this.ports.git.aheadBehind(dir, `origin/${b}`, 'HEAD')).ahead === 0) { empty = true; break; }
        if (!empty) return `refused: ${branch} has commits that are not on origin/${bases.join(' or origin/')}; recreating would lose work, so nothing was touched`;
      } else if (await this.ports.git.localBranchExists(this.repo, branch)) {
        const tip = await this.ports.git.revParse(this.repo, `refs/heads/${branch}`);
        if (!(await this.anyAncestor(tip, bases))) return `refused: the local branch ${branch} has commits that are not on origin/${bases.join(' or origin/')}; nothing was touched`;
      }
      const remote = await this.ports.git.remoteBranchSha(this.repo, branch);
      if (remote && !(await this.anyAncestor(remote, bases))) return `refused: the pushed branch ${branch} has commits that are not on origin/${bases.join(' or origin/')}; nothing was touched`;
    } catch (e) { return `refused: could not verify the worktree holds no work (${(e as Error).message.slice(0, 200)}); nothing was touched`; }
    const note = message?.trim() || `planestro recreated your worktree (${fm.worktree}, branch ${branch}) from origin/${base}. It holds none of your earlier edits (there were none to keep). Continue your ${fm.status === 'IN_PROGRESS' ? 'implementation of the approved plan' : 'planning'} from there.`;
    const hadWorktree = Boolean(entry);
    this.runJob(id, async () => {
      const opId = this.store.journal.begin('creating_worktree', id, { branch, dir, base, recreate: true });
      this.store.mutateItem(id, [{ set: { op: 'creating_worktree', op_started_at: this.now() } }, { activity: { actor: 'orchestrator', text: `recreating ${fm.worktree} on ${branch} from origin/${base}${hadWorktree ? '' : ' (the old one was gone)'}` } }], 'engine', { commit: `${id}: recreate worktree` });
      if (hadWorktree) { const kept = await this.setAsideBeforeRemove(id, dir); if (kept) this.store.mutateItem(id, [{ activity: { actor: 'app', text: kept } }], 'engine'); }
      if (hadWorktree) await this.ports.git.worktreeRemove(this.repo, dir, false);
      await this.ports.git.worktreePrune(this.repo);
      await this.ports.git.deleteLocalBranch(this.repo, branch);
      if (await this.ports.git.remoteBranchSha(this.repo, branch)) await this.ports.git.deleteRemoteBranch(this.repo, branch);
      await this.ports.git.worktreeAdd(this.repo, dir, branch, `origin/${base}`);
      if (!(await this.runSetupHooks(id, dir, opId))) return;
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
      this.store.journal.end(opId, id, 'ok');
      const cur = this.store.requireItem(id).file.frontmatter;
      if (cur.blocked || cur.awaiting === 'user') await this.unblock(id, cur.status === 'PLAN_READY' ? undefined : note, 'orchestrator');
    });
    return `recreating ${fm.worktree} from origin/${base}: setup hooks run, then the item is unblocked${fm.status === 'PLAN_READY' ? ' (its plan still waits for approval)' : ' and its session resumed with ' + (message?.trim() ? 'your message' : 'a note that the worktree is new')}.`;
  }

  private async anyAncestor(sha: string, bases: string[]): Promise<boolean> {
    for (const b of bases) if (await this.ports.git.isAncestor(this.repo, sha, `origin/${b}`)) return true;
    return false;
  }

  /** `after_worktree_create`, one hook at a time within the local-job limit; a failure blocks the item. */
  private async runSetupHooks(id: string, dir: string, opId: string): Promise<boolean> {
    this.store.mutateItem(id, [{ set: { op: 'importing', op_started_at: this.now() } }], 'engine');
    for (const hook of this.store.config.hooks.after_worktree_create) {
      const r = await this.withLocalJobSlot(() => this.ports.proc.run(hook, { cwd: dir, timeoutMs: 20 * 60_000 }));
      if (r.code !== 0) { this.store.journal.end(opId, id, 'failed', { hook, code: r.code }); this.block(id, 'hook_failed', `${hook} exited ${r.code}: ${r.stderr.slice(-400)}`); return false; }
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `hook ok: ${hook}` } }], 'engine');
    }
    return true;
  }

  /** Re-run what a transient failure stopped, by the same doors the pipeline itself uses. */
  /**
   * Re-run the failed jobs of the head's red CI run (#139, HH-307, HH-284): a suspected flake, with nothing to fix in
   * the branch. Only that run for an unchanged head; the orchestrator gets one per head (a real failure is not retried
   * in a loop), the user as many as they like. The block or triage clears, and the CI wait counts only the new attempt
   * (`op_data.ci_rerun`); a red attempt counts as a failure again. Returns what happened, or why not, in words.
   */
  /** What rerunCi would refuse that the store can tell without GitHub: checked when a card offering it is filed (#162). */
  private rerunRefusal(id: string): string | null {
    const fm = this.store.getItem(id)?.file.frontmatter;
    if (!fm) return `there is no item ${id}`;
    if (fm.status !== 'IN_REVIEW' || !fm.pr) return `${id} has no pull request in review`;
    if (!(fm.op_data?.last_red as { runId?: number } | undefined)?.runId) return `${id} has no red CI run on record`;
    return null;
  }

  async rerunCi(id: string, by: 'user' | 'orchestrator' = 'user'): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (by === 'orchestrator' && fm.taken_over) return `not now: the user has taken ${id} over`;
    if (fm.status !== 'IN_REVIEW' || !fm.pr || !fm.branch) return `not possible: ${id} has no pull request in review`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy} (a CI wait that is still running is not red)`;
    const red = fm.op_data?.last_red as { runId?: number; sha?: string } | undefined;
    if (!red?.runId || !red.sha) return `not possible: ${id} has no red CI run on record`;
    const view = await this.ports.gh.prView(this.github, fm.pr);
    if (view.headRefOid !== red.sha) return `not possible: the head moved to ${view.headRefOid.slice(0, 7)} after run ${red.runId} (${red.sha.slice(0, 7)}); the new head's own run is what counts`;
    const ci = await this.ports.gh.ciForSha(this.github, fm.branch, red.sha, this.ciWorkflow);
    if (ci.runId !== red.runId || ci.state !== 'failure') return `not possible: run ${red.runId} is not the head's red run any more (it is ${ci.state}${ci.runId && ci.runId !== red.runId ? `, run ${ci.runId}` : ''})`;
    const prev = fm.op_data?.ci_rerun as { sha?: string } | undefined;
    if (by === 'orchestrator' && prev?.sha === red.sha) return `not possible: you already re-ran CI once for ${red.sha.slice(0, 7)}; a second red on the same head is the user's to judge (or the session's to fix). If something has changed since (a runner's full disk freed, a fix landed), leave ask_user_decision with an option carrying action { tool: "rerun_ci", args: { id: "${id}" } }: their tap re-runs it`;
    await this.ports.gh.rerunFailed(this.github, red.runId);
    const attempt = (ci.attempt ?? 1) + 1;
    const { last_red: _red, ...od } = fm.op_data ?? {};
    this.store.mutateItem(id, [
      { unset: ['blocked', 'blocked_reason', 'triage', ...(fm.awaiting === 'user' ? ['awaiting', 'awaiting_data'] : [])] },
      { set: { ci_result: 'pending', ci_head_sha: red.sha, op: 'awaiting_ci', op_started_at: this.now(), op_data: { ...od, ci_rerun: { sha: red.sha, runId: red.runId, attempt, by } } } },
      { activity: { actor: by, text: `re-ran the failed jobs of CI run ${red.runId} for ${red.sha.slice(0, 7)} (attempt ${attempt}); waiting for that attempt` } },
    ], by, { commit: `${id}: re-run CI` });
    this.poke();
    return `re-running the failed jobs of run ${red.runId} (attempt ${attempt}); its verdict is the one that counts`;
  }

  async retryOp(id: string, by: 'user' | 'orchestrator' = 'orchestrator'): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) return `not now: the user has taken ${id} over`;
    if (!fm.blocked) return `nothing to retry: ${id} is not blocked`;
    if (fm.awaiting && fm.awaiting !== 'user') return `not now: ${id} is awaiting ${fm.awaiting}; answer that instead`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const reason = fm.blocked_reason ?? 'blocked';
    const opData = LiveEngine.withoutDirtyCount(fm.op_data);
    const clear = (text: string, extra: ItemOp[] = []): void => { this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, ...(opData !== fm.op_data ? [{ set: { op_data: opData } } as ItemOp] : []), ...extra, { activity: { actor: by, text } }], by, { commit: `${id}: retry${by === 'orchestrator' ? ' (orchestrator)' : ''}` }); };
    const resume = by === 'orchestrator'
      ? `The last step stopped on a transient failure (${reason}), which has been retried. Nothing of yours was lost: check your worktree and continue where you left off.`
      : `The user unblocked this item (it had stopped: ${reason}). Nothing of yours was lost: check your worktree and continue where you left off.`;
    // A conflict once handed to a session that never finished it is the pipeline's again: it re-syncs, and a conflict comes back to a session.
    if (fm.status === 'IN_REVIEW') { clear(`retrying the merge pipeline after ${reason}`, [{ set: { ci_result: 'pending', op_data: { ...(opData ?? {}), needs_session_rebase: false } } }]); this.poke(); return /^ci_red/.test(reason) ? 'retrying: it re-enters the merge pipeline, which reads the same CI run again (it does not run CI again: use rerun_ci to re-run its failed jobs)' : 'retrying: it re-enters the merge pipeline'; }
    if (fm.status === 'MERGED') { clear(`retrying cleanup after ${reason}`); this.runJob(id, () => this.cleanup(id)); return 'retrying the cleanup (it still needs positive evidence before deleting anything)'; }
    if (this.store.derived(item).flavor !== 'worker' || !fm.worktree) return `not possible: nothing in ${fm.status} to retry for ${id}; use unblock_item`;
    const dir = this.absWorktree(fm.worktree);
    const exists = (await this.ports.git.worktreeList(this.repo).catch(() => [])).some((w) => w.path === dir && !w.prunable);
    if (fm.status === 'PLAN_IN_PROGRESS' && !exists && !fm.session_id) {
      clear(`retrying setup after ${reason} (the worktree was never made)`, [{ transition: { to: 'QUEUED', actor: 'engine' } }]);
      this.poke();
      return 'retrying: back in the queue, so setup runs again from the start';
    }
    if (!exists) return `not possible: the worktree ${fm.worktree} is missing; use recreate_worktree`;
    if (fm.status === 'IN_PROGRESS') {
      const { clean } = await this.worktreeDirt(dir);
      const base = this.store.derived(item).base_branch;
      const ahead = clean && base ? (await this.ports.git.aheadBehind(dir, `origin/${base}`, 'HEAD')).ahead : 0;
      if (ahead > 0) {
        clear(`retrying after ${reason}: the work is committed, opening the pull request again`);
        this.runJob(id, () => this.afterWorkTurn(id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done: String(fm.op_data?.done_summary ?? '') || undefined }));
        return 'retrying: the committed work goes to a pull request';
      }
    }
    if (!this.phaseFor(fm.status)) return `not possible: nothing in ${fm.status} to retry for ${id}`;
    await this.unblock(id, resume, by);
    return 'retrying: the session is resumed';
  }

  /** A worker's structured progress (f4): validated, stored on the item, summarised in Activity. Returns the problem, or undefined. */
  private recordParts(id: string, parts: unknown): string | undefined {
    const v = validateParts(parts);
    if (!v.ok) return `the parts were not recorded: ${v.error}.`;
    this.store.mutateItem(id, [{ set: { parts: v.value } }, { activity: { actor: 'worker', text: `progress: ${partsSummary(v.value)}` } }], 'engine');
    return undefined;
  }

  /** An item's caps: its own budget_usd / budget_turns / budget_tokens when set, else the project's. Each names the setting for messages. */
  private budgetOf(fm: { budget_usd?: number; budget_turns?: number; budget_tokens?: number }): { usd: number; usdKey: string; turns: number; turnsKey: string; tokens: number; tokensKey: string } {
    const c = this.store.config;
    return {
      usd: fm.budget_usd ?? c.budget_usd_per_item, usdKey: fm.budget_usd !== undefined ? 'budget_usd on this item' : 'budget_usd_per_item',
      turns: fm.budget_turns ?? c.budget_turns_per_item, turnsKey: fm.budget_turns !== undefined ? 'budget_turns on this item' : 'budget_turns_per_item',
      tokens: fm.budget_tokens ?? c.budget_tokens_per_item, tokensKey: fm.budget_tokens !== undefined ? 'budget_tokens on this item' : 'budget_tokens_per_item',
    };
  }

  /**
   * Say once, when a turn carries an item past BUDGET_WARN_AT of a cap, that the stop is near (dogfood
   * p16, p24: HH-120 stopped one step from done, HH-118 crossed its token cap with a pack half drawn).
   * A raised cap starts the warning over.
   */
  private warnOnBudget(id: string, before: { cost_usd?: number; tokens?: number; agent_turns?: number }, after: { cost_usd?: number; tokens?: number; agent_turns?: number; budget_usd?: number; budget_turns?: number; budget_tokens?: number; parts?: Part[]; op_data?: Record<string, unknown> }): void {
    const b = this.budgetOf(after);
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
        this.store.mutateItem(id, [{ set: { op_data: { ...(after.op_data ?? {}), parts_forecast_warned: key } } }], 'engine');
      }
    }
    if (!lines.length) return;
    this.store.mutateItem(id, [{ activity: { actor: 'app', text: `budget warning: ${lines.join('; ')}. Raise it on the item page if the work is worth it, before it stops.` } }], 'engine');
    this.note('warn', `${id}: ${lines.join('; ')}`);
  }

  /** The orchestrator takes a card back: the item keeps its stop, and stops asking the user this question. */
  private withdrawDecision(id: string, reason: string): string {
    const item = this.store.getItem(id);
    if (!item) return `no item ${id}`;
    const { decision, ...rest } = item.file.frontmatter.awaiting_data ?? {};
    if (!decision) return `nothing to withdraw: ${id} has no decision card`;
    this.store.mutateItem(id, [Object.keys(rest).length ? { set: { awaiting_data: rest } } : { unset: ['awaiting_data'] }, { activity: { actor: 'orchestrator', text: `withdrew the decision card (${String((decision as { question?: string }).question ?? '').slice(0, 80)}): ${reason}` } }], 'orchestrator', { commit: `${id}: decision withdrawn` });
    this.store.journal.append({ type: 'orchestrator.decision_withdrawn', item: id, actor: 'orchestrator', data: { question: (decision as { question?: string }).question, reason } });
    return 'withdrawn: the card is gone; the item is otherwise as it was (still stopped, if it was). Resolve it or file a new card in this wake, or it goes to the user as a plain block.';
  }

  /**
   * "Finish from here" (dogfood f2): the work is committed on the worker branch and the item could
   * not reach a pull request on its own (over budget, a size gate, a runner that could not commit,
   * a block of any kind). One action runs planestro's own path from a clean, ahead worktree: any
   * stop is cleared, and the deterministic done check opens the pull request. Refuses anything
   * that is not that: a dirty tree, nothing ahead of the base, a running step, the wrong status.
   */
  async finishFromWorktree(id: string, by: 'user' | 'orchestrator' = 'user'): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.status !== 'IN_PROGRESS' || this.store.derived(item).flavor !== 'worker' || !fm.worktree) return `not possible: ${id} is ${fm.status}${fm.worktree ? '' : ' with no worktree'}; only a worker item in progress can be finished from its worktree`;
    if (fm.taken_over) return `not now: ${id} is taken over; hand it back and planestro runs this same check`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const cwd = this.absWorktree(fm.worktree);
    const base = this.store.derived(item).base_branch;
    if (!base) return `not possible: ${id} has no base branch`;
    let { clean, dirty } = await this.worktreeDirt(cwd);
    // A model whose commits are planestro's leaves its work in the tree: committing it is this step's first half (#55).
    if (!clean && this.commitsFor(fm)) {
      const head = await this.commitForWorker(id, String(fm.op_data?.done_summary ?? '') || `work committed by planestro to finish ${id} from its worktree`);
      if (head) this.store.mutateItem(id, [{ activity: { actor: by, text: `finish from here: committed the session's work first (${head.slice(0, 7)}, ${dirty.length} file${dirty.length === 1 ? '' : 's'}; engine_commits)` } }], by);
      ({ clean, dirty } = await this.worktreeDirt(cwd));
    }
    if (!clean) return `not possible: the worktree has uncommitted changes (${dirty.slice(0, 5).join(', ')}); commit or discard them first`;
    await this.ports.git.fetch(this.repo);
    const { ahead } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    if (ahead === 0) return `not possible: the branch has nothing ahead of origin/${base}; if the work landed some other way, close the item as done`;
    const stopped = fm.blocked ? ` (it was blocked: ${fm.blocked_reason})` : fm.awaiting ? ` (it was awaiting ${fm.awaiting})` : '';
    this.store.mutateItem(id, [
      { unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] },
      { activity: { actor: by, text: `finish from here: ${ahead} commit${ahead === 1 ? '' : 's'} ahead of origin/${base}, tree clean; opening the pull request${stopped}` } },
    ], by, { commit: `${id}: finish from worktree${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    this.runJob(id, () => this.afterWorkTurn(id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done: String(fm.op_data?.done_summary ?? '') || undefined }));
    return `finishing: ${ahead} commit${ahead === 1 ? '' : 's'} go to a pull request`;
  }

  /**
   * What an item has left and what its next turn costs before any work, for the orchestrator's packet
   * (#64): the numbers it needs to pick the step that fits without asking anyone. Undefined for an item
   * with no dollar budget to speak of (no Claude session phase).
   */
  private budgetLine(id: string): string | undefined {
    const fm = this.store.getItem(id)?.file.frontmatter;
    const phase = fm ? this.phaseFor(fm.status) : null;
    if (!fm || !phase) return undefined;
    const def = this.store.config.models.find((m) => m.id === (phase === 'plan' ? fm.planner : fm.implementer));
    if (!def || (def.runner ?? 'claude') !== 'claude') return undefined;
    const b = this.budgetOf(fm);
    const left = b.usd - (fm.cost_usd ?? 0);
    const e = fm.session_id ? this.resumeEstimateFor(fm, def.claude_model) : undefined;
    const head = `Budget: $${(fm.cost_usd ?? 0).toFixed(2)} spent of $${b.usd} (${b.usdKey}), $${left.toFixed(2)} left.`;
    if (!fm.session_id) return `${head} It has no conversation yet, so nothing to reload.`;
    if (!e) return `${head} What resuming its conversation costs is not known yet (no turn has been quoted); planestro asks the CLI before the first request and declines a resume the item cannot pay for.`;
    const fits = left >= e.usd + MIN_TURN_USD;
    const freshFits = left >= FRESH_FLOOR_USD && phase !== 'plan';
    return [
      `${head} Resuming its conversation reloads ${Math.round(e.tokens / 1000)}k tokens first: about $${e.usd.toFixed(2)} before any work${e.isWarm ? ` (the cache is still warm; $${e.cold.toFixed(2)} once it expires)` : ''}.`,
      fits ? 'A resume fits what is left.' : `A resume does NOT fit what is left: planestro will not start one.`,
      phase === 'plan' ? '' : freshFits ? `A fresh session fits (unblock_item with fresh: true and the task as the message): it gets a brief from the item and git, not the old conversation, and needs about $${FRESH_FLOOR_USD}.` : `A fresh session needs about $${FRESH_FLOOR_USD}, which is not left either.`,
      phase === 'plan' ? '' : 'Work that is already in the worktree needs no session at all: commit_paths commits named files, then finish_from_worktree (retry_op in review) carries on.',
      !fits && !freshFits ? `Only money is missing: a card with raise_budget_usd of at least $${minRaiseUsd(e, left, false)} to resume, or $${minRaiseUsd(e, left, true)} with fresh: true.` : '',
    ].filter(Boolean).join(' ');
  }

  /** The first raise option that would not pay for what it promises, as a sentence for the orchestrator; undefined when they all do. */
  private raiseTooSmall(fm: ItemFrontmatter, options: DecisionOption[]): string | undefined {
    const phase = this.phaseFor(fm.status);
    const left = this.budgetOf(fm).usd - (fm.cost_usd ?? 0);
    const def = this.store.config.models.find((m) => m.id === (phase === 'plan' ? fm.planner : fm.implementer));
    const estimate = fm.session_id && def && (def.runner ?? 'claude') === 'claude' ? this.resumeEstimateFor(fm, def.claude_model) : undefined;
    for (const o of options) {
      if (o.raise_budget_usd === undefined) continue;
      if (o.fresh && phase !== 'implement' && phase !== 'fix') return `option "${o.label.slice(0, 30)}" asks for a fresh session, which is only for work in progress or in review (${fm.id} is ${fm.status}).`;
      const floor = minRaiseUsd(estimate, left, Boolean(o.fresh));
      if (o.raise_budget_usd >= floor) continue;
      return o.fresh
        ? `option "${o.label.slice(0, 30)}" raises the budget by $${o.raise_budget_usd}, but a fresh session needs about $${floor} to do a small job.`
        : `option "${o.label.slice(0, 30)}" raises the budget by $${o.raise_budget_usd}, but resuming ${fm.id}'s conversation costs about $${estimate!.cold.toFixed(2)} before any work (${Math.round(estimate!.tokens / 1000)}k tokens to reload), so the raise would be spent on the reload. Raise by at least $${floor}, or offer a fresh session instead (fresh: true on the option, from +$${minRaiseUsd(estimate, left, true)}): it gets a brief and your instruction, and needs no reload.`;
    }
    return undefined;
  }

  // ---- what the user authorized: a card option's action, an explicit request in the chat (#73) ----

  /**
   * Why planestro cannot do this for the user, or null when it can: exactly what would make doing it
   * throw, or leave an item that never starts. Asked when a card is made, so the user is never
   * offered an option that fails, and again when it is picked, since the backlog moves in between.
   * The chat's create_item is held to the same answer.
   */
  private actionRefusal(action: DecisionAction): string | null {
    const cfg = this.store.config;
    if (action.tool === 'discard_item') return this.discardRefusal(action.args.id);
    if (action.tool === 'close_as_done') return this.closeAsDoneRefusal(action.args.id);
    if (action.tool === 'rerun_ci') return this.rerunRefusal(action.args.id);
    if (action.tool === 'submit_item') {
      const item = this.store.getItem(action.args.id);
      if (!item) return `there is no item ${action.args.id}`;
      const fm = item.file.frontmatter; const d = this.store.derived(item);
      if (fm.status !== 'NOT_YET_SUBMITTED') return `${fm.id} is ${fm.status}; only an item that is not submitted yet can be submitted`;
      if (fm.taken_over) return `${fm.id} is taken over: the user is finishing it by hand`;
      if (fm.blocked || fm.awaiting) return `${fm.id} is stopped (${fm.blocked ? `blocked: ${fm.blocked_reason}` : `awaiting ${fm.awaiting}`}); that comes first`;
      if (d.flavor === 'external') return `${fm.id} is implemented outside planestro (${fm.implementer}): it is started by hand, not queued`;
      if (d.flavor !== 'epic') return null;
      if (d.children.length) return `epic ${fm.id} already has children (${d.children.join(', ')}): submit those, and the epic opens by itself when one is queued`;
      if (!d.base_branch) return d.base_branch_error ?? `${fm.id} has no base branch`;
      return this.busyWith(fm.id) ?? null;
    }
    const a = action.args;
    if (a.category && !cfg.categories.includes(a.category)) return `unknown category "${a.category}": ${cfg.categories.join(', ')}`;
    if (a.parent) {
      const parent = this.store.getItem(a.parent)?.file.frontmatter;
      if (!parent) return `there is no item ${a.parent} to be its parent`;
      if (parent.kind !== 'epic') return `${a.parent} is not an epic, so it cannot be a parent`;
      if (a.kind === 'epic') return `an epic cannot be a child of ${a.parent}: epics do not nest`;
      if (isDone(parent.status)) return `epic ${a.parent} is ${parent.status}: it takes no more children`;
    }
    const planner = findModel(cfg, a.planner);
    if (a.planner && (!planner || !canPlan(planner))) return `planner "${a.planner}" is not a model that can plan: ${cfg.models.filter(canPlan).map((m) => m.id).join(', ')}`;
    if (a.implementer && !findModel(cfg, a.implementer)) return `implementer "${a.implementer}" is not one of the project's models: ${cfg.models.map((m) => m.id).join(', ')}`;
    const missing = (a.depends_on ?? []).filter((d) => !this.store.getItem(d));
    if (missing.length) return `it would depend on ${missing.join(', ')}, which ${missing.length === 1 ? 'is not an item' : 'are not items'} here: it could never start`;
    if (a.submit && a.kind !== 'epic' && findModel(cfg, a.implementer ?? cfg.defaults.implementer)?.external) return 'its implementer works outside planestro, so it is started by hand, not queued: leave submit out';
    return null;
  }

  /** Submit an item as the user does on its page: a worker item is queued, an epic has its breakdown planned (an epic is never queued). Throws the refusal. */
  private submitAsUser(id: string, why: string): 'queued' | 'planning' {
    const refusal = this.actionRefusal({ tool: 'submit_item', args: { id } });
    if (refusal) throw new Error(refusal);
    if (this.store.requireItem(id).file.frontmatter.kind === 'epic') { this.startEpicPlan(id, why); return 'planning'; }
    this.store.mutateItem(id, [{ transition: { to: 'QUEUED', actor: 'user' } }, { activity: { actor: 'app', text: `queued for planning: ${why}` } }], 'user', { commit: `${id}: queued` });
    this.poke();
    return 'queued';
  }

  /**
   * Do what the picked option says, as the user: their answer on `from`'s card authorized it. Returns
   * what happened, in words. It throws only while nothing is written; once the item exists a submit
   * that fails is part of the result, so a second tap can never create a second item.
   */
  private performAction(action: DecisionAction, from: string): string {
    const why = `you chose it on ${from}'s decision card`;
    if (action.tool === 'discard_item' || action.tool === 'close_as_done' || action.tool === 'rerun_ci') throw new Error(`${action.tool} is carried out by answerDecision`);
    if (action.tool === 'submit_item') return this.submitAsUser(action.args.id, why) === 'planning' ? `epic ${action.args.id} is having its breakdown planned` : `${action.args.id} is queued for planning`;
    const a = action.args; const epic = a.kind === 'epic';
    const planner = findModel(this.store.config, a.planner)?.id; const implementer = findModel(this.store.config, a.implementer)?.id;
    const it = this.store.createItem({ title: a.title, description: a.description, kind: epic ? 'epic' : 'item', ...(planner ? { planner } : {}), ...(implementer ? { implementer } : {}), ...(a.category ? { category: a.category } : {}), ...(a.parent ? { parent: a.parent } : {}), ...(a.depends_on ? { depends_on: a.depends_on } : {}) }, 'user');
    this.store.mutateItem(it.id, [{ activity: { actor: 'user', text: `created by your answer on ${from}'s decision card, as the orchestrator proposed it there` } }], 'user');
    const made = `created ${epic ? 'epic ' : ''}${it.id} ("${a.title}")`;
    if (!a.submit) return `${made}, not submitted yet`;
    try { return `${made} and ${this.submitAsUser(it.id, why) === 'planning' ? 'started planning its breakdown' : 'queued it for planning'}`; }
    catch (e) { return `${made}, but it could not be submitted: ${(e as Error).message}`; }
  }

  /** The orchestrator's escalation: one plain decision, parked on an item that is already stopped. */
  private askUserDecision(id: string, input: DecisionInput): string {
    const item = this.store.getItem(id);
    if (!item) return `no item ${id}`;
    const fm = item.file.frontmatter;
    if (!fm.blocked && fm.awaiting !== 'question' && fm.awaiting !== 'user') return `not possible: ${id} is not stopped (not blocked, no question). A decision card belongs on an item that waits; use ask_user for anything else.`;
    const v = validateDecision(input);
    if (!v.ok) return `not recorded: ${v.error}. Fix that and call ask_user_decision again.`;
    // A raise the item would spend reloading its conversation is not an option (HH-184's +$15 met a $32 reload):
    // the card is answered by someone who cannot know that, so every raise on it must be enough to finish.
    const small = this.raiseTooSmall(fm, v.value.options);
    if (small) return `not recorded: ${small} Fix that and call ask_user_decision again.`;
    // An option that does something is checked now: the user is never offered one that would fail (#73).
    for (const o of v.value.options) {
      const refusal = o.action ? this.actionRefusal(o.action) : null;
      if (refusal) return `not recorded: option "${o.label}" cannot be carried out: ${refusal}. Fix its action (or leave the action out) and call ask_user_decision again.`;
    }
    const decision: Decision = { ...v.value, requested_at: this.now(), reason: fm.blocked ? fm.blocked_reason : fm.awaiting === 'question' ? 'question' : fm.awaiting };
    this.store.mutateItem(id, [
      { set: { awaiting: fm.awaiting ?? 'user', awaiting_data: { ...(fm.awaiting_data ?? {}), decision } } },
      { unset: ['triage'] },
      { activity: { actor: 'orchestrator', text: `decision needed: ${decision.question} (recommended: ${decision.options[0].label})` } },
    ], 'orchestrator', { commit: `${id}: decision for the user` });
    this.store.journal.append({ type: 'orchestrator.decision_requested', item: id, actor: 'orchestrator', data: { question: decision.question, why: decision.why, options: decision.options.map((o) => o.label) } });
    this.note('warn', `${id}: needs your decision — ${decision.question}`);
    return 'recorded: the user sees the card; you will be woken with the answer. End this wake with done_with_wake.';
  }

  /**
   * The user answered a decision card. The answer is the orchestrator's to carry out, so the item
   * goes back into triage and the orchestrator is woken with the question and the answer; without
   * an orchestrator, a blocked session is resumed with them directly.
   */
  async answerDecision(id: string, answer: { choice?: string; text?: string }): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const decision = decisionOf(fm);
    if (!decision) throw new Error(`${id} has no decision waiting for you`);
    const choice = answer.choice?.trim(); const text = answer.text?.trim();
    if (!choice && !text) throw new Error('pick an option or write your answer');
    if (choice && !decision.options.some((o) => o.label === choice)) throw new Error(`"${choice}" is not one of the options`);
    if (!choice && !decision.allow_free_text) throw new Error('pick one of the options');
    const said = [choice, text].filter(Boolean).join(' — ');
    const { decision: _answered, ...rest } = fm.awaiting_data ?? {};
    const carry = this.triageAvailable();
    // The option carries the change it names (p43): answering IS raising the budget, not a promise to go raise it elsewhere.
    const chosen = decision.options.find((o) => o.label === choice);
    const raise = chosen?.raise_budget_usd;
    const fresh = Boolean(chosen?.fresh) && !this.freshRefusal(fm, said);
    // Or it carries an action (#73): the answer is the authorization, so planestro does it as the user, here. Checked
    // again first, since the backlog may have moved since the card was made; a refusal leaves the card as it was.
    const refusal = chosen?.action ? this.actionRefusal(chosen.action) : null;
    if (refusal) throw new Error(`"${choice}" cannot be carried out any more: ${refusal}. Pick another option, or answer in your own words.`);
    // A discard closes a pull request and may delete a branch: async, and it can leave this card's own item in the icebox.
    // So does closing one as done (#126): both are async, and both can end this card's own item (icebox, FINISHED).
    const act = chosen?.action;
    // A re-run clears the block and the card with it (#162): the same ending as the two that move the item.
    const ends = act?.tool === 'discard_item' || act?.tool === 'close_as_done' || act?.tool === 'rerun_ci';
    const done = act?.tool === 'discard_item' ? await this.discard(act.args.id, act.args.reason, { deleteBranch: act.args.delete_branch === true, from: `your answer on ${id}'s decision card` })
      : act?.tool === 'close_as_done' ? (await this.closeAsDone(act.args.id, `${act.args.reason} (your answer on ${id}'s decision card)`), `${act.args.id} closed as done`)
      : act?.tool === 'rerun_ci' ? await (async () => { const r = await this.rerunCi(act.args.id, 'user'); if (/^not (possible|now)/.test(r)) throw new Error(r); return r; })()
      : act ? this.performAction(act, id) : undefined;
    if (ends && !decisionOf(this.store.requireItem(id).file.frontmatter)) {
      this.store.mutateItem(id, [{ activity: { actor: 'user', text: `decided: ${decision.question} → ${said} (done for you: ${done})` } }], 'user', { commit: `${id}: decision answered` });
      this.store.journal.append({ type: 'orchestrator.decision_answered', item: id, actor: 'user', data: { question: decision.question, choice: choice ?? null, text: text ?? null, action: act!.tool, action_result: done } });
      return;
    }
    const raisedTo = raise ? Math.round((Math.max(this.budgetOf(fm).usd, fm.cost_usd ?? 0) + raise) * 100) / 100 : undefined;
    this.store.mutateItem(id, [
      Object.keys(rest).length ? { set: { awaiting_data: rest } } : { unset: ['awaiting_data'] },
      ...(carry ? [{ set: { triage: { reason: 'decision', started_at: this.now() } } } as ItemOp] : []),
      ...(raisedTo !== undefined ? [{ set: { budget_usd: raisedTo } } as ItemOp] : []),
      { activity: { actor: 'user', text: `decided: ${decision.question} → ${said}${raisedTo !== undefined ? ` (budget raised to $${raisedTo})` : ''}${done ? ` (done for you: ${done})` : ''}` } },
    ], 'user', { commit: `${id}: decision answered` });
    this.store.journal.append({ type: 'orchestrator.decision_answered', item: id, actor: 'user', data: { question: decision.question, choice: choice ?? null, text: text ?? null, ...(raisedTo !== undefined ? { budget_raised_to: raisedTo } : {}), ...(done ? { action: chosen!.action!.tool, action_result: done } : {}) } });
    const doneNote = done ? `Already done by planestro, as the user: ${done}. Do not do it again. ` : '';
    const raisedNote = raisedTo !== undefined ? `The item's budget is already raised to $${raisedTo} (budget_usd); nothing else needs changing. ` : '';
    if (carry) { this.wakeOrchestrator('decision_answered', id, { question: decision.question, answer: said, options: decision.options.map((o) => `${o.label}: ${o.description}`).join(' | '), ...(raisedTo !== undefined ? { budget: `${raisedNote}Resume it with unblock_item${fresh ? ' and fresh: true, as the option promised' : ''}.` } : fresh ? { budget: 'The option promised a fresh session: unblock_item with fresh: true and the instruction as its message.' } : {}), ...(done ? { action: `${doneNote}What is left is this item's own stop.` } : {}) }); return; }
    // No orchestrator to carry it out: a blocked session hears the answer itself; a worker's question stays for you to answer.
    const cur = this.store.requireItem(id).file.frontmatter;
    if (cur.blocked || cur.awaiting === 'user') await this.unblock(id, `The user was asked: ${decision.question}\nTheir answer: ${said}${raisedNote ? `\n${raisedNote}` : ''}${doneNote ? `\n${doneNote}` : ''}`, 'user', { fresh });
  }

  /**
   * Park a stopped item on other items (p14): "resume when HH-129 merges, and tell it this". The
   * block, question or triage it had is answered by the park, so it no longer needs anyone; the tick
   * resumes it when they have all merged. Items already merged need no wait: it resumes now.
   */
  async resumeAfter(id: string, items: string[], message: string, by: 'user' | 'orchestrator' = 'user', prs: number[] = []): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (!this.phaseFor(fm.status) || this.store.derived(item).flavor !== 'worker') return `not possible: ${id} is ${fm.status}; only a worker item planning or in progress can wait to resume`;
    if (fm.taken_over) return `not possible: the user has taken ${id} over`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const ids = [...new Set(items.map((x) => x.trim()).filter(Boolean))];
    const nums = [...new Set(prs.filter((n) => Number.isInteger(n) && n > 0))];
    if ((!ids.length && !nums.length) || !message.trim()) return 'not recorded: name at least one item or pull request to wait for, and the message to resume with';
    const missing = ids.filter((x) => x === id || !this.store.getItem(x));
    if (missing.length) return `not recorded: ${missing.join(', ')} ${missing.includes(id) ? '(an item cannot wait for itself) ' : ''}is not an item to wait for`;
    // A pull request by number (#136, HH-298): one a person opened, which no item stands for. It must exist and still be open.
    for (const n of nums) {
      if (n === fm.pr) return `not recorded: PR #${n} is ${id}'s own pull request`;
      const pr = await this.ports.gh.prView(this.github, n).catch(() => undefined);
      if (!pr) return `not recorded: there is no pull request #${n} in ${this.github}`;
      if (pr.state === 'CLOSED') return `not recorded: PR #${n} was closed without merging`;
    }
    const what = waitsFor({ items: ids, prs: nums });
    this.store.mutateItem(id, [
      { unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] },
      { set: { resume_after: { items: ids, ...(nums.length ? { prs: nums } : {}), message: message.trim(), since: this.now() } } },
      { activity: { actor: by, text: `waits for ${what} to merge, then resumes with: ${message.trim()}` } },
    ], by, { commit: `${id}: resume after ${what}` });
    void this.tick();
    return `parked: ${id} resumes when ${what} ${ids.length + nums.length === 1 ? 'has' : 'have'} merged`;
  }

  /** Stop waiting without resuming: the item is the user's again, as a plain block. */
  cancelResumeAfter(id: string): void {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (!fm.resume_after) return;
    this.store.mutateItem(id, [{ unset: ['resume_after'] }, { set: { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }, { activity: { actor: 'user', text: `stopped waiting for ${waitsFor(fm.resume_after)}` } }], 'user', { commit: `${id}: stop waiting` });
  }

  private waitedPrs = new Map<number, { state?: 'OPEN' | 'MERGED' | 'CLOSED'; at: number; reading?: boolean }>();
  /** A waited-on pull request's last known state, refreshed at most once a minute (one gh call each); undefined until first read. */
  private waitedPrState(n: number): 'OPEN' | 'MERGED' | 'CLOSED' | undefined {
    const cur = this.waitedPrs.get(n) ?? { at: 0 };
    if (!cur.reading && cur.state !== 'MERGED' && cur.state !== 'CLOSED' && Date.now() - cur.at > 60_000) {
      this.waitedPrs.set(n, { ...cur, reading: true });
      void this.ports.gh.prView(this.github, n).then((pr) => { this.waitedPrs.set(n, { state: pr.state, at: Date.now() }); if (pr.state !== 'OPEN') this.poke(); },
        () => { this.waitedPrs.set(n, { ...cur, at: Date.now(), reading: false }); });
    }
    return this.waitedPrs.get(n)?.state;
  }

  private driveResumeAfter(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      const wait = fm.resume_after;
      if (!wait || fm.taken_over || this.jobs.has(item.id) || this.turns.has(item.id)) continue;
      const gone = wait.items.filter((x) => !this.store.getItem(x));
      if (gone.length) { this.store.mutateItem(item.id, [{ unset: ['resume_after'] }], 'engine'); this.block(item.id, 'waited_on_gone', `it was waiting for ${gone.join(', ')}, which no longer exist${gone.length === 1 ? 's' : ''}; its message was: ${wait.message}`); continue; }
      if (!wait.items.every((x) => ['MERGED', 'FINISHED'].includes(this.store.requireItem(x).file.frontmatter.status))) continue;
      // Pull requests by number (#136): their state is GitHub's, read off the tick (waitedPrState) and looked up here.
      const prs = wait.prs ?? [];
      const states = prs.map((n) => this.waitedPrState(n));
      const closed = prs.filter((_, i) => states[i] === 'CLOSED');
      if (closed.length) { this.store.mutateItem(item.id, [{ unset: ['resume_after'] }], 'engine'); this.block(item.id, 'waited_on_gone', `it was waiting for ${closed.map((n) => `PR #${n}`).join(', ')}, closed without merging; its message was: ${wait.message}`); continue; }
      if (!states.every((x) => x === 'MERGED')) continue;
      const what = waitsFor(wait);
      this.store.mutateItem(item.id, [{ unset: ['resume_after'] }, { activity: { actor: 'app', text: `${what} merged; resuming` } }], 'engine', { commit: `${item.id}: resume after ${what}` });
      this.runJob(item.id, () => this.resumeWaited(item.id, [...wait.items, ...prs.map((n) => `PR #${n}`)], wait.message));
    }
  }

  /**
   * What it waited for is in the base now, not yet on its branch: bring the branch up to date first
   * (syncBranch: a worker branch rebases), so the session resumes with what it needs (HH-118 resumed
   * without the flag it had waited for, p29). A conflict goes to the session as any sync conflict does.
   */
  private async resumeWaited(id: string, merged: string[], message: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) return;
    const had = `${merged.join(', ')} ${merged.length === 1 ? 'has' : 'have'} merged`;
    const sync = fm.worktree ? await this.syncBranch(id, 'before resuming') : undefined;
    if (sync?.kind === 'conflict') { await this.runTurnFor(id, 'fix', `${this.conflictPrompt(id, sync)}\n\nThen continue with what you were waiting to do (${had}):\n\n${message}`, [], [], { fresh: 'auto' }); return; }
    const synced = sync?.kind === 'diverged' ? `planestro did not rebase your branch: the worktree (${sync.local.slice(0, 7)}) and the pushed branch (${sync.remote.slice(0, 7)}) have diverged, so someone pushed commits you do not have. Look at them first (git log HEAD..origin/${fm.branch}); ask with report_blocked if you need them brought in.`
      : sync?.kind === 'synced' ? `Your branch was rebased onto origin/${sync.base} (${sync.head.slice(0, 7)}), so it has what ${merged.join(', ')} delivered.`
      : sync?.kind === 'dirty' ? `Your branch is ${sync.behind} commit${sync.behind === 1 ? '' : 's'} behind origin/${sync.base}, which now has ${merged.join(', ')}; planestro did not rebase it because your worktree has uncommitted changes. Commit them first; ask with report_blocked if you need the rebase.`
      : '';
    await this.runTurnFor(id, phase, `${had}.${synced ? ` ${synced}` : ''}\n\n${message}`, [], [], { fresh: 'auto', note: `${merged.join(', ')} merging` });
  }

  /**
   * "Sync with base" between turns (p29): bring an item's branch up to date with origin/<base_branch>
   * while no turn is live, so a session resumed after a dependency merged has it (the orchestrator has
   * no git, and resumed HH-118 on the old base). A worker branch rebases and, only if it is already
   * pushed, is pushed with --force-with-lease; an epic's integration branch merges the base in and is
   * pushed plainly, never rewritten. A branch already on the base tip is left alone. A conflict is
   * aborted and goes to the item's session (the rebase-conflict prompt), or blocks it when there is
   * no session to take it or it is blocked and was not asked to go on. With `unblock`, a stopped item
   * is then unblocked as unblock_item would (with the message, its session resumes told of the sync).
   * Waits for the git part and returns what happened, in words, for the API and the orchestrator.
   */
  async syncWithBase(id: string, opts: { by?: 'user' | 'orchestrator'; unblock?: { message?: string; fresh?: boolean } } = {}): Promise<string> {
    const by = opts.by ?? 'user';
    const fresh = opts.unblock?.fresh === true;
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    const epic = fm.kind === 'epic';
    if (this._paused || this.draining || this.stopping) return `not now: automation is ${this._paused ? 'paused' : 'stopping'}; nothing was synced`;
    if (epic ? fm.status !== 'IN_PROGRESS' || !fm.branch : d.flavor !== 'worker' || !['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'].includes(fm.status)) return `not possible: ${id} is ${epic ? 'an epic that is not open' : `${fm.status}${d.flavor !== 'worker' ? ` (${d.flavor})` : ''}`}; only a worker item planning or in progress, or an open epic, is synced this way${fm.status === 'IN_REVIEW' ? ' (the merge pipeline syncs a pull request; retry_op re-enters it)' : ''}`;
    if (!epic && (!fm.worktree || !fm.branch)) return `not possible: ${id} has no worktree or branch yet`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    if (fm.op) return `not now: ${id} is ${fm.op.replace(/_/g, ' ')}; let it finish first`;
    if (fm.awaiting && fm.awaiting !== 'user') return `not now: ${id} is awaiting ${fm.awaiting.replace(/_/g, ' ')}; answer that first`;
    if (opts.unblock && !fm.blocked && fm.awaiting !== 'user') return `nothing to unblock: ${id} is not blocked; sync it without unblocking`;
    const noFresh = fresh ? this.freshRefusal(fm, opts.unblock?.message) : undefined;
    if (noFresh) return `not possible: ${noFresh}`;
    const base = d.base_branch;
    if (!base) return `not possible: ${d.base_branch_error ?? 'the base branch cannot be resolved'}`;
    if (!epic) {
      const dir = this.absWorktree(fm.worktree!);
      if (!(await this.ports.git.worktreeList(this.repo).catch(() => [])).some((w) => w.path === dir && !w.prunable)) return `not possible: the worktree ${fm.worktree} is missing; use recreate_worktree`;
      const { tracked } = await this.ports.git.dirtyDetail(dir);
      if (tracked.length) return `refused: ${fm.worktree} has uncommitted changes (${tracked.slice(0, 5).join(', ')}); a rebase needs a clean tree, so nothing was touched`;
    }
    let out: SyncOutcome | undefined;
    this.runJob(id, async () => { out = await this.syncBranch(id, by === 'orchestrator' ? 'for the orchestrator' : ''); });
    await this.jobs.get(id);
    const r = out as SyncOutcome | undefined;
    if (!r) return `not synced: the sync of ${id} stopped (see its Activity log)`;
    if (r.kind === 'conflict') {
      const where = `${r.integration ? `merging origin/${r.base} into ${fm.branch}` : `rebasing ${fm.branch} onto origin/${r.base}`} conflicted in ${r.files.join(', ')}; it was aborted, so the branch is as it was`;
      const cur = this.store.requireItem(id).file.frontmatter;
      const phase = this.phaseFor(cur.status);
      if (r.integration && this.store.config.epics.conflict_budget_usd > 0) {
        const baseSha = r.baseSha;
        this.runJob(id, async () => {
          const out = await this.resolveEpicConflict(id, r.cwd!, r.base, baseSha, r.files);
          if (out !== 'resolved') this.block(id, 'sync_conflict', `${where}: ${out}; resolve it by hand in ${r.cwd}, or have the orchestrator retry with resolve_epic_conflict and a hint`);
        });
        return `conflict: ${where}. A one-shot session is resolving it in ${r.cwd}; the Activity log says how it went`;
      }
      if (r.integration || !phase || !cur.session_id) { this.block(id, 'sync_conflict', `${where}, and ${r.integration ? 'an integration branch has' : 'it has'} no session to hand it to; resolve it by hand${r.integration ? ` in ${r.cwd}` : ''}`); return `conflict: ${where}; blocked for a person to resolve`; }
      if (cur.blocked && !opts.unblock) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `${where}; ${id} stays blocked (${cur.blocked_reason}), so the conflict waits for it to be unblocked with a sync first` } }], 'engine'); return `conflict: ${where}. ${id} stays blocked (${cur.blocked_reason}); unblock it with sync_first to hand the conflict to its session`; }
      const then = opts.unblock?.message?.trim() ? `Then continue with this:\n\n${opts.unblock.message.trim()}` : 'Once the rebase is done, carry on with your work on this item where you left off.';
      this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: by, text: `${opts.unblock ? 'unblocked; ' : ''}the sync conflict goes to the session` } }], by, { commit: `${id}: sync conflict to the session` });
      this.queueFollowUp(id, () => this.runTurnFor(id, 'fix', `${this.conflictPrompt(id, r)}\n\n${then}`, [], [], { fresh: fresh ? true : 'auto' }));
      return `conflict: ${where}. Handed to the session to resolve${opts.unblock?.message?.trim() ? ', with your message to act on after' : ''}`;
    }
    if (r.kind === 'diverged') return `refused: the worktree (${r.local.slice(0, 7)}) and the pushed branch ${fm.branch} (${r.remote.slice(0, 7)}) have diverged; not pushing either way. Someone pushed commits the worktree lacks: bring them into the worktree (or reset it to them) first; nothing was rebased or pushed`;
    const said = r.kind === 'current' ? `already up to date: ${epic ? fm.branch : fm.branch ?? id} is on origin/${r.base}@${r.baseSha.slice(0, 7)}; nothing to sync`
      : r.kind === 'dirty' ? `not synced: ${fm.worktree} has files in the way (${r.files.slice(0, 5).join(', ')}); commit or remove them first`
      : `synced: ${r.integration ? `merged origin/${r.base} into ${fm.branch}` : `rebased onto origin/${r.base}`}@${r.baseSha.slice(0, 7)} (${r.head.slice(0, 7)})${r.pushed ? (r.integration ? ', pushed' : ', pushed with --force-with-lease') : ', local only (not pushed yet)'}`;
    if (r.kind === 'dirty') return said;
    if (opts.unblock) {
      const note = r.kind === 'synced' ? `planestro rebased your branch onto origin/${r.base} (${r.head.slice(0, 7)}), so it has what has merged there since you started.` : `Your branch is already on origin/${r.base}.`;
      await this.unblock(id, opts.unblock.message?.trim() ? `${note}\n\n${opts.unblock.message.trim()}` : undefined, by, { fresh });
      return `${said}; unblocked${opts.unblock.message?.trim() ? `, and ${fresh ? 'a fresh session starts' : 'the session resumes'} with your message` : ', and the pipeline retries from where it stopped'}`;
    }
    return said;
  }

  /**
   * Rebase a worker branch onto origin/<base>, or merge it into an integration branch, with the project's
   * generated files (worktrees.generated, #63) resolved by code: a conflict only in those takes the base's
   * copy, their commands run, and what they changed is committed. HH-184's rebase conflicted only in
   * messages.pot (generated from en.po), went to a session that was over budget, and the designer paid for
   * a merge a tool could do. Anything else, a failed command, or a command that changed an unlisted file:
   * the branch goes back to its head before the sync and the conflict goes where it always went. `note`
   * says what was regenerated, or why it was not.
   */
  private async syncOnto(id: string, cwd: string, base: string, integration: boolean): Promise<RebaseResult & { note?: string }> {
    const generated = this.store.config.worktrees.generated;
    const patterns = Object.keys(generated);
    const before = patterns.length ? await this.ports.git.revParse(cwd, 'HEAD') : '';
    const sync = integration ? await this.ports.git.merge(cwd, `origin/${base}`, patterns) : await this.ports.git.rebase(cwd, `origin/${base}`, patterns);
    const took = sync.tookBase ?? [];
    if (!sync.ok || !took.length) return sync;
    const undo = async (why: string): Promise<RebaseResult & { note: string }> => {
      await this.ports.git.resetHard(cwd, before);
      return { ok: false, conflicts: took, head: before, note: `${why}; the sync was undone` };
    };
    const commands = [...new Set(patterns.filter((p) => took.some((f) => matchesPathPattern(f, p))).map((p) => generated[p]))];
    for (const command of commands) {
      const r = await this.withLocalJobSlot(() => this.ports.proc.run(command, { cwd, timeoutMs: 20 * 60_000 }));
      if (r.code !== 0) return undo(`regenerating with \`${command}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    }
    const { tracked } = await this.ports.git.dirtyDetail(cwd);
    const other = tracked.filter((f) => !patterns.some((p) => matchesPathPattern(f, p)));
    if (other.length) return undo(`regenerating also changed ${other.slice(0, 5).join(', ')}, which worktrees.generated does not list`);
    const head = tracked.length ? await this.ports.git.commitPaths(cwd, tracked, `${id}: regenerate ${tracked.map((f) => basename(f)).join(', ')}`) : sync.head;
    return { ...sync, head, note: `took ${base}'s copy of ${took.join(', ')} in the conflict and regenerated it (${commands.map((c) => `\`${c}\``).join(', ')})${tracked.length ? `; committed ${tracked.join(', ')}` : '; nothing changed'}` };
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
  private async resolveEpicConflict(id: string, cwd: string, base: string, baseSha: string, files: string[], hint?: string): Promise<string> {
    const cap = this.store.config.epics.conflict_budget_usd;
    if (!(cap > 0)) return 'conflict sessions are off (epics.conflict_budget_usd is 0)';
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) return 'you have taken this epic over';
    const branch = fm.branch!;
    const requested = this.store.config.models.find((m) => m.id === (fm.implementer ?? this.store.config.defaults.implementer));
    if (!requested) return `its implementer ${fm.implementer ?? this.store.config.defaults.implementer} is not a model row`;
    const pick = resolveTurnModel(this.store.config, requested, { allow: fm.allow_model_fallback === true, unavailable: this.store.local.model_unavailable, now: new Date(Date.now()) });
    if (pick.exhaustedUntil) return `${requested.label} is out of usage until ${pick.exhaustedUntil}`;
    const def = pick.def;
    const runner = def.runner ?? 'claude';
    const agent = this.ports.agents[runner];
    if (!agent) return `${def.label} needs the ${runner} runner, which is not available here`;
    const model = runner === 'claude' ? def.claude_model : def[`${runner}_model`];
    const before = await this.ports.git.revParse(cwd, 'HEAD');
    const remote = await this.ports.git.remoteBranchSha(this.repo, branch);
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
    const opId = this.store.journal.begin('conflict_session', id, { base, base_sha: baseSha, files, model: model ?? def.label });
    this.store.mutateItem(id, [{ set: { op: 'syncing_base', op_started_at: this.now() } }, { activity: { actor: 'app', text: `merging origin/${base} (${baseSha.slice(0, 7)}) into ${branch} conflicted in ${files.join(', ')}; a one-shot ${def.label} session resolves it in ${cwd} (up to $${cap}, epics.conflict_budget_usd)${hint?.trim() ? ` with the hint: ${hint.trim().slice(0, 200)}` : ''}` } }], 'engine', { commit: `${id}: conflict session` });
    const reported: { done?: string; blocked?: string } = {};
    const none = async () => 'not available in a conflict session: resolve the merge, then report_done or report_blocked';
    const tools: TurnTools = {
      submit_plan: none, submit_breakdown: none, add_note: none, report_progress: none, hand_off: none,
      append_activity: async (t) => { this.store.mutateItem(id, [{ activity: { actor: 'worker', text: `[conflict session] ${String(t).slice(0, 500)}` } }], 'engine'); return 'appended'; },
      report_done: async (s) => { reported.done = String(s); return 'recorded: planestro checks your merge and pushes it. End your turn now.'; },
      report_blocked: async (r) => { reported.blocked = String(r); return 'recorded. End your turn now.'; },
      get_item: async () => `${id} "${fm.title}" (epic) — integration branch ${branch}, base ${base}`,
    };
    const allowed = [...BASE_ALLOWED.fix, 'Bash(git merge *)', ...this.store.config.permissions.allow];
    const policy = makePolicy(this.store.config, base, cwd);
    const abort = new AbortController();
    this.turns.set(id, { model: model ?? def.label, phase: 'fix', startedAt: this.now(), lastOutput: '', abort });
    let result: TurnResult;
    try {
      result = await this.withRunnerSlot(runner, () => this.withSessionSlot(id, () => agent.runTurn({
        itemId: id, phase: 'fix', cwd, model: model as string, permissionMode: 'acceptEdits', prompt,
        systemAppend: `${this.store.renderPrompt(runner === 'claude' ? 'worker-system' : `worker-system-${runner}`, item)}\n\n${this.hostNote}${runner === 'claude' ? cwdNote(cwd) : ''}`,
        ...(pick.sdkFallback ? { fallbackModel: pick.sdkFallback } : {}),
        allowedTools: sdkRules(allowed), extraDirs: [this.store.dataDir], maxBudgetUsd: cap, tools,
        // One shot, so nothing parks: what the rules do not allow is refused with a way forward.
        onPermission: async (req) => {
          const why = policy.deny(req);
          if (why) return { action: 'deny', message: `Not allowed: ${why}` };
          if (allowedByRules(req, allowed, cwd)) return { action: 'allow' };
          return { action: 'deny', message: 'Not allowed in a conflict session: resolve the merge with git and file edits. If you need something else, git merge --abort and report_blocked saying what.' };
        },
        onQuestion: async () => undefined,
        onOutput: (text) => { const t = this.turns.get(id); if (t) t.lastOutput = text.slice(-400); this.emit({ type: 'session.output', id, text }); },
        signal: abort.signal,
      })));
    } finally { this.turns.delete(id); }
    const after = this.store.requireItem(id).file.frontmatter;
    this.store.mutateItem(id, [{ set: { cost_usd: Math.round(((after.cost_usd ?? 0) + result.costUsd) * 10000) / 10000, turns: (after.turns ?? 0) + result.numTurns } }, { unset: ['op', 'op_started_at'] }], 'engine');
    this.usageSeen(result.rateLimit);
    const fail = async (why: string): Promise<string> => {
      await this.ports.git.abortInProgress(cwd).catch(() => undefined);
      const attempt = await this.ports.git.revParse(cwd, 'HEAD').catch(() => before);
      if (attempt !== before) await this.ports.git.resetHard(cwd, before);
      this.store.journal.end(opId, id, 'failed', { reason: why, attempt });
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `the conflict session did not resolve it: ${why}${attempt !== before ? `; its attempt is ${attempt.slice(0, 12)} (git show it), the worktree is back on ${before.slice(0, 7)}` : ''} ($${result.costUsd.toFixed(2)})` } }], 'engine', { commit: `${id}: conflict session failed` });
      return why;
    };
    if (result.subtype === 'killed') return fail('the session was stopped');
    const blocked = reported.blocked ?? result.blocked;
    if (blocked) return fail(`it needs a decision: ${blocked}`);
    const done = reported.done ?? result.done;
    if (!done) return fail(`it ended without reporting done (${result.subtype}${result.error ? `: ${result.error.slice(0, 160)}` : ''})`);
    // Positive evidence before the push (invariant 7's spirit): a finished merge, nothing left over, both histories in it.
    if (await this.ports.git.inProgressOp(cwd)) return fail('it reported done with the merge unfinished');
    const { clean, dirty } = await this.worktreeDirt(cwd);
    if (!clean) return fail(`it left uncommitted changes (${dirty.slice(0, 5).join(', ')})`);
    if (!(await this.ports.git.isAncestor(cwd, `origin/${base}`, 'HEAD'))) return fail(`the result does not contain origin/${base}`);
    if (remote && !(await this.ports.git.isAncestor(cwd, remote, 'HEAD'))) return fail(`the result does not contain origin/${branch} (${remote.slice(0, 7)}): the branch was rewritten`);
    try { await this.ports.git.pushSetUpstream(cwd, branch); } catch (e) { return fail(`the push was refused (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)})`); }
    const head = await this.ports.git.revParse(cwd, 'HEAD');
    this.store.journal.end(opId, id, 'ok', { head, cost: result.costUsd });
    this.store.mutateItem(id, [{ activity: { actor: 'app', text: `the conflict session resolved the merge ("${done.slice(0, 300)}"); checked it (finished, clean, contains origin/${base} and origin/${branch}) and pushed ${head.slice(0, 7)} ($${result.costUsd.toFixed(2)})` } }], 'engine', { commit: `${id}: conflict resolved` });
    return 'resolved';
  }

  /**
   * The orchestrator's resolve_epic_conflict (#71): an epic that stopped on a sync conflict, tried again
   * with a fresh merge and, if it still conflicts, a conflict session carrying the hint. Returns at once;
   * the Activity log and the next wake say how it went.
   */
  async retryEpicConflict(id: string, hint: string | undefined, by: 'user' | 'orchestrator' = 'orchestrator'): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.kind !== 'epic') return `not possible: ${id} is not an epic (a worker item's session resolves its own conflicts)`;
    if (!['IN_PROGRESS', 'IN_REVIEW'].includes(fm.status) || !fm.branch) return `not possible: ${id} is ${fm.status}; only an open epic's branch is merged with its base`;
    if (!(this.store.config.epics.conflict_budget_usd > 0)) return 'not possible: conflict sessions are off (epics.conflict_budget_usd is 0)';
    if (this._paused || this.draining || this.stopping) return 'not now: automation is paused';
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    if (fm.op) return `not now: ${id} is ${fm.op.replace(/_/g, ' ')}`;
    if (fm.blocked && fm.blocked_reason !== 'sync_conflict') return `not possible: ${id} is blocked for ${fm.blocked_reason}, not a sync conflict`;
    this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: by, text: `resolving the sync conflict with a conflict session${hint?.trim() ? `: ${hint.trim().slice(0, 300)}` : ''}` } }], by, { commit: `${id}: resolve conflict` });
    this.runJob(id, async () => {
      const r = await this.syncBranch(id, by === 'orchestrator' ? 'for the orchestrator' : '');
      if (r.kind !== 'conflict') return;   // the base merged cleanly this time, or there was nothing to do: the chain carries on
      const out = await this.resolveEpicConflict(id, r.cwd!, r.base, r.baseSha, r.files, hint);
      if (out !== 'resolved') this.block(id, 'sync_conflict', `merging ${r.base} into ${fm.branch} conflicted in ${r.files.join(', ')}: ${out}; resolve it by hand in ${r.cwd}`);
    });
    return `started: ${id}'s branch is merged with its base again, and a conflict goes to a one-shot session${hint?.trim() ? ' with your hint' : ''}; its Activity log says how it went`;
  }

  /** The rebase-conflict prompt for a sync that stopped on a conflict. */
  private conflictPrompt(id: string, r: { files: string[]; baseSha: string }): string {
    return this.store.renderPrompt('rebase-conflict', this.store.requireItem(id), { conflict_files: r.files.join('\n'), base_sha: r.baseSha.slice(0, 12) });
  }

  /**
   * The git of a sync, run inside the item's job. `op` says what is in flight (rebasing /
   * syncing_base / pushing), so a restart part-way is recovered by reconcile (a half-done rebase is
   * aborted). The mechanics are the merge step's: fetch, the one dirty tree it may clear
   * (clearForSync), sync only when behind, rebase or merge, push with a lease or plainly.
   */
  private async syncBranch(id: string, context = ''): Promise<SyncOutcome> {
    const item = this.store.requireItem(id);
    let fm = item.file.frontmatter;
    const base = this.store.derived(item).base_branch!;
    const integration = fm.kind === 'epic';
    const branch = fm.branch!;
    const opId = this.store.journal.begin('sync_with_base', id, { base, branch });
    this.store.mutateItem(id, [{ set: { op: integration ? 'syncing_base' : 'rebasing', op_started_at: this.now() } }], 'engine');
    const done = (status: 'ok' | 'aborted', data: Record<string, unknown>, text?: string): void => {
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, ...(text ? [{ activity: { actor: 'app', text } } as ItemOp] : [])], 'engine', text ? { commit: `${id}: sync with ${base}` } : undefined);
      this.store.journal.end(opId, id, status, data);
    };
    await this.ports.git.fetch(this.repo);
    let cwd: string;
    if (integration) {
      // An epic has no session worktree: sync in a temporary one on its integration branch, first taking in what merged into that branch remotely.
      cwd = fm.worktree ? this.absWorktree(fm.worktree) : join(this.store.worktreesRoot(), `merge-${id.toLowerCase()}`);
      if (!(await this.ports.git.worktreeList(this.repo)).some((w) => w.path === cwd && !w.prunable)) await this.ports.git.worktreeAdd(this.repo, cwd, branch, `origin/${branch}`);
      if (!fm.worktree) { this.store.mutateItem(id, [{ set: { worktree: cwd } }], 'engine'); fm = this.store.requireItem(id).file.frontmatter; }
      if (await this.ports.git.remoteBranchSha(this.repo, branch)) {
        const own = await this.ports.git.merge(cwd, `origin/${branch}`);
        if (!own.ok) { done('aborted', { reason: 'conflict', files: own.conflicts }, `merge of origin/${branch} into its local copy conflicted in ${own.conflicts.join(', ')}`); return { kind: 'conflict', base, baseSha: await this.ports.git.revParse(this.repo, `origin/${base}`), files: own.conflicts, integration, cwd }; }
      }
    } else cwd = this.absWorktree(fm.worktree!);
    const dirty = await this.clearForSync(id, cwd, base);
    if (dirty.length) {
      const { behind } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
      done('aborted', { reason: 'dirty' }, `not synced with origin/${base}: the worktree has uncommitted changes (${dirty.slice(0, 5).join(', ')})`);
      return { kind: 'dirty', base, behind, files: dirty };
    }
    const baseSha = await this.ports.git.revParse(this.repo, `origin/${base}`);
    const { behind } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    if (behind === 0) { done('aborted', { reason: 'up_to_date' }, `already on ${base}@${baseSha.slice(0, 7)}; no sync needed${context ? ` ${context}` : ''}`); return { kind: 'current', base, baseSha }; }
    const expected = await this.ports.git.remoteBranchSha(this.repo, branch);
    // A pushed worker branch that moved on its own (a person finishing it by hand, p28) is never rebased away and pushed over: positive evidence first, as driveHeld and cleanup ask.
    if (!integration && expected) {
      const local = await this.ports.git.revParse(cwd, 'HEAD');
      if (expected !== local && !(await this.ports.git.isAncestor(cwd, expected, local))) {
        done('aborted', { reason: 'diverged', local, remote: expected }, `not synced: the worktree (${local.slice(0, 7)}) and the pushed branch (${expected.slice(0, 7)}) have diverged; not pushing either way`);
        return { kind: 'diverged', base, local, remote: expected };
      }
    }
    const sync = await this.syncOnto(id, cwd, base, integration);
    if (!sync.ok) {
      done('aborted', { reason: 'conflict', files: sync.conflicts }, `${integration ? 'merge of' : 'rebase onto'} origin/${base} (${baseSha.slice(0, 7)}) conflicted in ${sync.conflicts.join(', ')}${sync.note ? ` (${sync.note})` : ''}; aborted, the branch is unchanged`);
      return { kind: 'conflict', base, baseSha, files: sync.conflicts, integration, cwd };
    }
    // Pushed only when the branch is already on the remote: a branch no one has seen needs only the local rebase.
    if (expected) {
      this.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.now() } }], 'engine');
      if (integration) await this.ports.git.pushSetUpstream(cwd, branch);
      else await this.ports.git.pushForceWithLease(cwd, branch, expected);
    }
    done('ok', { head: sync.head, pushed: Boolean(expected) }, `${integration ? `merged origin/${base} into ${branch}` : `rebased onto origin/${base}`}${context ? ` ${context}` : ''} (${sync.head.slice(0, 7)}${expected ? (integration ? ', pushed' : ', pushed with --force-with-lease') : ''})${sync.note ? `; ${sync.note}` : ''}`);
    return { kind: 'synced', base, baseSha, head: sync.head, pushed: Boolean(expected), integration };
  }

  /** Why this item cannot be given a fresh conversation, in words; undefined when it can. */
  private freshRefusal(fm: { id: string; status: Status; worktree?: string }, message?: string): string | undefined {
    const phase = this.phaseFor(fm.status);
    if (!message?.trim()) return 'a fresh session needs a message: it is the task in its brief, and the new conversation knows nothing else of what to do';
    if (phase !== 'implement' && phase !== 'fix') return `${fm.id} is ${fm.status}: a fresh session is for work in progress or in review. A planning conversation is the basis of its plan and is resumed`;
    if (!fm.worktree) return `${fm.id} has no worktree for a fresh session to work in`;
    return undefined;
  }

  /** User-driven unblock: clears the flag and, if the item is in a session phase, resumes with a message. With `fresh`, in a new conversation that gets a brief. */
  async unblock(id: string, message?: string, by: 'user' | 'orchestrator' = 'user', opts: { fresh?: boolean } = {}): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.taken_over) throw new Error(`${id} is taken over: hand it back instead`);
    const refusal = opts.fresh ? this.freshRefusal(fm, message) : undefined;
    if (refusal) throw new Error(refusal);
    // Without a message there is nothing to tell a session, so "unblock" means "carry on from where
    // it stopped": the same step retry_op takes (open the PR for committed work, re-enter the merge
    // pipeline, requeue a setup that never ran, resume the session). Clearing the flag alone left
    // items idle with nothing driving them (HH-115, HH-125).
    if (!message && fm.blocked && !this.busyWith(id)) {
      const r = await this.retryOp(id, by);
      if (!/^(not possible|nothing to retry|not now)/.test(r)) return;
    }
    const opData = LiveEngine.withoutDirtyCount(fm.op_data);
    this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, ...(opData !== fm.op_data ? [{ set: { op_data: opData } } as ItemOp] : []), { activity: { actor: by, text: `unblocked${message ? `: ${message}` : ''}` } }], by, { commit: `${id}: unblock${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    const phase = this.phaseFor(fm.status);
    // The message is an instruction that stands on its own, so the engine may give it to a fresh conversation (#64); `fresh` asks for one.
    if (message && phase) this.queueFollowUp(id, () => this.runTurnFor(id, phase, message, [], [], { fresh: opts.fresh ? true : 'auto', note: by === 'orchestrator' ? 'the orchestrator' : 'a decision from the user' }));
    // p50: a merged item that stopped in cleanup (a worktree removal failed) retries it now, the path reconcile takes
    // five minutes later; with a message, or a retry that declined, clearing the flag alone left it MERGED until then.
    else if (fm.status === 'MERGED') this.runJob(id, () => this.cleanup(id));
    else void this.tick();
  }

  private async deliveredBy(id: string): Promise<ReviewImage[] | undefined> {
    const refs = this.reviewRefs(id);
    if (!refs) return undefined;
    const files = (await this.ports.git.changedFiles(refs.cwd, refs.base, refs.head)).slice(0, 200);
    return Promise.all(files.map(async (f) => ({ ...f, ...(f.change !== 'deleted' && /\.png$/i.test(f.path) ? pngSize(await this.ports.git.readBlob(refs.cwd, refs.head, f.path)) : {}) })));
  }

  /**
   * Who will carry the plan out, said in code rather than in plan-item (data dirs keep their own
   * copies of it): a planner writing for an image-generating runner asked how it was meant to draw images
   * itself, and proposed drawing them procedurally (HH-114).
   */
  private withImplementer(id: string, rendered: string): string {
    const fm = this.store.requireItem(id).file.frontmatter;
    const impl = this.store.config.models.find((m) => m.id === fm.implementer);
    if (!impl || fm.kind === 'epic') return rendered;
    const runner = impl.runner ?? 'claude';
    const lines = [`## Who implements this plan`, '', `${impl.label} (\`${impl.id}\`, ${runner} runner) carries out the approved plan, not you.${impl.description ? ` ${impl.description}` : ''}`];
    // Paid tools (#157): the plan states what they will cost in calls, and a person approves that number.
    if (impl.mcp.length) lines.push('', `It has ${impl.mcp.join(', ')} (MCP), and each call there costs money. State in the plan, under a line that starts \`MCP budget:\`, how many ${impl.mcp.join(' / ')} calls the work needs in all, generations and retries included, with a sentence of why. ${impl.user_approves_plans ? 'The user approves that number with the plan; past it the calls are refused.' : 'Past it the calls are refused.'}`);
    if (fm.planner !== fm.implementer) lines.push('', `You are writing the brief it follows. Plan for what ${impl.label} can do${runner === 'claude' ? '' : ', and do not plan to do its work yourself (for example drawing images in code because you cannot generate them)'}: name the files it must produce, the checks that prove them, and anything it must not touch.`);
    return `${rendered}\n\n${lines.join('\n')}`;
  }

  /**
   * How a plain item's planner says "this is an epic", in code rather than in plan-item (data dirs keep
   * their own copies of it): HH-198 and HH-199 were planned as full breakdowns and handed in as plans,
   * approved as items, and each went to one implementer (#69). A child of an epic is not told: epics do not nest.
   */
  private withEpicCheck(id: string, rendered: string): string {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.kind === 'epic' || fm.parent) return rendered;
    return `${rendered}\n\n## If this is really an epic\n\nOne item is one piece of work that one implementer finishes in one pull request. If the request is really several separately shippable pieces (for example images an image model makes plus the code that uses them, or parts that each deserve their own worker and pull request), do not plan it as one item: call \`submit_breakdown\` instead of \`submit_plan\`, with \`plan\` (the approach and the seams between the pieces) and \`children\` (each \`{ "title", "description", "implementer", "depends_on": [indexes] }\`). Implementers:\n${this.implementersList()}\n\nplanestro records it as this item's plan, marked as an epic, and the user converts the item to an epic; your breakdown becomes the request its epic planner starts from. Then end your turn.`;
  }

  /** The models a breakdown can route children to, with what each is for. */
  private implementersList(): string {
    return this.store.config.models.filter((m) => !m.external).map((m) => `- \`${m.id}\` — ${m.label} (runner ${m.runner ?? 'claude'}): ${m.description ?? (canPlan(m) ? 'general software work: code, tests, docs. Cannot generate images.' : 'no description configured')}`).join('\n');
  }

  /** A project whose copy of a template predates `{{dependencies.delivered}}` still gets the facts, appended. */
  private withDelivered(id: string, template: string, rendered: string): string {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (!fm.depends_on.length || (this.store.getPrompt(template)?.file.body ?? '{{dependencies.delivered}}').includes('dependencies.delivered')) return rendered;
    return `${rendered}\n\n## Delivered by the items this one waited on\n\n${this.store.deliveredText(fm.depends_on)}`;
  }

  // ---- review: what did the branch make? Answered from git alone; no model is asked.
  private reviewRefs(id: string): { cwd: string; base: string; head: string } | undefined {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const base = this.store.derived(item).base_branch;
    if (!fm.branch || !base || fm.status === 'FINISHED') return undefined;
    return { cwd: fm.worktree ? this.absWorktree(fm.worktree) : this.repo, base: `origin/${base}`, head: fm.branch };
  }

  /** One file over `review.max_file_bytes` stops the item before a pull request carries it anywhere. */
  private async blockOversize(id: string): Promise<boolean> {
    const refs = this.reviewRefs(id);
    if (!refs) return false;
    const { max_file_bytes, max_file_bytes_by_ext } = this.store.config.review;
    const mb = (n: number) => `${Math.round(n / 1e6 * 10) / 10} MB`;
    // The limit for a file: its extension's (".ogg" or "ogg" in config), else the project-wide one.
    const limitFor = (path: string): { bytes: number; key: string } => {
      const ext = extname(path).toLowerCase();
      const hit = Object.entries(max_file_bytes_by_ext).find(([k]) => (k.startsWith('.') ? k : `.${k}`).toLowerCase() === ext);
      return hit ? { bytes: hit[1], key: `review.max_file_bytes_by_ext["${hit[0]}"]` } : { bytes: max_file_bytes, key: 'review.max_file_bytes' };
    };
    const big = (await this.ports.git.changedFiles(refs.cwd, refs.base, refs.head).catch(() => [])).filter((f) => (f.bytes ?? 0) > limitFor(f.path).bytes);
    if (!big.length) return false;
    this.block(id, 'asset_too_large', `${big.map((f) => { const l = limitFor(f.path); return `${f.path} (${mb(f.bytes ?? 0)}) exceeds ${l.key} (${mb(l.bytes)})`; }).join('; ')}; shrink it, or raise that limit (a per-extension one in review.max_file_bytes_by_ext for a kind of file that is legitimately big) and unblock`);
    return true;
  }

  /** By item, the list for one head and base: the page and every picture on it ask, and a branch with 23 files took seconds each time. */
  private reviewCache = new Map<string, { key: string; files: Promise<ReviewImage[]> }>();
  async reviewImages(id: string): Promise<ReviewImage[]> {
    const refs = this.reviewRefs(id);
    if (!refs) return [];
    const [head, base] = await Promise.all([this.ports.git.revParse(refs.cwd, refs.head).catch(() => ''), this.ports.git.revParse(refs.cwd, refs.base).catch(() => '')]);
    const key = `${head}:${base}`;
    const hit = head && base ? this.reviewCache.get(id) : undefined;
    if (hit?.key === key) return hit.files;
    const files = (async () => {
      const changed = (await this.ports.git.changedFiles(refs.cwd, refs.base, refs.head).catch(() => [])).filter((f) => reviewKind(f.path));
      return Promise.all(changed.map(async (f) => ({ ...f, kind: reviewKind(f.path)!, ...(f.change !== 'deleted' && /\.png$/i.test(f.path) ? pngSize(await this.ports.git.readBlob(refs.cwd, refs.head, f.path)) : {}) })));
    })();
    if (head && base) { this.reviewCache.set(id, { key, files }); files.catch(() => this.reviewCache.delete(id)); }
    return files;
  }

  /** Only files the branch actually changed can be read through here. */
  async reviewImage(id: string, path: string, side: 'before' | 'after'): Promise<Buffer | null> {
    const refs = this.reviewRefs(id);
    if (!refs || !(await this.reviewImages(id)).some((f) => f.path === path)) return null;
    if (side === 'after') return this.ports.git.readBlob(refs.cwd, refs.head, path);
    const mb = await this.ports.git.mergeBase(refs.cwd, refs.base, refs.head);
    return mb ? this.ports.git.readBlob(refs.cwd, mb, path) : null;
  }

  /** Send a reviewed item back to the session that made it. The hold stays: the revision comes back for review. */
  async requestReviewChanges(id: string, note: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.status !== 'IN_REVIEW' || fm.awaiting !== 'review') throw new Error(`${id} is not waiting for a review`);
    if (fm.taken_over) throw new Error(`${id} is taken over: hand it back first`);
    if (!note.trim()) throw new Error('say what should change');
    this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { set: { op_data: { ...(fm.op_data ?? {}), review_nudged: false } } }, { activity: { actor: 'user', text: `review: changes requested: ${note.trim()}` } }], 'user', { commit: `${id}: request review changes` });
    this.runJob(id, () => this.runTurnFor(id, 'fix', `The user reviewed what you delivered and asks for changes:\n\n${note.trim()}\n\nRevise it in your worktree, commit on your branch, leave the tree clean, and finish as before. It will come back to the user for another look.`, [], [], { fresh: 'auto', note: 'your review' }));
  }

  /**
   * Why a pull request into `base` opens held (review.hold_into), or nothing. LM-2's epic PR into main, which deploys to
   * production, merged five minutes after it opened: the project's rule was to hold it for a playtest, and nothing had.
   */
  private holdIntoReason(base: string, alreadyHeld?: boolean): string | undefined {
    if (alreadyHeld || !this.store.config.review.hold_into.includes(base)) return undefined;
    return `a pull request into ${base}: held for you before it merges (review.hold_into)`;
  }

  /** The one way a hold is put on an item (#97): out of the merge queue, with the reason on the item and in its log. */
  private holdOps(reason: string, by: 'user' | 'orchestrator' | 'worker' | 'app'): ItemOp[] {
    const why = reason.trim().replace(/\s+/g, ' ').slice(0, 300);
    return [{ set: { skip_merge: true, hold_reason: why } }, { activity: { actor: by, text: `held out of the merge queue: ${why}` } }];
  }

  private orchestratorHolds(id: string, reason: string): string {
    this.store.requireItem(id);
    if (!reason?.trim()) return 'not held: say why, the reason is shown on the item';
    this.store.mutateItem(id, this.holdOps(reason, 'orchestrator'), 'orchestrator', { commit: `${id}: skip merge` });
    return 'held';
  }

  /**
   * What the implementer is told about a hold, in code rather than in implement-plan (data dirs keep
   * their own copies of it): it does the work as usual and never waits for the hold itself.
   */
  private withHoldNote(id: string, rendered: string): string {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.skip_merge) return `${rendered}\n\n## Merge hold\n\nThis item's pull request is held out of the merge queue${fm.hold_reason ? `: ${fm.hold_reason}` : ''}. Do the work and report it done as usual: planestro opens the pull request, shows its CI, and does not merge it until the user releases the hold. Do not wait for anything yourself; there is no need to pass \`hold\`.`;
    const stated = fm.op_data?.hold_waived ? holdShapeOf(getSection(item.file, 'Plan')) : null;
    if (stated) return `${rendered}\n\n## Merge hold\n\nThe plan says "${stated.quote}" The user approved it without that hold: the pull request merges as usual, so do not ask for a hold when you report the work done.`;
    return rendered;
  }

  /**
   * Let a held pull request merge: a review hold the user has now approved, or a plain `skip_merge`.
   * The item goes back through the merge pipeline rather than straight to the merge — the base may
   * have moved while it waited. A green run is kept only on evidence that it still describes what
   * would merge (dogfood p15: releases reset it to pending by reflex); anything else is asked again.
   */
  /** The PR head's changed paths against its base (three-dot), with that head: what a review approves. */
  private async changedPaths(id: string): Promise<{ sha: string; paths: string[] } | undefined> {
    const item = this.store.requireItem(id); const fm = item.file.frontmatter; const base = this.store.derived(item).base_branch;
    if (!fm.worktree || !base || !fm.branch) return undefined;
    const cwd = this.absWorktree(fm.worktree);
    const sha = (await this.ports.git.remoteBranchSha(this.repo, fm.branch)) ?? await this.ports.git.revParse(cwd, 'HEAD');
    const paths = (await this.ports.git.changedFiles(cwd, `origin/${base}`, sha)).map((f) => f.path).sort();
    return { sha, paths };
  }

  /** The orchestrator released a hold: an approved set the item had now covers its head, so the same paths are not held twice. */
  private async acceptScope(id: string): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (!fm.op_data?.approved_scope) return '';
    const now = await this.changedPaths(id).catch(() => undefined);
    if (!now) return '';
    this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), approved_scope: now } } }], 'orchestrator');
    return `its approved change is now ${now.paths.length} path${now.paths.length === 1 ? '' : 's'} at ${now.sha.slice(0, 7)}`;
  }

  /** Paths the head about to merge changes that the approved head did not (#74), or none: a CI fix turn or an engine commit after approval. */
  private async outsideApprovedScope(id: string, sha: string): Promise<string[]> {
    const approved = this.store.requireItem(id).file.frontmatter.op_data?.approved_scope as { sha?: string; paths?: string[] } | undefined;
    if (!approved?.paths || approved.sha === sha) return [];
    const now = await this.changedPaths(id).catch(() => undefined);
    if (!now) return [];
    const ok = new Set(approved.paths);
    return now.paths.filter((p) => !ok.has(p));
  }

  async releaseHold(id: string, note?: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    // A hold put on at approval, or by the worker, before there is a pull request to let through: it is simply dropped (#97).
    if (fm.status === 'IN_PROGRESS' && fm.skip_merge) {
      this.store.mutateItem(id, [{ unset: ['skip_merge'] }, { set: { op_data: { ...(fm.op_data ?? {}), hold_waived: true } } }, { activity: { actor: 'user', text: `hold dropped: its pull request will merge as usual${note?.trim() ? `: ${note.trim()}` : ''}` } }], 'user', { commit: `${id}: release hold` });
      return;
    }
    if (fm.status !== 'IN_REVIEW') throw new Error(`${id} is ${fm.status}; only an item in review can be released to merge`);
    if (!fm.review_hold && !fm.skip_merge) throw new Error(`${id} is not held`);
    if (fm.awaiting && fm.awaiting !== 'review') throw new Error(`${id} is awaiting ${fm.awaiting}; answer that first`);
    const keep = fm.ci_result === 'green' && await this.greenStillCurrent(id).catch(() => false);
    // What was approved (#74, HH-214): the reviewed head's changed paths. A later commit outside them is held before it
    // merges (outsideApprovedScope); releasing that hold approves the new set. Only an item that waited for review has one.
    const scope = fm.review_hold || fm.op_data?.approved_scope ? await this.changedPaths(id).catch(() => undefined) : undefined;
    this.store.mutateItem(id, [
      { unset: ['review_hold', 'skip_merge', ...(fm.awaiting === 'review' ? ['awaiting', 'awaiting_data'] : [])] },
      ...(keep ? [] : [{ set: { ci_result: 'pending' as const } }]),
      { set: { op_data: { ...(fm.op_data ?? {}), hold_waived: true, ...(scope ? { approved_scope: scope } : {}) } } },
      { activity: { actor: 'user', text: `approved for merge${note?.trim() ? `: ${note.trim()}` : ''}` } },
      ...(keep ? [{ activity: { actor: 'app' as const, text: `CI stays green: ${fm.ci_head_sha!.slice(0, 7)} is still the PR's head and on its base's tip, so it merges without a new run` } }] : []),
    ], 'user', { commit: `${id}: release hold` });
    void this.tick();
  }

  /** Evidence, not memory: the green head is still the PR branch and the worktree, and it sits on the base tip after a fresh fetch. */
  private async greenStillCurrent(id: string): Promise<boolean> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const base = this.store.derived(item).base_branch;
    if (!fm.ci_head_sha || !fm.branch || !fm.worktree || !base) return false;
    await this.ports.git.fetch(this.repo);
    const cwd = this.absWorktree(fm.worktree);
    const [remote, local, { behind }] = await Promise.all([this.ports.git.remoteBranchSha(this.repo, fm.branch), this.ports.git.revParse(cwd, 'HEAD'), this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD')]);
    return remote === fm.ci_head_sha && local === remote && behind === 0;
  }

  /**
   * User-driven "close as done": the work landed some other way, so the item finishes without a
   * pull request. The worktree and branch are removed only on positive evidence that they hold
   * nothing (invariant 7: a clean tree and no commit ahead of a freshly fetched base); anything
   * else is left in place and named in the Activity log — closing never discards work.
   */
  // ---- discard (#135, HH-286) ----
  /** Why this item cannot be discarded, or null. Only work planestro is doing on a worker item: an epic, an external item and finished work are not. */
  discardRefusal(id: string): string | null {
    const item = this.store.getItem(id);
    if (!item) return `there is no item ${id}`;
    const fm = item.file.frontmatter; const d = this.store.derived(item);
    if (d.flavor === 'epic') return `${id} is an epic: discard its children, or icebox it before it opens`;
    if (d.flavor === 'external') return `${id} is implemented outside planestro: icebox it, or close it as done`;
    // An iceboxed child is discarded to let its epic finish without it: that only takes it off the epic.
    const icedChild = fm.status === 'ICEBOX' && Boolean(fm.parent);
    if (!icedChild && (!findTransition(fm.status, 'ICEBOX', 'user', d.flavor) || fm.status === 'NOT_YET_SUBMITTED')) return `${id} is ${fm.status}; only work in progress (queued through in review), or an iceboxed epic child, is discarded`;
    if (this.jobs.has(id) && !this.turns.has(id)) return `${id} has a step running (${fm.op?.replace(/_/g, ' ') ?? 'an engine step'}); discard it when that ends`;
    return null;
  }

  /** What the Discard dialog shows: its branch, whether that is on the remote and at which tip (the delete is leased to it), and its pull request. */
  async discardPreview(id: string): Promise<{ refusal: string | null; branch?: string; remote_sha: string | null; pr?: number }> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const refusal = this.discardRefusal(id);
    const remote = !refusal && fm.branch ? await this.ports.git.remoteBranchSha(this.repo, fm.branch).catch(() => null) : null;
    return { refusal, ...(fm.branch ? { branch: fm.branch } : {}), remote_sha: remote, ...(fm.pr ? { pr: fm.pr } : {}) };
  }

  /**
   * Discard (#135): the user drops work planestro is doing. A live turn is stopped (and waited for), the pull
   * request closed with the reason, and the item taken off its epic and put in the icebox, so the epic does not
   * wait on it. The branch on the remote is deleted only on the user's word (`deleteBranch`), and only at the
   * tip they were shown (`expectSha`, leased): a commit since then keeps it. The tips go in the Activity log
   * first, so a deleted branch can be restored. Uncommitted files are set aside in .displaced/, never deleted.
   * Without deleteBranch the local worktree and branch go only on positive evidence (invariant 7): a clean tree
   * whose HEAD is what the remote holds. Returns what happened, in words; throws only before anything is changed.
   */
  async discard(id: string, reason: string, opts: { deleteBranch?: boolean; expectSha?: string; from?: string } = {}): Promise<string> {
    const why = reason.trim();
    if (!why) throw new Error('say why it is discarded: it goes on the closed pull request');
    let refusal = this.discardRefusal(id);
    if (refusal) throw new Error(refusal);
    // A live turn is stopped and waited for: nothing is removed under a running session.
    if (this.turns.has(id)) {
      const { ops, said } = this.stopSessionWork(id, 'you discarded this item');
      if (ops.length || said.length) this.store.mutateItem(id, [...ops, { activity: { actor: 'app', text: `discarding: stopped ${said.join(', ')}` } }], 'engine');
      await this.jobs.get(id)?.catch(() => undefined);
      refusal = this.discardRefusal(id);
      if (refusal) throw new Error(refusal);
    }
    let release!: () => void;
    this.jobs.set(id, new Promise<void>((r) => { release = r; }));
    try {
      const fm = this.store.requireItem(id).file.frontmatter;
      const said: string[] = [];
      const brief = (e: unknown) => (e as Error).message.replace(/\s+/g, ' ').slice(0, 200);
      if (fm.pr) {
        const pr = await this.ports.gh.prView(this.github, fm.pr);
        if (pr.state === 'MERGED') throw new Error(`its pull request #${fm.pr} has merged: it is not discarded`);
        if (pr.state === 'OPEN') { await this.ports.gh.closePr(this.github, fm.pr, `Discarded in planestro: ${why}`); said.push(`closed pull request #${fm.pr}`); }
        else said.push(`pull request #${fm.pr} was already closed`);
      }
      const { ops } = this.stopSessionWork(id, 'you discarded this item');
      const unset = ['blocked', 'blocked_reason', 'parent', 'resume_after'];
      let removed = false;
      if (fm.worktree && fm.branch) {
        const cwd = this.absWorktree(fm.worktree); const branch = fm.branch;
        const remote = await this.ports.git.remoteBranchSha(this.repo, branch).catch(() => null);
        const head = await this.ports.git.revParse(cwd, 'HEAD').catch(() => null);
        if (opts.deleteBranch && remote) {
          if (opts.expectSha && remote !== opts.expectSha) said.push(`kept branch ${branch}: it moved to ${remote.slice(0, 7)} after you looked (${opts.expectSha.slice(0, 7)}), and nothing on it was deleted`);
          else {
            // The tips first: a deleted branch is restored from these (GitHub's "Restore branch", or git push origin <sha>:refs/heads/<branch>).
            this.store.mutateItem(id, [{ activity: { actor: 'app', text: `deleting branch ${branch}: remote tip ${remote}${head && head !== remote ? `, local tip ${head}` : ''}` } }], 'engine');
            const r = await this.ports.git.deleteRemoteBranchAt(this.repo, branch, remote);
            if (r === 'moved') said.push(`kept branch ${branch}: it moved on the remote while it was being deleted`);
            else {
              said.push(r === 'deleted' ? `deleted branch ${branch} on the remote (tip ${remote.slice(0, 7)})` : `branch ${branch} was already gone from the remote`);
              try {
                const w = await this.worktreeDirt(cwd); const dirty = [...w.dirty, ...w.byproducts];
                const aside = dirty.length ? join(this.store.worktreesRoot(), '.displaced', `${branch.replace(/[\/\\]/g, '-')}-${this.now().replace(/[:+]/g, '-')}`) : undefined;
                if (aside) { await this.ports.git.moveAside(cwd, dirty, aside); said.push(`set ${dirty.length} uncommitted file${dirty.length === 1 ? '' : 's'} aside in ${relative(this.repo, aside)}`); }
                await this.ports.git.worktreeRemove(this.repo, cwd, true);
                await this.ports.git.worktreePrune(this.repo);
                await this.ports.git.deleteLocalBranch(this.repo, branch);
                removed = true; said.push('removed its worktree and local branch');
              } catch (e) { said.push(`removing its worktree stopped partway (${brief(e)}); finish it by hand`); }
            }
          }
        } else {
          const clean = await this.worktreeDirt(cwd).then((w) => w.clean).catch(() => false);
          if (!remote) said.push(`kept its worktree and branch ${branch}: the branch is not on the remote, so they are the only copy`);
          else if (!clean) said.push(`kept its worktree and branch ${branch}: it has uncommitted changes`);
          else if (head !== remote) said.push(`kept its worktree and branch ${branch}: its local commits are not all on the remote`);
          else {
            try { await this.ports.git.worktreeRemove(this.repo, cwd, false); await this.ports.git.worktreePrune(this.repo); await this.ports.git.deleteLocalBranch(this.repo, branch); removed = true; said.push(`removed its worktree and local branch (everything is on the remote branch ${branch}, which is kept)`); }
            catch (e) { said.push(`removing its worktree stopped partway (${brief(e)}); finish it by hand`); }
          }
        }
      }
      if (removed) unset.push('worktree', 'branch', 'session_id', 'session_context', 'pr', 'ci_result');
      else if (fm.pr) unset.push('pr', 'ci_result');
      const from = fm.parent;
      this.store.mutateItem(id, [
        ...ops,
        ...(fm.status === 'ICEBOX' ? [] : [{ transition: { to: 'ICEBOX', actor: 'user' } } as ItemOp]),
        { unset },
        { activity: { actor: 'user', text: `discarded${opts.from ? ` by ${opts.from}` : ''}: ${why}` } },
        { activity: { actor: 'app', text: [...(from ? [`taken off epic ${from}`] : []), ...said].join('; ') || 'nothing else to undo' } },
      ], 'user', { commit: `${id}: discard` });
      if (from && this.store.getItem(from)) this.store.mutateItem(from, [{ activity: { actor: 'app', text: `${id} discarded: ${why}. It is no longer one of this epic's children.` } }], 'engine', { commit: `${from}: ${id} discarded` });
      this.note('info', `${id}: discarded`);
      return [`${id} discarded`, ...(from ? [`taken off epic ${from}`] : []), ...said].join('; ');
    } finally { this.jobs.delete(id); release(); void this.tick(); }
  }

  /** Why this item cannot be closed as done, or null: what closeAsDone would throw. A card option that closes it is checked with it (#126). */
  closeAsDoneRefusal(id: string): string | null {
    const item = this.store.getItem(id);
    if (!item) return `there is no item ${id}`;
    const fm = item.file.frontmatter;
    if (!findTransition(fm.status, 'FINISHED', 'user', this.store.derived(item).flavor)) return `${id} is ${fm.status}; it cannot be closed as done from there`;
    if (fm.pr) return `${id} has pull request #${fm.pr}; merge or close that instead`;
    if (this.turns.has(id) || this.jobs.has(id)) return `${id} has a step running; wait for it to park, then close it`;
    return null;
  }

  async closeAsDone(id: string, reason?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    const refusal = this.closeAsDoneRefusal(id);
    if (refusal) throw new Error(refusal);
    const left = d.flavor === 'worker' && fm.worktree && fm.branch ? await this.releaseUnusedWorktree(this.absWorktree(fm.worktree), fm.branch, d.base_branch) : undefined;
    this.store.mutateItem(id, [
      { transition: { to: 'FINISHED', actor: 'user' } },
      { activity: { actor: 'user', text: `closed as done without a pull request${reason?.trim() ? `: ${reason.trim()}` : ''}` } },
      ...(left ? [{ activity: { actor: 'app' as const, text: left } }] : []),
    ], 'user', { commit: `${id}: close as done` });
    this.note('info', `${id}: closed as done`);
    void this.tick();
  }

  // ---- item ↔ epic (#69, HH-198) ----
  /**
   * Change an item's kind while nothing has run for implementation (kindConversionRefusal says where).
   * Its description stays; its plan (or an epic's breakdown) moves to Notes, which the other kind's
   * planner reads; its planning checkout is removed only on positive evidence that it holds nothing
   * (invariant 7), and work in it refuses the conversion. What was not yet submitted stays in the
   * backlog; what was, carries on as the new kind: an epic has its breakdown planned (planEpic), an
   * item is queued. Returns what happened, in words.
   */
  async convertKind(id: string, to: 'item' | 'epic', by: 'user' | 'orchestrator' = 'user', why?: string): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const busy = this.turns.has(id) || this.jobs.has(id);
    // A plan review is decided while the planner's turn is still ending (as approvePlan): the conversion waits for that turn.
    const winding = busy && fm.status === 'PLAN_READY';
    const refused = kindConversionRefusal(winding ? { ...fm, op: undefined } : fm, to, this.store.derived(item).children.length);
    if (refused) throw new Error(`not converted: ${refused}`);
    const as = to === 'epic' ? 'an epic' : 'an item';
    if (winding) {
      this.queueFollowUp(id, async () => {
        try { const out = await this.convertHeld(id, to, by, why); if (out.plan) await out.plan(); else this.poke(); }
        catch (e) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: (e as Error).message } }], 'engine'); }
      });
      return `${id} converts to ${as} as soon as its planning turn has ended`;
    }
    if (busy) throw new Error(`not converted: ${id} has a turn or step running; convert it once it has parked`);
    // Held as the item's job while its checkout is checked and removed, so no admission, turn or wake starts on it meanwhile.
    let release!: () => void;
    this.jobs.set(id, new Promise<void>((r) => { release = r; }));
    let out: { said: string; plan?: () => Promise<void> };
    try { out = await this.convertHeld(id, to, by, why); } finally { this.jobs.delete(id); this.followUps.delete(id); this.pendingWakes.delete(id); release(); }
    if (out.plan) this.runJob(id, out.plan); else this.poke();
    return out.said;
  }

  /** The conversion itself, by whoever holds the item's job slot; `plan` is an epic's breakdown turn, to run in that slot. */
  private async convertHeld(id: string, to: 'item' | 'epic', by: 'user' | 'orchestrator', why?: string): Promise<{ said: string; plan?: () => Promise<void> }> {
    const item = this.store.requireItem(id);
    const refused = kindConversionRefusal(item.file.frontmatter, to, this.store.derived(item).children.length);
    if (refused) throw new Error(`not converted: ${refused}`);
    const out = await this.convertNow(id, to, by, why);
    const plan = out.next === 'plan' ? this.beginEpicPlan(id, 'converted to an epic, so its planner breaks it down') : undefined;
    if (out.next === 'queue') this.store.transition(id, 'QUEUED', by);
    const said = `${out.said}${plan ? '; its breakdown is being planned' : out.next === 'queue' ? '; queued to be planned as one item' : ''}`;
    this.note('info', said);
    return { said, plan };
  }

  private async convertNow(id: string, to: 'item' | 'epic', by: 'user' | 'orchestrator', why?: string): Promise<{ said: string; next?: 'plan' | 'queue' }> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const was = fm.kind ?? 'item';
    let released: string | undefined;
    if (fm.worktree) {
      const cwd = this.absWorktree(fm.worktree);
      if (was === 'epic') {
        // An epic's planning checkout is detached and was only ever read: a clean tree is the whole proof (as approveBreakdown).
        const st = await this.ports.git.status(cwd).catch(() => undefined);
        if (st && !st.clean) throw new Error(`not converted: the breakdown's planning checkout ${fm.worktree} has uncommitted changes`);
        if (st) { await this.ports.git.worktreeRemove(this.repo, cwd, false); await this.ports.git.worktreePrune(this.repo); released = `removed the breakdown's read-only planning checkout ${fm.worktree}`; }
      } else if (fm.branch) {
        const unused = await this.unusedWorktree(cwd, fm.branch, this.store.derived(item).base_branch);
        if ('keep' in unused) throw new Error(`not converted: ${id}'s worktree ${fm.worktree} may hold work (${unused.keep}), and nothing with work in it is removed. Clear it by hand first, or keep it as an item`);
        released = await this.removeUnusedWorktree(cwd, fm.branch, this.store.derived(item).base_branch!, unused.remote);
      }
    }
    // The text crosses over: the new kind's planner reads Notes (plan-item and plan-epic both quote them).
    const plan = getSection(item.file, 'Plan').trim();
    const proposed = (was === 'epic' ? fm.awaiting_data?.children : epicFlagOf(fm)?.children) as ProposedChild[] | undefined;
    const carried = plan || proposed?.length ? [
      `### ${was === 'epic' ? 'Breakdown proposed while this was an epic' : 'Plan written while this was one item'} (converted ${this.now().slice(0, 10)})`, '',
      to === 'epic' ? 'Its planner planned this request as one item. Start the breakdown from it: keep what holds, and split the work into children.' : 'The epic planner proposed this before it became one item. Plan it as one piece of work; the children only show how the work divides.',
      ...(plan ? ['', plan] : []),
      ...(proposed?.length ? ['', 'Children proposed:', ...proposed.map((c, i) => `- ${i}: **${c.title}**${c.implementer ? ` (${c.implementer})` : ''}${c.depends_on?.length ? `, after ${c.depends_on.join(', ')}` : ''}${c.description ? ` — ${c.description}` : ''}`)] : []),
    ].join('\n') : '';
    const notes = getSection(item.file, 'Notes').trim();
    const reset = fm.status !== 'NOT_YET_SUBMITTED' && fm.status !== 'ICEBOX';
    const a = (text: string, actor: 'user' | 'orchestrator' | 'app' = by): ItemOp => ({ activity: { actor, text } });
    this.store.mutateItem(id, [
      // Not a lifecycle transition: the item starts over as the other kind, from the backlog (or stays in the icebox).
      { set: { kind: to, ...(reset ? { status: 'NOT_YET_SUBMITTED' as const } : {}) } },
      // What belonged to the other kind's planning goes with it; the new planner starts a conversation of its own.
      { unset: ['worktree', 'branch', 'session_id', 'agent_sessions', 'op', 'op_started_at', 'op_data', 'awaiting', 'awaiting_data', 'triage', 'blocked', 'blocked_reason', 'resume_after', 'plan_revisions', 'skip_merge', 'hold_reason'] },
      ...(carried ? [{ section: 'Notes', body: notes ? `${notes}\n\n${carried}` : carried }, { section: 'Plan', body: '' }] : []),
      ...(reset ? [a(`status ${fm.status} → NOT_YET_SUBMITTED`)] : []),
      a(`converted to ${to === 'epic' ? 'an epic' : 'an item'}${why?.trim() ? `: ${why.trim()}` : ''}${carried ? `. The ${was === 'epic' ? 'breakdown' : 'plan'} is kept in Notes for its new planner` : ''}`),
      ...(released ? [a(released, 'app')] : []),
    ], by, { commit: `${id}: convert to ${to}` });
    const said = `${id} converted to ${to === 'epic' ? 'an epic' : 'an item'}${released ? ` (${released})` : ''}`;
    if (!reset) return { said };
    if (to === 'epic') return { said, next: 'plan' };
    const d = this.store.derived(this.store.requireItem(id));
    if (d.flavor === 'worker' && d.deps_satisfied && !d.base_branch_error) return { said, next: 'queue' };
    return { said: `${said}; left in the backlog (${d.flavor !== 'worker' ? 'an external item is not planned' : d.base_branch_error ?? 'its dependencies are not merged yet'})` };
  }

  // ---- take-over: a person finishes the item by hand (dogfood p28) ----
  /**
   * Everything that would drive this item's session, stopped: the live turn is aborted through its
   * own controller (its runTurnFor ends as `killed`, so nothing is left waiting on anyone), and the
   * turn queued behind it, a triage wake held for it, queued messages, a one-shot resume, a parked
   * request of the session's and triage are dropped. Returns the ops that clear what is persisted,
   * and what was stopped, in words.
   */
  private stopSessionWork(id: string, why: string): { ops: ItemOp[]; said: string[] } {
    const fm = this.store.requireItem(id).file.frontmatter;
    const said: string[] = [];
    const turn = this.turns.get(id);
    if (turn) { this.stoppedFor.set(id, why); turn.abort.abort(); said.push(`its ${turn.phase} turn`); }
    if (this.followUps.delete(id)) said.push('the turn queued behind it');
    if (this.pendingWakes.delete(id)) said.push('an orchestrator wake');
    this.idleSince.delete(id);
    const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
    if (pending.length) said.push(`${pending.length} queued message${pending.length === 1 ? '' : 's'}`);
    if (fm.resume_after) said.push(`the resume after ${waitsFor(fm.resume_after)}`);
    const parked = fm.awaiting === 'permission' || fm.awaiting === 'question' || (fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission');
    if (parked) said.push(`its parked ${fm.awaiting === 'question' ? 'question' : 'permission request'}`);
    if (fm.triage) said.push('triage');
    const unset = [...(fm.resume_after ? ['resume_after'] : []), ...(fm.triage ? ['triage'] : []), ...(parked ? ['awaiting', 'awaiting_data'] : [])];
    return { said, ops: [
      ...(pending.length ? [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: [] } } } as ItemOp] : []),
      ...(unset.length ? [{ unset } as ItemOp] : []),
    ] };
  }

  /**
   * "I'm taking this over": the person finishes the item by hand. Its session is stopped and what was
   * queued for it dropped (stopSessionWork); a block, a decision card or a review wait is theirs now
   * and is cleared with it, and a plan waiting for approval stays waiting. Until handBack nothing
   * automatic drives it: no admission, turn, orchestrator wake, stall, triage, fix turn or merge.
   * Its CI is still read. User-only: the orchestrator's tools refuse the item instead.
   */
  async takeOver(id: string, note?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) throw new Error(`${id} is already yours`);
    if (this.store.derived(item).flavor !== 'worker' || !['QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'].includes(fm.status)) throw new Error(`${id} is ${fm.status}; only a worker item planestro is driving can be taken over`);
    const { ops, said } = this.stopSessionWork(id, 'you took this item over');
    const theirs = fm.awaiting === 'user' || fm.awaiting === 'review';
    if (fm.blocked) said.push(`its block (${fm.blocked_reason ?? 'blocked'})`);
    if (fm.op_data?.needs_session_rebase) said.push('the conflict handed to its session');
    this.store.mutateItem(id, [
      ...ops,
      { set: { taken_over: { since: this.now(), ...(note?.trim() ? { note: note.trim() } : {}) } } },
      ...(fm.blocked || theirs ? [{ unset: ['blocked', 'blocked_reason', ...(theirs ? ['awaiting', 'awaiting_data'] : [])] } as ItemOp] : []),
      // A plan the orchestrator was reviewing is the person's to approve while they have the item; the hand-back delegates it again.
      ...(fm.status === 'PLAN_READY' && fm.awaiting === 'orchestrator' ? [{ set: { awaiting: 'plan_approval' } } as ItemOp] : []),
      { activity: { actor: 'user', text: `took this item over by hand${note?.trim() ? `: ${note.trim()}` : ''}${said.length ? `; stopped ${said.join(', ')}` : ''}. Nothing automatic drives it until you hand it back.` } },
    ], 'user', { commit: `${id}: take over` });
    this.heldPolledAt.delete(id);
    this.note('info', `${id}: taken over by hand${said.length ? ` (stopped ${said.join(', ')})` : ''}`);
  }

  /**
   * The person is done with it. planestro carries on from the item as it is now (invariant 3), by
   * the doors it already has: an item in review re-enters the merge pipeline (its CI is asked for
   * again, for whatever head it now has); work planning or in progress takes the stall check, so a
   * clean worktree ahead of its base goes to a pull request and anything else resumes the session,
   * told that someone else had the worktree; a merged one is cleaned up on positive evidence.
   */
  async handBack(id: string, note?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (!fm.taken_over) throw new Error(`${id} is not taken over`);
    const said = note?.trim() ? `: ${note.trim()}` : '';
    const inReview = fm.status === 'IN_REVIEW' && Boolean(fm.pr);
    const carryOn = ['PLAN_IN_PROGRESS', 'IN_PROGRESS'].includes(fm.status) && Boolean(fm.worktree);
    const next = inReview ? 'it re-enters the merge pipeline' : carryOn ? 'planestro carries on from where the work stands' : fm.status === 'MERGED' ? 'its merged branch is cleaned up' : 'planestro drives it again';
    const opData = LiveEngine.withoutDirtyCount(fm.op_data);
    this.store.mutateItem(id, [
      { unset: ['taken_over'] },
      ...(opData !== fm.op_data ? [{ set: { op_data: opData } } as ItemOp] : []),
      ...(inReview ? [{ set: { ci_result: 'pending', op_data: { ...(opData ?? {}), needs_session_rebase: false } } } as ItemOp] : []),
      { activity: { actor: 'user', text: `handed back to planestro${said}; ${next}` } },
    ], 'user', { commit: `${id}: hand back` });
    // queued, not dropped: the turn the take-over stopped may still be winding down
    if (fm.status === 'MERGED') this.queueFollowUp(id, () => this.cleanup(id));
    else if (carryOn) this.queueFollowUp(id, () => this.carryOnStalled(id, { why: 'handed back', who: 'the user handing the item back', say: `The user took this item over and worked on it by hand, and has now handed it back to you${said}. Your worktree may have changed while they had it: check \`git status\` and \`git log\` first, then continue from where the work stands.` }));
    else void this.tick();
  }

  /**
   * The user moved the item into review by hand (they opened its pull request themselves): its
   * session's work is over, so a live turn is stopped and what was queued for it dropped, as a
   * take-over does. Left running, HH-136's worker hit the person's half-made edits and blocked an
   * item that was by then in review with its PR (dogfood p28).
   */
  stopForReview(id: string): void {
    const { ops, said } = this.stopSessionWork(id, 'the item was moved into review by hand');
    if (!said.length) return;
    this.store.mutateItem(id, [...ops, { activity: { actor: 'app', text: `moved into review by hand: stopped ${said.join(', ')}` } }], 'engine', { commit: `${id}: stop the session (moved to review)` });
  }

  /** Returns the Activity line describing what was removed, or what was left in place and why. */
  private async releaseUnusedWorktree(cwd: string, branch: string, base: string | undefined): Promise<string> {
    const unused = await this.unusedWorktree(cwd, branch, base);
    return 'keep' in unused ? `left worktree ${cwd} and branch ${branch} in place: ${unused.keep}` : this.removeUnusedWorktree(cwd, branch, base!, unused.remote);
  }

  /** Positive evidence that a worktree and its branch hold no work (invariant 7): a clean tree and nothing ahead of a freshly fetched base. Otherwise why not. */
  private async unusedWorktree(cwd: string, branch: string, base: string | undefined): Promise<{ keep: string } | { remote: string | null }> {
    if (!base) return { keep: 'the base branch could not be resolved' };
    try {
      const { clean, dirty } = await this.worktreeDirt(cwd);
      if (!clean) return { keep: `uncommitted changes (${dirty.slice(0, 5).join(', ')})` };
      await this.ports.git.fetch(this.repo);
      const { ahead } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
      if (ahead > 0) return { keep: `${ahead} commit(s) are not on origin/${base}` };
      const remote = await this.ports.git.remoteBranchSha(this.repo, branch);
      if (remote && !await this.ports.git.isAncestor(this.repo, remote, `origin/${base}`)) return { keep: `the pushed branch has commits that are not on origin/${base}` };
      return { remote };
    } catch (e) { return { keep: `could not verify it is unused (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)})` }; }
  }

  private async removeUnusedWorktree(cwd: string, branch: string, base: string, remote: string | null): Promise<string> {
    const brief = (e: unknown) => (e as Error).message.replace(/\s+/g, ' ').slice(0, 200);
    let kept: string | undefined;
    try {
      kept = await this.setAsideBeforeRemove(branch.replace(/[\/\\]/g, '-'), cwd);
      await this.ports.git.worktreeRemove(this.repo, cwd, false);
      await this.ports.git.worktreePrune(this.repo);
      await this.ports.git.deleteLocalBranch(this.repo, branch);
      if (remote) await this.ports.git.deleteRemoteBranch(this.repo, branch);
    } catch (e) { return `removing the unused worktree ${cwd} / branch ${branch} stopped partway (${brief(e)}); finish it by hand`; }
    return `removed unused worktree and branch ${branch} (clean, nothing ahead of origin/${base})${kept ? `; ${kept}` : ''}`;
  }

  /**
   * `concurrency.max_sessions` bounds agent turns actually running, whatever started them (p51). admit()
   * counts it only when it starts a QUEUED item; a stall carry-on, an unblock, a plan approval or a review
   * follow-up resumes an item that is already active and never passed through admit(): HH ran five
   * implement turns against a cap of three. Every turn now wins a session slot before its agent starts,
   * and waits (shown as waiting for a session slot) while all of them are taken.
   */
  private async withSessionSlot<T>(id: string, fn: () => Promise<T>): Promise<T> {
    while (this.sessionTurns >= Math.max(1, this.store.config.concurrency.max_sessions)) {
      const t = this.turns.get(id); if (t) t.waiting = 'session';
      await new Promise<void>((r) => this.sessionWaiters.push(r));
    }
    this.sessionTurns += 1;
    try { return await fn(); } finally { this.sessionTurns -= 1; this.sessionWaiters.shift()?.(); }
  }

  /** `concurrency.runner_limits`: a runner with its own rate limit takes its turns a few at a time; unlisted runners are not limited here. */
  private async withRunnerSlot<T>(runner: string, fn: () => Promise<T>): Promise<T> {
    const limit = () => this.store.config.concurrency.runner_limits?.[runner];
    while (limit() !== undefined && (this.runnerTurns.get(runner) ?? 0) >= limit()!) await new Promise<void>((r) => { const q = this.runnerWaiters.get(runner) ?? []; q.push(r); this.runnerWaiters.set(runner, q); });
    this.runnerTurns.set(runner, (this.runnerTurns.get(runner) ?? 0) + 1);
    try { return await fn(); } finally { this.runnerTurns.set(runner, (this.runnerTurns.get(runner) ?? 1) - 1); this.runnerWaiters.get(runner)?.shift()?.(); }
  }

  /**
   * Setup hooks and local check commands are the heavy processes planestro starts itself (an asset
   * import, a full test suite); `concurrency.max_local_jobs` bounds how many run at once. The limit
   * is read at each acquire, so changing it in Settings applies to the next job.
   */
  private async withLocalJobSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.localJobs >= Math.max(1, this.store.config.concurrency.max_local_jobs)) await new Promise<void>((r) => this.localJobWaiters.push(r));
    this.localJobs += 1;
    try { return await fn(); } finally { this.localJobs -= 1; this.localJobWaiters.shift()?.(); }
  }

  private absWorktree(rel: string): string { return isAbsolute(rel) ? rel : join(this.repo, rel); }

  private note(level: 'info' | 'warn' | 'error', message: string): void {
    const e: ServerEvent = { type: 'engine.log', level, message };
    this.log.push(e); if (this.log.length > 500) this.log.shift();
    this.emit(e);
  }
}
