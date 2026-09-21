import { join, relative, isAbsolute } from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { serializeItemFile, getSection, idNumber, slugify, isoLocal, renderPrompt, findTransition, canPlan, validateBreakdown, dependencyOrder, type BreakdownChild, type ServerEvent, type Status } from '@planestro/shared';
import type { DataStore, StoredItem, ItemOp } from '../store/DataStore.ts';
import type { Engine, SessionView } from './Engine.ts';
import type { Ports, TurnPhase, TurnResult, TurnTools, PermissionRequest } from './ports.ts';
import { makePolicy, ruleFor, allowedByRules, BASE_ALLOWED } from './policy.ts';
import { Orchestrator } from './orchestrator.ts';
import { pngSize } from './placeholderPng.ts';
import type { ReviewImage } from './Engine.ts';

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg)$/i;

export interface EngineOptions { sleep?: (ms: number) => Promise<void>; tickMs?: number; now?: () => string; ciWorkflow?: string }

const RESUMABLE_TURN_OPS = new Set(['planning_turn', 'implement_turn']);
/** How many of one item's permission requests the orchestrator may refuse before they go to the user instead. */
const MAX_ORCHESTRATOR_DENIALS = 3;
const JUDGMENT_BLOCKS = ['turn_error', 'no_plan', 'no_commits', 'dirty_tree', 'sync_conflict', 'ci_timeout', 'ci_blocked', 'base_red', 'pr_closed_externally', 'merge_unverified', 'agent_blocked', 'engine_error'] as const;
const ACTIVE_FOR_SLOTS: Status[] = ['PLAN_IN_PROGRESS', 'IN_PROGRESS'];
/** Turn failures with their own block reason, because the fix is the user's (log in, wait, start over) and not a judgment call. */
const ACTIONABLE_FAILURES = new Set(['auth_required', 'rate_limited', 'session_lost', 'spawn_error']);

/**
 * The Phase 3 lifecycle: one worker item at a time through
 * QUEUED → worktree → plan → (approval) → implement → PR → rebase → CI → merge → cleanup → FINISHED.
 * Deterministic; every step persists `op` before acting and journals begin/end.
 */
/** How long a just-pushed head may still read as the old sha from `gh pr view` before it counts as a real move. */
const HEAD_PROPAGATION_GRACE_MS = 90_000;

export class LiveEngine implements Engine {
  readonly mode: 'live' | 'dry-run';
  log: ServerEvent[] = [];
  private _paused: boolean;
  private jobs = new Map<string, Promise<void>>();
  private turns = new Map<string, { model: string; phase: TurnPhase; startedAt: string; lastOutput: string; abort: AbortController }>();
  private mergeChain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private readonly sleep: (ms: number) => Promise<void>;
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
    this.now = opts.now ?? isoLocal;
    this.ciWorkflow = opts.ciWorkflow ?? 'CI';
    this.orchestrator = new Orchestrator(store, ports, {
      message: (id, text) => this.message(id, text),
      approvePlan: (id, notes) => this.approvePlan(id, notes, 'orchestrator'),
      requestPlanChanges: (id, m) => this.orchestratorRequestsPlanChanges(id, m),
      planDelegated: (id) => this.planDelegated(this.store.requireItem(id).file.frontmatter),
      handPlanToUser: (id, reason) => this.handPlanToUser(id, `the orchestrator left it to you: ${reason}`),
      planReviewEnded: (id) => this.handPlanToUser(id, 'the orchestrator reviewed it without deciding'),
      permissionsDelegated: () => this.permissionsDelegated(),
      decidePermission: (id, decision, reason) => this.orchestratorDecidesPermission(id, decision, reason),
      permissionReviewEnded: (id) => this.handPermissionToUser(id, 'the orchestrator looked at it without deciding'),
      handOff: (from, to, paths, note) => this.handOff(from, to, paths, note, 'orchestrator'),
      poke: () => this.poke(),
    }, emit, (l, m) => this.note(l, m), () => this._paused);
  }

  /** Fire-and-forget judgment wake (invariant 4: never for anything a state machine can know). */
  private wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void {
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
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 10_000);
    this.timer.unref?.();
    this.reconcileTimer = setInterval(() => void this.reconcile('periodic').catch(() => undefined), 5 * 60_000);
    this.reconcileTimer.unref?.();
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.orchestrator.stop();
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const t of this.turns.values()) t.abort.abort();
    await Promise.allSettled([...this.jobs.values()]);
  }
  pause(): void { this._paused = true; this.store.updateLocal({ engine: { ...this.store.local.engine, paused: true } }); this.emit({ type: 'engine.paused', paused: true }); this.note('warn', 'AUTOMATION PAUSED — running steps finish, nothing new starts'); }
  resume(): void { this._paused = false; this.store.updateLocal({ engine: { ...this.store.local.engine, paused: false } }); this.emit({ type: 'engine.paused', paused: false }); this.note('info', 'automation resumed'); this.orchestrator.kick(); void this.tick(); }
  poke(): void { void this.tick(); }
  sessions(): SessionView[] {
    return [...this.turns.entries()].map(([item, t]) => ({ item, session_id: this.store.getItem(item)?.file.frontmatter.session_id, model: t.model, op: t.phase, started_at: t.startedAt, busy: true, last_output: t.lastOutput }));
  }

  /** Run one scheduling pass. Idempotent; safe to call often. */
  async tick(): Promise<void> {
    if (this._paused || this.stopping) return;
    try {
      this.admit();
      this.nudgeStaleReviews();
      this.driveStaleBlocks();
      this.drivePlanReviews();
      this.drivePermissionReviews();
      await this.driveEpics();
      await this.driveExternal();
      this.driveInReview();
    } catch (e) { this.note('error', `tick: ${(e as Error).message}`); }
  }

  /** A review nobody has looked at for `review.nudge_after_min` wakes the orchestrator once — to remind, never to approve. */
  private nudgeStaleReviews(): void {
    const after = this.store.config.review.nudge_after_min * 60_000;
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.awaiting !== 'review' || fm.op_data?.review_nudged || Date.now() - new Date(fm.updated_at).getTime() < after) continue;
      this.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), review_nudged: true } } }], 'engine');
      this.wakeOrchestrator('review_pending', item.id, { waiting_min: Math.round((Date.now() - new Date(fm.updated_at).getTime()) / 60_000) });
    }
  }

  private admit(): void {
    const items = this.store.listItems();
    const active = items.filter((i) => (ACTIVE_FOR_SLOTS.includes(i.file.frontmatter.status) && !i.file.frontmatter.awaiting && !i.file.frontmatter.blocked) || this.turns.has(i.id)).length;
    let free = this.store.config.concurrency.max_sessions - active;
    for (const item of items) {
      if (free <= 0) break;
      const fm = item.file.frontmatter;
      if (fm.status !== 'QUEUED' || this.jobs.has(item.id)) continue;
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
   * An IN_PROGRESS worker item that is agent_blocked yet carries a done_summary finished after its
   * block (report_blocked drops any earlier summary), but nothing cleared the flag, so no turn end
   * ever ran the done check. Clear it and run that check: clean tree + commits ahead → pull request.
   */
  private driveStaleBlocks(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.status !== 'IN_PROGRESS' || !fm.blocked || fm.blocked_reason !== 'agent_blocked' || (fm.awaiting && fm.awaiting !== 'user')) continue;
      const done = fm.op_data?.done_summary as string | undefined;
      if (!done || !fm.worktree || this.store.derived(item).flavor !== 'worker' || this.jobs.has(item.id) || this.turns.has(item.id)) continue;
      this.store.mutateItem(item.id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }, { activity: { actor: 'app', text: 'cleared a stale agent_blocked flag (the session reported done after it); checking the work' } }], 'engine', { commit: `${item.id}: clear stale block` });
      this.runJob(item.id, () => this.afterWorkTurn(item.id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done }));
    }
  }

  // ---- plan approval delegated to the orchestrator ----
  /** The item opted in, the project allows it, and there is an orchestrator to ask. Never an epic's breakdown. */
  private planDelegated(fm: { kind?: string; auto_approve_plan?: boolean }): boolean {
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
      if (fm.status !== 'PLAN_READY' || fm.blocked || fm.awaiting_data?.kind === 'permission') continue;
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
      if (fm.blocked || !this.phaseFor(fm.status)) continue;
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

  private driveInReview(): void {
    const candidates = this.store.listItems().filter((item) => {
      const fm = item.file.frontmatter;
      if (fm.status !== 'IN_REVIEW' || fm.blocked || fm.awaiting || fm.skip_merge || this.jobs.has(item.id) || this.turns.has(item.id)) return false;
      if (fm.ci_result === 'green' || fm.ci_result === 'red' || fm.op_data?.needs_session_rebase) return false;
      const flavor = this.store.derived(item).flavor;
      if (flavor === 'external' && (fm.merge_policy ?? 'watch') === 'watch') return false; // watched: driveExternal observes it
      return true;
    }).sort((a, b) => {
      const fa = a.file.frontmatter, fb = b.file.frontmatter;
      return (fa.merge_order ?? Infinity) - (fb.merge_order ?? Infinity) || (fa.rank ?? Infinity) - (fb.rank ?? Infinity) || (fa.pr_created_at ?? '').localeCompare(fb.pr_created_at ?? '');
    });
    for (const item of candidates) this.runJob(item.id, () => this.mergeJob(item.id)); // mergeChain keeps them strictly serial, in this order
  }

  private followUps = new Map<string, () => Promise<unknown>>();

  private runJob(id: string, fn: () => Promise<unknown>): void {
    if (this.jobs.has(id)) return;
    const p = fn().then(() => undefined, (e) => { this.block(id, 'engine_error', (e as Error).message); }).finally(() => {
      this.jobs.delete(id);
      const next = this.followUps.get(id);
      if (next) { this.followUps.delete(id); this.runJob(id, next); }
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
    this.store.mutateItem(id, [{ set: { op: 'importing', op_started_at: this.now() } }], 'engine');
    for (const hook of kept ? [] : this.store.config.hooks.after_worktree_create) {
      const r = await this.withLocalJobSlot(() => this.ports.proc.run(hook, { cwd: dir, timeoutMs: 20 * 60_000 }));
      if (r.code !== 0) { this.store.journal.end(opId, id, 'failed', { hook, code: r.code }); this.block(id, 'hook_failed', `${hook} exited ${r.code}: ${r.stderr.slice(-400)}`); return; }
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `hook ok: ${hook}` } }], 'engine');
    }
    this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
    this.store.journal.end(opId, id, 'ok');
    await this.runTurnFor(id, 'plan', this.withDelivered(id, 'plan-item', this.store.renderPrompt('plan-item', this.store.requireItem(id))), [], [], { opener: true });
  }

  async approvePlan(id: string, notes?: string, by: 'user' | 'orchestrator' = 'user'): Promise<void> {
    const item = this.store.requireItem(id);
    if (item.file.frontmatter.kind === 'epic') { if (by !== 'user') throw new Error(`${id} is an epic: its breakdown is the user's to approve`); await this.approveBreakdown(id); return; }
    if (item.file.frontmatter.status !== 'PLAN_READY') throw new Error(`${id} is ${item.file.frontmatter.status}, not PLAN_READY`);
    const { plan_handed_back: _spent, ...opData } = item.file.frontmatter.op_data ?? {};
    this.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: by } },
      { set: { op_data: { ...opData, approval_notes: notes ?? '' } } },
      ...(by === 'orchestrator' ? [{ activity: { actor: by, text: `approved the plan on your behalf${notes ? `: ${notes}` : ''}` } }] : notes ? [{ activity: { actor: by, text: `approval notes: ${notes}` } }] : []),
    ], by, { commit: `${id}: approve plan${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    // queued, not dropped: the orchestrator can decide while the planner's turn is still ending
    this.queueFollowUp(id, () => this.runTurnFor(id, 'implement', this.withDelivered(id, 'implement-plan', this.store.renderPrompt('implement-plan', this.store.requireItem(id), { approval_notes: notes?.trim() || '(none)' })), [], [], { opener: true }));
  }

  async rejectPlan(id: string, message: string, by: 'user' | 'orchestrator' = 'user'): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.status !== 'PLAN_READY') throw new Error(`${id} is ${fm.status}, not PLAN_READY`);
    const round = (fm.plan_revisions ?? 0) + 1;
    this.store.mutateItem(id, [
      { transition: { to: 'PLAN_IN_PROGRESS', actor: by } },
      ...(by === 'orchestrator' ? [{ set: { plan_revisions: round } } as ItemOp] : []),
      { activity: { actor: by, text: by === 'orchestrator' ? `plan changes requested (fix round ${round} of ${this.store.config.orchestrator.max_plan_revisions}): ${message}` : `plan changes requested: ${message}` } },
    ], by, { commit: `${id}: request plan changes${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    const tool = item.file.frontmatter.kind === 'epic' ? 'submit_breakdown' : 'submit_plan';
    this.queueFollowUp(id, () => this.runTurnFor(id, 'plan', `${this.resumeNote(id, 'your plan review')}\n\nChanges requested on your plan:\n\n${message}\n\nRevise it accordingly and submit it again with the ${tool} tool, then end your turn.`));
  }

  async message(id: string, text: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) throw new Error(`${id} has no session to message in status ${fm.status}`);
    if (this.turns.has(id) || this.jobs.has(id)) {
      const pending = [...((fm.op_data?.pending_messages as string[] | undefined) ?? []), text];
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: pending } } }, { activity: { actor: 'user', text: `message queued: ${text}` } }], 'user');
      return;
    }
    if (fm.awaiting && fm.awaiting !== 'user') throw new Error(`${id} is awaiting ${fm.awaiting}; answer that first`);
    // A message that resumes a blocked session is the answer to the block (unblock-with-message
    // by another door). Leaving the flag set made afterTurn skip the finished turn, so a worker
    // that then reported done sat IN_PROGRESS as "blocked" forever and no PR was ever opened.
    this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data', ...(fm.blocked ? ['blocked', 'blocked_reason'] : [])] }, { activity: { actor: 'user', text: `message: ${text}` } }], 'user');
    this.runJob(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'a message from the user')}\n\nMessage from the user:\n\n${text}`));
  }

  async respond(id: string, payload: Record<string, unknown>, by: 'user' | 'orchestrator' = 'user'): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) throw new Error(`${id} is not in a session phase`);
    if (payload.kind === 'question') {
      if (fm.awaiting !== 'question') throw new Error(`${id} is not awaiting a question`);
      const answers = payload.answers as Record<string, string>;
      const text = Object.entries(answers).map(([q, a]) => `- Q: ${q}\n  A: ${a}`).join('\n');
      this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: 'user', text: `answered: ${Object.values(answers).join(' / ')}` } }], 'user', { commit: `${id}: answer questions` });
      this.queueFollowUp(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'your questions')}\n\nAnswers to your questions:\n\n${text}\n\nContinue.`));
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
      if (by === 'orchestrator' && decision === 'deny') ops.push({ set: { op_data: { ...(fm.op_data ?? {}), orchestrator_denials: Number(fm.op_data?.orchestrator_denials ?? 0) + 1 } } });
      if (decision === 'always' && !this.store.config.permissions.allow.includes(rule)) this.store.updateConfig((doc) => { doc.setIn(['permissions', 'allow'], [...this.store.config.permissions.allow, rule]); }, `config: always allow ${rule.slice(0, 60)}`);
      this.store.mutateItem(id, ops, by, { commit: `${id}: permission ${decision}${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
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

  // ---- turns ----
  private async runTurnFor(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[] = [], oneShotCommands: string[] = [], opts: { opener?: boolean } = {}): Promise<TurnResult | undefined> {
    const oneShot = new Set(oneShotCommands.map((c) => c.trim()));
    if (this.stopping) return undefined;
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    const cwd = this.absWorktree(fm.worktree!);
    const modelId = phase === 'plan' ? fm.planner : fm.implementer;
    const def = this.store.config.models.find((m) => m.id === modelId);
    if (!def) throw new Error(`unknown model ${modelId}`);
    const runner = def.runner ?? 'claude';
    if (phase === 'plan' && !canPlan(def)) { this.block(id, 'planner_cannot_plan', `${def.label} runs on ${runner}, which cannot plan; pick a Claude model as the planner`); return undefined; }
    const agent = this.ports.agents[runner];
    if (!agent) { this.block(id, 'runner_unavailable', `${def.label} needs the ${runner} runner, which is not available in this engine`); return undefined; }
    const model = runner === 'claude' ? def.claude_model : def[`${runner}_model`];
    if (runner === 'claude' && !model) throw new Error(`model ${modelId} has no claude_model`);
    // Runners that report tokens instead of dollars are budgeted in worker turns.
    const metered = runner === 'claude';
    if (!metered && (fm.agent_turns ?? 0) >= this.store.config.budget_turns_per_item) { this.block(id, 'turn_budget', `${def.label} has used ${fm.agent_turns} of ${this.store.config.budget_turns_per_item} turns on this item (budget_turns_per_item); raise it or take the item over by hand`); return undefined; }
    if (!metered && (fm.tokens ?? 0) >= this.store.config.budget_tokens_per_item) { this.block(id, 'token_budget', `${def.label} has used ${(fm.tokens ?? 0).toLocaleString()} of ${this.store.config.budget_tokens_per_item.toLocaleString()} tokens on this item (budget_tokens_per_item); raise it or take the item over by hand`); return undefined; }
    const resumeId = metered ? fm.session_id : fm.agent_sessions?.[runner];
    // "Continue where you left off" presumes a conversation to continue. When there is none — the
    // opening turn died before the agent heard the task, or the thread was lost — a fresh conversation
    // gets the phase's full prompt first, and the resume note after it.
    if (!resumeId && !opts.opener && (phase === 'plan' || phase === 'implement')) {
      const opener = phase === 'plan' ? this.withDelivered(id, 'plan-item', this.store.renderPrompt('plan-item', item)) : this.withDelivered(id, 'implement-plan', this.store.renderPrompt('implement-plan', item, { approval_notes: String(fm.op_data?.approval_notes ?? '').trim() || '(none)' }));
      prompt = `${opener}\n\n---\n\n${prompt}`;
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `no ${def.label} conversation to resume: starting a fresh one with the full ${phase} prompt` } }], 'engine');
    }
    const images = fm.attachments.map((a) => this.store.attachmentAbsPath(a)).filter((p) => /\.(png|jpe?g|webp|gif)$/i.test(p));
    const policy = makePolicy(this.store.config, d.base_branch!, cwd);
    const op = phase === 'plan' ? 'planning_turn' : 'implement_turn';
    const abort = new AbortController();
    const opId = this.store.journal.begin(op, id, { phase, model: model ?? def.label, runner });
    this.store.mutateItem(id, [{ set: { op, op_started_at: this.now() } }], 'engine');
    this.turns.set(id, { model: model ?? def.label, phase, startedAt: this.now(), lastOutput: '', abort });
    this.emit({ type: 'session.started', id, session_id: fm.session_id });
    const budgetLeft = Math.max(0.5, this.store.config.budget_usd_per_item - (fm.cost_usd ?? 0));
    let result: TurnResult;
    try {
      result = await this.withRunnerSlot(runner, () => agent.runTurn({
        itemId: id, phase, cwd, model: model as string, permissionMode: phase === 'plan' ? 'plan' : 'acceptEdits', prompt, resume: resumeId, images,
        systemAppend: this.store.renderPrompt(metered ? 'worker-system' : `worker-system-${runner}`, item),
        allowedTools: [...BASE_ALLOWED[phase], ...this.store.config.permissions.allow, ...extraAllowed],
        extraDirs: [this.store.dataDir], maxBudgetUsd: budgetLeft,
        tools: this.makeTools(id),
        onPermission: async (req) => {
          const why = policy.deny(req);
          if (why) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `denied ${req.tool}: ${why}` } }], 'engine'); return { action: 'deny', message: `Not allowed: ${why}` }; }
          if (req.tool === 'Bash' && oneShot.delete(String(req.input.command ?? '').trim())) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'one-shot approval consumed' } }], 'engine'); return { action: 'allow' }; }
          if (allowedByRules(req, [...BASE_ALLOWED[phase], ...this.store.config.permissions.allow, ...extraAllowed])) return { action: 'allow' };
          const ask = this.permissionsDelegated() && this.mayAskOrchestrator(this.store.requireItem(id).file.frontmatter);
          this.store.mutateItem(id, [{ set: { awaiting: ask ? 'orchestrator' : 'permission', awaiting_data: { ...(ask ? { kind: 'permission' } : {}), tool: req.tool, input: req.input, requested_at: this.now() } } }, { activity: { actor: 'app', text: `parked: permission for ${req.tool} ${String(req.input.command ?? req.input.file_path ?? '').slice(0, 80)}${ask ? ' (asking the orchestrator)' : ''}` } }], 'engine', { commit: `${id}: awaiting permission` });
          if (ask) this.wakeOrchestrator('permission_request', id);
          return { action: 'park' };
        },
        onQuestion: async (questions) => {
          this.store.mutateItem(id, [{ set: { awaiting: 'question', awaiting_data: { questions, requested_at: this.now() } } }, { activity: { actor: 'app', text: `parked: agent asked ${questions.length} question(s)` } }], 'engine', { commit: `${id}: awaiting answers` });
        },
        onOutput: (text) => { const t = this.turns.get(id); if (t) t.lastOutput = text.slice(-400); this.emit({ type: 'session.output', id, text }); },
        signal: abort.signal,
      }));
    } finally {
      this.turns.delete(id);
    }
    const after = this.store.requireItem(id).file.frontmatter;
    this.store.mutateItem(id, [
      { set: {
        ...(metered ? { session_id: result.sessionId ?? after.session_id } : result.sessionId ? { agent_sessions: { ...(after.agent_sessions ?? {}), [runner]: result.sessionId } } : {}),
        cost_usd: Math.round(((after.cost_usd ?? 0) + result.costUsd) * 10000) / 10000, turns: (after.turns ?? 0) + result.numTurns,
        ...(metered ? {} : { agent_turns: (after.agent_turns ?? 0) + 1 }),
        ...(result.tokens ? { tokens: (after.tokens ?? 0) + result.tokens } : {}),
      } },
      // A turn killed by stop() keeps its op: that is what resumeInterrupted looks for at the next
      // start. Cleared, the item sat in its phase with nothing to resume it, holding a session slot.
      ...(after.op === op && !(result.subtype === 'killed' && this.stopping) ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
    ], 'engine');
    this.store.journal.end(opId, id, result.isError ? 'failed' : 'ok', { subtype: result.subtype, cost: result.costUsd, parked: result.parked });
    this.emit({ type: 'session.ended', id, subtype: result.subtype });
    if (result.subtype === 'killed') { this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'turn interrupted (engine stopping); resumable' } }], 'engine'); return result; }
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
    // the worker proceeded without it. Clear it instead of stalling on a moot prompt.
    if ((fm.awaiting === 'permission' || (fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission')) && (result.done || result.planSubmitted)) {
      this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: 'app', text: 'cleared a stale permission request (the turn finished its work without it)' } }], 'engine');
      fm = this.store.requireItem(id).file.frontmatter;
    }
    // Same for an agent_blocked flag the worker outlived: it was resumed, did not block again this
    // turn and reported done. Whatever door resumed it, the block is answered.
    if (fm.blocked && fm.blocked_reason === 'agent_blocked' && result.done && !result.blocked) {
      this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }, { activity: { actor: 'app', text: 'cleared a stale agent_blocked flag (the resumed session reported done)' } }], 'engine');
      fm = this.store.requireItem(id).file.frontmatter;
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
      if (fm.status === 'PLAN_IN_PROGRESS' && !result.planSubmitted) this.block(id, 'no_plan', 'the planner ended its turn without submitting a plan');
      return;
    }
    await this.afterWorkTurn(id, phase, result);
  }

  /** Deterministic "is it really done": clean tree + commits ahead of the base. */
  private async afterWorkTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    const { clean, dirty } = await this.ports.git.status(cwd);
    if (!clean) {
      const tries = Number(fm.op_data?.dirty_tree_turns ?? 0) + 1;
      if (tries > 2) { this.block(id, 'dirty_tree', `the worktree still has uncommitted changes after ${tries - 1} reminders: ${dirty.slice(0, 5).join(', ')}`); return; }
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), dirty_tree_turns: tries } } }, { activity: { actor: 'app', text: `worktree dirty after turn (${dirty.length} files); asking the session to commit` } }], 'engine');
      await this.runTurnFor(id, phase, this.store.renderPrompt('commit-dirty-tree', item, { dirty_files: dirty.join('\n') }));
      return;
    }
    await this.ports.git.fetch(this.repo);
    const { ahead } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    if (fm.status === 'IN_PROGRESS') {
      if (ahead === 0) { this.block(id, 'no_commits', 'the session reported done but the branch has no commits ahead of its base'); return; }
      if (await this.blockOversize(id)) return;
      if (!result.done) this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'turn ended with commits but without report_done; proceeding to a pull request' } }], 'engine');
      await this.openPr(id, result.done);
      return;
    }
    if (fm.status === 'IN_REVIEW') {
      if (await this.blockOversize(id)) return;
      const head = await this.ports.git.revParse(cwd, 'HEAD');
      const moved = head !== fm.ci_head_sha;
      this.store.mutateItem(id, [
        { set: { ci_result: 'pending', op_data: { ...(fm.op_data ?? {}), needs_session_rebase: false } } },
        { activity: { actor: 'app', text: moved ? `session updated the branch (${head.slice(0, 7)}); re-entering the merge pipeline` : 'session finished without changing the branch; re-checking' } },
      ], 'engine');
      void this.tick();
    }
  }

  private async openPr(id: string, summary?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    const implementer = this.store.config.models.find((m) => m.id === fm.implementer);
    const held = Boolean(implementer?.hold_for_review);
    const opId = this.store.journal.begin('creating_pr', id, { branch: fm.branch, base });
    this.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.now() } }], 'engine');
    await this.ports.git.pushSetUpstream(cwd, fm.branch!);
    this.store.mutateItem(id, [{ set: { op: 'creating_pr', op_started_at: this.now() } }], 'engine');
    const existing = (await this.ports.gh.prList(this.github, { head: fm.branch!, state: 'open' }))[0];
    const pr = existing ? { number: existing.number, url: existing.url } : await this.ports.gh.createPr(this.github, {
      base, head: fm.branch!, title: `${fm.title} (${id})`,
      body: `${summary ?? getSection(item.file, 'Description').slice(0, 1500)}\n\n---\nplanestro item **${id}** · plan:\n\n${getSection(item.file, 'Plan').slice(0, 3000)}\n\n🤖 Opened by planestro`,
    });
    this.store.mutateItem(id, [
      { transition: { to: 'IN_REVIEW', actor: 'engine' } },
      { set: { pr: pr.number, ci_result: 'pending', ...(held ? { review_hold: true } : {}) } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `opened PR #${pr.number} → ${base} (${pr.url})` } },
      ...(held ? [{ activity: { actor: 'app' as const, text: `will wait for your review before merging: ${implementer!.label} is a hold_for_review model` } }] : []),
    ], 'engine', { commit: `${id}: open PR #${pr.number}` });
    this.store.journal.end(opId, id, 'ok', { pr: pr.number });
    this.note('info', `${id}: PR #${pr.number} opened against ${base}`);
    this.wakeOrchestrator('pr_opened', id);
    void this.tick();
  }

  // ---- merge pipeline (serial) ----
  private mergeJob(id: string): Promise<void> {
    const run = this.mergeChain.then(() => this.mergeStep(id));
    this.mergeChain = run.catch(() => undefined);
    return run;
  }

  private async mergeStep(id: string): Promise<void> {
    if (this._paused || this.stopping) return;
    let item = this.store.requireItem(id);
    let fm = item.file.frontmatter;
    if (fm.status !== 'IN_REVIEW' || fm.blocked || fm.awaiting) return;
    const d = this.store.derived(item);
    const base = d.base_branch!;
    const integration = fm.kind === 'epic';
    const canFix = d.flavor === 'worker';
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
    const opId = this.store.journal.begin('merge', id, { pr: fm.pr, base });

    if (cfg.require_green_base) {
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
    const { clean } = await this.ports.git.status(cwd);
    if (!clean) { this.store.journal.end(opId, id, 'aborted', { reason: 'dirty' }); this.block(id, 'dirty_tree', 'the worktree has uncommitted changes; it cannot be synced'); return; }
    const baseSha = await this.ports.git.revParse(this.repo, `origin/${base}`);
    const expected = await this.ports.git.remoteBranchSha(this.repo, fm.branch!);
    const localHead = await this.ports.git.revParse(cwd, 'HEAD');
    const { behind } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    let headSha: string;
    if (behind === 0 && expected === localHead) {
      // Already on the base tip and the remote matches: there is nothing to sync, and the CI
      // run for this head is still the truth. Re-pushing the same commit bought nothing, and
      // rebasing here whenever an item merely entered the pipeline is what made every open
      // PR re-run CI after every merge.
      headSha = localHead;
      this.store.mutateItem(id, [{ set: { op: 'awaiting_ci', op_started_at: this.now(), ci_head_sha: headSha, ci_result: 'pending' } }, { activity: { actor: 'app', text: `already on ${base}@${baseSha.slice(0, 7)}; no sync needed, reusing CI for ${headSha.slice(0, 7)}; waiting for CI` } }], 'engine');
    } else {
      const sync = integration ? await this.ports.git.merge(cwd, `origin/${base}`) : await this.ports.git.rebase(cwd, `origin/${base}`);
      if (!sync.ok) {
        this.store.mutateItem(id, [
          { unset: ['op', 'op_started_at'] },
          { set: { ci_result: 'unknown', op_data: { ...(fm.op_data ?? {}), needs_session_rebase: canFix } } },
          { activity: { actor: 'app', text: `${integration ? 'merge of' : 'rebase onto'} origin/${base} (${baseSha.slice(0, 7)}) conflicted in ${sync.conflicts.join(', ')}${canFix ? '; handing to the session' : ''}` } },
        ], 'engine', { commit: `${id}: ${integration ? 'merge' : 'rebase'} conflict` });
        this.store.journal.end(opId, id, 'aborted', { reason: 'conflict', files: sync.conflicts });
        if (canFix) this.queueFollowUp(id, () => this.runTurnFor(id, 'fix', this.store.renderPrompt('rebase-conflict', this.store.requireItem(id), { conflict_files: sync.conflicts.join('\n'), base_sha: baseSha.slice(0, 12) })));
        else this.block(id, 'sync_conflict', `conflicts with ${base} in ${sync.conflicts.join(', ')} and no session to hand them to; resolve by hand`);
        return;
      }

      // 2. push (integration branches push plainly; worker branches force-with-lease their rebase)
      this.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.now() } }], 'engine');
      if (integration) await this.ports.git.pushSetUpstream(cwd, fm.branch!);
      else await this.ports.git.pushForceWithLease(cwd, fm.branch!, expected);
      headSha = sync.head;
      this.store.mutateItem(id, [{ set: { op: 'awaiting_ci', op_started_at: this.now(), ci_head_sha: headSha, ci_result: 'pending' } }, { activity: { actor: 'app', text: `rebased onto ${base}@${baseSha.slice(0, 7)} and pushed ${headSha.slice(0, 7)}; waiting for CI` } }], 'engine');
    }

    // 3. wait for CI. `expected` is the head the push replaced: GitHub keeps reporting it for a
    // few seconds, and that must read as propagation lag, not as someone moving the branch.
    const verdict = await this.waitForCi(id, fm.branch!, headSha, fm.pr!, expected);
    if (verdict === 'moved') { this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }], 'engine'); this.store.journal.end(opId, id, 'aborted', { reason: 'head_moved' }); void this.tick(); return; }
    // The engine is stopping, which says nothing about CI: leave `op: awaiting_ci` on the item, and the next start re-enters the pipeline.
    if (verdict === 'stopping') { this.store.journal.end(opId, id, 'aborted', { reason: 'engine_stopping' }); return; }
    if (verdict === 'timeout') { this.store.journal.end(opId, id, 'aborted', { reason: 'ci_timeout' }); this.block(id, 'ci_timeout', `CI for ${headSha.slice(0, 7)} did not finish within ${cfg.timeout_min} min`); return; }
    if (verdict === 'blocked') {
      if (cfg.mode === 'github-or-local' && cfg.local_check_command) {
        this.store.mutateItem(id, [{ set: { op: 'running_local_checks', op_started_at: this.now() } }, { activity: { actor: 'app', text: `GitHub Actions is blocked; running local gate: ${cfg.local_check_command}` } }], 'engine');
        const r = await this.withLocalJobSlot(() => this.ports.proc.run(cfg.local_check_command!, { cwd, timeoutMs: cfg.timeout_min * 60_000 }));
        if (r.code !== 0) { await this.onCiRed(id, opId, headSha, `local checks exited ${r.code}\n${(r.stdout + r.stderr).split('\n').filter((l) => /FAIL|Error/i.test(l)).slice(-40).join('\n')}`, 'local'); return; }
        this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'local checks passed (used as the CI gate)' } }], 'engine');
      } else { this.store.journal.end(opId, id, 'aborted', { reason: 'ci_blocked' }); this.block(id, 'ci_blocked', 'GitHub Actions did not run (billing blocked or workflow missing); set ci.mode to github-or-local with a local_check_command, or re-run by hand'); return; }
    }
    if (verdict === 'red') { await this.onCiRed(id, opId, headSha, undefined, 'github', canFix); return; }

    // 4. merge — re-check the holds: a skip_merge/block may have landed while we waited on CI
    const latest = this.store.requireItem(id).file.frontmatter;
    if (latest.review_hold && !latest.skip_merge && !latest.blocked && !latest.awaiting) {
      // Synced and green: everything a machine can check has passed. What is left is a person's eye.
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'green', awaiting: 'review' } }, { activity: { actor: 'app', text: 'CI is green; waiting for your review before merging' } }], 'engine', { commit: `${id}: awaiting review` });
      this.store.journal.end(opId, id, 'aborted', { reason: 'awaiting_review' });
      return;
    }
    if (latest.skip_merge || latest.blocked || latest.awaiting) {
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'green' } }, { activity: { actor: 'app', text: `CI is green but the item is held (${latest.skip_merge ? 'skip_merge' : latest.blocked ? 'blocked' : 'awaiting ' + latest.awaiting}); not merging` } }], 'engine');
      this.store.journal.end(opId, id, 'aborted', { reason: 'held_after_ci' });
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
    const notify = this.store.config.notifications.on_merge;
    if (notify) void this.ports.proc.run(notify, { cwd: this.repo, timeoutMs: 30_000 });
    await this.cleanup(id);
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
    if (!canFix) { this.block(id, 'ci_red', 'CI is red and there is no session to hand the failure to; investigate by hand'); return; }
    if (count >= 2) { this.block(id, 'ci_red_twice', `CI failed ${count} times`); this.wakeOrchestrator('ci_red_again', id, { failed_log: log.slice(0, 3000) }); return; }
    this.queueFollowUp(id, () => this.runTurnFor(id, 'fix', this.store.renderPrompt('ci-failed', this.store.requireItem(id), { ci: { attempt: String(count), run_url: ci?.url ?? '(local run)', failed_log: log } })));
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
  private async waitForCi(id: string, branch: string, sha: string, pr: number, previousSha: string | null = null): Promise<'green' | 'red' | 'blocked' | 'moved' | 'timeout' | 'stopping'> {
    const cfg = this.store.config.ci;
    const started = Date.now();
    let sawRun = false;
    while (true) {
      if (this.stopping) return 'stopping';
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
      if (ci.runId) { sawRun = true; const cur = this.store.requireItem(id).file.frontmatter; if ((cur.op_data?.ci as any)?.runId !== ci.runId) this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci: { runId: ci.runId, url: ci.url } } } }], 'engine'); }
      if (ci.state === 'success') return 'green';
      if (ci.state === 'failure') return (ci.runId && await this.ports.gh.isBillingBlocked(this.github, ci.runId)) ? 'blocked' : 'red';
      if (ci.state === 'cancelled') { /* superseded; keep polling for the new run */ }
      if (ci.state === 'none' && !sawRun && elapsedMin > cfg.start_timeout_min) return 'blocked';
      if (elapsedMin > cfg.timeout_min) return 'timeout';
      await this.sleep(elapsedMin < 2 ? 10_000 : 30_000);
    }
  }

  private async cleanup(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
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
    const tip = fm.ci_head_sha ?? await this.ports.git.revParse(cwd, 'HEAD');
    const reachable = await this.ports.git.isAncestor(this.repo, tip, `origin/${base}`);
    if (view.state !== 'MERGED' || !reachable) { this.store.journal.end(opId, id, 'aborted', { reason: 'unverifiable' }); this.block(id, 'cleanup_unverifiable', `cannot prove ${tip.slice(0, 7)} is reachable from origin/${base} (PR ${view.state}); nothing was deleted`); return; }
    const { clean } = await this.ports.git.status(cwd).catch(() => ({ clean: true }));
    if (!clean) { this.store.journal.end(opId, id, 'aborted', { reason: 'dirty' }); this.block(id, 'cleanup_dirty', 'the worktree has uncommitted changes after the merge; remove it by hand or discard them'); return; }
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
            if (wtAbs && wtEntry && await this.ports.git.inProgressOp(wtAbs)) { await this.ports.git.abortInProgress(wtAbs); correct(id, `aborted a half-done ${fm.op} left by a crash`, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }]); }
            else correct(id, `cleared stale op ${fm.op}`, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }]);
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
        if (fm.pr && github && (fm.status === 'IN_REVIEW' || fm.status === 'MERGED' || fm.status === 'IN_PROGRESS')) {
          const pr = await this.ports.gh.prView(github, fm.pr).catch(() => undefined);
          if (pr?.state === 'MERGED' && (fm.status === 'IN_REVIEW' || fm.status === 'IN_PROGRESS')) {
            if (fm.status === 'IN_PROGRESS') this.store.mutateItem(id, [{ transition: { to: 'IN_REVIEW', actor: 'engine' } }], 'engine');
            correct(id, `PR #${fm.pr} was merged outside planestro`, [{ transition: { to: 'MERGED', actor: 'engine' } }, { set: { merged_at: pr.mergedAt ? isoLocal(new Date(pr.mergedAt)) : this.now(), ci_result: 'green' } }]);
            this.runJob(id, () => this.cleanup(id));
          } else if (pr?.state === 'CLOSED' && fm.status === 'IN_REVIEW' && !fm.blocked) {
            this.block(id, 'pr_closed_externally', `PR #${fm.pr} was closed without merging`);
            corrections.push(`${id}: PR #${fm.pr} closed externally`);
          } else if (pr?.state === 'OPEN' && fm.status === 'IN_REVIEW' && fm.ci_head_sha && pr.headRefOid !== fm.ci_head_sha && fm.ci_result !== 'pending') {
            correct(id, `branch tip moved (${pr.headRefOid.slice(0, 7)}); CI verdict discarded`, [{ set: { ci_result: 'pending' } }]);
          }
        }
        // worktree truth (never recreate silently: local commits could be lost)
        if (d.flavor === 'worker' && wtAbs && !wtEntry && ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'].includes(fm.status) && !fm.blocked) {
          this.block(id, 'worktree_missing', `the worktree ${fm.worktree} no longer exists; status preserved, nothing recreated`);
          corrections.push(`${id}: worktree missing`);
        }
        // MERGED but never finished, or FINISHED leftovers
        if (fm.status === 'MERGED' && !fm.op && !this.jobs.has(id) && !fm.blocked) { corrections.push(`${id}: resuming cleanup`); this.runJob(id, () => this.cleanup(id)); }
        if (fm.status === 'FINISHED' && fm.branch && d.flavor !== 'external' && remoteHeads.has(fm.branch)) correct(id, `remote branch ${fm.branch} still exists after finish (left in place; delete by hand or re-run cleanup)`);
      } catch (e) { corrections.push(`${id}: reconcile error ${(e as Error).message}`); }
    }
    // orphans: worktrees under our root that no item references
    const root = this.store.worktreesRoot();
    const referenced = new Set(this.store.listItems().map((i) => i.file.frontmatter.worktree && this.absWorktree(i.file.frontmatter.worktree!)).filter(Boolean));
    const orphans = worktrees.filter((w) => w.path.startsWith(root + '/') && !referenced.has(w.path));
    if (orphans.length) {
      corrections.push(`orphan worktrees: ${orphans.map((o) => o.path).join(', ')}`);
      // Wake the orchestrator only when the orphan set CHANGES — a wake per reconcile pass
      // would re-ask the same question every five minutes and burn a model turn each time.
      const key = orphans.map((o) => o.path).sort().join('|');
      const last = this.store.journal.read({ type: 'reconcile.orphans_reported', limit: 1 })[0];
      if (last?.data?.key !== key) {
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
        this.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }, { activity: { actor: 'app', text: `turn (${fm.op}) was interrupted by a restart; resuming` } }], 'engine');
        if (phase && !fm.awaiting && !fm.blocked) this.runJob(item.id, () => this.runTurnFor(item.id, phase, `${this.resumeNote(item.id, 'a planestro restart')}\n\nYour previous turn was interrupted before it finished. Check the state of your worktree and continue where you left off.`));
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

  async planEpic(id: string): Promise<void> {
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
      { activity: { actor: 'app', text: `planning the breakdown in a read-only checkout of origin/${base} (${worktreeRel})` } },
    ], 'user', { commit: `${id}: plan the breakdown` });
    this.runJob(id, async () => {
      await this.ports.git.fetch(this.repo);
      if (!(await this.ports.git.worktreeList(this.repo)).some((w) => w.path === dir && !w.prunable)) await this.ports.git.worktreeAddDetached(this.repo, dir, `origin/${base}`);
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
      const implementers = this.store.config.models.filter((m) => !m.external).map((m) => `- \`${m.id}\` — ${m.label} (runner ${m.runner ?? 'claude'}): ${m.description ?? (canPlan(m) ? 'general software work: code, tests, docs. Cannot generate images.' : 'no description configured')}`).join('\n');
      await this.runTurnFor(id, 'plan', this.store.renderPrompt('plan-epic', this.store.requireItem(id), { implementers, categories: this.store.config.categories.join(', ') }), [], [], { opener: true });
    });
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
      const child = this.store.createItem({ title: c.title.trim(), description: c.description.trim(), category: c.category ?? fm.category, implementer: c.implementer, parent: id, depends_on: (c.depends_on ?? []).map((d) => ids.get(d)!) }, 'user');
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
      if (!children.every((c) => c.status === 'MERGED' || c.status === 'FINISHED')) continue;
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
    ], 'engine', { commit: `${id}: open PR #${pr.number}` });
    this.store.journal.end(opId, id, 'ok', { pr: pr.number });
    void this.tick();
  }

  /** Deterministic "Sync with base": merge origin/<base> into the integration branch and push plainly. */
  async syncBase(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic' || fm.status !== 'IN_PROGRESS' || !fm.branch) throw new Error(`${id} is not an open epic`);
    const base = this.store.derived(item).base_branch!;
    const dir = fm.worktree ? this.absWorktree(fm.worktree) : join(this.store.worktreesRoot(), `merge-${id.toLowerCase()}`);
    const opId = this.store.journal.begin('syncing_base', id, { base });
    this.store.mutateItem(id, [{ set: { op: 'syncing_base', op_started_at: this.now(), ...(fm.worktree ? {} : { worktree: dir }) } }], 'engine');
    await this.ports.git.fetch(this.repo);
    await this.ports.git.worktreeAdd(this.repo, dir, fm.branch, `origin/${fm.branch}`);
    const sync = await this.ports.git.merge(dir, `origin/${base}`);
    if (!sync.ok) { this.store.journal.end(opId, id, 'aborted', { reason: 'conflict' }); this.block(id, 'sync_conflict', `merging ${base} into ${fm.branch} conflicted in ${sync.conflicts.join(', ')}; resolve by hand in ${dir}`); return; }
    await this.ports.git.pushSetUpstream(dir, fm.branch);
    this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { activity: { actor: 'app', text: `merged origin/${base} into ${fm.branch} and pushed (${sync.head.slice(0, 7)})` } }], 'engine', { commit: `${id}: sync with ${base}` });
    this.store.journal.end(opId, id, 'ok');
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
          const notify = this.store.config.notifications.on_merge;
          if (notify) void this.ports.proc.run(notify, { cwd: this.repo, timeoutMs: 30_000 });
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
    return {
      submit_breakdown: async (plan, children) => {
        const cur = s.requireItem(id).file.frontmatter;
        if (cur.kind !== 'epic') return 'Rejected: this item is not an epic. Hand in your plan with submit_plan.';
        const problem = validateBreakdown(children, s.config.models, s.config.categories);
        if (problem) { s.mutateItem(id, [{ activity: { actor: 'app', text: `breakdown rejected back to the planner: ${problem}` } }], 'engine'); return `Rejected: ${problem}. Fix that and call submit_breakdown again.`; }
        const ops: ItemOp[] = [{ section: 'Plan', body: plan }];
        if (cur.blocked && cur.blocked_reason === 'no_plan') ops.push({ unset: ['blocked', 'blocked_reason'] });
        if (cur.status === 'PLAN_IN_PROGRESS') ops.push({ transition: { to: 'PLAN_READY', actor: 'engine' } });
        ops.push({ set: { awaiting_data: { children, requested_at: this.now() } } });
        s.mutateItem(id, ops, 'engine', { commit: `${id}: submit breakdown` });
        this.note('info', `${id}: breakdown of ${(children as unknown[]).length} children submitted — needs your approval`);
        return 'Breakdown recorded by planestro. End your turn now; the user will review the children.';
      },
      submit_plan: async (plan) => {
        const cur = s.requireItem(id).file.frontmatter;
        if (cur.kind === 'epic') return 'Rejected: this is an epic. Hand in its children with submit_breakdown.';
        const ops: ItemOp[] = [{ section: 'Plan', body: plan }];
        // The planner went on without the permission it had asked for: that request is moot, and must not be mistaken for the plan's own wait.
        if (cur.awaiting === 'permission' || cur.awaiting_data?.kind === 'permission') ops.push({ unset: ['awaiting', 'awaiting_data'] });
        // A late submit cures a no_plan block (e.g. after an MCP transport failure ate the first attempt).
        if (cur.blocked && cur.blocked_reason === 'no_plan') ops.push({ unset: ['blocked', 'blocked_reason'] });
        const delegated = cur.status === 'PLAN_IN_PROGRESS' && this.planDelegated(cur);
        if (cur.status === 'PLAN_IN_PROGRESS') ops.push({ transition: { to: 'PLAN_READY', actor: 'engine' } });
        // A new plan is a new decision: whoever had it last time, it starts with the orchestrator again if delegated.
        const { plan_handed_back: _spent, ...opData } = cur.op_data ?? {};
        if (cur.op_data?.plan_handed_back) ops.push({ set: { op_data: opData } });
        if (delegated) ops.push({ set: { awaiting: 'orchestrator' } });
        s.mutateItem(id, ops, 'engine', { commit: `${id}: submit plan` });
        this.note('info', `${id}: plan submitted — ${delegated ? 'the orchestrator decides (you asked it to)' : 'needs your approval'}`);
        this.wakeOrchestrator('plan_review', id);
        return 'Plan recorded by planestro. End your turn now; you will be resumed once it is approved.';
      },
      add_note: async (markdown) => { const cur = getSection(s.requireItem(id).file, 'Notes'); s.mutateItem(id, [{ section: 'Notes', body: cur ? `${cur}\n\n${markdown}` : markdown }], 'engine', { commit: `${id}: worker note` }); return 'Note recorded.'; },
      append_activity: async (text) => { s.mutateItem(id, [{ activity: { actor: 'worker', text } }], 'engine'); return 'Recorded.'; },
      report_done: async (summary) => { const cur = s.requireItem(id).file.frontmatter; s.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), done_summary: summary } } }, { activity: { actor: 'worker', text: `done: ${summary.slice(0, 300)}` } }], 'engine'); return 'Recorded. End your turn now.'; },
      report_blocked: async (reason) => {
        const cur = s.requireItem(id).file.frontmatter;
        if (cur.op_data?.done_summary !== undefined) { const { done_summary: _withdrawn, ...rest } = cur.op_data; s.mutateItem(id, [{ set: { op_data: rest } }], 'engine'); }
        this.block(id, 'agent_blocked', reason, 'user'); return 'Recorded. End your turn now; planestro will resume you with the answer.';
      },
      hand_off: async (to, paths, note) => this.handOff(id, to, paths, note, 'worker'),
      get_item: async () => serializeItemFile(s.requireItem(id).file),
    };
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
      if (this.turns.has(to) || this.jobs.has(to) || (cur.awaiting && cur.awaiting !== 'user')) {
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

  private block(id: string, reason: string, detail: string, awaiting: 'user' | undefined = 'user'): void {
    try {
      const cur = this.store.requireItem(id).file.frontmatter;
      this.store.mutateItem(id, [
        { set: { blocked: true, blocked_reason: reason, ...(awaiting ? { awaiting } : {}) } },
        ...(cur.op ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
        { activity: { actor: 'app', text: `BLOCKED (${reason}): ${detail.replace(/\s+/g, ' ').slice(0, 500)}` } },
      ], 'engine', { commit: `${id}: blocked (${reason})` });
      this.note('warn', `${id} blocked: ${reason} — ${detail.slice(0, 200)}`);
      if ((JUDGMENT_BLOCKS as readonly string[]).includes(reason)) this.wakeOrchestrator(`blocked_${reason}`, id, { detail: detail.slice(0, 2000) });
    } catch (e) { this.note('error', `could not record block on ${id}: ${(e as Error).message}`); }
  }

  /** User-driven unblock: clears the flag and, if the item is in a session phase, resumes with a message. */
  async unblock(id: string, message?: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }, { activity: { actor: 'user', text: `unblocked${message ? `: ${message}` : ''}` } }], 'user', { commit: `${id}: unblock` });
    const phase = this.phaseFor(fm.status);
    if (message && phase) this.runJob(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'a decision from the user')}\n\n${message}`));
    else void this.tick();
  }

  private async deliveredBy(id: string): Promise<ReviewImage[] | undefined> {
    const refs = this.reviewRefs(id);
    if (!refs) return undefined;
    const files = (await this.ports.git.changedFiles(refs.cwd, refs.base, refs.head)).slice(0, 200);
    return Promise.all(files.map(async (f) => ({ ...f, ...(f.change !== 'deleted' && /\.png$/i.test(f.path) ? pngSize(await this.ports.git.readBlob(refs.cwd, refs.head, f.path)) : {}) })));
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
    const limit = this.store.config.review.max_file_bytes;
    const big = (await this.ports.git.changedFiles(refs.cwd, refs.base, refs.head).catch(() => [])).filter((f) => (f.bytes ?? 0) > limit);
    if (!big.length) return false;
    this.block(id, 'asset_too_large', `${big.map((f) => `${f.path} (${Math.round((f.bytes ?? 0) / 1e6 * 10) / 10} MB)`).join(', ')} exceed${big.length === 1 ? 's' : ''} review.max_file_bytes (${Math.round(limit / 1e6 * 10) / 10} MB); shrink it, or raise the limit`);
    return true;
  }

  async reviewImages(id: string): Promise<ReviewImage[]> {
    const refs = this.reviewRefs(id);
    if (!refs) return [];
    const files = (await this.ports.git.changedFiles(refs.cwd, refs.base, refs.head).catch(() => [])).filter((f) => IMAGE_FILE.test(f.path));
    return Promise.all(files.map(async (f) => ({ ...f, ...(f.change !== 'deleted' && /\.png$/i.test(f.path) ? pngSize(await this.ports.git.readBlob(refs.cwd, refs.head, f.path)) : {}) })));
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
    if (!note.trim()) throw new Error('say what should change');
    this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { set: { op_data: { ...(fm.op_data ?? {}), review_nudged: false } } }, { activity: { actor: 'user', text: `review: changes requested: ${note.trim()}` } }], 'user', { commit: `${id}: request review changes` });
    this.runJob(id, () => this.runTurnFor(id, 'fix', `${this.resumeNote(id, 'your review')}\n\nThe user reviewed what you delivered and asks for changes:\n\n${note.trim()}\n\nRevise it in your worktree, commit on your branch, leave the tree clean, and finish as before. It will come back to the user for another look.`));
  }

  /**
   * Let a held pull request merge: a review hold the user has now approved, or a plain `skip_merge`.
   * The item goes back through the merge pipeline rather than straight to the merge — the base may
   * have moved while it waited — so a CI result from before the hold is asked for again.
   */
  async releaseHold(id: string, note?: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.status !== 'IN_REVIEW') throw new Error(`${id} is ${fm.status}; only an item in review can be released to merge`);
    if (!fm.review_hold && !fm.skip_merge) throw new Error(`${id} is not held`);
    if (fm.awaiting && fm.awaiting !== 'review') throw new Error(`${id} is awaiting ${fm.awaiting}; answer that first`);
    this.store.mutateItem(id, [
      { unset: ['review_hold', 'skip_merge', ...(fm.awaiting === 'review' ? ['awaiting', 'awaiting_data'] : [])] },
      { set: { ci_result: 'pending' } },
      { activity: { actor: 'user', text: `approved for merge${note?.trim() ? `: ${note.trim()}` : ''}` } },
    ], 'user', { commit: `${id}: release hold` });
    void this.tick();
  }

  /**
   * User-driven "close as done": the work landed some other way, so the item finishes without a
   * pull request. The worktree and branch are removed only on positive evidence that they hold
   * nothing (invariant 7: a clean tree and no commit ahead of a freshly fetched base); anything
   * else is left in place and named in the Activity log — closing never discards work.
   */
  async closeAsDone(id: string, reason?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    if (!findTransition(fm.status, 'FINISHED', 'user', d.flavor)) throw new Error(`${id} is ${fm.status}; it cannot be closed as done from there`);
    if (fm.pr) throw new Error(`${id} has pull request #${fm.pr}; merge or close that instead`);
    if (this.turns.has(id) || this.jobs.has(id)) throw new Error(`${id} has a step running; wait for it to park, then close it`);
    const left = d.flavor === 'worker' && fm.worktree && fm.branch ? await this.releaseUnusedWorktree(this.absWorktree(fm.worktree), fm.branch, d.base_branch) : undefined;
    this.store.mutateItem(id, [
      { transition: { to: 'FINISHED', actor: 'user' } },
      { activity: { actor: 'user', text: `closed as done without a pull request${reason?.trim() ? `: ${reason.trim()}` : ''}` } },
      ...(left ? [{ activity: { actor: 'app' as const, text: left } }] : []),
    ], 'user', { commit: `${id}: close as done` });
    this.note('info', `${id}: closed as done`);
    void this.tick();
  }

  /** Returns the Activity line describing what was removed, or what was left in place and why. */
  private async releaseUnusedWorktree(cwd: string, branch: string, base: string | undefined): Promise<string> {
    const keep = (why: string) => `left worktree ${cwd} and branch ${branch} in place: ${why}`;
    if (!base) return keep('the base branch could not be resolved');
    const brief = (e: unknown) => (e as Error).message.replace(/\s+/g, ' ').slice(0, 200);
    let remote: string | null;
    try {
      const { clean, dirty } = await this.ports.git.status(cwd);
      if (!clean) return keep(`uncommitted changes (${dirty.slice(0, 5).join(', ')})`);
      await this.ports.git.fetch(this.repo);
      const { ahead } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
      if (ahead > 0) return keep(`${ahead} commit(s) are not on origin/${base}`);
      remote = await this.ports.git.remoteBranchSha(this.repo, branch);
      if (remote && !await this.ports.git.isAncestor(this.repo, remote, `origin/${base}`)) return keep(`the pushed branch has commits that are not on origin/${base}`);
    } catch (e) { return keep(`could not verify it is unused (${brief(e)})`); }
    try {
      await this.ports.git.worktreeRemove(this.repo, cwd, false);
      await this.ports.git.worktreePrune(this.repo);
      await this.ports.git.deleteLocalBranch(this.repo, branch);
      if (remote) await this.ports.git.deleteRemoteBranch(this.repo, branch);
    } catch (e) { return `removing the unused worktree ${cwd} / branch ${branch} stopped partway (${brief(e)}); finish it by hand`; }
    return `removed unused worktree and branch ${branch} (clean, nothing ahead of origin/${base})`;
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
