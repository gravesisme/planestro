import { join, basename } from 'node:path';
import type { Status } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import { matchesPathPattern, type Ports, type TurnPhase, type TurnResult, type RebaseResult } from './ports.ts';
import type { CleanupReconcile } from './cleanupReconcile.ts';
import type { Guards } from './guards.ts';
import { namedInLog } from './ciFilters.ts';
import { HELD_POLL_MS } from './heldPoll.ts';

/** What a sync with the base did (BaseSync.syncBranch). */
/** An epic's red run that is likely its base's, waiting for the base to move (#204); `synced` is the base tip merged in once it did. */
type BaseWait = { sha: string; base: string; base_sha: string; files: string[]; since: string; synced?: string };

type SyncOutcome =
  | { kind: 'current'; base: string; baseSha: string }
  | { kind: 'synced'; base: string; baseSha: string; head: string; pushed: boolean; integration: boolean }
  | { kind: 'dirty'; base: string; behind: number; files: string[]; why?: string }
  | { kind: 'diverged'; base: string; local: string; remote: string }
  | { kind: 'conflict'; base: string; baseSha: string; files: string[]; integration: boolean; cwd: string; stopped?: StoppedRebase };

/** A worker rebase left stopped at its conflict (HH-532): the head before it, the remote it was pushed at, and where it stopped. */
type StoppedRebase = { before: string; expected: string | null; head: string; files: string[]; took: string[] };

/**
 * `op_data.rebase_continue` (HH-532): a rebase planestro started and left stopped at a conflict for the item's session. The session
 * edits only the conflicted files; planestro continues the rebase, checks it and pushes it (`continueHeldRebase`), or puts the branch
 * back on `before` and blocks `sync_conflict`. `then` is what the session is told to do once the rebase is done (`then_opener`: it is
 * the phase's own first prompt); `rounds` counts the commits it stopped on.
 */
type HeldRebase = { base: string; base_sha: string; before: string; expected: string | null; stop_head: string; conflicts: string[]; files: string[]; took: string[]; rounds: number; then?: string; then_opener?: boolean };
/** How many commits of one rebase may stop on a conflict before planestro gives it to a person. */
const MAX_REBASE_ROUNDS = 5;

/** A sync that failed, in words (#212): the files it conflicted in, or what git would not overwrite to start it. */
export function syncFailed(r: RebaseResult): string {
  if (!r.refused) return `conflicted in ${r.conflicts.join(', ')}`;
  const { paths, message } = r.refused;
  return paths.length ? `was refused by git: the worktree has local changes it would overwrite (${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''})` : `was refused by git: ${message}`;
}

/**
 * Sync with base (#404, seam 6): bringing a branch up to date with origin/<base_branch>. Worker branches rebase, integration
 * branches merge. The git of a sync (syncBranch: fetch, the move-asides, sync only when behind, push with a lease or plainly),
 * generated files resolved by code (syncOnto, regenerate, #63), "Sync with base" between turns (syncWithBase, #217), a worker's
 * rebase left stopped at its conflict for its session and continued, kept or put back by planestro (HH-532: holdRebase,
 * continueHeldRebase, failHeldRebase, dropHeldRebase), the orchestrator's retry of an epic's conflict (retryEpicConflict), and
 * an epic whose red run is its base's, waiting for the base to move (#204: waitForBaseFix, driveBaseWaits). The one-shot
 * conflict session itself (resolveEpicConflict) runs a turn, so it stays with the turn machinery; the merge chain's own steps
 * stay with the merge pipeline. LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface BaseSyncContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'git' | 'proc'>;
  /** The code repo's main checkout. */
  readonly repo: string;
  /** Read live: a sync is refused while the engine stops. */
  readonly stopping: boolean;
  /** Turns this engine started and items with a job in flight: read only (a sync's own job is awaited through `jobs`). */
  readonly turns: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<string, Promise<void>>;
  /** The pause and drain: a sync is refused under either. */
  readonly guards: Pick<Guards, 'paused' | 'draining'>;
  /** The move-asides a sync makes (invariant 7's, audited there). */
  readonly cleanupReconcile: Pick<CleanupReconcile, 'syncAside' | 'clearForSync' | 'clearMergeWorktree'>;
  /** driveHeld's last look at each item: a rebase resolved in review is looked at afresh. */
  readonly heldPolledAt: Pick<Map<string, number>, 'delete'>;
  now(): string;
  absWorktree(rel: string): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  block(id: string, reason: string, detail: string): void;
  runJob(id: string, fn: () => Promise<unknown>): void;
  tick(): Promise<void>;
  /** Why an item cannot take a step now (a job or a turn running), or undefined. */
  busyWith(id: string): string | undefined;
  phaseFor(status: Status): TurnPhase | null;
  queueTurn(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[], oneShotCommands: string[], opts: { fresh?: true | 'auto'; opener?: boolean }): void;
  /** An item in review re-enters the merge pipeline (retry_op); a stopped one is unblocked after a sync. */
  retryOp(id: string, by: 'user' | 'orchestrator' | 'engine', message?: string): Promise<string>;
  unblock(id: string, message: string | undefined, by: 'user' | 'orchestrator' | 'engine', opts: { fresh?: boolean }): Promise<void>;
  freshRefusal(fm: { id: string; status: Status; worktree?: string }, message?: string): string | undefined;
  /** A local job slot, for the generated files' commands. */
  withLocalJobSlot<T>(fn: () => Promise<T>): Promise<T>;
  worktreeDirt(cwd: string): Promise<{ clean: boolean; dirty: string[]; byproducts: string[] }>;
  /** An epic's one-shot conflict session (#71): a whole turn, so it stays with the turn machinery. Returns 'resolved', or why not. */
  resolveEpicConflict(id: string, cwd: string, base: string, baseSha: string, files: string[], hint?: string): Promise<string>;
}

export class BaseSync {
  constructor(private readonly ctx: BaseSyncContext) {}
  /**
   * A red epic whose run is likely the base's (#204, HH-375): its failed log names files the base changed since the epic
   * last synced and none the epic changed. HH-375's PR went red on a check develop had just broken; the orchestrator
   * triaged ci_red, blamed the epic, and a worker turn pushed a duplicate of develop's own fix onto the integration
   * branch. So it is not blocked: `op_data.base_wait` records the evidence and driveBaseWaits merges the base in once it
   * moves, so CI runs again. That happens once. Returns true when it waits, or, when it already waited, the words the
   * ci_red block adds (and the record is dropped, so a later red is looked at afresh); undefined otherwise.
   */
  async waitForBaseFix(id: string, headSha: string, log: string): Promise<true | string | undefined> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    const prior = fm.op_data?.base_wait as BaseWait | undefined;
    if (prior) {
      const { base_wait: _w, ...od } = fm.op_data ?? {};
      this.ctx.store.mutateItem(id, [{ set: { op_data: od } }], 'engine');
      return prior.synced ? `. It is still red after merging the moved base in (it looked like a base regression in ${prior.files.join(', ')})` : undefined;
    }
    const base = this.ctx.store.derived(item).base_branch;
    if (!base) return undefined;
    let files: string[];
    let baseSha: string;
    try {
      await this.ctx.ports.git.fetch(this.ctx.repo);
      baseSha = await this.ctx.ports.git.revParse(this.ctx.repo, `origin/${base}`);
      // Three dots: the epic's own changes since it left the base, and the base's since then.
      const [own, theirs] = await Promise.all([this.ctx.ports.git.changedFiles(this.ctx.repo, `origin/${base}`, headSha), this.ctx.ports.git.changedFiles(this.ctx.repo, headSha, `origin/${base}`)]);
      if (own.some((f) => namedInLog(log, f.path))) return undefined;
      files = theirs.map((f) => f.path).filter((p) => namedInLog(log, p));
    } catch { return undefined; }   // cannot tell: the stop is a person's, as before
    if (!files.length) return undefined;
    const wait: BaseWait = { sha: headSha, base, base_sha: baseSha, files: files.slice(0, 20), since: this.ctx.now() };
    this.ctx.store.mutateItem(id, [
      { set: { op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), base_wait: wait } } },
      { activity: { actor: 'app', text: `likely a base regression: the failed run names ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}, which ${base} changed since this epic last synced, and nothing this epic changed. No fix turn on the integration branch: waiting for ${base} to move past ${baseSha.slice(0, 7)}, then merging it in and running CI again, once` } },
    ], 'engine', { commit: `${id}: CI red, waiting for ${base}` });
    this.ctx.note('info', `${id}: CI red on files ${base} changed; waiting for ${base} to move rather than starting a fix`);
    return true;
  }

  baseWaitPolledAt = new Map<string, number>();
  /** Epics waiting on their base (`op_data.base_wait`, #204), looked at once a minute outside any other step. */
  driveBaseWaits(): void {
    const now = Date.now();
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.kind !== 'epic' || fm.status !== 'IN_REVIEW' || !fm.op_data?.base_wait || (fm.op_data.base_wait as BaseWait).synced) continue;
      if (fm.blocked || fm.awaiting || fm.taken_over || fm.op || !fm.branch || this.ctx.jobs.has(item.id) || this.ctx.turns.has(item.id)) continue;
      if (now - (this.baseWaitPolledAt.get(item.id) ?? 0) < HELD_POLL_MS) continue;
      this.baseWaitPolledAt.set(item.id, now);
      this.ctx.runJob(item.id, () => this.baseWaitStep(item.id));
    }
  }

  /**
   * One look at an epic waiting on its base. Its own head moved (a child merged): that head's CI decides, as ever. The
   * base moved: it is merged in and pushed, so CI runs again for the new head, and the next red is ci_red. Neither, past
   * `ci.stall_wake_min`: the wait ends as ci_red, with the suspicion said, for the orchestrator and then a person.
   */
  private async baseWaitStep(id: string): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const wait = fm.op_data?.base_wait as BaseWait | undefined;
    if (!wait || wait.synced) return;
    const drop = (): Record<string, unknown> => { const { base_wait: _w, ...od } = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}; return od; };
    await this.ctx.ports.git.fetch(this.ctx.repo);
    const remote = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, fm.branch!);
    if (remote && remote !== wait.sha) {
      this.ctx.store.mutateItem(id, [{ set: { ci_result: 'pending', op_data: drop() } }, { activity: { actor: 'app', text: `${fm.branch} moved to ${remote.slice(0, 7)} while waiting for ${wait.base}; its CI decides now` } }], 'engine');
      void this.ctx.tick();
      return;
    }
    const tip = await this.ctx.ports.git.revParse(this.ctx.repo, `origin/${wait.base}`);
    const regression = `likely a base regression in ${wait.files.join(', ')}`;
    if (tip === wait.base_sha) {
      const after = this.ctx.store.config.ci.stall_wake_min * 60_000;
      if (after && Date.now() - Date.parse(wait.since) >= after) {
        this.ctx.store.mutateItem(id, [{ set: { op_data: drop() } }], 'engine');
        this.ctx.block(id, 'ci_red', `CI is red on files ${wait.base} changed (${regression}), and ${wait.base} has not moved past ${wait.base_sha.slice(0, 7)} in ${Math.round(after / 60_000)} min. Wait for its fix, or fix ${wait.base}; a fix on this integration branch would duplicate it`);
      }
      return;
    }
    this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), base_wait: { ...wait, synced: tip } } } }, { activity: { actor: 'app', text: `${wait.base} moved to ${tip.slice(0, 7)} (${regression}); merging it in and running CI again, once` } }], 'engine');
    const r = await this.syncBranch(id, `for the base it was waiting on`);
    if (r.kind === 'synced') { this.ctx.store.mutateItem(id, [{ set: { ci_result: 'pending', ci_head_sha: r.head } }], 'engine'); void this.ctx.tick(); return; }
    this.ctx.store.mutateItem(id, [{ set: { op_data: drop() } }], 'engine');
    if (r.kind === 'conflict') this.ctx.block(id, 'sync_conflict', `merging origin/${r.base} into ${fm.branch} (to take in the base's fix for the red run, ${regression}) conflicted in ${r.files.join(', ')}; it was aborted. Resolve it by hand in ${r.cwd}, or have the orchestrator retry with resolve_epic_conflict and a hint`);
    else if (r.kind === 'dirty') this.ctx.block(id, 'dirty_tree', `not synced with ${r.base} to take in its fix for the red run (${regression}): ${r.why ?? `files in the way: ${r.files.slice(0, 5).join(', ')}`}`);
    else this.ctx.block(id, 'ci_red', `CI is red (${regression}), and ${wait.base} moved, but ${r.kind === 'current' ? `${fm.branch} already has it` : 'the sync did not run'}; investigate by hand`);
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
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.ctx.store.derived(item);
    const epic = fm.kind === 'epic';
    if (this.ctx.guards.paused || this.ctx.guards.draining || this.ctx.stopping) return `not now: automation is ${this.ctx.guards.paused ? 'paused' : 'stopping'}; nothing was synced`;
    // A pull request is synced by the merge pipeline (HH-532): a stopped one re-enters it, so a sync conflict goes to the
    // held-rebase continuation from there, instead of a refusal that pointed the orchestrator back at the same loop.
    if (!epic && d.flavor === 'worker' && fm.status === 'IN_REVIEW') {
      if (!fm.blocked) return `not needed: ${id} is in review, and the merge pipeline rebases its pull request onto its base before it merges; a conflict there goes to its session as planestro's held rebase`;
      // A message on any other stop is the session's next instruction (#486): re-entering the pipeline only put it in
      // Activity, and HH-610's fix for a red run was lost while CI ran the failing code again. The pipeline syncs after it.
      const message = opts.unblock?.message?.trim();
      if (message && fm.blocked_reason !== 'sync_conflict') {
        await this.ctx.unblock(id, message, by, { fresh });
        return `in review, so the session resumes with your message${fresh ? ' (a fresh session)' : ''}; the merge pipeline rebases its pull request onto its base once it has committed, before it merges`;
      }
      return `in review, so the merge pipeline syncs it: ${await this.ctx.retryOp(id, by, opts.unblock?.message?.trim() || undefined)}`;
    }
    if (epic ? fm.status !== 'IN_PROGRESS' || !fm.branch : d.flavor !== 'worker' || !['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'].includes(fm.status)) return `not possible: ${id} is ${epic ? 'an epic that is not open' : `${fm.status}${d.flavor !== 'worker' ? ` (${d.flavor})` : ''}`}; only a worker item planning or in progress, or an open epic, is synced this way${fm.status === 'IN_REVIEW' ? ' (the merge pipeline syncs a pull request; retry_op re-enters it)' : ''}`;
    if (!epic && (!fm.worktree || !fm.branch)) return `not possible: ${id} has no worktree or branch yet`;
    const busy = this.ctx.busyWith(id); if (busy) return `not now: ${busy}`;
    if (fm.op) return `not now: ${id} is ${fm.op.replace(/_/g, ' ')}; let it finish first`;
    if (fm.awaiting && fm.awaiting !== 'user') return `not now: ${id} is awaiting ${fm.awaiting.replace(/_/g, ' ')}; answer that first`;
    if (opts.unblock && !fm.blocked && fm.awaiting !== 'user') return `nothing to unblock: ${id} is not blocked; sync it without unblocking`;
    if (fm.op_data?.rebase_continue) {
      if (!fm.blocked && fm.op_data?.pending_turn) return `not now: a rebase planestro left stopped at a conflict waits for ${id}'s session to resolve it`;
      await this.dropHeldRebase(id, 'a new sync starts from the branch as it was');
    }
    const noFresh = fresh ? this.ctx.freshRefusal(fm, opts.unblock?.message) : undefined;
    if (noFresh) return `not possible: ${noFresh}`;
    const base = d.base_branch;
    if (!base) return `not possible: ${d.base_branch_error ?? 'the base branch cannot be resolved'}`;
    if (!epic) {
      const dir = this.ctx.absWorktree(fm.worktree!);
      if (!(await this.ctx.ports.git.worktreeList(this.ctx.repo).catch(() => [])).some((w) => w.path === dir && !w.prunable)) return `not possible: the worktree ${fm.worktree} is missing; use recreate_worktree`;
      const { tracked } = await this.ctx.ports.git.dirtyDetail(dir);
      if (tracked.length) return `refused: ${fm.worktree} has uncommitted changes (${tracked.slice(0, 5).join(', ')}); a rebase needs a clean tree, so nothing was touched`;
    }
    // A conflict is left stopped for the session only when it will be handed one (HH-532): a worker item with a session, not blocked or being unblocked.
    const handable = !epic && Boolean(this.ctx.phaseFor(fm.status)) && Boolean(fm.session_id || Object.keys(fm.agent_sessions ?? {}).length) && (!fm.blocked || Boolean(opts.unblock));
    let out: SyncOutcome | undefined;
    this.ctx.runJob(id, async () => { out = await this.syncBranch(id, by === 'orchestrator' ? 'for the orchestrator' : '', { stop: handable }); });
    await this.ctx.jobs.get(id);
    const r = out as SyncOutcome | undefined;
    if (!r) return `not synced: the sync of ${id} stopped (see its Activity log)`;
    if (r.kind === 'conflict') {
      const where = `${r.integration ? `merging origin/${r.base} into ${fm.branch}` : `rebasing ${fm.branch} onto origin/${r.base}`} conflicted in ${r.files.join(', ')}; ${r.stopped ? 'it is left stopped at the conflict' : 'it was aborted, so the branch is as it was'}`;
      const cur = this.ctx.store.requireItem(id).file.frontmatter;
      const phase = this.ctx.phaseFor(cur.status);
      if (r.integration && this.ctx.store.config.epics.conflict_budget_usd > 0) {
        const baseSha = r.baseSha;
        this.ctx.runJob(id, async () => {
          const out = await this.ctx.resolveEpicConflict(id, r.cwd!, r.base, baseSha, r.files);
          if (out !== 'resolved') this.ctx.block(id, 'sync_conflict', `${where}: ${out}; resolve it by hand in ${r.cwd}, or have the orchestrator retry with resolve_epic_conflict and a hint`);
        });
        return `conflict: ${where}. A one-shot session is resolving it in ${r.cwd}; the Activity log says how it went`;
      }
      if (r.integration || !phase || (!cur.session_id && !Object.keys(cur.agent_sessions ?? {}).length)) { this.ctx.block(id, 'sync_conflict', `${where}, and ${r.integration ? 'an integration branch has' : 'it has'} no session to hand it to; resolve it by hand${r.integration ? ` in ${r.cwd}` : ''}`); return `conflict: ${where}; blocked for a person to resolve`; }
      if (cur.blocked && !opts.unblock) { this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `${where}; ${id} stays blocked (${cur.blocked_reason}), so the conflict waits for it to be unblocked with a sync first` } }], 'engine'); return `conflict: ${where}. ${id} stays blocked (${cur.blocked_reason}); unblock it with sync_first to hand the conflict to its session`; }
      if (!r.stopped) { this.ctx.block(id, 'sync_conflict', `${where}; resolve it by hand`); return `conflict: ${where}; blocked for a person to resolve`; }
      this.ctx.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: by, text: `${opts.unblock ? 'unblocked; ' : ''}the sync conflict goes to the session` } }], by, { commit: `${id}: sync conflict to the session` });
      const prompt = this.holdRebase(id, { base: r.base, base_sha: r.baseSha, before: r.stopped.before, expected: r.stopped.expected, stop_head: r.stopped.head, conflicts: r.files, files: r.stopped.files, took: r.stopped.took, ...(opts.unblock?.message?.trim() ? { then: opts.unblock.message.trim() } : {}) }, `rebasing onto origin/${r.base} (${r.baseSha.slice(0, 7)}) conflicted`);
      this.ctx.queueTurn(id, 'fix', prompt, [], [], { fresh: fresh ? true : 'auto' });
      return `conflict: ${where}. Handed to the session to resolve the conflicted files; planestro continues the rebase and pushes it${opts.unblock?.message?.trim() ? ', and the session then acts on your message' : ''}`;
    }
    if (r.kind === 'diverged') return `refused: the worktree (${r.local.slice(0, 7)}) and the pushed branch ${fm.branch} (${r.remote.slice(0, 7)}) have diverged; not pushing either way. Someone pushed commits the worktree lacks: bring them into the worktree (or reset it to them) first; nothing was rebased or pushed`;
    const said = r.kind === 'current' ? `already up to date: ${epic ? fm.branch : fm.branch ?? id} is on origin/${r.base}@${r.baseSha.slice(0, 7)}; nothing to sync`
      : r.kind === 'dirty' ? (r.why ? `not synced: the ${epic ? 'merge' : 'rebase'} ${r.why}; look in ${this.ctx.store.requireItem(id).file.frontmatter.worktree}` : `not synced: ${fm.worktree} has files in the way (${r.files.slice(0, 5).join(', ')}); commit or remove them first`)
      : `synced: ${r.integration ? `merged origin/${r.base} into ${fm.branch}` : `rebased onto origin/${r.base}`}@${r.baseSha.slice(0, 7)} (${r.head.slice(0, 7)})${r.pushed ? (r.integration ? ', pushed' : ', pushed with --force-with-lease') : ', local only (not pushed yet)'}`;
    if (r.kind === 'dirty') return said;
    if (opts.unblock) {
      const note = r.kind === 'synced' ? `planestro rebased your branch onto origin/${r.base} (${r.head.slice(0, 7)}), so it has what has merged there since you started.` : `Your branch is already on origin/${r.base}.`;
      await this.ctx.unblock(id, opts.unblock.message?.trim() ? `${note}\n\n${opts.unblock.message.trim()}` : undefined, by, { fresh });
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
  async syncOnto(id: string, cwd: string, base: string, integration: boolean, stop = false): Promise<RebaseResult & { note?: string }> {
    const patterns = Object.keys(this.ctx.store.config.worktrees.generated);
    const before = patterns.length ? await this.ctx.ports.git.revParse(cwd, 'HEAD') : '';
    // `stop` (HH-532): a worker rebase's real conflict is left stopped for its session, not aborted.
    const sync = await this.ctx.cleanupReconcile.syncAside(id, cwd, () => integration ? this.ctx.ports.git.merge(cwd, `origin/${base}`, patterns) : this.ctx.ports.git.rebase(cwd, `origin/${base}`, patterns, stop ? { stop: true } : undefined));
    const took = sync.tookBase ?? [];
    if (!sync.ok || !took.length) return sync;
    const r = await this.regenerate(id, cwd, base, took, before, sync.head);
    if (!('undo' in r)) return { ...sync, head: r.head, note: r.note };
    // The generated file is the session's after all (HH-532): rebased again without taking the base's copy, left stopped at it.
    if (stop && !integration) {
      const again = await this.ctx.cleanupReconcile.syncAside(id, cwd, () => this.ctx.ports.git.rebase(cwd, `origin/${base}`, [], { stop: true }));
      if (again.stopped) return { ...again, note: `${r.undo}; the sync was undone and rebased again, left stopped at the conflict` };
      if (again.ok) await this.ctx.ports.git.resetHard(cwd, before);
    }
    return { ok: false, conflicts: took, head: before, note: `${r.undo}; the sync was undone` };
  }

  /**
   * The generated files (worktrees.generated, #63) a sync resolved by taking the base's copy: their commands run, and what
   * they changed is committed. Anything else (a failed command, a command that changed an unlisted file) puts the worktree
   * back on `before` and says why.
   */
  private async regenerate(id: string, cwd: string, base: string, took: string[], before: string, head: string): Promise<{ head: string; note: string } | { undo: string }> {
    const generated = this.ctx.store.config.worktrees.generated;
    const patterns = Object.keys(generated);
    const undo = async (why: string): Promise<{ undo: string }> => { await this.ctx.ports.git.resetHard(cwd, before); return { undo: why }; };
    const commands = [...new Set(patterns.filter((p) => took.some((f) => matchesPathPattern(f, p))).map((p) => generated[p]))];
    for (const command of commands) {
      const r = await this.ctx.withLocalJobSlot(() => this.ctx.ports.proc.run(command, { cwd, timeoutMs: 20 * 60_000 }));
      if (r.code !== 0) return undo(`regenerating with \`${command}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    }
    const { tracked } = await this.ctx.ports.git.dirtyDetail(cwd);
    const other = tracked.filter((f) => !patterns.some((p) => matchesPathPattern(f, p)));
    if (other.length) return undo(`regenerating also changed ${other.slice(0, 5).join(', ')}, which worktrees.generated does not list`);
    const next = tracked.length ? await this.ctx.ports.git.commitPaths(cwd, tracked, `${id}: regenerate ${tracked.map((f) => basename(f)).join(', ')}`) : head;
    return { head: next, note: `took ${base}'s copy of ${took.join(', ')} in the conflict and regenerated it (${commands.map((c) => `\`${c}\``).join(', ')})${tracked.length ? `; committed ${tracked.join(', ')}` : '; nothing changed'}` };
  }

  /**
   * The orchestrator's resolve_epic_conflict (#71): an epic that stopped on a sync conflict, tried again
   * with a fresh merge and, if it still conflicts, a conflict session carrying the hint. Returns at once;
   * the Activity log and the next wake say how it went.
   */
  async retryEpicConflict(id: string, hint: string | undefined, by: 'user' | 'orchestrator' = 'orchestrator'): Promise<string> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (fm.kind !== 'epic') return `not possible: ${id} is not an epic (a worker item's session resolves its own conflicts)`;
    if (!['IN_PROGRESS', 'IN_REVIEW'].includes(fm.status) || !fm.branch) return `not possible: ${id} is ${fm.status}; only an open epic's branch is merged with its base`;
    if (!(this.ctx.store.config.epics.conflict_budget_usd > 0)) return 'not possible: conflict sessions are off (epics.conflict_budget_usd is 0)';
    if (this.ctx.guards.paused || this.ctx.guards.draining || this.ctx.stopping) return 'not now: automation is paused';
    const busy = this.ctx.busyWith(id); if (busy) return `not now: ${busy}`;
    if (fm.op) return `not now: ${id} is ${fm.op.replace(/_/g, ' ')}`;
    if (fm.blocked && fm.blocked_reason !== 'sync_conflict') return `not possible: ${id} is blocked for ${fm.blocked_reason}, not a sync conflict`;
    this.ctx.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: by, text: `resolving the sync conflict with a conflict session${hint?.trim() ? `: ${hint.trim().slice(0, 300)}` : ''}` } }], by, { commit: `${id}: resolve conflict` });
    this.ctx.runJob(id, async () => {
      const r = await this.syncBranch(id, by === 'orchestrator' ? 'for the orchestrator' : '');
      if (r.kind === 'dirty') { this.ctx.block(id, 'dirty_tree', `merging ${r.base} into ${fm.branch}: ${r.why ?? `the merge worktree has changes in the way (${r.files.slice(0, 5).join(', ')})`}; look in ${this.ctx.store.requireItem(id).file.frontmatter.worktree}, then unblock`); return; }
      if (r.kind !== 'conflict') return;   // the base merged cleanly this time, or there was nothing to do: the chain carries on
      const out = await this.ctx.resolveEpicConflict(id, r.cwd!, r.base, r.baseSha, r.files, hint);
      if (out !== 'resolved') this.ctx.block(id, 'sync_conflict', `merging ${r.base} into ${fm.branch} conflicted in ${r.files.join(', ')}: ${out}; resolve it by hand in ${r.cwd}`);
    });
    return `started: ${id}'s branch is merged with its base again, and a conflict goes to a one-shot session${hint?.trim() ? ' with your hint' : ''}; its Activity log says how it went`;
  }

  /**
   * Hand a rebase planestro left stopped at a conflict to the item's session (HH-532): persisted as `op_data.rebase_continue`,
   * so the turn that ends next is judged by continueHeldRebase, whatever turn it is. Returns that turn's prompt. The session is
   * asked only to edit the conflicted files: the fetch, the rebase, its continuation, the checks and the push stay planestro's,
   * which is what its worker rules say (HH-529's worker was told to fetch and rebase, and rightly refused).
   */
  holdRebase(id: string, h: Omit<HeldRebase, 'rounds'> & { rounds?: number }, why: string): string {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const hint = String(fm.op_data?.rebase_hint ?? '').trim();
    const { rebase_hint: _hint, rebase_declined: _declined, ...rest } = fm.op_data ?? {};
    const held: HeldRebase = { ...h, rounds: h.rounds ?? 1 };
    this.ctx.store.mutateItem(id, [
      { set: { op_data: { ...rest, rebase_continue: held, ...(fm.status === 'IN_REVIEW' ? { needs_session_rebase: true } : {}) } } },
      { activity: { actor: 'app', text: `${why}; the rebase is left stopped at the conflict for the session, which edits only ${h.conflicts.join(', ')}: planestro continues the rebase, checks it and pushes it` } },
    ], 'engine', { commit: `${id}: rebase conflict to the session` });
    return this.continuePrompt(id, h.conflicts, h.base_sha, hint, held.rounds > 1);
  }

  /** The rebase-conflict prompt for a rebase planestro left stopped at a conflict (HH-532). */
  private continuePrompt(id: string, files: string[], baseSha: string, hint = '', again = false): string {
    const body = this.ctx.store.renderPrompt('rebase-conflict', this.ctx.store.requireItem(id), {
      conflict_files: files.join('\n'), base_sha: baseSha.slice(0, 12),
      conflict_hint: hint ? `\n\nGuidance for this conflict:\n\n${hint}` : '',
    });
    return again ? `planestro continued the rebase after your resolution, and it stopped again at a later commit of your branch.\n\n${body}` : body;
  }

  /**
   * The turn after planestro left a rebase stopped for the session has ended (HH-532). A parked or stopped turn leaves it as it is.
   * A block, or a turn that ended with nothing, puts the branch back where it was and blocks `sync_conflict`. Otherwise planestro
   * continues the rebase (continueRebase), and only on positive evidence (finished, clean, contains origin/<base>, the branch still
   * ahead of it) is the result kept: in review the merge pipeline pushes it with a lease and validates the new head; before that it
   * is pushed only if the branch already was, and the session carries on with what it was doing. Returns false when it is not one.
   */
  async continueHeldRebase(id: string, result: TurnResult): Promise<boolean> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const held = fm.op_data?.rebase_continue as HeldRebase | undefined;
    if (!held || !fm.worktree || fm.taken_over) return false;
    if (result.subtype === 'killed') return true;   // stopped or restarting: the rebase waits as it is, and the turn is replayed
    if ((result.parked || result.requeued) && !result.done && !result.blocked) return true;
    if (fm.awaiting && fm.awaiting !== 'user' && !fm.blocked) return true;
    const cwd = this.ctx.absWorktree(fm.worktree);
    const blocked = result.blocked ?? (fm.blocked && fm.blocked_reason === 'agent_blocked' ? 'it reported blocked' : undefined);
    if (blocked) { await this.failHeldRebase(id, `the session could not resolve it: ${blocked}`); return true; }
    if (!result.done && (result.isError || result.numTurns === 0)) { await this.failHeldRebase(id, `the session's turn ended without resolving it (${result.subtype}${result.error ? `: ${result.error.slice(0, 160)}` : ''})`); return true; }
    const patterns = Object.keys(this.ctx.store.config.worktrees.generated);
    const r = await this.ctx.ports.git.continueRebase(cwd, patterns, { conflicts: held.conflicts, files: held.files, head: held.stop_head });
    const took = [...new Set([...held.took, ...(r.tookBase ?? [])])];
    if (r.state === 'stopped') {
      if (held.rounds >= MAX_REBASE_ROUNDS) { await this.failHeldRebase(id, `the rebase stopped on a conflict at ${held.rounds + 1} commits of the branch, more than one session turn per commit should take (${MAX_REBASE_ROUNDS})`); return true; }
      const prompt = this.holdRebase(id, { ...held, conflicts: r.files, files: r.stepFiles ?? r.files, stop_head: r.head, took, rounds: held.rounds + 1 }, `the session resolved its conflict and planestro continued the rebase; it stopped again in ${r.files.join(', ')}`);
      this.ctx.queueTurn(id, 'fix', prompt, [], [], { fresh: 'auto' });
      return true;
    }
    if (r.state === 'markers') { await this.failHeldRebase(id, `it left conflict markers in ${r.files.join(', ')}`); return true; }
    if (r.state === 'outside') { await this.failHeldRebase(id, `it changed ${r.files.slice(0, 5).join(', ')} during the rebase, which no conflict named (only the conflicted files are the session's to edit)`); return true; }
    if (r.state === 'failed') { await this.failHeldRebase(id, `git could not continue the rebase: ${r.message ?? 'no reason given'}`); return true; }
    // Positive evidence before anything is kept: a finished rebase, nothing left over, the base in it, the branch's own work still on top.
    const base = held.base;
    const { clean, dirty } = await this.ctx.worktreeDirt(cwd);
    if (!clean) { await this.failHeldRebase(id, `it left uncommitted changes (${dirty.slice(0, 5).join(', ')})`); return true; }
    if (!(await this.ctx.ports.git.isAncestor(cwd, `origin/${base}`, 'HEAD'))) { await this.failHeldRebase(id, `the result does not contain origin/${base}`); return true; }
    if ((await this.ctx.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD')).ahead === 0) { await this.failHeldRebase(id, `the result has none of the branch's own commits left on origin/${base}`); return true; }
    let head = r.head;
    let note = '';
    if (took.length) {
      const regen = await this.regenerate(id, cwd, base, took, held.before, head);
      if ('undo' in regen) { await this.failHeldRebase(id, regen.undo); return true; }
      head = regen.head; note = `; ${regen.note}`;
    }
    const cur = this.ctx.store.requireItem(id).file.frontmatter;
    const { rebase_continue: _held, ...rest } = cur.op_data ?? {};
    const said = result.done ? ` ("${result.done.slice(0, 200)}")` : '';
    if (cur.status === 'IN_REVIEW') {
      this.ctx.store.mutateItem(id, [
        { set: { ci_result: 'pending', op_data: { ...rest, needs_session_rebase: false } } },
        { activity: { actor: 'app', text: `the session resolved the conflict${said}; planestro continued the rebase onto origin/${base} (${held.base_sha.slice(0, 7)}) and checked it (finished, clean, contains origin/${base}): ${head.slice(0, 7)}${note}. Re-entering the merge pipeline, which pushes it with a lease and waits for CI on the new head` } },
      ], 'engine', { commit: `${id}: rebase conflict resolved` });
      this.ctx.heldPolledAt.delete(id);
      void this.ctx.tick();
      return true;
    }
    let pushed = '';
    if (held.expected && fm.branch) {
      try { await this.ctx.ports.git.pushForceWithLease(cwd, fm.branch, held.expected); pushed = ', pushed with --force-with-lease'; }
      catch (e) { await this.failHeldRebase(id, `the push was refused (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)})`); return true; }
    }
    this.ctx.store.mutateItem(id, [
      { set: { op_data: rest } },
      { activity: { actor: 'app', text: `the session resolved the conflict${said}; planestro continued the rebase onto origin/${base} (${held.base_sha.slice(0, 7)}) and checked it (finished, clean, contains origin/${base}): ${head.slice(0, 7)}${pushed}${note}` } },
    ], 'engine', { commit: `${id}: rebase conflict resolved` });
    const phase = this.ctx.phaseFor(cur.status);
    if (phase) this.ctx.queueTurn(id, phase, `planestro finished rebasing your branch onto origin/${base} (${head.slice(0, 7)}) with your resolution, so it has what has merged there.\n\n${held.then ?? 'Carry on with your work on this item where you left off.'}`, [], [], { ...(held.then_opener ? { opener: true } : {}), fresh: 'auto' });
    return true;
  }

  /**
   * A held rebase that is not kept (HH-532): the rebase is aborted, the worktree goes back to the head it had before it (the
   * attempt stays findable by its sha), and the item blocks `sync_conflict` once. The base it declined is remembered, so a retry
   * without guidance does not hand the same conflict to the same session again (the HH-532 loop): it blocks for a person.
   */
  private async failHeldRebase(id: string, why: string): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const held = fm.op_data?.rebase_continue as HeldRebase;
    const cwd = this.ctx.absWorktree(fm.worktree!);
    await this.ctx.ports.git.abortInProgress(cwd).catch(() => undefined);
    const attempt = await this.ctx.ports.git.revParse(cwd, 'HEAD').catch(() => held.before);
    if (attempt !== held.before) await this.ctx.ports.git.resetHard(cwd, held.before);
    const { rebase_continue: _held, ...rest } = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {};
    this.ctx.store.mutateItem(id, [
      { set: { op_data: { ...rest, needs_session_rebase: false, rebase_declined: { base_sha: held.base_sha } }, ...(fm.status === 'IN_REVIEW' ? { ci_result: 'unknown' } : {}) } },
      { activity: { actor: 'app', text: `the held rebase onto origin/${held.base} was not kept: ${why}${attempt !== held.before ? `; its attempt is ${attempt.slice(0, 12)} (git show it)` : ''}; the branch is back on ${held.before.slice(0, 7)}` } },
    ], 'engine', { commit: `${id}: rebase conflict not resolved` });
    this.ctx.block(id, 'sync_conflict', `rebasing ${fm.branch} onto origin/${held.base} (${held.base_sha.slice(0, 7)}) stopped at a conflict in ${held.conflicts.join(', ')}, and ${why}. The branch is as it was. Resolve it by hand in ${fm.worktree}, or retry with a message that says how the conflict should go (retry_op / unblock_item with a message): planestro then hands it to the session again with that guidance`);
  }

  /** A held rebase that nothing will finish (an unblock or retry of an item stopped while it waited): aborted, the branch as it was (HH-532). */
  async dropHeldRebase(id: string, why: string): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const held = fm.op_data?.rebase_continue as HeldRebase | undefined;
    if (!held || !fm.worktree) return;
    const cwd = this.ctx.absWorktree(fm.worktree);
    const stopped = await this.ctx.ports.git.inProgressOp(cwd).catch(() => null);
    if (stopped === 'rebase') await this.ctx.ports.git.abortInProgress(cwd).catch(() => undefined);
    const { rebase_continue: _held, ...rest } = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {};
    this.ctx.store.mutateItem(id, [{ set: { op_data: { ...rest, needs_session_rebase: false } } }, { activity: { actor: 'app', text: `${stopped === 'rebase' ? `aborted the rebase onto origin/${held.base} left stopped for the session` : `cleared the held rebase onto origin/${held.base} (none is in progress in the worktree any more)`}: ${why}` } }], 'engine', { commit: `${id}: held rebase dropped` });
  }

  /**
   * The git of a sync, run inside the item's job. `op` says what is in flight (rebasing /
   * syncing_base / pushing), so a restart part-way is recovered by reconcile (a half-done rebase is
   * aborted). The mechanics are the merge step's: fetch, the one dirty tree it may clear
   * (clearForSync), sync only when behind, rebase or merge, push with a lease or plainly.
   */
  async syncBranch(id: string, context = '', { stop = false }: { stop?: boolean } = {}): Promise<SyncOutcome> {
    const item = this.ctx.store.requireItem(id);
    let fm = item.file.frontmatter;
    const base = this.ctx.store.derived(item).base_branch!;
    const integration = fm.kind === 'epic';
    const branch = fm.branch!;
    const opId = this.ctx.store.journal.begin('sync_with_base', id, { base, branch });
    this.ctx.store.mutateItem(id, [{ set: { op: integration ? 'syncing_base' : 'rebasing', op_started_at: this.ctx.now() } }], 'engine');
    const done = (status: 'ok' | 'aborted', data: Record<string, unknown>, text?: string): void => {
      this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, ...(text ? [{ activity: { actor: 'app', text } } as ItemOp] : [])], 'engine', text ? { commit: `${id}: sync with ${base}` } : undefined);
      this.ctx.store.journal.end(opId, id, status, data);
    };
    await this.ctx.ports.git.fetch(this.ctx.repo);
    let cwd: string;
    if (integration) {
      // An epic has no session worktree: sync in a temporary one on its integration branch, first taking in what merged into that branch remotely.
      cwd = fm.worktree ? this.ctx.absWorktree(fm.worktree) : join(this.ctx.store.worktreesRoot(), `merge-${id.toLowerCase()}`);
      if (!(await this.ctx.ports.git.worktreeList(this.ctx.repo)).some((w) => w.path === cwd && !w.prunable)) await this.ctx.ports.git.worktreeAdd(this.ctx.repo, cwd, branch, `origin/${branch}`);
      if (!fm.worktree) { this.ctx.store.mutateItem(id, [{ set: { worktree: cwd } }], 'engine'); fm = this.ctx.store.requireItem(id).file.frontmatter; }
      const left = await this.ctx.cleanupReconcile.clearMergeWorktree(id, cwd, branch);
      if (left.length) {
        const { behind } = await this.ctx.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
        done('aborted', { reason: 'dirty' }, `not synced with origin/${base}: the merge worktree has changes that could not be set aside (${left.slice(0, 5).join(', ')})`);
        return { kind: 'dirty', base, behind, files: left };
      }
      if (await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch)) {
        const own = await this.ctx.cleanupReconcile.syncAside(id, cwd, () => this.ctx.ports.git.merge(cwd, `origin/${branch}`));
        if (own.refused) {
          const { behind } = await this.ctx.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
          done('aborted', { reason: 'dirty', files: own.refused.paths }, `merge of origin/${branch} into its local copy ${syncFailed(own)}`);
          return { kind: 'dirty', base, behind, files: own.refused.paths, why: syncFailed(own) };
        }
        if (!own.ok) { done('aborted', { reason: 'conflict', files: own.conflicts }, `merge of origin/${branch} into its local copy conflicted in ${own.conflicts.join(', ')}`); return { kind: 'conflict', base, baseSha: await this.ctx.ports.git.revParse(this.ctx.repo, `origin/${base}`), files: own.conflicts, integration, cwd }; }
      }
    } else cwd = this.ctx.absWorktree(fm.worktree!);
    const dirty = await this.ctx.cleanupReconcile.clearForSync(id, cwd, base);
    if (dirty.length) {
      const { behind } = await this.ctx.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
      done('aborted', { reason: 'dirty' }, `not synced with origin/${base}: the worktree has uncommitted changes (${dirty.slice(0, 5).join(', ')})`);
      return { kind: 'dirty', base, behind, files: dirty };
    }
    const baseSha = await this.ctx.ports.git.revParse(this.ctx.repo, `origin/${base}`);
    const { behind } = await this.ctx.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    if (behind === 0) { done('aborted', { reason: 'up_to_date' }, `already on ${base}@${baseSha.slice(0, 7)}; no sync needed${context ? ` ${context}` : ''}`); return { kind: 'current', base, baseSha }; }
    const expected = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch);
    // A pushed worker branch that moved on its own (a person finishing it by hand, p28) is never rebased away and pushed over: positive evidence first, as driveHeld and cleanup ask.
    if (!integration && expected) {
      const local = await this.ctx.ports.git.revParse(cwd, 'HEAD');
      if (expected !== local && !(await this.ctx.ports.git.isAncestor(cwd, expected, local))) {
        done('aborted', { reason: 'diverged', local, remote: expected }, `not synced: the worktree (${local.slice(0, 7)}) and the pushed branch (${expected.slice(0, 7)}) have diverged; not pushing either way`);
        return { kind: 'diverged', base, local, remote: expected };
      }
    }
    const before = await this.ctx.ports.git.revParse(cwd, 'HEAD');
    const sync = await this.syncOnto(id, cwd, base, integration, stop && !integration);
    if (sync.refused) {
      done('aborted', { reason: 'dirty', files: sync.refused.paths }, `${integration ? 'merge of' : 'rebase onto'} origin/${base} (${baseSha.slice(0, 7)}) ${syncFailed(sync)}; nothing was changed`);
      return { kind: 'dirty', base, behind, files: sync.refused.paths, why: syncFailed(sync) };
    }
    if (!sync.ok && sync.stopped) {
      done('aborted', { reason: 'conflict', files: sync.conflicts, stopped: true }, `rebase onto origin/${base} (${baseSha.slice(0, 7)}) conflicted in ${sync.conflicts.join(', ')}${sync.note ? ` (${sync.note})` : ''}; left stopped at the conflict for the session`);
      return { kind: 'conflict', base, baseSha, files: sync.conflicts, integration, cwd, stopped: { before, expected, head: sync.head, files: sync.stepFiles ?? sync.conflicts, took: sync.tookBase ?? [] } };
    }
    if (!sync.ok) {
      done('aborted', { reason: 'conflict', files: sync.conflicts }, `${integration ? 'merge of' : 'rebase onto'} origin/${base} (${baseSha.slice(0, 7)}) conflicted in ${sync.conflicts.join(', ')}${sync.note ? ` (${sync.note})` : ''}; aborted, the branch is unchanged`);
      return { kind: 'conflict', base, baseSha, files: sync.conflicts, integration, cwd };
    }
    // Pushed only when the branch is already on the remote: a branch no one has seen needs only the local rebase.
    if (expected) {
      this.ctx.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.ctx.now() } }], 'engine');
      if (integration) await this.ctx.ports.git.pushSetUpstream(cwd, branch);
      else await this.ctx.ports.git.pushForceWithLease(cwd, branch, expected);
    }
    done('ok', { head: sync.head, pushed: Boolean(expected) }, `${integration ? `merged origin/${base} into ${branch}` : `rebased onto origin/${base}`}${context ? ` ${context}` : ''} (${sync.head.slice(0, 7)}${expected ? (integration ? ', pushed' : ', pushed with --force-with-lease') : ''})${sync.note ? `; ${sync.note}` : ''}`);
    return { kind: 'synced', base, baseSha, head: sync.head, pushed: Boolean(expected), integration };
  }
}
