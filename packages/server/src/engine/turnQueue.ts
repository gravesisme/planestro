import { randomUUID } from 'node:crypto';
import { findModel, resolveTurnModel, unavailableEntry, unavailableView, type ModelDef, type Account, type Status } from '@planestro/shared';
import type { DataStore } from '../store/DataStore.ts';
import type { TurnPhase, TurnResult } from './ports.ts';
import { RESUMABLE_TURN_OPS } from './resumableOps.ts';
import type { Guards } from './guards.ts';
import type { BaseSync } from './baseSync.ts';
import type { TurnRunner, PendingTurn, TurnOpts } from './turnRunner.ts';

/**
 * The turn queue (#404, seam 9): when a turn runs, never how. Every instruction for a turn is saved first in
 * `op_data.pending_turn` (savePendingTurn, queueTurn), so a pause, a drain, a provider guard or a restart only delays it;
 * runPendingTurn runs the one still saved, with the user's messages that arrived meanwhile, after syncing the branch with its
 * base when asked (#217: syncBeforeTurn), and the tick admits saved instructions their provider and account allow
 * (drivePendingTurns). Messages queued while something other than a turn drove the item are sent as its next job
 * (deliverQueued, HH-263). A restart resumes what it interrupted from persisted state (resumeInterrupted: a lost report applied,
 * a saved instruction kept, an interrupted turn carried on), and an item parked with resume_after resumes on a synced branch
 * (resumeWaited). Running the turn is TurnRunner's; the job queue and its follow-ups are Slots', and the tick and resume_after's
 * wait are the Scheduler's. LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface TurnQueueContext {
  readonly store: DataStore;
  /** Read live: nothing is delivered or synced while the engine stops. */
  readonly stopping: boolean;
  /** Turns this engine started, items with a job in flight and the steps queued behind one: read only (a step running holds a saved turn back). */
  readonly turns: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<string, unknown>;
  readonly followUps: ReadonlyMap<string, unknown>;
  /** The pause and drain: a turn waits under either with its sync not yet run. */
  readonly guards: Pick<Guards, 'paused' | 'draining'>;
  /** The sync before a turn, and a conflict left stopped for its session (HH-532). */
  readonly baseSync: Pick<BaseSync, 'syncBranch' | 'holdRebase'>;
  /** The turn itself, and a lost report applied at the restart (#167). */
  readonly turnRunner: Pick<TurnRunner, 'runTurnFor' | 'ingestOutbox'>;
  block(id: string, reason: string, detail: string): void;
  runJob(id: string, fn: () => Promise<unknown>): void;
  queueFollowUp(id: string, fn: () => Promise<unknown>): void;
  phaseFor(status: Status): TurnPhase | null;
  /** The account a saved turn would run on (#242), and whether its usage guard is up. */
  accountFor(fm: { account?: string }, def: ModelDef): { account: Account } | { missing: string; why: string };
  guarded(runner: string, account?: string): boolean;
  /** A plan's revision turn answers the stop its plan's last turn left (#359). */
  clearSupersededStop(id: string): void;
  /** What a turn's end means for the item, for a report applied at the restart. */
  afterTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void>;
}

export class TurnQueue {
  constructor(private readonly ctx: TurnQueueContext) {}

  /**
   * Messages queued for an item's session while something other than a turn drove it: sent now as the item's next
   * job, when nothing else is queued and nothing waits on an answer. Returns whether it did (HH-263).
   */
  deliverQueued(id: string, when: string): boolean {
    const item = this.ctx.store.getItem(id);
    if (!item) return false;
    const fm = item.file.frontmatter;
    const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
    const phase = this.ctx.phaseFor(fm.status);
    if (!pending.length || !phase || fm.taken_over || fm.blocked || fm.awaiting || this.ctx.turns.has(id) || this.ctx.followUps.has(id)) return false;
    if (this.ctx.store.derived(item).flavor !== 'worker' || this.ctx.stopping || fm.op_data?.pending_turn) return false;
    this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: [] } } }, { activity: { actor: 'app', text: `sending ${pending.length} queued message${pending.length === 1 ? '' : 's'} to the session ${when}` } }], 'engine');
    const review = fm.status === 'IN_REVIEW' ? '\n\nYour pull request is open and was about to merge: it waits for what you do with these. Commit any change; planestro pushes it and runs CI again.' : '';
    this.queueTurn(id, phase, `Messages from the user while you were working:\n\n${pending.map((m) => `- ${m}`).join('\n')}${review}`);
    return true;
  }

  /** The exact instruction, including a permission ruling, survives admission pauses.
   * Only the in-flight process owns active_turn; pending_turn belongs to the next turn.
   * Keys keep an ending turn from deleting a newer answer queued while it was ending. */
  savePendingTurn(id: string, turn: PendingTurn): void {
    const data = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {};
    this.ctx.store.mutateItem(id, [{ set: { op_data: { ...data, pending_turn: turn } } }], 'engine');
  }
  queueTurn(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[] = [], oneShotCommands: string[] = [], opts: TurnOpts = {}): void {
    const turn: PendingTurn = { key: randomUUID(), phase, prompt, extraAllowed, oneShotCommands, opts };
    this.savePendingTurn(id, turn);
    this.ctx.queueFollowUp(id, () => this.runPendingTurn(id, turn));
  }
  private runPendingTurn(id: string, turn: PendingTurn): Promise<TurnResult | undefined> {
    const current = this.ctx.store.requireItem(id).file.frontmatter.op_data?.pending_turn as PendingTurn | undefined;
    if (current?.key !== turn.key) return Promise.resolve(undefined);
    if (turn.opts.clearsStop) this.ctx.clearSupersededStop(id);
    if (turn.opts.syncFirst && !(this.ctx.guards.paused || this.ctx.guards.draining || this.ctx.stopping) && !this.ctx.store.requireItem(id).file.frontmatter.taken_over) {
      return this.syncBeforeTurn(id, turn).then((synced) => { this.savePendingTurn(id, synced); return this.runPendingTurn(id, synced); });
    }
    const data = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {};
    const messages = (data.pending_messages as string[] | undefined) ?? [];
    if (messages.length) {
      // With the user's messages it is a turn of work, not only a ruling's resume: it is charged (#295).
      const { ruling: _ruling, ...opts } = current.opts;
      turn = { ...current, opts, prompt: `${current.prompt}\n\nAlso, from the user while admission was paused:\n\n${messages.map((m) => `- ${m}`).join('\n')}` };
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...data, pending_turn: turn, pending_messages: [] } } }], 'engine');
    }
    return this.ctx.turnRunner.runTurnFor(id, turn.phase, turn.prompt, turn.extraAllowed, turn.oneShotCommands, turn.opts, turn);
  }
  /**
   * A turn that starts on its base as it is now (#217): approved just after its base moved, an implement
   * turn began on the base its plan was cut from, and the worker had to stop and ask for a sync. The git
   * is syncBranch's (Engine.syncWithBase's): only when behind, pushed only if already on the remote. A
   * conflict is the first thing the session reads, with the turn's own task after it. The sync's intent
   * is in the pending turn until it has run, so a restart part-way syncs again (a no-op once on the tip).
   */
  private async syncBeforeTurn(id: string, turn: PendingTurn): Promise<PendingTurn> {
    const { syncFirst: _done, ...opts } = turn.opts;
    const next = (prompt: string): PendingTurn => ({ ...turn, prompt, opts });
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (this.ctx.store.derived(item).flavor !== 'worker' || !fm.worktree || !fm.branch || fm.kind === 'epic') return next(turn.prompt);
    const sync = await this.ctx.baseSync.syncBranch(id, 'before implementation starts', { stop: true });
    if (sync.kind === 'conflict') {
      if (!sync.stopped) { this.ctx.block(id, 'sync_conflict', `rebasing onto origin/${sync.base} before implementation conflicted in ${sync.files.join(', ')}; resolve it by hand`); return next(turn.prompt); }
      return next(this.ctx.baseSync.holdRebase(id, { base: sync.base, base_sha: sync.baseSha, before: sync.stopped.before, expected: sync.stopped.expected, stop_head: sync.stopped.head, conflicts: sync.files, files: sync.stopped.files, took: sync.stopped.took, then: `Now start on this:\n\n${turn.prompt}`, ...(turn.opts.opener ? { then_opener: true } : {}) }, `rebasing onto origin/${sync.base} (${sync.baseSha.slice(0, 7)}) before implementation conflicted`));
    }
    const said = sync.kind === 'synced' ? `planestro rebased your branch onto origin/${sync.base} (${sync.head.slice(0, 7)}) before you start, so it has what has merged there since the plan was made.`
      : sync.kind === 'diverged' ? `planestro did not rebase your branch onto origin/${sync.base}: the worktree (${sync.local.slice(0, 7)}) and the pushed branch (${sync.remote.slice(0, 7)}) have diverged. Look at git log HEAD..origin/${fm.branch} first; ask with report_blocked if you need them brought in.`
      : sync.kind === 'dirty' ? `Your branch is ${sync.behind} commit${sync.behind === 1 ? '' : 's'} behind origin/${sync.base}; planestro did not rebase it (${sync.why ?? `uncommitted changes: ${sync.files.slice(0, 5).join(', ')}`}). Commit or clear them first; ask with report_blocked if you need the rebase.`
      : '';
    return next(said ? `${said}\n\n${turn.prompt}` : turn.prompt);
  }
  drivePendingTurns(): void {
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      const turn = fm.op_data?.pending_turn as PendingTurn | undefined;
      if (!turn || this.ctx.jobs.has(item.id) || this.ctx.turns.has(item.id) || this.ctx.followUps.has(item.id) || fm.op || fm.blocked || fm.awaiting || fm.taken_over || fm.resume_after) continue;
      const phase = this.ctx.phaseFor(fm.status);
      if (!phase || (phase === 'plan') !== (turn.phase === 'plan')) continue;
      const model = findModel(this.ctx.store.config, turn.phase === 'plan' ? fm.planner : fm.implementer);
      if (!model || model.external) continue;
      const now = new Date();
      const acct = this.ctx.accountFor(fm, model);
      const unavailable = 'account' in acct ? unavailableView(this.ctx.store.local.model_unavailable, acct.account.name) : undefined;
      const pick = resolveTurnModel(this.ctx.store.config, model, { allow: fm.allow_model_fallback === true, unavailable, now });
      if ('account' in acct && (this.ctx.guarded(pick.def.runner ?? 'claude', acct.account.name) || unavailableEntry(unavailable, pick.def.id, now))) continue;
      this.ctx.runJob(item.id, () => this.runPendingTurn(item.id, turn));
    }
  }

  // ---- restart recovery (Phase 3 subset; Phase 5 adds the full reconciler) ----
  async resumeInterrupted(): Promise<void> {
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      // An op this process is running now (a step a call made before start() poked off) was not interrupted by a restart.
      if (this.ctx.jobs.has(item.id) || this.ctx.turns.has(item.id)) continue;
      if (fm.op_data?.outbox && !fm.taken_over) {
        const phase = this.ctx.phaseFor(fm.status);
        this.ctx.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }], 'engine');
        this.ctx.runJob(item.id, async () => {
          const r: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '' };
          await this.ctx.turnRunner.ingestOutbox(item.id, r);
          const { active_turn: _active, ...data } = this.ctx.store.requireItem(item.id).file.frontmatter.op_data ?? {};
          this.ctx.store.mutateItem(item.id, [{ set: { op_data: data } }], 'engine');
          if (phase && (r.done || r.planSubmitted || r.blocked)) await this.ctx.afterTurn(item.id, phase, r);
        });
        continue;
      }
      const savedTurn = (fm.op_data?.pending_turn ?? fm.op_data?.active_turn) as PendingTurn | undefined;
      if (savedTurn && (!fm.op || RESUMABLE_TURN_OPS.has(fm.op))) {
        this.ctx.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }, ...(fm.op ? [{ activity: { actor: 'app' as const, text: `turn (${fm.op}) was interrupted by a restart; resuming its saved instruction when admission allows` } }] : [])], 'engine');
        this.savePendingTurn(item.id, savedTurn);
        continue; // tick admits it only when its provider and the global lever allow it
      }
      if (!fm.op) continue;
      if (RESUMABLE_TURN_OPS.has(fm.op)) {
        const phase = this.ctx.phaseFor(fm.status);
        this.ctx.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }, { activity: { actor: 'app', text: `turn (${fm.op}) was interrupted by a restart; ${fm.taken_over ? 'not resumed: you have this item' : 'resuming'}` } }], 'engine');
        // Its session's last report was lost on the way here (#167): that is where it stopped, so it is applied rather than resumed.
        if (phase && fm.op_data?.outbox && !fm.awaiting && !fm.blocked && !fm.taken_over) this.ctx.runJob(item.id, async () => { const r: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '' }; await this.ctx.turnRunner.ingestOutbox(item.id, r); await this.ctx.afterTurn(item.id, phase, r); });
        else if (phase && !fm.awaiting && !fm.blocked && !fm.taken_over) this.ctx.runJob(item.id, () => this.ctx.turnRunner.runTurnFor(item.id, phase, 'Your previous turn was interrupted before it finished. Check the state of your worktree and continue where you left off.', [], [], { fresh: 'auto', note: 'a planestro restart', carryOn: true }));
      } else if (fm.op === 'awaiting_ci') {
        this.ctx.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }, { activity: { actor: 'app', text: 'restart while waiting for CI; re-entering the merge pipeline' } }], 'engine');
      } else {
        this.ctx.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }], 'engine');
        this.ctx.block(item.id, `interrupted_${fm.op}`, `planestro restarted during ${fm.op}; verify the repo state and unblock (the Phase 5 reconciler will do this automatically)`);
      }
    }
  }

  /**
   * What it waited for is in the base now, not yet on its branch: bring the branch up to date first
   * (syncBranch: a worker branch rebases), so the session resumes with what it needs (HH-118 resumed
   * without the flag it had waited for, p29). A conflict goes to the session as any sync conflict does.
   */
  async resumeWaited(id: string, merged: string[], message: string): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const phase = this.ctx.phaseFor(fm.status);
    if (!phase) return;
    const had = `${merged.join(', ')} ${merged.length === 1 ? 'has' : 'have'} merged`;
    const sync = fm.worktree ? await this.ctx.baseSync.syncBranch(id, 'before resuming', { stop: true }) : undefined;
    if (sync?.kind === 'conflict') {
      if (!sync.stopped) { this.ctx.block(id, 'sync_conflict', `rebasing onto origin/${sync.base} after ${had.replace(/ ha(s|ve) merged$/, '')} merged conflicted in ${sync.files.join(', ')}; resolve it by hand`); return; }
      const prompt = this.ctx.baseSync.holdRebase(id, { base: sync.base, base_sha: sync.baseSha, before: sync.stopped.before, expected: sync.stopped.expected, stop_head: sync.stopped.head, conflicts: sync.files, files: sync.stopped.files, took: sync.stopped.took, then: `Then continue with what you were waiting to do (${had}):\n\n${message}` }, `rebasing onto origin/${sync.base} (${sync.baseSha.slice(0, 7)}) before resuming conflicted`);
      await this.ctx.turnRunner.runTurnFor(id, 'fix', prompt, [], [], { fresh: 'auto' });
      return;
    }
    const synced = sync?.kind === 'diverged' ? `planestro did not rebase your branch: the worktree (${sync.local.slice(0, 7)}) and the pushed branch (${sync.remote.slice(0, 7)}) have diverged, so someone pushed commits you do not have. Look at them first (git log HEAD..origin/${fm.branch}); ask with report_blocked if you need them brought in.`
      : sync?.kind === 'synced' ? `Your branch was rebased onto origin/${sync.base} (${sync.head.slice(0, 7)}), so it has what ${merged.join(', ')} delivered.`
      : sync?.kind === 'dirty' ? `Your branch is ${sync.behind} commit${sync.behind === 1 ? '' : 's'} behind origin/${sync.base}, which now has ${merged.join(', ')}; planestro did not rebase it because your worktree has uncommitted changes. Commit them first; ask with report_blocked if you need the rebase.`
      : '';
    await this.ctx.turnRunner.runTurnFor(id, phase, `${had}.${synced ? ` ${synced}` : ''}\n\n${message}`, [], [], { fresh: 'auto', note: `${merged.join(', ')} merging` });
  }
}
