import { findModel, waitsFor, stepDownDue, limitsLabel, type HostLoad, type ModelDef, type Status } from '@planestro/shared';
import type { DataStore, StoredItem, ItemOp } from '../store/DataStore.ts';
import type { Ports, TurnPhase, CiQueue } from './ports.ts';
import { driveSchedules } from './schedules.ts';
import { recentCi, lastConcurrencyChange, rollbackConcurrency, hostLoad, limitsOf } from '../concurrency.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { Guards } from './guards.ts';
import type { Triage } from './triage.ts';
import type { Epics } from './epics.ts';
import type { MergePipeline } from './mergePipeline.ts';
import type { BaseSync } from './baseSync.ts';
import type { CiWatch } from './ciWatch.ts';
import type { TurnRunner, RunningTurn } from './turnRunner.ts';
import type { TurnQueue } from './turnQueue.ts';

const ACTIVE_FOR_SLOTS: Status[] = ['PLAN_IN_PROGRESS', 'IN_PROGRESS'];

/**
 * Scheduling (#404, seam 10): when things run. The tick (one pass of the drive loops at a time, a tick asked for meanwhile
 * folded into one more pass) and the order of its drivers: triage and the quiet watchdog before the pause check, the
 * guards' backstops, then schedules (#247) before admission. Admission (admit): a session slot per item something drives,
 * held back while CI's queue is at `ci.max_queued_runs` (#170: refreshCiQueue, read off the tick). The drivers that are
 * timing alone: stalls carried on once, then blocked `stalled` (driveStalls); turns quiet for `concurrency.turn_quiet_min`
 * stopped (driveQuietTurns); the retries due later (driveTimedRetries: #241's transient retry, #296's usage reset);
 * resume_after's wait on other items and pull requests (resumeAfter, driveResumeAfter, #136); and the concurrency
 * step-down (driveStepDown, #330). What each driver does to an item is the other parts'; the slots and the job queue are
 * Slots'. LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface SchedulerContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'gh'>;
  /** `owner/repo` of the code repo (throws when code_repo.github is not configured). */
  readonly github: string;
  /** The project's CI workflow, by name: whose queue admission reads. */
  readonly ciWorkflow: string;
  /** Read live: no pass runs, and no further pass is folded in, while the engine stops. */
  readonly stopping: boolean;
  /** Turns this engine started: the quiet watchdog reads their output times and aborts the quiet ones. */
  readonly turns: ReadonlyMap<string, RunningTurn>;
  /** Items with a job in flight and jobs queued behind them: read only (something drives the item). */
  readonly jobs: ReadonlyMap<string, unknown>;
  readonly followUps: ReadonlyMap<string, unknown>;
  /** This machine's load, for the concurrency step-down (#330); tests pin it. */
  readonly opts: { hostLoad?: () => HostLoad | undefined };
  /** The pause, drain and the guards' timers, whose backstops the tick runs. */
  readonly guards: Pick<Guards, 'paused' | 'draining' | 'guardResumeDue' | 'guardResume' | 'modelResumeDue' | 'modelResume' | 'checkDisk'>;
  /** The orchestrator's queued wakes, kicked each pass. */
  readonly orchestrator: Pick<Orchestrator, 'kick'>;
  /** Stops for the orchestrator to triage, and a scheduled item submitted as the user (#247). */
  readonly triage: Pick<Triage, 'driveTriage' | 'submitAsUser'>;
  /** Epics: reopened, driven, and opened when admission starts a child of one not yet submitted. */
  readonly epics: Pick<Epics, 'reopenEpics' | 'driveEpics' | 'openEpic'>;
  readonly mergePipeline: Pick<MergePipeline, 'driveInReview' | 'driveHeld'>;
  readonly baseSync: Pick<BaseSync, 'driveBaseWaits'>;
  readonly ciWatch: Pick<CiWatch, 'driveRunnerStalls' | 'driveReviewStalls'>;
  /** A timed retry someone else already moved is dropped. */
  readonly turnRunner: Pick<TurnRunner, 'dropTransientRetry'>;
  /** The synced resume once what an item waits on has merged. */
  readonly turnQueue: Pick<TurnQueue, 'resumeWaited'>;
  now(): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  block(id: string, reason: string, detail: string): void;
  runJob(id: string, fn: () => Promise<unknown>): void;
  /** Why an item cannot take a step now (a job or a turn running), or undefined. */
  busyWith(id: string): string | undefined;
  phaseFor(status: Status): TurnPhase | null;
  /** Whether the model's usage guard is up on the item's account (#242): its planning is not admitted. */
  guardedFor(fm: { account?: string }, def: ModelDef): boolean;
  startItem(id: string): Promise<void>;
  /** An idle item carried on from where it stands. */
  carryOnStalled(id: string): Promise<void>;
  retryOp(id: string, by: 'engine', message?: string): Promise<string>;
  /** The engine's own drivers the tick runs, in its order. */
  continueAfterProviderSwitch(id: string): void;
  driveEfficiencyAudit(): void;
  drivePendingTurns(): void;
  nudgeStaleReviews(): void;
  driveStaleBlocks(): void;
  drivePlanReviews(): void;
  drivePermissionReviews(): void;
  driveExternal(): Promise<void>;
  /** A limit stepped down in place: the turns waiting for a slot look again. */
  wakeSlotWaiters(): void;
}

export class Scheduler {
  constructor(private readonly ctx: SchedulerContext) {}

  poke(): void { void this.tick(); }

  /** Run one scheduling pass. Idempotent; safe to call often. */
  private ticking?: Promise<void>;
  private tickAgain = false;
  /**
   * One pass of the drive loops at a time. A tick asked for while one runs (the interval, a poke) is folded into one
   * more pass after it, and its caller waits for that pass: overlapping ticks did the same work twice and interleaved.
   * Nothing a pass throws escapes: the interval and every poke call this unawaited.
   */
  tick(): Promise<void> {
    if (this.ticking) { this.tickAgain = true; return this.ticking; }
    this.ticking = (async () => {
      try { do { this.tickAgain = false; await this.tickOnce(); } while (this.tickAgain && !this.ctx.stopping); }
      catch (e) { this.ctx.note('error', `tick: ${(e as Error).message}`); }
      finally { this.ticking = undefined; }
    })();
    return this.ticking;
  }
  private async tickOnce(): Promise<void> {
    if (this.ctx.stopping) return;
    // Before the pause check: while automation is paused the orchestrator is not woken, so nothing may sit in triage.
    if (this.ctx.guards.draining) return;
    try { this.ctx.triage.driveTriage(); } catch (e) { this.ctx.note('error', `triage: ${(e as Error).message}`); }
    // Before the pause check too: a paused engine's running turns still finish, or hang.
    this.driveQuietTurns();
    // A backstop for the guard's timer (a machine that slept through it): resume once the reset has passed.
    const due = this.ctx.guards.guardResumeDue();
    if (due !== undefined && due <= Date.now()) { this.ctx.guards.guardResume(); return; }
    const modelDue = this.ctx.guards.modelResumeDue();
    if (modelDue !== undefined && modelDue <= Date.now()) this.ctx.guards.modelResume();
    // Read off the tick, not awaited in it: an await here let overlapping ticks interleave. A pause it sets holds from the next tick.
    void this.ctx.guards.checkDisk().catch(() => undefined);
    void this.refreshCiQueue().catch(() => undefined);
    if (this.ctx.guards.paused) return;
    try {
      this.ctx.orchestrator.kick();
      // Before admission, so an item a schedule submits starts on this pass.
      driveSchedules(this.ctx.store, new Date(Date.parse(this.ctx.now())), { submit: (id, why) => { this.ctx.triage.submitAsUser(id, why); }, note: (l, m) => this.ctx.note(l, m) });
      this.ctx.driveEfficiencyAudit();
      this.ctx.drivePendingTurns();
      this.driveTimedRetries();
      for (const item of this.ctx.store.listItems()) this.ctx.continueAfterProviderSwitch(item.id);
      this.ctx.epics.reopenEpics();
      this.admit();
      this.ctx.nudgeStaleReviews();
      this.ctx.driveStaleBlocks();
      this.ctx.drivePlanReviews();
      this.ctx.drivePermissionReviews();
      await this.ctx.epics.driveEpics();
      // Its GitHub reads retry for about a minute each: off the pass, one at a time, so the rest of the tick never waits on them.
      if (!this.externalPoll) this.externalPoll = this.ctx.driveExternal().catch((e) => this.ctx.note('error', `external PRs: ${(e as Error).message}`)).finally(() => { this.externalPoll = undefined; });
      this.ctx.mergePipeline.driveInReview();
      this.ctx.mergePipeline.driveHeld();
      this.ctx.baseSync.driveBaseWaits();
      await this.driveStalls();
      void this.ctx.ciWatch.driveRunnerStalls().catch((e) => this.ctx.note('error', `runner stalls: ${(e as Error).message}`));
      this.ctx.ciWatch.driveReviewStalls();
      this.driveResumeAfter();
      this.driveStepDown();
    } catch (e) { this.ctx.note('error', `tick: ${(e as Error).message}`); }
  }

  /**
   * An item holds a session slot while something is driving it: a live turn, an engine step, or an
   * op in flight. An item that only sits in an active status does not (HH-109 idled five days after
   * a messageless unblock and held a slot throughout), and an epic never does: its children do the work.
   */
  private holdsSlot(i: StoredItem): boolean {
    const fm = i.file.frontmatter;
    if (this.ctx.turns.has(i.id)) return true;
    if (fm.kind === 'epic' || !ACTIVE_FOR_SLOTS.includes(fm.status)) return false;
    return this.ctx.jobs.has(i.id) || Boolean(fm.op);
  }

  private admit(): void {
    const items = this.ctx.store.listItems();
    const active = items.filter((i) => this.holdsSlot(i)).length;
    let free = this.ctx.store.config.concurrency.max_sessions - active;
    // Admission control (#170): with CI the bottleneck, a new start only adds a run to the queue. In-flight items carry on.
    const cap = this.ctx.store.config.ci.max_queued_runs;
    // Until the first reading lands (it is read off the tick) nothing is known, so nothing new starts on a guess.
    if (cap > 0 && this.ctx.ports.gh.ciQueue && this.ctx.store.config.code_repo.github && !this.ciQueue && !this.ciQueueUnreadable) return;
    if (cap > 0 && this.ciQueue && this.ciQueue.queued >= cap) {
      if (!this.ciQueueHeld) { this.ciQueueHeld = true; this.ctx.note('info', `holding new starts: ${this.ciQueue.queued} CI runs are queued for a runner (ci.max_queued_runs ${cap})`); }
      return;
    }
    if (this.ciQueueHeld) { this.ciQueueHeld = false; this.ctx.note('info', `CI queue down to ${this.ciQueue?.queued ?? 0}; starting new items again`); }
    for (const item of items) {
      if (free <= 0) break;
      const fm = item.file.frontmatter;
      if (fm.status !== 'QUEUED' || this.ctx.jobs.has(item.id) || fm.taken_over) continue;
      const planner = findModel(this.ctx.store.config, fm.planner);
      if (planner && this.ctx.guardedFor(fm, planner)) continue;
      let d = this.ctx.store.derived(item);
      if (d.flavor !== 'worker' || !d.deps_satisfied) continue;
      if (fm.parent) {
        const parent = this.ctx.store.getItem(fm.parent);
        if (!parent) continue;
        if (parent.file.frontmatter.status === 'NOT_YET_SUBMITTED') { this.ctx.runJob(fm.parent, () => this.ctx.epics.openEpic(fm.parent!)); continue; }
        if (parent.file.frontmatter.status !== 'IN_PROGRESS') continue;
        d = this.ctx.store.derived(item);
      }
      if (!d.base_branch) continue;
      free -= 1;
      this.ctx.runJob(item.id, () => this.ctx.startItem(item.id));
    }
  }

  /**
   * Stall detection (f1). An item planning or in progress with no live turn, no engine step, no op,
   * not waiting on anyone (a person, the orchestrator, or other items to merge: resume_after) and not blocked has nothing driving it. Past `stall_after_min` it is carried
   * on once: committed work goes to its pull request, otherwise the session is resumed (an item that
   * never had a conversation, like HH-123 orphaned between its setup and its first turn, gets the full prompt).
   * A second stall within the hour is not retried again: it blocks as `stalled` for triage.
   */
  idleSince = new Map<string, number>();
  private async driveStalls(): Promise<void> {
    const after = this.ctx.store.config.concurrency.stall_after_min * 60_000;
    if (!after) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      if (!ACTIVE_FOR_SLOTS.includes(fm.status) || fm.kind === 'epic' || this.ctx.store.derived(item).flavor !== 'worker') continue;
      // Parked with resume_after, it waits for other items to merge (HH-265 on HH-272, whose PR was held): the resume is
      // theirs to trigger. Carried on, it re-reported the same block and woke the orchestrator for nothing.
      if (this.ctx.turns.has(item.id) || this.ctx.jobs.has(item.id) || this.ctx.followUps.has(item.id) || fm.op || fm.awaiting || fm.blocked || fm.triage || fm.taken_over || fm.resume_after || fm.op_data?.pending_turn) continue;
      seen.add(item.id);
      const since = this.idleSince.get(item.id) ?? now;
      this.idleSince.set(item.id, since);
      if (now - since < after) continue;
      this.idleSince.delete(item.id);
      const idleMin = Math.round((now - since) / 60_000);
      const last = Date.parse(String(fm.op_data?.stall_resumed_at ?? ''));
      if (Number.isFinite(last) && now - last < 60 * 60_000) { this.ctx.block(item.id, 'stalled', `nothing has driven this item for ${idleMin} min, again within an hour of being carried on; look at its worktree and Activity`); continue; }
      this.ctx.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), stall_resumed_at: this.ctx.now() } } }, { activity: { actor: 'app', text: `stalled: nothing has driven this item for ${idleMin} min; carrying on from where it stopped` } }], 'engine', { commit: `${item.id}: stalled, carried on` });
      this.ctx.runJob(item.id, () => this.ctx.carryOnStalled(item.id));
    }
    for (const id of this.idleSince.keys()) if (!seen.has(id)) this.idleSince.delete(id);
  }

  /** Why a live turn was aborted on purpose (a take-over, a move into review), for the line its end writes. */
  stoppedFor = new Map<string, string>();
  /** Turns the quiet watchdog stopped, with why: blocked `turn_quiet` once the kill lands. */
  quietStopped = new Map<string, string>();
  /**
   * `concurrency.turn_quiet_min`: a turn that has said nothing for that long is stopped. The stall detector skips live
   * turns, and a session held open by a background process (or a hung CLI) kept its slot until a person noticed. A turn
   * whose run_heavy is running is not quiet (#502): planestro itself holds that call.
   */
  private driveQuietTurns(): void {
    const min = this.ctx.store.config.concurrency.turn_quiet_min;
    if (!min) return;
    for (const [id, t] of this.ctx.turns) {
      if (t.waiting || t.heavy || t.abort.signal.aborted || t.lastOutputAt === undefined || Date.now() - t.lastOutputAt < min * 60_000) continue;
      const why = `no output for ${min} min (concurrency.turn_quiet_min)`;
      this.quietStopped.set(id, why); this.stoppedFor.set(id, why);
      t.abort.abort();
    }
  }

  /**
   * The retries scheduled for later, once due: blockOrRetry's (#241) and retryAtReset's at a usage reset (#296). One that
   * someone else already moved (an unblock, a take-over, another stop) is dropped without running. Each runs once: the
   * marker is spent (`retried_at`, no due time) before the retry, so the stop it may end in is an ordinary one.
   */
  private driveTimedRetries(): void {
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      for (const key of ['transient_retry', 'usage_retry'] as const) {
        const r = fm.op_data?.[key] as { due_at?: string; reason?: string; by?: string; message?: string } | undefined;
        if (!r?.due_at) continue;
        const usage = key === 'usage_retry';
        if (!fm.blocked || fm.taken_over || (usage && fm.blocked_reason !== 'usage_exhausted')) { this.ctx.turnRunner.dropTransientRetry(item.id, key); continue; }
        if (Date.parse(r.due_at) > Date.now() || this.ctx.busyWith(item.id)) continue;
        const reason = usage ? 'usage_exhausted' : r.reason;
        this.ctx.store.mutateItem(item.id, [{ set: { op_data: { ...(this.ctx.store.requireItem(item.id).file.frontmatter.op_data ?? {}), [key]: { retried_at: this.ctx.now(), reason } } } },
          ...(usage ? [{ activity: { actor: 'app', text: `usage reset (${r.due_at}): retrying the step it stopped, once` } } as ItemOp] : [])], 'engine');
        void this.ctx.retryOp(item.id, 'engine', usage ? 'Your model\'s usage window has reset; carry on.' : r.message).then((said) => {
          if (/^not now/.test(said)) { const cur = this.ctx.store.requireItem(item.id).file.frontmatter; this.ctx.store.mutateItem(item.id, [{ set: { op_data: { ...(cur.op_data ?? {}), [key]: r } } }], 'engine'); return; }
          if (/^(not possible|nothing to retry)/.test(said)) { this.ctx.turnRunner.dropTransientRetry(item.id, key); this.ctx.block(item.id, reason ?? 'turn_error', `the automatic retry could not run: ${said}`); }
        }).catch((e) => { this.ctx.turnRunner.dropTransientRetry(item.id, key); this.ctx.block(item.id, reason ?? 'turn_error', `the automatic retry failed: ${(e as Error).message}`); });
        break;
      }
    }
  }

  /** The workflow's queue repository-wide, read at most once a minute (#170); undefined when the port cannot tell. */
  ciQueue: CiQueue | undefined;
  ciQueueAt = 0;
  private ciQueueHeld = false;
  private ciQueueUnreadable = false;
  async refreshCiQueue(): Promise<CiQueue | undefined> {
    if (!this.ctx.ports.gh.ciQueue || !this.ctx.store.config.code_repo.github) return undefined;
    if (Date.now() - this.ciQueueAt < 60_000) return this.ciQueue;
    this.ciQueueAt = Date.now();
    // A failed read keeps the last reading; with none at all, admission control steps aside rather than hold every start.
    try { this.ciQueue = await this.ctx.ports.gh.ciQueue(this.ctx.github, this.ctx.ciWorkflow); this.ciQueueUnreadable = false; } catch { this.ciQueueUnreadable = !this.ciQueue; }
    return this.ciQueue;
  }

  private externalPoll?: Promise<void>;

  /**
   * Park a stopped item on other items (p14): "resume when HH-129 merges, and tell it this". The
   * block, question or triage it had is answered by the park, so it no longer needs anyone; the tick
   * resumes it when they have all merged. Items already merged need no wait: it resumes now.
   */
  async resumeAfter(id: string, items: string[], message: string, by: 'user' | 'orchestrator' = 'user', prs: number[] = []): Promise<string> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (!this.ctx.phaseFor(fm.status) || this.ctx.store.derived(item).flavor !== 'worker') return `not possible: ${id} is ${fm.status}; only a worker item planning or in progress can wait to resume`;
    if (fm.taken_over) return `not possible: the user has taken ${id} over`;
    const busy = this.ctx.busyWith(id); if (busy) return `not now: ${busy}`;
    const ids = [...new Set(items.map((x) => x.trim()).filter(Boolean))];
    const nums = [...new Set(prs.filter((n) => Number.isInteger(n) && n > 0))];
    if ((!ids.length && !nums.length) || !message.trim()) return 'not recorded: name at least one item or pull request to wait for, and the message to resume with';
    const missing = ids.filter((x) => x === id || !this.ctx.store.getItem(x));
    if (missing.length) return `not recorded: ${missing.join(', ')} ${missing.includes(id) ? '(an item cannot wait for itself) ' : ''}is not an item to wait for`;
    // A pull request by number (#136, HH-298): one a person opened, which no item stands for. It must exist and still be open.
    for (const n of nums) {
      if (n === fm.pr) return `not recorded: PR #${n} is ${id}'s own pull request`;
      const pr = await this.ctx.ports.gh.prView(this.ctx.github, n).catch(() => undefined);
      if (!pr) return `not recorded: there is no pull request #${n} in ${this.ctx.github}`;
      if (pr.state === 'CLOSED') return `not recorded: PR #${n} was closed without merging`;
    }
    const what = waitsFor({ items: ids, prs: nums });
    this.ctx.store.mutateItem(id, [
      { unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] },
      { set: { resume_after: { items: ids, ...(nums.length ? { prs: nums } : {}), message: message.trim(), since: this.ctx.now() } } },
      { activity: { actor: by, text: `waits for ${what} to merge, then resumes with: ${message.trim()}` } },
    ], by, { commit: `${id}: resume after ${what}` });
    void this.tick();
    return `parked: ${id} resumes when ${what} ${ids.length + nums.length === 1 ? 'has' : 'have'} merged`;
  }

  /** Stop waiting without resuming: the item is the user's again, as a plain block. */
  cancelResumeAfter(id: string): void {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (!fm.resume_after) return;
    this.ctx.store.mutateItem(id, [{ unset: ['resume_after'] }, { set: { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }, { activity: { actor: 'user', text: `stopped waiting for ${waitsFor(fm.resume_after)}` } }], 'user', { commit: `${id}: stop waiting` });
  }

  waitedPrs = new Map<number, { state?: 'OPEN' | 'MERGED' | 'CLOSED'; at: number; reading?: boolean }>();
  /** A waited-on pull request's last known state, refreshed at most once a minute (one gh call each); undefined until first read. */
  private waitedPrState(n: number): 'OPEN' | 'MERGED' | 'CLOSED' | undefined {
    const cur = this.waitedPrs.get(n) ?? { at: 0 };
    if (!cur.reading && cur.state !== 'MERGED' && cur.state !== 'CLOSED' && Date.now() - cur.at > 60_000) {
      this.waitedPrs.set(n, { ...cur, reading: true });
      void this.ctx.ports.gh.prView(this.ctx.github, n).then((pr) => { this.waitedPrs.set(n, { state: pr.state, at: Date.now() }); if (pr.state !== 'OPEN') this.poke(); },
        () => { this.waitedPrs.set(n, { ...cur, at: Date.now(), reading: false }); });
    }
    return this.waitedPrs.get(n)?.state;
  }

  private driveResumeAfter(): void {
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      const wait = fm.resume_after;
      if (!wait || fm.taken_over || this.ctx.jobs.has(item.id) || this.ctx.turns.has(item.id)) continue;
      const gone = wait.items.filter((x) => !this.ctx.store.getItem(x));
      if (gone.length) { this.ctx.store.mutateItem(item.id, [{ unset: ['resume_after'] }], 'engine'); this.ctx.block(item.id, 'waited_on_gone', `it was waiting for ${gone.join(', ')}, which no longer exist${gone.length === 1 ? 's' : ''}; its message was: ${wait.message}`); continue; }
      if (!wait.items.every((x) => ['MERGED', 'FINISHED'].includes(this.ctx.store.requireItem(x).file.frontmatter.status))) continue;
      // Pull requests by number (#136): their state is GitHub's, read off the tick (waitedPrState) and looked up here.
      const prs = wait.prs ?? [];
      const states = prs.map((n) => this.waitedPrState(n));
      const closed = prs.filter((_, i) => states[i] === 'CLOSED');
      if (closed.length) { this.ctx.store.mutateItem(item.id, [{ unset: ['resume_after'] }], 'engine'); this.ctx.block(item.id, 'waited_on_gone', `it was waiting for ${closed.map((n) => `PR #${n}`).join(', ')}, closed without merging; its message was: ${wait.message}`); continue; }
      if (!states.every((x) => x === 'MERGED')) continue;
      const what = waitsFor(wait);
      this.ctx.store.mutateItem(item.id, [{ unset: ['resume_after'] }, { activity: { actor: 'app', text: `${what} merged; resuming` } }], 'engine', { commit: `${item.id}: resume after ${what}` });
      this.ctx.runJob(item.id, () => this.ctx.turnQueue.resumeWaited(item.id, [...wait.items, ...prs.map((n) => `PR #${n}`)], wait.message));
    }
  }

  /**
   * Auto-step-down (#330, `concurrency.guard.auto_step_down`, off by default): the last change raised a limit, and a
   * check was killed at its timeout since, or the load stayed high. It is rolled back to the values before it, as the
   * engine, once: the step-down is the last change now. Read from the journal and config on each tick; no timer.
   */
  private driveStepDown(): void {
    const guard = this.ctx.store.config.concurrency.guard;
    if (!guard.auto_step_down) return;
    const last = lastConcurrencyChange(this.ctx.store);
    const why = stepDownDue({ last_change: last, ci: recentCi(this.ctx.store), host: (this.ctx.opts.hostLoad ?? hostLoad)(), now: Date.now() }, guard);
    if (!why || !last) return;
    const now = limitsLabel(limitsOf(this.ctx.store.config));
    if (now === limitsLabel(last.from)) return;   // already there (the file was edited back by hand)
    try { rollbackConcurrency(this.ctx.store, { reason: `stepped down: ${why}` }, 'engine', { auto: true }); }
    catch (e) { this.ctx.note('error', `concurrency step-down: ${(e as Error).message}`); return; }
    // Auto: never stepped down twice, and the banner names it.
    this.ctx.note('warn', `stepped concurrency down from ${now} to ${limitsLabel(last.from)}: ${why} (concurrency.guard.auto_step_down)`);
    this.ctx.wakeSlotWaiters();
  }
}
