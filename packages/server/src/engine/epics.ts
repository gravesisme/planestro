import { join, relative, isAbsolute } from 'node:path';
import { idNumber, slugify, validateBreakdown, dependencyOrder, type BreakdownChild } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Ports, TurnPhase } from './ports.ts';
import { closesLine } from './issueImport.ts';
import { HELD_POLL_MS } from './heldPoll.ts';

/**
 * Epics (#404, seam 5): an epic's lifecycle up to its pull request. Planning the breakdown in a read-only checkout
 * (planEpic), the user's approval that creates the children and queues them (approveBreakdown, #438), children added
 * from a list, opening and ensuring the integration branch (openEpic, ensureEpicBranch), taking an epic in review back
 * for a new child (reopenEpics), and opening the epic PR once every child has merged (driveEpics, submitEpic).
 * Merging the base into the integration branch and its conflict sessions stay with sync; kind conversion stays on the engine.
 * LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface EpicsContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'git' | 'gh'>;
  /** The code repo's main checkout, and its GitHub `owner/name` (throws when code_repo.github is not configured). */
  readonly repo: string;
  readonly github: string;
  /** Turns this engine started and items with a job in flight: read only, so an epic under a step is never reopened or submitted. */
  readonly turns: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<string, unknown>;
  now(): string;
  absWorktree(rel: string): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  runJob(id: string, fn: () => Promise<unknown>): void;
  tick(): Promise<void>;
  /** Why an item cannot take a step now (a job or a turn running), or undefined. */
  busyWith(id: string): string | undefined;
  /** The epic planner's turn, run as every turn is. */
  runTurnFor(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[], oneShotCommands: string[], opts: { opener: boolean }): Promise<unknown>;
  /** The models a breakdown can route children to: shared with a plain item's epic check, so it stays on the engine. */
  implementersList(): string;
  /** The hold an epic PR into its base takes (review.hold_into), and the ops that build every hold. */
  holdIntoReason(base: string, alreadyHeld?: boolean): string | undefined;
  holdOps(reason: string, by: 'user' | 'orchestrator' | 'worker' | 'app'): ItemOp[];
  wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void;
  /** The general sync, which merges origin/<base> into an integration branch. */
  syncWithBase(id: string, opts: { by: 'user' | 'orchestrator' }): Promise<string>;
}

export class Epics {
  constructor(private readonly ctx: EpicsContext) {}
  // ---- epics ----
  /** Push the integration branch from the epic's base and open the epic (auto when a child queues, or via API). */
  // ---- epics planned by the planner: it proposes the children, the user approves, the engine creates them
  private epicPlanDir(id: string): string { return join(this.ctx.store.worktreesRoot(), `${this.ctx.store.config.project.id_prefix.toLowerCase()}-${idNumber(id)}-plan`); }

  async planEpic(id: string, why?: string): Promise<void> { this.startEpicPlan(id, why); }

  /**
   * planEpic in one synchronous step. An epic with a step running is refused before its status moves:
   * runJob drops a second job, which would leave the epic planning with no planner (#73).
   */
  startEpicPlan(id: string, why?: string): void {
    const busy = this.ctx.busyWith(id);
    if (busy) throw new Error(busy);
    this.ctx.runJob(id, this.beginEpicPlan(id, why));
  }

  /** planEpic's persisted half; returns its planning turn, for whoever holds the item's job slot (a conversion already does: #69). */
  beginEpicPlan(id: string, why?: string): () => Promise<void> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic') throw new Error(`${id} is not an epic`);
    if (fm.status !== 'NOT_YET_SUBMITTED') throw new Error(`${id} is ${fm.status}; only an epic that has not started can be planned`);
    const base = this.ctx.store.derived(item).base_branch;
    if (!base) throw new Error(this.ctx.store.derived(item).base_branch_error ?? `${id} has no base branch`);
    const dir = this.epicPlanDir(id);
    const worktreeRel = isAbsolute(dir) ? relative(this.ctx.repo, dir) : dir;
    this.ctx.store.mutateItem(id, [
      { transition: { to: 'PLAN_IN_PROGRESS', actor: 'user' } },
      // The integration branch gets its name now (the planner's rules speak of it); it is created on approval.
      { set: { worktree: worktreeRel, branch: fm.branch ?? `feature/${slugify(fm.title)}`, op: 'creating_worktree', op_started_at: this.ctx.now() } },
      { activity: { actor: 'app', text: `${why ? `${why}: ` : ''}planning the breakdown in a read-only checkout of origin/${base} (${worktreeRel})` } },
    ], 'user', { commit: `${id}: plan the breakdown` });
    return async () => {
      await this.ctx.ports.git.fetch(this.ctx.repo);
      if (!(await this.ctx.ports.git.worktreeList(this.ctx.repo)).some((w) => w.path === dir && !w.prunable)) await this.ctx.ports.git.worktreeAddDetached(this.ctx.repo, dir, `origin/${base}`);
      this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
      await this.ctx.runTurnFor(id, 'plan', this.ctx.store.renderPrompt('plan-epic', this.ctx.store.requireItem(id), { implementers: this.ctx.implementersList(), categories: this.ctx.store.config.categories.join(', ') }), [], [], { opener: true });
    };
  }

  /** Create the approved children (as edited by the user), drop the planning checkout, open the epic, and queue what can start. */
  async approveBreakdown(id: string, edited?: BreakdownChild[], opts: { queue?: boolean } = {}): Promise<string[]> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic' || fm.status !== 'PLAN_READY') throw new Error(`${id} has no breakdown waiting for approval`);
    const children = edited ?? (fm.awaiting_data?.children as BreakdownChild[] | undefined) ?? [];
    const created = this.createChildren(id, children);
    const dir = fm.worktree ? this.ctx.absWorktree(fm.worktree) : undefined;
    this.ctx.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: 'user' } },
      { unset: ['worktree'] },
      { activity: { actor: 'user', text: `breakdown approved: created ${created.join(', ')}` } },
    ], 'user', { commit: `${id}: approve breakdown (${created.length} children)` });
    this.ctx.runJob(id, async () => {
      // The planning checkout is detached and was only ever read: a clean tree is the whole proof it holds nothing.
      if (dir) {
        const st = await this.ctx.ports.git.status(dir).catch(() => undefined);
        if (st?.clean) { await this.ctx.ports.git.worktreeRemove(this.ctx.repo, dir, false); await this.ctx.ports.git.worktreePrune(this.ctx.repo); }
        else if (st) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `left the planning checkout ${dir} in place: it has uncommitted changes` } }], 'engine');
      }
      await this.ensureEpicBranch(id);
      if (opts.queue !== false) this.queueApprovedChildren(id, created);
      void this.ctx.tick();
    });
    return created;
  }

  /**
   * The approval's queue step (#438): each child still NOT_YET_SUBMITTED is queued as the user. One the user queued by hand
   * while the job ran (QUEUED, or already planning) is skipped and said in Activity, and one child's refusal never stops the rest.
   */
  private queueApprovedChildren(id: string, children: string[]): void {
    const notes: string[] = [];
    for (const cid of children) {
      const status = this.ctx.store.getItem(cid)?.file.frontmatter.status;
      if (!status) { notes.push(`${cid} is gone`); continue; }
      if (status !== 'NOT_YET_SUBMITTED') { notes.push(`${cid} is already ${status}`); continue; }
      try { this.ctx.store.transition(cid, 'QUEUED', 'user'); }
      catch (e) { notes.push(`${cid} could not be queued (${(e as Error).message})`); }
    }
    if (notes.length) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `queuing the approved children: skipped ${notes.join('; ')}` } }], 'engine');
  }

  /** The user's children for an epic, validated as a breakdown is; returns their ids in the order given. */
  private createChildren(id: string, children: BreakdownChild[]): string[] {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const problem = validateBreakdown(children, this.ctx.store.config.models, this.ctx.store.config.categories);
    if (problem) throw new Error(problem);
    // dependencies first, so every depends_on can name an item that already exists
    const ids = new Map<number, string>();
    for (const i of dependencyOrder(children)) {
      const c = children[i];
      // A child is planned by the model the breakdown names, else by the epic's own planner (not the project default: an outage of that one should not reach every child).
      const child = this.ctx.store.createItem({ title: c.title.trim(), description: c.description.trim(), category: c.category ?? fm.category, ...(fm.priority ? { priority: fm.priority } : {}), implementer: c.implementer, planner: c.planner ?? fm.planner, allow_model_fallback: fm.allow_model_fallback === true, parent: id, depends_on: (c.depends_on ?? []).map((d) => ids.get(d)!), ...(c.hold_for_review ? { extra: { review_hold: true } } : {}) }, 'user');
      ids.set(i, child.id);
    }
    return children.map((_c, i) => ids.get(i)!);
  }

  /**
   * Children the user rendered from a list and reviewed (#239), added to an epic that is not being planned: one not yet
   * started (queuing a child opens it), in progress, or in review (reopenEpics takes it back for them). Queued only on
   * the user's word (#73). A breakdown waiting for approval takes them into its proposal instead.
   */
  async addChildren(id: string, children: BreakdownChild[], opts: { queue?: boolean } = {}): Promise<string[]> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (fm.kind !== 'epic') throw new Error(`${id} is not an epic`);
    if (fm.status === 'PLAN_READY') throw new Error(`${id} has a breakdown waiting for approval: add them to it there`);
    if (!['NOT_YET_SUBMITTED', 'IN_PROGRESS', 'IN_REVIEW'].includes(fm.status)) throw new Error(`${id} is ${fm.status}: children are added to an epic not yet started, in progress or in review`);
    const created = this.createChildren(id, children);
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'user', text: `added ${created.length} ${created.length === 1 ? 'child' : 'children'} from a list: ${created.join(', ')}` } }], 'user', { commit: `${id}: add ${created.length} children` });
    if (opts.queue) { for (const cid of created) this.ctx.store.transition(cid, 'QUEUED', 'user'); void this.ctx.tick(); }
    return created;
  }

  async openEpic(id: string): Promise<void> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic' || fm.status !== 'NOT_YET_SUBMITTED') return;
    const base = this.ctx.store.derived(item).base_branch!;
    const branch = fm.branch ?? `feature/${slugify(fm.title)}`;
    const opId = this.ctx.store.journal.begin('open_epic', id, { branch, base });
    await this.ctx.ports.git.fetch(this.ctx.repo);
    if (!(await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch))) await this.ctx.ports.git.pushRef(this.ctx.repo, `origin/${base}`, branch);
    this.ctx.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: 'engine' } },
      { set: { branch } },
      { activity: { actor: 'app', text: `opened integration branch ${branch} from origin/${base}` } },
    ], 'engine', { commit: `${id}: open epic` });
    this.ctx.store.journal.end(opId, id, 'ok');
    this.ctx.note('info', `${id}: epic open on ${branch}`);
  }

  /** The integration branch of an epic that is already IN_PROGRESS (a planned epic gets there by approval, not by openEpic). */
  async ensureEpicBranch(id: string): Promise<void> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    const base = this.ctx.store.derived(item).base_branch!;
    const branch = fm.branch ?? `feature/${slugify(fm.title)}`;
    await this.ctx.ports.git.fetch(this.ctx.repo);
    const exists = !!(await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch));
    // A retry (#439) finds it already there: only a branch this step opened is said.
    if (exists && fm.branch === branch) return;
    if (!exists) await this.ctx.ports.git.pushRef(this.ctx.repo, `origin/${base}`, branch);
    this.ctx.store.mutateItem(id, [{ set: { branch } }, { activity: { actor: 'app', text: exists ? `integration branch ${branch} is on the remote` : `opened integration branch ${branch} from origin/${base}` } }], 'engine', { commit: `${id}: open epic` });
    this.ctx.note('info', `${id}: epic open on ${branch}`);
  }

  /**
   * A child added to an epic whose PR is open (#208, HH-342): admission starts children of an epic in progress only,
   * so the epic goes back to IN_PROGRESS for it, keeping its PR and any hold. Once every child has merged, submitEpic
   * finds the same PR open and submits it again. Only on GitHub's word that the PR is still open, and never under a step.
   */
  private reopenCheckedAt = new Map<string, number>();
  reopenEpics(): void {
    const now = Date.now();
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.kind !== 'epic' || fm.status !== 'IN_REVIEW' || !fm.pr || fm.taken_over || this.ctx.jobs.has(item.id) || this.ctx.turns.has(item.id) || (fm.op && fm.op !== 'awaiting_ci')) continue;
      const fresh = this.ctx.store.derived(item).children.map((c) => this.ctx.store.requireItem(c).file.frontmatter).filter((c) => !['MERGED', 'FINISHED', 'ICEBOX'].includes(c.status));
      // A PR GitHub says is not open is asked about again at most once a minute, not every tick.
      if (!fresh.length || now - (this.reopenCheckedAt.get(item.id) ?? 0) < HELD_POLL_MS) continue;
      this.reopenCheckedAt.set(item.id, now);
      this.ctx.runJob(item.id, () => this.reopenEpic(item.id, fresh.map((c) => c.id)));
    }
  }

  private async reopenEpic(id: string, children: string[]): Promise<void> {
    const pr = await this.ctx.ports.gh.prView(this.ctx.github, this.ctx.store.requireItem(id).file.frontmatter.pr!);
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (pr.state !== 'OPEN' || fm.status !== 'IN_REVIEW' || (fm.op && fm.op !== 'awaiting_ci')) return;
    this.ctx.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: 'engine' } },
      { unset: ['op', 'op_started_at', 'ci_result'] },
      { activity: { actor: 'app', text: `new child ${children.join(', ')}: epic back in progress; PR #${pr.number} stays open and is reused` } },
    ], 'engine', { commit: `${id}: reopen for ${children.join(', ')}` });
    this.ctx.note('info', `${id}: reopened for new child ${children.join(', ')}; PR #${pr.number} is reused`);
    void this.ctx.tick();
  }

  /** Epic completion: every child merged → open the epic PR into its base. */
  async driveEpics(): Promise<void> {
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.kind !== 'epic' || fm.status !== 'IN_PROGRESS' || fm.blocked || this.ctx.jobs.has(item.id)) continue;
      const d = this.ctx.store.derived(item);
      if (!d.children.length) continue;
      const children = d.children.map((c) => this.ctx.store.requireItem(c).file.frontmatter);
      if (!children.every((c) => c.status === 'MERGED' || c.status === 'FINISHED')) {
        // Iceboxed is "not now", not "not in this epic": it still waits on them, and says so once (#135).
        const iced = children.filter((c) => c.status === 'ICEBOX').map((c) => c.id);
        const note = iced.join(',');
        if (iced.length && children.every((c) => c.status === 'MERGED' || c.status === 'FINISHED' || c.status === 'ICEBOX') && fm.op_data?.epic_iceboxed_noted !== note) this.ctx.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), epic_iceboxed_noted: note } } }, { activity: { actor: 'app', text: `every other child has merged; still waiting on ${iced.join(', ')} (iceboxed). Discard ${iced.length === 1 ? 'it' : 'them'} to let the epic finish without ${iced.length === 1 ? 'it' : 'them'}, or bring ${iced.length === 1 ? 'it' : 'them'} back` } }], 'engine');
        continue;
      }
      if (!this.ctx.store.config.epics.auto_submit) { if (!fm.op_data?.epic_ready_noted) this.ctx.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), epic_ready_noted: true } } }, { activity: { actor: 'app', text: 'all children merged — submit the epic PR when ready (epics.auto_submit is off)' } }], 'engine'); continue; }
      this.ctx.runJob(item.id, () => this.submitEpic(item.id));
    }
  }

  async submitEpic(id: string): Promise<void> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.kind !== 'epic' || fm.status !== 'IN_PROGRESS') return;
    const base = this.ctx.store.derived(item).base_branch!;
    const children = this.ctx.store.derived(item).children.map((c) => this.ctx.store.requireItem(c).file.frontmatter);
    const opId = this.ctx.store.journal.begin('creating_pr', id, { branch: fm.branch, base });
    this.ctx.store.mutateItem(id, [{ set: { op: 'creating_pr', op_started_at: this.ctx.now() } }], 'engine');
    const existing = (await this.ctx.ports.gh.prList(this.ctx.github, { head: fm.branch!, state: 'open' }))[0];
    const pr = existing ? { number: existing.number, url: existing.url } : await this.ctx.ports.gh.createPr(this.ctx.github, {
      base, head: fm.branch!, title: `${fm.title} (${id})`,
      body: `Integration branch for epic **${id}**. Child pull requests:\n\n${children.map((c) => `- ${c.id}: ${c.title}${c.pr ? ` (#${c.pr})` : ''}`).join('\n')}${closesLine(fm)}\n\n🤖 Opened by planestro`,
    });
    this.ctx.store.mutateItem(id, [
      { transition: { to: 'IN_REVIEW', actor: 'engine' } },
      { set: { pr: pr.number, ci_result: 'pending' } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `opened epic PR #${pr.number} → ${base} (${pr.url})` } },
      ...(() => { const why = this.ctx.holdIntoReason(base, fm.skip_merge); return why ? this.ctx.holdOps(why, 'app') : []; })(),
    ], 'engine', { commit: `${id}: open PR #${pr.number}` });
    this.ctx.store.journal.end(opId, id, 'ok', { pr: pr.number });
    // As for an item's PR: the orchestrator hears of it before it can merge (LM-2's went to main unseen).
    this.ctx.wakeOrchestrator('pr_opened', id);
    void this.ctx.tick();
  }

  /** The epic page's "Sync with base": the general sync (syncWithBase), which merges origin/<base> into an integration branch. */
  async syncBase(id: string): Promise<void> {
    const r = await this.ctx.syncWithBase(id, { by: 'user' });
    if (/^(not now|not possible|refused)/.test(r)) throw new Error(r);
  }
}
