import type { DataStore } from '../store/DataStore.ts';
import type { RunningTurn } from './turnRunner.ts';
import type { TurnQueue } from './turnQueue.ts';

/**
 * Slots and jobs (#404, seam 10): what may run at once. One engine step per item at a time (runJob), with the step queued
 * behind it (queueFollowUp, never dropped) and a triage wake held until the step that stopped has ended (wakeWhenIdle); the
 * `concurrency.max_sessions` session slots every turn wins before its agent starts, `concurrency.runner_limits`' per-runner
 * slots and `concurrency.max_local_jobs`' local-job slots, each read at every acquire so a limit changed in Settings applies to
 * the next one, and a raised limit wakes the turns waiting (wakeSlotWaiters, #330); and what the concurrency control shows
 * (slotUsage). When to start something is the Scheduler's. LiveEngine owns one and delegates to it; this is what it needs
 * from the engine, and nothing more.
 */
export interface SlotsContext {
  readonly store: DataStore;
  /** Read live: a turn waiting for a slot ends its wait when the engine stops. */
  readonly stopping: boolean;
  /** Turns this engine started: a turn queued for a session slot is marked `waiting` on its entry. */
  readonly turns: ReadonlyMap<string, RunningTurn>;
  /** Items with a step in flight: the job queue is the one part that adds and removes them. */
  readonly jobs: Map<string, Promise<void>>;
  /** The server's log (serve.log): a failed step's stack goes here (#439). */
  readonly opts: { log?: (level: 'info' | 'warn' | 'error', message: string) => void };
  /** Messages queued while a step that is not a turn ran, sent once it ends (HH-263). */
  readonly turnQueue: Pick<TurnQueue, 'deliverQueued'>;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  block(id: string, reason: string, detail: string): void;
  wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void;
}

export class Slots {
  constructor(private readonly ctx: SlotsContext) {}

  /** Agent turns holding one of `concurrency.max_sessions` slots, and the turns queued for one (withSessionSlot). */
  sessionTurns = 0;
  sessionWaiters: Array<() => void> = [];

  private localJobs = 0;
  private runnerTurns = new Map<string, number>();
  private runnerWaiters = new Map<string, (() => void)[]>();
  private localJobWaiters: (() => void)[] = [];

  /**
   * What the concurrency control shows (#330): agents running, and what waits for a session slot: turns queued for one,
   * and QUEUED items admission would start (deps merged, not blocked or taken over). Each limited runner's turns beside.
   */
  slotUsage(): { running: number; waiting: number; runners: Record<string, { running: number; waiting: number }> } {
    const turns = [...this.ctx.turns.values()];
    const ready = this.ctx.store.listItems().filter((i) => {
      const fm = i.file.frontmatter;
      if (fm.status !== 'QUEUED' || fm.kind === 'epic' || fm.taken_over || fm.blocked || this.ctx.jobs.has(i.id) || this.ctx.turns.has(i.id)) return false;
      const d = this.ctx.store.derived(i);
      return d.flavor === 'worker' && d.deps_satisfied;
    }).length;
    const runners = Object.fromEntries(Object.keys(this.ctx.store.config.concurrency.runner_limits ?? {}).map((r) => [r, { running: this.runnerTurns.get(r) ?? 0, waiting: turns.filter((t) => t.waiting === r).length }]));
    return { running: turns.filter((t) => !t.waiting).length, waiting: turns.filter((t) => t.waiting === 'session').length + ready, runners };
  }

  followUps = new Map<string, () => Promise<unknown>>();

  /** Triage wakes held until the item's step (the turn that stopped) has finished: the orchestrator must find it idle to act on it. */
  pendingWakes = new Map<string, { type: string; data?: Record<string, unknown> }>();

  runJob(id: string, fn: () => Promise<unknown>): void {
    if (this.ctx.jobs.has(id)) return;
    // Started now (callers rely on what a step does before its first await), but a step that throws before it rejects like any other.
    let started: Promise<unknown>;
    try { started = fn(); } catch (e) { started = Promise.reject(e); }
    const p = started.then(() => undefined, (e) => {
      // The Activity line carries the message; the stack goes to serve.log, so the next one can be traced (#439).
      try { this.ctx.opts.log?.('error', `${id}: engine step failed: ${(e as Error)?.stack ?? String(e)}`); } catch { /* a log must not stop the block */ }
      try {
        // A finished or iceboxed item has nothing left for a person to decide: a failed step is noted, not a block (#214).
        const status = this.ctx.store.getItem(id)?.file.frontmatter.status;
        if (status === 'FINISHED' || status === 'ICEBOX') this.ctx.note('warn', `${id}: an engine step failed after the item reached ${status}: ${(e as Error).message}`);
        else this.ctx.block(id, 'engine_error', (e as Error).message);
      } catch (again) { this.ctx.note('error', `${id}: a step failed (${(e as Error).message}) and blocking it failed too: ${(again as Error).message}`); }
    }).finally(() => {
      this.ctx.jobs.delete(id);
      // Nothing here may throw out of the job: no one awaits it, and a rejection would end the process.
      try {
        const next = this.followUps.get(id);
        if (next) { this.followUps.delete(id); this.runJob(id, next); }
        // A message queued while a job that is not a turn ran (a CI wait, a merge step) has no turn to end and deliver it.
        else if (this.ctx.turnQueue.deliverQueued(id, 'its job ended')) { /* queued as the next job */ }
        else { const wake = this.pendingWakes.get(id); if (wake) { this.pendingWakes.delete(id); this.ctx.wakeOrchestrator(wake.type, id, wake.data); } }
      } catch (e) { this.ctx.note('error', `${id}: after its step ended: ${(e as Error).message}`); }
    });
    this.ctx.jobs.set(id, p);
  }

  /** Run `fn` as the item's next job — immediately if idle, otherwise right after the current job (never dropped). */
  queueFollowUp(id: string, fn: () => Promise<unknown>): void {
    if (this.ctx.jobs.has(id)) this.followUps.set(id, fn); else this.runJob(id, fn);
  }

  /** A stop usually happens inside the turn that is still ending: wake once it has, so every tool finds the item idle. */
  wakeWhenIdle(id: string, type: string, data?: Record<string, unknown>): void {
    if (this.ctx.jobs.has(id) || this.ctx.turns.has(id)) this.pendingWakes.set(id, { type, data });
    else this.ctx.wakeOrchestrator(type, id, data);
  }

  /** A limit raised in place (#330): every turn waiting for a session or runner slot looks again, and those that now fit start. */
  wakeSlotWaiters(): void {
    for (const w of this.sessionWaiters.splice(0)) w();
    for (const q of this.runnerWaiters.values()) for (const w of q.splice(0)) w();
  }

  /**
   * `concurrency.max_sessions` bounds agent turns actually running, whatever started them (p51). admit()
   * counts it only when it starts a QUEUED item; a stall carry-on, an unblock, a plan approval or a review
   * follow-up resumes an item that is already active and never passed through admit(): HH ran five
   * implement turns against a cap of three. Every turn now wins a session slot before its agent starts,
   * and waits (shown as waiting for a session slot) while all of them are taken.
   */
  async withSessionSlot<T>(id: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (this.sessionTurns >= Math.max(1, this.ctx.store.config.concurrency.max_sessions) && !this.ctx.stopping && !signal?.aborted) {
      const t = this.ctx.turns.get(id); if (t) t.waiting = 'session';
      await this.slotWait(this.sessionWaiters, signal);
    }
    this.sessionTurns += 1;
    try { return await fn(); } finally { this.sessionTurns -= 1; this.sessionWaiters.shift()?.(); }
  }

  /**
   * Wait in `queue` for a slot, or until `signal` aborts: a turn stopped (Discard, take over, shutdown) while it
   * waited left its job, and `stop()`, waiting on every job, hanging until some other turn ended. It leaves the queue
   * when it stops waiting, so a slot freed later goes to a turn that still wants it. The turn's first check sees the stop.
   */
  private slotWait(queue: (() => void)[], signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const go = () => { signal?.removeEventListener('abort', gone); resolve(); };
      const gone = () => { const i = queue.indexOf(go); if (i >= 0) queue.splice(i, 1); resolve(); };
      queue.push(go);
      signal?.addEventListener('abort', gone, { once: true });
    });
  }

  /** `concurrency.runner_limits`: a runner with its own rate limit takes its turns a few at a time; unlisted runners are not limited here. */
  async withRunnerSlot<T>(runner: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const limit = () => this.ctx.store.config.concurrency.runner_limits?.[runner];
    while (limit() !== undefined && (this.runnerTurns.get(runner) ?? 0) >= limit()! && !this.ctx.stopping && !signal?.aborted) {
      const q = this.runnerWaiters.get(runner) ?? []; this.runnerWaiters.set(runner, q);
      await this.slotWait(q, signal);
    }
    this.runnerTurns.set(runner, (this.runnerTurns.get(runner) ?? 0) + 1);
    try { return await fn(); } finally { this.runnerTurns.set(runner, (this.runnerTurns.get(runner) ?? 1) - 1); this.runnerWaiters.get(runner)?.shift()?.(); }
  }

  /**
   * Setup hooks and local check commands are the heavy processes planestro starts itself (an asset
   * import, a full test suite); `concurrency.max_local_jobs` bounds how many run at once. The limit
   * is read at each acquire, so changing it in Settings applies to the next job.
   */
  async withLocalJobSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.localJobs >= Math.max(1, this.ctx.store.config.concurrency.max_local_jobs)) await new Promise<void>((r) => this.localJobWaiters.push(r));
    this.localJobs += 1;
    try { return await fn(); } finally { this.localJobs -= 1; this.localJobWaiters.shift()?.(); }
  }
}
