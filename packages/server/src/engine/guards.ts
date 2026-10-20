import { usageGuardTrips, usageWindowLabel, usagePercent, localClock, findModel, fallbackChain, unavailableEntry, markUnavailable, unavailableUntil, unavailableKey, guardKey, DEFAULT_ACCOUNT, type RateLimitSnapshot, type UsageGuardState, type ServerEvent, type ModelDef, type Account } from '@planestro/shared';
import type { DataStore } from '../store/DataStore.ts';
import type { Ports, TurnPhase, TurnResult } from './ports.ts';
import type { Orchestrator } from './orchestrator.ts';
import { clearUsageStopOps } from '../providerSwitch.ts';

/**
 * Guards (#404, seam 3): the global pause and its persistence (the big red lever, invariant 6), the provider usage guard
 * (tripped from a turn's rate-limit snapshot, resumed after its window's reset), the disk guard that pauses on a nearly full
 * disk, model outages (`model_unavailable`) and the unblock when one ends, and the drain before a restart.
 * LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface GuardsContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'proc'>;
  /** The code repo's main checkout: the disk guard reads its volume, beside the worktrees'. */
  readonly repo: string;
  /** The engine is stopping: nothing is tripped, armed or resumed. */
  readonly stopping: boolean;
  /** Turns this engine started and items with a job in flight: read only, for restartReadiness. */
  readonly turns: ReadonlyMap<string, { phase: TurnPhase }>;
  readonly jobs: ReadonlyMap<string, unknown>;
  /** Kicked on a resume; asked whether a wake is running, for restartReadiness. */
  readonly orchestrator: Pick<Orchestrator, 'kick' | 'busy'>;
  emit(e: ServerEvent): void;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  announce(event: 'on_usage_pause', title: string, message: string): void;
  /** The engine's timer, whose callback notes a throw rather than ending the process. Returns a cancel. */
  schedule(fn: () => void, ms: number): () => void;
  tick(): Promise<void>;
  accountFor(fm: { account?: string }, def: ModelDef): { account: Account } | { missing: string; why: string };
}

/** A guard-made pause resumes this long after its window's reset, so the first turn lands in the fresh window. */
export const USAGE_RESUME_GRACE_MS = 60_000;
/** Two readings of one window whose resets differ by less than this are the same crossing. */
const SAME_CROSSING_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export class Guards {
  private _paused: boolean;
  private cancelGuardResume?: () => void;

  constructor(private readonly ctx: GuardsContext) {
    this._paused = ctx.store.local.engine.paused;
  }

  get paused(): boolean { return this._paused; }

  /** The lever by hand. A manual pause is the user's: the usage guard never resumes it. */
  pause(): void { this.setPaused(true, 'user'); this.ctx.note('warn', 'AUTOMATION PAUSED — running steps finish, nothing new starts'); }
  /** Global automation control is independent of provider usage guards. */
  resume(message = 'automation resumed'): void { this.setPaused(false); this.ctx.note('info', message); this.ctx.orchestrator.kick(); void this.ctx.tick(); }
  private setPaused(paused: boolean, by?: 'user' | 'disk', guard?: UsageGuardState, disk?: { free_gib: number; path: string; tripped_at: string }): void {
    this._paused = paused;
    this.ctx.store.updateLocal({ engine: { ...this.ctx.store.local.engine, paused, paused_by: paused ? by : undefined, disk_guard: paused ? disk : undefined } });
    this.ctx.emit({ type: 'engine.paused', paused, ...(paused && by ? { by } : {}) });
  }

  // ---- usage guard: pause before a subscription window runs out, resume once it resets ----
  /** Read after turns and wakes with verified telemetry; trips once per provider/window crossing. */
  usageSeen(r: RateLimitSnapshot | undefined, runner = 'claude'): void {
    const cfg = this.ctx.store.config.usage_guard;
    if (!r || this.ctx.stopping || !usageGuardTrips(cfg, r)) return;
    const last = this.ctx.store.local.engine.provider_guard_last?.[runner];
    if (last && last.window === r.window && (r.resetsAt && last.resets_at ? Math.abs(Date.parse(r.resetsAt) - Date.parse(last.resets_at)) < SAME_CROSSING_MS : !r.resetsAt && !last.resets_at && Date.now() - Date.parse(last.tripped_at) < 3_600_000)) return;
    const resumeAt = cfg.auto_resume && r.resetsAt ? new Date(Date.parse(r.resetsAt) + USAGE_RESUME_GRACE_MS).toISOString() : undefined;
    const guard: UsageGuardState = { window: r.window, status: r.status, ...(r.utilization !== undefined ? { utilization: r.utilization } : {}), ...(r.resetsAt ? { resets_at: r.resetsAt } : {}), tripped_at: new Date(Date.now()).toISOString(), ...(resumeAt ? { resume_at: resumeAt } : {}) };
    this.ctx.store.updateLocal({ engine: { ...this.ctx.store.local.engine, provider_guards: { ...this.ctx.store.local.engine.provider_guards, [runner]: guard }, provider_guard_last: { ...this.ctx.store.local.engine.provider_guard_last, [runner]: guard } } });
    this.ctx.store.journal.append({ type: 'usage.guard_tripped', actor: 'engine', data: { provider: runner, ...guard, threshold: cfg.threshold } });
    this.ctx.note('warn', `${runner} USAGE GUARD: ${usageWindowLabel(r.window)} window ${usagePercent(r.utilization) ? `at ${usagePercent(r.utilization)}` : r.status === 'rejected' ? 'is exhausted' : 'sent a usage warning'} — ${runner} paused ${resumeAt ? `until ${localClock(resumeAt)}` : r.resetsAt ? `(the window resets at ${localClock(r.resetsAt)}; resume by hand)` : 'until you resume it'}; running turns finish, nothing new starts`);
    this.ctx.announce('on_usage_pause', `${runner} paused for usage`, `${runner} paused: the ${usageWindowLabel(r.window)} usage window ${usagePercent(r.utilization) ? `is at ${usagePercent(r.utilization)}` : 'is near its limit'}`);
    this.armGuardResume();
  }

  // ---- disk guard (#161, HH-355): a full disk fails every worker one by one; pause before it does ----
  private diskCheckedAt = 0;
  /** Free space on the volumes the work is written to (the repo, its worktrees), at most once a minute; `force` reads now. */
  async checkDisk(force = false): Promise<void> {
    const cfg = this.ctx.store.config.disk_guard;
    if (!cfg.enabled || this.ctx.stopping || !this.ctx.ports.proc.freeBytes || (!force && Date.now() - this.diskCheckedAt < 60_000)) return;
    this.diskCheckedAt = Date.now();
    const paths = [...new Set([this.ctx.repo, this.ctx.store.worktreesRoot()])];
    const reads = await Promise.all(paths.map(async (path) => ({ path, free: await this.ctx.ports.proc.freeBytes!(path) })));
    const known = reads.filter((r): r is { path: string; free: number } => typeof r.free === 'number');
    if (!known.length) return;
    const low = known.reduce((a, b) => (b.free < a.free ? b : a));
    const gib = Math.round((low.free / 2 ** 30) * 10) / 10;
    const e = this.ctx.store.local.engine;
    if (this._paused && e.paused_by === 'disk') {
      if (gib >= cfg.resume_free_gib) { this.ctx.store.journal.append({ type: 'disk.guard_resumed', actor: 'engine', data: { free_gib: gib, path: low.path } }); this.resume(`automation resumed: ${gib} GiB free again on ${low.path}`); }
      return;
    }
    if (this._paused || gib >= cfg.min_free_gib) return;
    const disk = { free_gib: gib, path: low.path, tripped_at: new Date(Date.now()).toISOString() };
    this.setPaused(true, 'disk', undefined, disk);
    this.ctx.store.journal.append({ type: 'disk.guard_tripped', actor: 'engine', data: { ...disk, min_free_gib: cfg.min_free_gib } });
    this.ctx.note('warn', `DISK GUARD: ${gib} GiB free on ${low.path} (under ${cfg.min_free_gib}) — automation paused; running steps finish, nothing new starts until ${cfg.resume_free_gib} GiB is free`);
    this.ctx.announce('on_usage_pause', 'planestro paused', `Disk nearly full: ${gib} GiB free on ${low.path}. Nothing new starts until ${cfg.resume_free_gib} GiB is free.`);
  }

  /** (Re)arm the guard's resume from local config — at trip and at startup; one already due resumes now. */
  armGuardResume(): void {
    this.cancelGuardResume?.(); this.cancelGuardResume = undefined;
    const due = this.guardResumeDue();
    if (due === undefined || this.ctx.stopping) return;
    const ms = due - Date.now();
    if (ms <= 0) { this.guardResume(); return; }
    this.cancelGuardResume = this.ctx.schedule(() => { this.cancelGuardResume = undefined; if (ms > MAX_TIMER_MS) this.armGuardResume(); else this.guardResume(); }, Math.min(ms, MAX_TIMER_MS));
  }
  /** When a guard-made pause is due to resume (epoch ms), or undefined when nothing will resume it. */
  guardResumeDue(): number | undefined {
    if (!this.ctx.store.config.usage_guard.auto_resume) return undefined;
    const due = Object.values(this.ctx.store.local.engine.provider_guards ?? {}).flatMap((g) => g.resume_at && Number.isFinite(Date.parse(g.resume_at)) ? [Date.parse(g.resume_at)] : []);
    return due.length ? Math.min(...due) : undefined;
  }
  retryProvider(runner: string): void {
    const { [runner]: _guard, ...guards } = this.ctx.store.local.engine.provider_guards ?? {};
    this.ctx.store.updateLocal({ engine: { ...this.ctx.store.local.engine, provider_guards: guards } });
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      const def = findModel(this.ctx.store.config, fm.status === 'PLAN_IN_PROGRESS' ? fm.planner : fm.implementer);
      const acct = def ? this.ctx.accountFor(fm, def) : undefined;
      if (fm.blocked_reason === 'provider_usage' && def && acct && 'account' in acct && guardKey(def.runner ?? 'claude', acct.account.name) === runner)
        this.ctx.store.mutateItem(item.id, clearUsageStopOps(fm), 'engine');
    }
    this.ctx.store.journal.append({ type: 'usage.guard_resumed', actor: 'engine', data: { provider: runner } });
    this.armGuardResume(); this.ctx.orchestrator.kick(); void this.ctx.tick();
  }
  guardResume(): void {
    if (this.ctx.stopping || !this.ctx.store.config.usage_guard.auto_resume) return;
    for (const [runner, guard] of Object.entries(this.ctx.store.local.engine.provider_guards ?? {}))
      if (guard.resume_at && Date.parse(guard.resume_at) <= Date.now()) this.retryProvider(runner);
    this.armGuardResume();
  }

  // ---- model outages (#244): when a model's remembered unavailability ends, its usage_exhausted items are unblocked ----
  private cancelModelResume?: () => void;
  /** (Re)arm the earliest `model_unavailable` expiry from local config (at startup, when one is recorded); one already past runs now. */
  armModelResume(): void {
    this.cancelModelResume?.(); this.cancelModelResume = undefined;
    const due = this.modelResumeDue();
    if (due === undefined || this.ctx.stopping) return;
    const ms = due - Date.now();
    if (ms <= 0) { if (this.modelResume()) void this.ctx.tick(); return; }
    this.cancelModelResume = this.ctx.schedule(() => { this.cancelModelResume = undefined; if (ms > MAX_TIMER_MS) this.armModelResume(); else if (this.modelResume()) void this.ctx.tick(); }, Math.min(ms, MAX_TIMER_MS));
  }
  /** When the next model outage ends (epoch ms), or undefined when none will unblock anything by itself. */
  modelResumeDue(): number | undefined {
    if (!this.ctx.store.config.usage_guard.auto_resume) return undefined;
    const due = Object.values(this.ctx.store.local.model_unavailable ?? {}).map((e) => Date.parse(e.until)).map((t) => (Number.isFinite(t) ? t : 0));
    return due.length ? Math.min(...due) : undefined;
  }
  /**
   * Each ended outage is dropped from `model_unavailable` first, so it unblocks at most once, then the items it
   * kept out are unblocked. Returns whether any outage ended.
   */
  modelResume(): boolean {
    if (this.ctx.stopping || !this.ctx.store.config.usage_guard.auto_resume) return false;
    const map = this.ctx.store.local.model_unavailable ?? {};
    const ended = Object.keys(map).filter((id) => !unavailableEntry(map, id, new Date(Date.now())));
    if (ended.length) {
      this.ctx.store.updateLocal({ model_unavailable: Object.fromEntries(Object.entries(map).filter(([id]) => !ended.includes(id))) });
      for (const id of ended) this.unblockModel(id);
    }
    this.armModelResume();
    return ended.length > 0;
  }
  /**
   * Clear `usage_exhausted` on the items whose next turn can now run on `modelId`: their current-phase model
   * (planner while planning, otherwise implementer) is that model, or, when they allow a fallback, has it in its chain.
   * Items blocked for anything else, held, or taken over are left alone; they re-enter through ordinary admission.
   */
  private unblockModel(key: string): void {
    // A named account's outage is keyed `<model>@<account>` (#242): only items on that account were held by it.
    const at = key.lastIndexOf('@');
    const modelId = at > 0 ? key.slice(0, at) : key;
    const account = at > 0 ? key.slice(at + 1) : DEFAULT_ACCOUNT;
    const label = findModel(this.ctx.store.config, modelId)?.label ?? modelId;
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.blocked_reason !== 'usage_exhausted' || fm.taken_over || fm.skip_merge) continue;
      const requested = findModel(this.ctx.store.config, fm.status === 'PLAN_IN_PROGRESS' ? fm.planner : fm.implementer);
      if (!requested) continue;
      const chain = fm.allow_model_fallback === true ? fallbackChain(this.ctx.store.config, requested) : [requested];
      if (!chain.some((m) => m.id === modelId)) continue;
      const acct = this.ctx.accountFor(fm, requested);
      if (!('account' in acct) || acct.account.name !== account) continue;
      this.ctx.store.mutateItem(item.id, [...clearUsageStopOps(fm), { activity: { actor: 'app', text: `unblocked: ${label} usage window reset${account !== DEFAULT_ACCOUNT ? ` on account ${account}` : ''}` } }], 'engine', { commit: `${item.id}: unblock (${key} usage window reset)` });
    }
  }
  /**
   * Getting ready for a restart (f3). Like PAUSE AUTOMATION, nothing new starts (no admissions, no
   * merge steps, no orchestrator wakes) and what runs finishes, but it is not persisted: planestro
   * comes back from the restart running. Items in triage keep waiting (the wake after the restart
   * picks them up). restartReadiness says when nothing is left running.
   */
  draining = false;
  /** Who asked: the Console's button (`user`), or `serve --watch` restarting onto new planestro code (`update`, #90). */
  private drainedBy: 'user' | 'update' = 'user';
  drain(by: 'user' | 'update' = 'user'): void {
    this.draining = true; this.drainedBy = by;
    this.ctx.emit({ type: 'engine.paused', paused: this._paused });
    this.ctx.note('warn', by === 'update' ? 'updating planestro: running steps finish, nothing new starts, then it restarts and carries on' : 'preparing to restart: running steps finish, nothing new starts');
  }
  undrain(): void { this.draining = false; this.drainedBy = 'user'; this.ctx.emit({ type: 'engine.paused', paused: this._paused }); this.ctx.note('info', 'restart preparation cancelled; carrying on'); this.ctx.orchestrator.kick(); void this.ctx.tick(); }
  /**
   * What still runs (turns, engine steps, ops in flight, an orchestrator wake): empty means a restart loses nothing.
   * A wait for CI (`op: awaiting_ci`) is not counted: it is GitHub's to finish, and the next start picks the wait
   * up where it was (watchCi leaves the op for exactly that). Counting it held every restart for a whole CI run,
   * and a drain starts no poll, so an item waiting when the drain began kept it from ever being idle (#90).
   */
  restartReadiness(): { draining: boolean; by?: 'user' | 'update'; idle: boolean; running: string[] } {
    const waitingCi = (id: string) => this.ctx.store.getItem(id)?.file.frontmatter.op === 'awaiting_ci';
    const running = [
      ...[...this.ctx.turns.entries()].map(([id, t]) => `${id}: ${t.phase} turn`),
      ...[...this.ctx.jobs.keys()].filter((id) => !this.ctx.turns.has(id) && !waitingCi(id)).map((id) => `${id}: engine step`),
      ...this.ctx.store.listItems().filter((i) => i.file.frontmatter.op && i.file.frontmatter.op !== 'awaiting_ci' && !this.ctx.jobs.has(i.id) && !this.ctx.turns.has(i.id)).map((i) => `${i.id}: ${i.file.frontmatter.op}`),
      ...(this.ctx.orchestrator.busy ? ['orchestrator: a wake'] : []),
    ];
    return { draining: this.draining, ...(this.draining ? { by: this.drainedBy } : {}), idle: running.length === 0, running };
  }

  /** Mark a model out of usage on this machine until its reset (or the default window); returns the time, for messages. */
  recordUnavailable(def: { id: string; label: string }, limit: TurnResult['usageLimit'], manual = false, account?: string): string {
    const now = new Date(Date.now());
    const until = unavailableUntil(limit?.resetsAt, now);
    this.ctx.store.updateLocal({ model_unavailable: markUnavailable(this.ctx.store.local.model_unavailable, unavailableKey(def.id, account), { until, reason: limit?.message ?? 'usage limit', manual }, now) });
    this.ctx.store.journal.append({ type: 'model.unavailable', actor: manual ? 'user' : 'engine', data: { model: def.id, until: until.toISOString(), reason: limit?.message ?? '', ...(account && account !== DEFAULT_ACCOUNT ? { account } : {}) } });
    this.ctx.note('warn', `${def.label} is out of usage${account && account !== DEFAULT_ACCOUNT ? ` on account ${account}` : ''} until ${until.toISOString()}`);
    this.armModelResume();
    return until.toISOString();
  }

  /** At stop: the resume timers are cancelled. */
  stop(): void {
    this.cancelGuardResume?.(); this.cancelGuardResume = undefined;
    this.cancelModelResume?.(); this.cancelModelResume = undefined;
  }
}
