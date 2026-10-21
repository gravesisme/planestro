import { join } from 'node:path';
import { isoLocal, type ItemFrontmatter } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Ports, TurnPhase } from './ports.ts';
import type { Guards } from './guards.ts';
import type { CleanupReconcile } from './cleanupReconcile.ts';
import type { ReviewUndo } from './reviewUndo.ts';
import { syncFailed, type BaseSync } from './baseSync.ts';
import type { CiWatch } from './ciWatch.ts';
import type { RunnerStall } from './runners.ts';
import { TRANSIENT } from './transient.ts';
import { HELD_POLL_MS } from './heldPoll.ts';

/**
 * The merge pipeline (#404, seam 8): the serial merge chain only syncs and merges. Every IN_REVIEW item the pipeline may
 * move enters it in merge order (driveInReview, mergeJob); one pass syncs the branch with its base and merges a head that is
 * already green on the base tip (mergeStep, greenFor, merge, with the evidence that proved it green, #180); a head that is not
 * green yet leaves the chain as `op: awaiting_ci` and is watched beside it (watchCi), which brings it back once green or
 * takes it down the red, timeout, blocked and runner-stall paths. Green with a hold, block or question landed meanwhile parks
 * (parkIfHeld). A held item (skip_merge) skips only the merge: its new commits are pushed through the chain and its CI is
 * polled from the tick, outside it (driveHeld, heldStep), as is a taken-over item's (readOwnedCi) and a held PR's preview
 * (readPreview). Reading CI itself, red runs and runner stalls are CiWatch's; holds and their scope check stay in LiveEngine.
 * LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface MergePipelineContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'git' | 'gh' | 'proc'>;
  /** The code repo's main checkout. */
  readonly repo: string;
  /** `owner/repo` of the code repo (throws when code_repo.github is not configured). */
  readonly github: string;
  /** The project's CI workflow, by name. */
  readonly ciWorkflow: string;
  /** Read live: nothing enters the chain while the engine stops. */
  readonly stopping: boolean;
  /** Turns this engine started and items with a job in flight: read only (an item with a step running is not moved). */
  readonly turns: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<string, unknown>;
  /** The pause and drain: the chain takes no step under either. */
  readonly guards: Pick<Guards, 'paused' | 'draining'>;
  /** The sync itself, and a worker's conflict left stopped for its session (HH-532). */
  readonly baseSync: Pick<BaseSync, 'syncOnto' | 'holdRebase'>;
  /** The move-asides before a sync, and the cleanup after a merge (invariant 7's, audited there). */
  readonly cleanupReconcile: Pick<CleanupReconcile, 'clearMergeWorktree' | 'clearForSync' | 'syncAside' | 'cleanup'>;
  /** What the branch delivered, recorded while it still exists. */
  readonly reviewUndo: Pick<ReviewUndo, 'deliveredBy'>;
  /** Reading CI, its red runs and its runners. */
  readonly ciWatch: Pick<CiWatch, 'waitForCi' | 'noteCiTiming' | 'rerunIfInfra' | 'rerunIfFlaky' | 'onCiRed' | 'runnerStallFor' | 'ciQueueNote' | 'sawCi'>;
  now(): string;
  sleep(ms: number): Promise<void>;
  absWorktree(rel: string): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  /** `stall`: the runner a CI timeout waits on (#216). */
  block(id: string, reason: string, detail: string, awaiting?: 'user', stall?: RunnerStall): void;
  runJob(id: string, fn: () => Promise<unknown>): void;
  queueFollowUp(id: string, fn: () => Promise<unknown>): void;
  queueTurn(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[], oneShotCommands: string[], opts: { fresh?: true | 'auto' }): void;
  tick(): Promise<void>;
  /** Messages queued for the session go to it before its pull request merges (HH-263). Returns whether they did. */
  deliverQueued(id: string, when: string): boolean;
  /** An epic's one-shot conflict session (#71): a whole turn, so it stays with the turn machinery. Returns 'resolved', or why not. */
  resolveEpicConflict(id: string, cwd: string, base: string, baseSha: string, files: string[], hint?: string): Promise<string>;
  /** Holds (#97, #195) and the approved scope a merge is checked against (#74). */
  draftsWhileHeld(id: string): boolean;
  outsideApprovedScope(id: string, sha: string): Promise<string[]>;
  holdOps(reason: string, by: 'app', waitsOn: 'agent'): ItemOp[];
  wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void;
  announce(event: 'on_merge', title: string, message: string, item?: string): void;
  /** A local job slot, for the local gate's check command. */
  withLocalJobSlot<T>(fn: () => Promise<T>): Promise<T>;
}

/** Held polls (one a minute) a new head's preview deployment is looked for before planestro stops asking. */
const PREVIEW_TRIES = 10;
/** Looks (5 s apart) at a just-pushed PR's head before it is marked ready anyway. */
const READY_AFTER_PUSH_POLLS = 6;

export class MergePipeline {
  constructor(private readonly ctx: MergePipelineContext) {}

  mergeChain: Promise<void> = Promise.resolve();

  /**
   * Every IN_REVIEW item the pipeline may move. One whose head is waiting for CI is watched outside
   * the chain (watchCi); the rest enter the serial chain in merge order, where a head already green
   * on the base tip merges without waiting again (a released hold's kept green, too).
   */
  driveInReview(): void {
    const candidates = this.ctx.store.listItems().filter((item) => {
      const fm = item.file.frontmatter;
      if (fm.status !== 'IN_REVIEW' || fm.blocked || fm.awaiting || fm.skip_merge || fm.taken_over || fm.op_data?.pending_turn || this.ctx.jobs.has(item.id) || this.ctx.turns.has(item.id)) return false;
      if (fm.ci_result === 'red' || fm.op_data?.needs_session_rebase) return false;
      const flavor = this.ctx.store.derived(item).flavor;
      if (flavor === 'external' && (fm.merge_policy ?? 'watch') === 'watch') return false; // watched: driveExternal observes it
      return true;
    }).sort((a, b) => {
      const fa = a.file.frontmatter, fb = b.file.frontmatter;
      return (fa.merge_order ?? Infinity) - (fb.merge_order ?? Infinity) || (fa.rank ?? Infinity) - (fb.rank ?? Infinity) || (fa.pr_created_at ?? '').localeCompare(fb.pr_created_at ?? '');
    });
    // mergeChain keeps the syncs and merges strictly serial, in this order; CI waits run beside it.
    for (const item of candidates) this.ctx.runJob(item.id, () => item.file.frontmatter.op === 'awaiting_ci' ? this.watchCi(item.id) : this.mergeJob(item.id));
  }

  /**
   * A held pull request (skip_merge) stays out of the merge queue, not out of sight. Its session's
   * fix commits are pushed, so the PR and CI show them, and its CI is read, so a red run reaches
   * the fix path and a green one is for the head it names. None of it waits inside the serial merge
   * chain: only the push goes through it, and CI is polled once per HELD_POLL_MS from the tick.
   */
  heldPolledAt = new Map<string, number>();
  driveHeld(): void {
    const now = Date.now();
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      // A taken-over PR is polled the same way, for its CI only: it is shown, never acted on.
      const owned = Boolean(fm.taken_over);
      // An epic's PR is held and polled too (#116): HH-242 was held "to play it", went red, and nothing read its CI.
      const epic = this.ctx.store.derived(item).flavor === 'epic' && !owned;
      if (fm.status !== 'IN_REVIEW' || !(fm.skip_merge || owned) || fm.blocked || fm.awaiting || !fm.pr || !fm.branch || (!fm.worktree && !owned && !epic)) continue;
      if (this.ctx.jobs.has(item.id) || this.ctx.turns.has(item.id) || fm.op || (fm.op_data?.needs_session_rebase && !owned)) continue;
      if (this.ctx.store.derived(item).flavor !== 'worker' && !epic) continue;
      if (now - (this.heldPolledAt.get(item.id) ?? 0) < HELD_POLL_MS) continue;
      this.heldPolledAt.set(item.id, now);
      this.ctx.runJob(item.id, () => owned ? this.readOwnedCi(item.id) : this.heldStep(item.id));
    }
  }

  /**
   * CI of a pull request a person has taken over (dogfood p28), for whatever head is on GitHub,
   * whoever pushed it: recorded so the board shows it, and nothing else. No push, no fix turn, no
   * merge; the hand-back sends it through the pipeline, which reuses this run for an unchanged head.
   */
  private async readOwnedCi(id: string): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const remote = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, fm.branch!);
    if (!remote) return;
    const ci = await this.ctx.ports.gh.ciForSha(this.ctx.github, fm.branch!, remote, this.ctx.ciWorkflow);
    const result = ci.state === 'success' ? 'green' : ci.state === 'failure' ? 'red' : 'pending';
    const cur = this.ctx.store.requireItem(id).file.frontmatter;
    if (!cur.taken_over || (cur.ci_result === result && cur.ci_head_sha === remote)) return;
    this.ctx.store.mutateItem(id, [
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
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const seen = fm.op_data?.preview as { sha?: string; url?: string; tries?: number } | undefined;
    if (seen?.sha === head && (seen.url || (seen.tries ?? 0) >= PREVIEW_TRIES)) return;
    const url = await this.ctx.ports.gh.previewUrl(this.ctx.github, head).catch(() => null);
    const tries = (seen?.sha === head ? seen.tries ?? 0 : 0) + 1;
    const cur = this.ctx.store.requireItem(id).file.frontmatter;
    this.ctx.store.mutateItem(id, [
      { set: { op_data: { ...(cur.op_data ?? {}), preview: { sha: head, tries, ...(url ? { url } : {}) } } } },
      ...(url ? [{ activity: { actor: 'app' as const, text: `preview for ${head.slice(0, 7)}: ${url}` } }] : []),
    ], 'engine');
  }

  /** Whether CI is queued or running for the head the PR branch has on GitHub: a run a draft would cancel (#195). */
  private async ciRunningOnPr(branch: string): Promise<boolean> {
    const remote = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch);
    return remote ? (await this.ctx.ports.gh.ciForSha(this.ctx.github, branch, remote, this.ctx.ciWorkflow)).state === 'pending' : false;
  }

  private async heldStep(id: string): Promise<void> {
    let fm = this.ctx.store.requireItem(id).file.frontmatter;
    const drafts = this.ctx.draftsWhileHeld(id);
    if (drafts && !fm.op_data?.pr_draft && !(await this.ciRunningOnPr(fm.branch!))) {
      // A person's hold put on after the PR opened: back to draft, so pushes during the hold run no CI. A run already
      // going is never cancelled by it (#195): the draft waits for the next poll after it ends.
      await this.ctx.ports.gh.setDraft(this.ctx.github, fm.pr!, true);
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pr_draft: true } } }, { activity: { actor: 'app', text: `held: PR #${fm.pr} is back to a draft, so CI waits until the hold is released` } }], 'engine');
      fm = this.ctx.store.requireItem(id).file.frontmatter;
    } else if (!drafts && fm.op_data?.pr_draft) {
      // A hold that waits on the orchestrator or the worker holds the merge only (#195): HH PR #541 was drafted by one, its
      // CI skipped drafts, and the fix the hold waited for never got a run. Ready again, so every push runs CI.
      await this.ctx.ports.gh.setDraft(this.ctx.github, fm.pr!, false);
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pr_draft: false } } }, { activity: { actor: 'app', text: `held for the merge only: PR #${fm.pr} is ready for review again, so CI runs on its pushes` } }], 'engine');
      fm = this.ctx.store.requireItem(id).file.frontmatter;
    }
    // An epic has no session of its own: nothing of its is pushed from here, only its CI is read, and a red run goes to triage.
    const epic = fm.kind === 'epic';
    const cwd = epic ? '' : this.ctx.absWorktree(fm.worktree!);
    const [local, remote] = await Promise.all([epic ? Promise.resolve('') : this.ctx.ports.git.revParse(cwd, 'HEAD'), this.ctx.ports.git.remoteBranchSha(this.ctx.repo, fm.branch!)]);
    if (!epic && remote && local !== remote) {
      // Commits the session made while the item was held. Pushed only when they build on what the
      // PR has; a remote that moved on its own is someone else's work and is left alone.
      if (await this.ctx.ports.git.isAncestor(cwd, remote, local)) { await this.mergeJob(id, { hold: true }); return; }
      if (fm.op_data?.held_diverged !== remote) this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), held_diverged: remote } } }, { activity: { actor: 'app', text: `held: the worktree (${local.slice(0, 7)}) and the PR branch (${remote.slice(0, 7)}) have diverged; not pushing either way` } }], 'engine');
      return;
    }
    if (!remote) return;
    await this.readPreview(id, remote);
    const ci = await this.ctx.ports.gh.ciForSha(this.ctx.github, fm.branch!, remote, this.ctx.ciWorkflow);
    this.ctx.ciWatch.sawCi(id, ci);
    const cur = this.ctx.store.requireItem(id).file.frontmatter;
    const seen = cur.op_data?.ci as { runId?: number; attempt?: number } | undefined;
    if (ci.runId && (seen?.runId !== ci.runId || seen?.attempt !== ci.attempt)) this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci: { runId: ci.runId, url: ci.url, ...(ci.attempt ? { attempt: ci.attempt } : {}) } } } }], 'engine');
    if (ci.state === 'success') {
      if (cur.ci_result !== 'green' || cur.ci_head_sha !== remote) this.ctx.store.mutateItem(id, [{ set: { ci_result: 'green', ci_head_sha: remote } }, { activity: { actor: 'app', text: `held: CI is green for ${remote.slice(0, 7)} (not merging until the hold is released)` } }], 'engine');
      return;
    }
    if (ci.state === 'failure') {
      if (ci.runId && await this.ctx.ports.gh.isBillingBlocked(this.ctx.github, ci.runId)) return;
      const lastRed = cur.op_data?.last_red as { runId?: number; sha?: string; attempt?: number } | undefined;
      if (cur.ci_result === 'red' || (lastRed?.runId === ci.runId && lastRed?.sha === remote && (ci.attempt ?? 1) <= (lastRed.attempt ?? 1))) return;
      this.ctx.store.mutateItem(id, [{ set: { ci_head_sha: remote } }], 'engine');
      const opId = this.ctx.store.journal.begin('held_ci', id, { pr: fm.pr, sha: remote });
      // The infrastructure's red (#219) is re-run once here too, and its attempt read by the next poll.
      const infra = await this.ctx.ciWatch.rerunIfInfra(id, opId, remote);
      if (infra === 'blocked') return;
      if (infra) { this.ctx.store.mutateItem(id, [{ set: { ci_result: 'pending' } }], 'engine'); this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'infra_rerun' }); return; }
      await this.ctx.ciWatch.onCiRed(id, opId, remote, undefined, 'github', !epic);
      return;
    }
    // Still running, or not started: a green (or red) from another head is not this head's verdict.
    if (cur.ci_head_sha !== remote || cur.ci_result === 'green' || cur.ci_result === 'red') this.ctx.store.mutateItem(id, [{ set: { ci_result: 'pending', ci_head_sha: remote } }], 'engine');
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
  async mergeStep(id: string, { hold = false }: { hold?: boolean } = {}): Promise<void> {
    if (this.ctx.guards.paused || this.ctx.guards.draining || this.ctx.stopping) return;
    let item = this.ctx.store.requireItem(id);
    let fm = item.file.frontmatter;
    if (fm.status !== 'IN_REVIEW' || fm.blocked || fm.awaiting || fm.taken_over || fm.op_data?.pending_turn) return;
    if (hold && !fm.skip_merge) return;
    const d = this.ctx.store.derived(item);
    const base = d.base_branch!;
    const integration = fm.kind === 'epic';
    const canFix = d.flavor === 'worker';
    // Never merge over a message still queued for the session (HH-263): the designer's ruling "ship the Crawler" sat in
    // the queue through a 14-minute CI wait, then the PR merged without it. It goes to the session now; the PR comes back after.
    if (canFix && this.ctx.deliverQueued(id, 'before its pull request merges')) return;
    if (!fm.worktree) {
      // epics and app-policy external items have no session worktree: make a temporary one from the remote branch
      const dir = join(this.ctx.store.worktreesRoot(), `merge-${id.toLowerCase()}`);
      await this.ctx.ports.git.fetch(this.ctx.repo);
      await this.ctx.ports.git.worktreeAdd(this.ctx.repo, dir, fm.branch!, `origin/${fm.branch}`);
      this.ctx.store.mutateItem(id, [{ set: { worktree: dir } }, { activity: { actor: 'app', text: `temporary worktree ${dir} for the merge pipeline` } }], 'engine');
      item = this.ctx.store.requireItem(id); fm = item.file.frontmatter;
    }
    const cwd = this.ctx.absWorktree(fm.worktree!);
    const cfg = this.ctx.store.config.ci;
    const opId = this.ctx.store.journal.begin(hold ? 'held_sync' : 'merge', id, { pr: fm.pr, base });

    if (cfg.require_green_base && !hold) {
      const health = await this.ctx.ports.gh.branchCi(this.ctx.github, base, this.ctx.ciWorkflow);
      // A verdict only counts if it is about the CURRENT base tip. Since push-triggered
      // runs on the default branch were removed (PRs gate it), the latest push run can be
      // arbitrarily stale — a red from last week must not block today's merges.
      const baseTip = await this.ctx.ports.git.revParse(this.ctx.repo, `origin/${base}`).catch(() => null);
      const current = !health.sha || !baseTip || health.sha === baseTip;
      if (health.state === 'failure' && current) { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'base_red' }); this.ctx.block(id, 'base_red', `the base branch ${base} is red at its tip (${health.url ?? 'no run url'}); fix the base or disable ci.require_green_base`); return; }
      if (health.state === 'failure' && !current) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `ignoring a stale red on ${base} (run is for ${health.sha?.slice(0, 7)}, tip is ${baseTip?.slice(0, 7)})` } }], 'engine');
    }

    // 1. sync with the base — worker branches rebase, integration branches merge (never rewritten)
    this.ctx.store.mutateItem(id, [{ set: { op: integration ? 'syncing_base' : 'rebasing', op_started_at: this.ctx.now(), op_data: { ...(fm.op_data ?? {}), base_sha: null } } }], 'engine');
    await this.ctx.ports.git.fetch(this.ctx.repo);
    const inTheWay = integration ? await this.ctx.cleanupReconcile.clearMergeWorktree(id, cwd, fm.branch!) : [];
    if (!inTheWay.length) inTheWay.push(...await this.ctx.cleanupReconcile.clearForSync(id, cwd, base));
    if (inTheWay.length) { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'dirty' }); this.ctx.block(id, 'dirty_tree', `the worktree has uncommitted changes, so it cannot be synced: ${inTheWay.slice(0, 5).join(', ')}${inTheWay.length > 5 ? ` and ${inTheWay.length - 5} more` : ''}`); return; }
    const baseSha = await this.ctx.ports.git.revParse(this.ctx.repo, `origin/${base}`);
    const expected = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, fm.branch!);
    // An integration branch moves on GitHub whenever a child merges into it: take that in before merging
    // the base, or the push is refused as non-fast-forward, and a retry refuses the same way (dogfood p53, HH-172).
    if (integration && expected && !(await this.ctx.ports.git.isAncestor(cwd, expected, 'HEAD'))) {
      const own = await this.ctx.cleanupReconcile.syncAside(id, cwd, () => this.ctx.ports.git.merge(cwd, `origin/${fm.branch}`));
      if (!own.ok) {
        this.ctx.store.journal.end(opId, id, 'aborted', own.refused ? { reason: 'dirty', files: own.refused.paths } : { reason: 'conflict', files: own.conflicts });
        this.ctx.block(id, own.refused ? 'dirty_tree' : 'sync_conflict', `merging origin/${fm.branch} into its local copy in ${fm.worktree} ${syncFailed(own)}; resolve by hand`);
        return;
      }
      this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `took in origin/${fm.branch} (${expected.slice(0, 7)}) before syncing: it had moved on GitHub` } }], 'engine');
    }
    const localHead = await this.ctx.ports.git.revParse(cwd, 'HEAD');
    const { behind } = await this.ctx.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    let headSha: string;
    let synced: string;
    let pushed = false;
    if (hold && expected === localHead) {
      this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
      this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'nothing_to_push' });
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
      // A worker's conflict is left stopped for its session (HH-532), unless that session already could not resolve it at this
      // same base tip and nobody has said since how it should go: then it is a person's, and asking again would only loop.
      const declined = canFix && !integration && (fm.op_data?.rebase_declined as { base_sha?: string } | undefined)?.base_sha === baseSha && !String(fm.op_data?.rebase_hint ?? '').trim();
      const sync = await this.ctx.baseSync.syncOnto(id, cwd, base, integration, canFix && !integration && !declined);
      if (!sync.ok && sync.refused) {
        // Nothing conflicted: git would not overwrite files in the worktree (#212). Not a session's conflict to resolve.
        this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
        this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'dirty', files: sync.refused.paths });
        this.ctx.block(id, 'dirty_tree', `${integration ? 'the merge of' : 'the rebase onto'} origin/${base} (${baseSha.slice(0, 7)}) ${syncFailed(sync)}; look in ${fm.worktree}, then unblock`);
        return;
      }
      if (!sync.ok) {
        const held = canFix && Boolean(sync.stopped);
        this.ctx.store.mutateItem(id, [
          { unset: ['op', 'op_started_at'] },
          { set: { ci_result: 'unknown', op_data: { ...(fm.op_data ?? {}), needs_session_rebase: held } } },
          { activity: { actor: 'app', text: `${integration ? 'merge of' : 'rebase onto'} origin/${base} (${baseSha.slice(0, 7)}) ${syncFailed(sync)}${sync.note ? ` (${sync.note})` : ''}${held ? '; handing to the session' : ''}` } },
        ], 'engine', { commit: `${id}: ${integration ? 'merge' : 'rebase'} conflict` });
        this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'conflict', files: sync.conflicts, ...(held ? { stopped: true } : {}) });
        if (held) {
          const prompt = this.ctx.baseSync.holdRebase(id, { base, base_sha: baseSha, before: localHead, expected, stop_head: sync.head, conflicts: sync.conflicts, files: sync.stepFiles ?? sync.conflicts, took: sync.tookBase ?? [] }, `the rebase of the pull request onto origin/${base} (${baseSha.slice(0, 7)}) conflicted`);
          this.ctx.queueTurn(id, 'fix', prompt, [], [], { fresh: 'auto' });
        }
        else if (canFix && declined) this.ctx.block(id, 'sync_conflict', `rebasing onto origin/${base} (${baseSha.slice(0, 7)}) conflicts in ${sync.conflicts.join(', ')}, and the session already could not resolve this conflict at this base tip; resolve it by hand in ${fm.worktree}, or retry with a message that says how it should go (retry_op / unblock_item with a message) to hand it to the session again with that guidance`);
        else if (integration && this.ctx.store.config.epics.conflict_budget_usd > 0) {
          // An epic has no session of its own: a one-shot one resolves the merge (#71), as the item's next job, outside the
          // serial merge chain (a session inside it would hold every other merge). Resolved, it is pushed and the chain picks the epic up again.
          const conflicts = sync.conflicts;
          this.ctx.queueFollowUp(id, async () => {
            const r = await this.ctx.resolveEpicConflict(id, cwd, base, baseSha, conflicts);
            if (r !== 'resolved') this.ctx.block(id, 'sync_conflict', `merging ${base} into ${fm.branch} conflicted in ${conflicts.join(', ')}: ${r}; resolve it by hand in ${cwd}, or have the orchestrator retry with resolve_epic_conflict and a hint`);
          });
        }
        else this.ctx.block(id, 'sync_conflict', `conflicts with ${base} in ${sync.conflicts.join(', ')} and no session to hand them to; resolve by hand`);
        return;
      }

      // 2. push (integration branches push plainly; worker branches force-with-lease their rebase)
      this.ctx.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.ctx.now() } }, ...(sync.note ? [{ activity: { actor: 'app', text: sync.note } } as ItemOp] : [])], 'engine');
      if (integration) await this.ctx.ports.git.pushSetUpstream(cwd, fm.branch!);
      else await this.ctx.ports.git.pushForceWithLease(cwd, fm.branch!, expected);
      headSha = sync.head;
      pushed = true;
      if (hold) {
        this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_head_sha: headSha, ci_result: 'pending' } }, { activity: { actor: 'app', text: `held: rebased onto ${base}@${baseSha.slice(0, 7)} and pushed ${headSha.slice(0, 7)} so the PR ${this.ctx.draftsWhileHeld(id) ? 'shows the session\'s commits (a draft: CI runs once the hold is released)' : 'and CI show the session\'s commits'}; not merging` } }], 'engine');
        this.ctx.store.journal.end(opId, id, 'ok', { held: true, head: headSha });
        return;
      }
      synced = `rebased onto ${base}@${baseSha.slice(0, 7)} and pushed ${headSha.slice(0, 7)}`;
    }

    // 2b. a draft PR: while it is held for review, the review comes first and CI waits; once
    // released, it is marked ready here, after the sync, so CI runs once, on the head that merges.
    const drafted = this.ctx.store.requireItem(id).file.frontmatter;
    let readied = false;
    if (this.ctx.store.config.ci.draft_while_held && drafted.op_data?.pr_draft) {
      if (drafted.review_hold && !drafted.skip_merge) {
        this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { awaiting: 'review', ci_head_sha: headSha, ci_result: 'pending' } }, { activity: { actor: 'app', text: `synced ${headSha.slice(0, 7)}; the PR is a draft, so CI runs once you approve it; waiting for your review before merging` } }], 'engine', { commit: `${id}: awaiting review` });
        this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'awaiting_review' });
        return;
      }
      // ready_for_review runs CI on the head GitHub shows at that moment: right after a push that can
      // still be the replaced one, whose run is then cancelled while the pushed head's was skipped as
      // a draft's (HH-180). A few seconds' look first; refireReady covers a head that never shows.
      if (pushed) for (let i = 0; i < READY_AFTER_PUSH_POLLS && (await this.ctx.ports.gh.prView(this.ctx.github, fm.pr!)).headRefOid !== headSha; i++) await this.ctx.sleep(5_000);
      await this.ctx.ports.gh.setDraft(this.ctx.github, fm.pr!, false);
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(drafted.op_data ?? {}), pr_draft: false } } }, { activity: { actor: 'app', text: `marked PR #${fm.pr} ready for review: CI runs on ${headSha.slice(0, 7)}` } }], 'engine');
      readied = true;
    }

    // 3. CI. Green for this exact head merges now. Anything else (a fresh push, a run still going,
    // a red, a head GitHub has not caught up with) leaves the chain for watchCi, so the next item
    // is not held up by this one's CI. `expected` is the head the push replaced: GitHub keeps
    // reporting it for a few seconds, and the watcher must read that as lag, not a moved head.
    if (pushed || readied || !(await this.greenFor(id, fm.branch!, headSha, fm.pr!))) {
      const cur = this.ctx.store.requireItem(id).file.frontmatter;
      // watchCi saw this very head green and this look says otherwise (greenFor trusts that record,
      // so only a PR head that moved gets here). Once goes back to the watcher, which reads the move;
      // a second time for the same head is not bounced between the two again: it is a stop to judge.
      const seen = cur.op_data?.ci_disagree as { sha?: string; count?: number } | undefined;
      const disagree = !pushed && !readied && cur.op_data?.ci_green === headSha ? (seen?.sha === headSha ? seen.count ?? 0 : 0) + 1 : 0;
      if (disagree >= 2) { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'ci_disagree', head: headSha }); this.ctx.block(id, 'ci_disagree', `watchCi saw CI green for ${headSha.slice(0, 7)} but the merge step did not, ${disagree} times; check the PR's head and its run, then unblock`); return; }
      this.ctx.store.mutateItem(id, [{ set: { op: 'awaiting_ci', op_started_at: this.ctx.now(), ci_head_sha: headSha, ci_result: 'pending', op_data: { ...(cur.op_data ?? {}), ci_replaced: pushed ? expected : null, ...(disagree ? { ci_disagree: { sha: headSha, count: disagree } } : {}) } } }, { activity: { actor: 'app', text: `${synced}; waiting for CI outside the merge queue` } }], 'engine');
      this.ctx.store.journal.end(opId, id, 'ok', { awaiting_ci: headSha });
      this.ctx.queueFollowUp(id, () => this.watchCi(id));
      return;
    }
    this.ctx.store.mutateItem(id, [{ set: { ci_head_sha: headSha, ci_result: 'green' } }, { activity: { actor: 'app', text: `${synced}; CI is green for it` } }], 'engine');
    if (this.parkIfHeld(id, opId)) return;
    await this.merge(id, opId, base, headSha, baseSha);
  }

  /**
   * One look, no waiting: is CI green for exactly this head, with the PR on that head? What watchCi
   * or the local gate already found green for this sha is the answer, not a second poll: a status API
   * that briefly says otherwise would bounce the item between the chain and the watcher.
   */
  async greenFor(id: string, branch: string, sha: string, pr: number): Promise<boolean> {
    // GitHub not answering is "not known green": the item waits beside the chain, where ciRead waits the outage out.
    const unsure = (e: unknown) => { if (TRANSIENT.test(String((e as Error).message))) return undefined; throw e; };
    const view = await this.ctx.ports.gh.prView(this.ctx.github, pr).catch(unsure);
    if (!view) return false;
    if (view.state === 'MERGED') return true;
    if (view.headRefOid !== sha) return false;
    const od = this.ctx.store.requireItem(id).file.frontmatter.op_data;
    if (od?.ci_green === sha || od?.local_green === sha) return true;
    const ci = await this.ctx.ports.gh.ciForSha(this.ctx.github, branch, sha, this.ctx.ciWorkflow).catch(unsure);
    if (!ci) return false;
    if (ci.state !== 'success') return false;
    // The run that proved this head green, for the merge's evidence pointer (#180).
    if (ci.runId) this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), ci: { runId: ci.runId, url: ci.url, sha, ...(ci.attempt ? { attempt: ci.attempt } : {}) } } } }], 'engine');
    return true;
  }

  /**
   * CI for a head the chain left waiting (`op: awaiting_ci`), polled outside the serial merge chain
   * the way driveHeld polls a held item's, so one item's CI never holds up another's merge. Red,
   * a timeout and a blocked Actions take the same paths as ever; green goes back into the chain,
   * which merges it if the head is still on the base tip, and re-syncs it if another merge moved
   * the base in the meantime.
   */
  private async watchCi(id: string): Promise<void> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.status !== 'IN_REVIEW' || fm.op !== 'awaiting_ci' || fm.blocked || fm.awaiting || !fm.ci_head_sha || !fm.pr || !fm.branch) return;
    const headSha = fm.ci_head_sha;
    const canFix = this.ctx.store.derived(item).flavor === 'worker';
    const opId = this.ctx.store.journal.begin('ci_wait', id, { pr: fm.pr, sha: headSha });
    // Each wait's end leaves the run's timing on the item and on this op's end, whichever path ends it (#179).
    const wait = async (previousSha: string | null, minAttempt?: number) => {
      const v = await this.ctx.ciWatch.waitForCi(id, fm.branch!, headSha, fm.pr!, previousSha, minAttempt);
      if (v !== 'stopping') await this.ctx.ciWatch.noteCiTiming(id, opId, headSha);
      return v;
    };
    let verdict = await wait((fm.op_data?.ci_replaced as string | null | undefined) ?? null);
    // A red on the infrastructure (#219) or on a known flake is re-run once, for this same head, before anything else happens to it.
    if (verdict === 'red') {
      const infra = await this.ctx.ciWatch.rerunIfInfra(id, opId, headSha);
      if (infra === 'blocked') return;
      if (infra) {
        verdict = await wait(null, infra);
        if (verdict === 'red' && await this.ctx.ciWatch.rerunIfInfra(id, opId, headSha) === 'blocked') return;
      } else if (canFix) {
        const attempt = await this.ctx.ciWatch.rerunIfFlaky(id, headSha);
        if (attempt) verdict = await wait(null, attempt);
      }
    }
    // Read after the wait, not before it: a setting changed in the meantime is the one that applies (#173).
    const cfg = this.ctx.store.config.ci;
    if (verdict === 'moved') { this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }], 'engine'); this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'head_moved' }); void this.ctx.tick(); return; }
    // The engine is stopping, which says nothing about CI: leave `op: awaiting_ci` on the item, and the next start re-enters the pipeline.
    if (verdict === 'stopping') { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'engine_stopping' }); return; }
    if (verdict === 'taken_over') { this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { activity: { actor: 'app', text: 'stopped waiting for CI to merge: you took this item over (its CI is still read)' } }], 'engine'); this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'taken_over' }); return; }
    if (verdict === 'skipped') { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'ci_skipped', head: headSha }); this.ctx.block(id, 'ci_skipped', (await this.ctx.ports.gh.prView(this.ctx.github, fm.pr)).isDraft ? `every CI run for ${headSha.slice(0, 7)} skipped its jobs because PR #${fm.pr} is a draft; mark it ready for review, then unblock` : `every CI run for ${headSha.slice(0, 7)} skipped its jobs, again after planestro sent ready for review once more; check the workflow's job conditions, start a run by hand, then unblock`); return; }
    if (verdict === 'cancelled') {
      // Still cancelled after its one re-run: nothing else is coming for this head, so it stops now rather than at ci.timeout_min (#174).
      const cur = this.ctx.store.requireItem(id).file.frontmatter;
      const run = cur.op_data?.ci as { runId?: number; url?: string } | undefined;
      this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), last_cancelled: { runId: run?.runId, sha: headSha, ...(run?.url ? { url: run.url } : {}) } } } }], 'engine');
      this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'ci_cancelled', run: run?.runId });
      this.ctx.block(id, 'ci_cancelled', `CI run ${run?.runId ?? '?'} for ${headSha.slice(0, 7)} was cancelled again after planestro re-ran it once${run?.url ? ` (${run.url})` : ''}; no other run is coming for this head. Re-run CI once what cancelled it is fixed (a job time limit, a concurrency group), or push a new head`);
      return;
    }
    // A timeout on a runner that looks stalled or offline is the runner's, said once for every item on it (#216), not triaged item by item.
    const stall = verdict === 'timeout' || verdict === 'queue_timeout' ? await this.ctx.ciWatch.runnerStallFor(id) : undefined;
    const onRunner = stall ? `; runner ${stall.label} looks stalled or offline` : '';
    if (verdict === 'timeout') { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'ci_timeout' }); this.ctx.block(id, 'ci_timeout', `CI for ${headSha.slice(0, 7)} ran longer than ${cfg.timeout_min} min after a runner started it${this.ctx.ciWatch.ciQueueNote()}${onRunner}`, 'user', stall); return; }
    if (verdict === 'queue_timeout') { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'ci_queue_timeout' }); this.ctx.block(id, 'ci_timeout', `CI for ${headSha.slice(0, 7)} waited ${cfg.queue_timeout_min} min for a runner and never started${this.ctx.ciWatch.ciQueueNote()}${onRunner}. A queue, not a failure: check the runners' capacity, not the change`, 'user', stall); return; }
    if (verdict === 'blocked') {
      if (cfg.mode === 'github-or-local' && cfg.local_check_command) {
        this.ctx.store.mutateItem(id, [{ set: { op: 'running_local_checks', op_started_at: this.ctx.now() } }, { activity: { actor: 'app', text: `GitHub Actions is blocked; running local gate: ${cfg.local_check_command}` } }], 'engine');
        const r = await this.ctx.withLocalJobSlot(() => this.ctx.ports.proc.run(cfg.local_check_command!, { cwd: this.ctx.absWorktree(fm.worktree!), timeoutMs: cfg.timeout_min * 60_000 }));
        if (r.code !== 0) { await this.ctx.ciWatch.onCiRed(id, opId, headSha, `local checks exited ${r.code}\n${(r.stdout + r.stderr).split('\n').filter((l) => /FAIL|Error/i.test(l)).slice(-40).join('\n')}`, 'local'); return; }
        // Remembered for this head, so the chain's own look at it counts the local gate as its green.
        const cur = this.ctx.store.requireItem(id).file.frontmatter;
        this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), local_green: headSha } } }, { activity: { actor: 'app', text: 'local checks passed (used as the CI gate)' } }], 'engine');
      } else { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'ci_blocked' }); this.ctx.block(id, 'ci_blocked', 'GitHub Actions did not run (billing blocked or workflow missing); set ci.mode to github-or-local with a local_check_command, or re-run by hand'); return; }
    }
    if (verdict === 'red') { await this.ctx.ciWatch.onCiRed(id, opId, headSha, undefined, 'github', canFix); return; }
    // Green for this exact head, recorded as such: the chain's look at it reads this, never a fresh poll that could disagree.
    const cur = this.ctx.store.requireItem(id).file.frontmatter;
    this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'green', op_data: { ...(cur.op_data ?? {}), ci_green: headSha } } }], 'engine');
    if (this.parkIfHeld(id, opId)) return;
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `CI is green for ${headSha.slice(0, 7)}; back in the merge queue` } }], 'engine');
    this.ctx.store.journal.end(opId, id, 'ok', { green: headSha });
    await this.mergeJob(id);
  }

  /** Green, but a hold, block or question landed while CI ran: the verdict is kept and nothing merges. Returns whether it parked. */
  private parkIfHeld(id: string, opId: string): boolean {
    const latest = this.ctx.store.requireItem(id).file.frontmatter;
    if (latest.review_hold && !latest.skip_merge && !latest.blocked && !latest.awaiting) {
      // Synced and green: everything a machine can check has passed. What is left is a person's eye.
      this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'green', awaiting: 'review' } }, { activity: { actor: 'app', text: 'CI is green; waiting for your review before merging' } }], 'engine', { commit: `${id}: awaiting review` });
      this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'awaiting_review' });
      return true;
    }
    if (latest.skip_merge || latest.blocked || latest.awaiting || latest.taken_over) {
      this.ctx.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'green' } }, { activity: { actor: 'app', text: `CI is green but the item is held (${latest.taken_over ? 'taken over' : latest.skip_merge ? 'skip_merge' : latest.blocked ? 'blocked' : 'awaiting ' + latest.awaiting}); not merging` } }], 'engine');
      this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'held_after_ci' });
      return true;
    }
    return false;
  }

  /** 4. merge, inside the chain, on a head the chain has just seen green on the base tip. */
  /**
   * What proved a merge green (#180): the run for this exact head (`op_data.ci`, which a later head's run replaces), or the
   * local gate, or a change the project's CI does not run for; with the head, the base tip it was synced onto and the merge commit.
   */
  private validationPointer(id: string, headSha: string, baseSha?: string, merged?: string): NonNullable<ItemFrontmatter['validated_by']> {
    const od = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {};
    const run = od.ci as { runId?: number; url?: string; attempt?: number; sha?: string } | undefined;
    const gate = run?.runId && run.sha === headSha ? { run_id: run.runId, ...(run.attempt ? { attempt: run.attempt } : {}), ...(run.url ? { url: run.url } : {}) }
      : od.local_green === headSha ? { gate: 'local' as const } : od.ci_not_run === headSha ? { gate: 'not_run' as const } : { gate: 'unknown' as const };
    return { ...gate, head: headSha, ...(baseSha ? { base: baseSha } : {}), ...(merged ? { merge: merged } : {}) };
  }

  async merge(id: string, opId: string, base: string, headSha: string, baseSha?: string): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    // Commits made after the review touch something the reviewer never saw: held for the orchestrator to accept or send back (#74).
    const extra = fm.ci_head_sha ? await this.ctx.outsideApprovedScope(id, fm.ci_head_sha) : [];
    if (extra.length) {
      const list = extra.slice(0, 8).join(', ') + (extra.length > 8 ? `, and ${extra.length - 8} more` : '');
      const why = `commits after your approval touched ${extra.length} path${extra.length === 1 ? '' : 's'} the approved change did not: ${list}`;
      // A release approves the paths it lets through; the same paths held again on the same head mean it did not (#209).
      const prior = this.ctx.store.requireItem(id).file.frontmatter.op_data?.scope_held as { sha?: string; paths?: string[] } | undefined;
      const held = extra.slice(0, 50);
      const again = prior?.sha === fm.ci_head_sha && prior?.paths?.join('\n') === held.join('\n');
      this.ctx.store.mutateItem(id, [
        { unset: ['op', 'op_started_at'] }, ...this.ctx.holdOps(why, 'app', 'agent'),
        { set: { op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), scope_held: { sha: fm.ci_head_sha, paths: held } } } },
        ...(again ? [{ activity: { actor: 'app' as const, text: `the same path${extra.length === 1 ? '' : 's'} on the same head ${fm.ci_head_sha!.slice(0, 7)} ${extra.length === 1 ? 'was' : 'were'} held before and released, but the release did not approve ${extra.length === 1 ? 'it' : 'them'}: a planestro bug (#209), not something the session did` } }] : []),
      ], 'engine', { commit: `${id}: held (changed after approval)` });
      this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'outside_approved_scope', paths: extra.slice(0, 50) });
      this.ctx.wakeOrchestrator('scope_changed', id, { paths: extra.slice(0, 50).join('\n'), policy: 'Release the hold (unskip_merge) if these belong to the change: that approves them. Otherwise message_session to revert them, and the PR is checked again before it merges.' });
      return;
    }
    // Record what this branch changed while it still exists: dependents are told from this, not from a summary.
    const delivered = await this.ctx.reviewUndo.deliveredBy(id).catch(() => undefined);
    this.ctx.store.mutateItem(id, [{ set: { op: 'merging', op_started_at: this.ctx.now(), ci_result: 'green', ...(delivered ? { delivered } : {}) } }], 'engine');
    if (await this.ctx.ports.gh.mergePr(this.ctx.github, fm.pr!, { headSha }) === 'head_moved') {
      this.ctx.store.mutateItem(id, [{ set: { ci_result: 'pending' } }], 'engine');
      this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'head_moved', head: headSha });
      this.ctx.block(id, 'merge_head_moved', `PR #${fm.pr} moved after ${headSha.slice(0, 7)} passed checks; nothing merged. Inspect and sync the branch, then retry validation.`);
      return;
    }
    const view = await this.ctx.ports.gh.prView(this.ctx.github, fm.pr!);
    if (view.state !== 'MERGED') { this.ctx.store.journal.end(opId, id, 'failed', { state: view.state }); this.ctx.block(id, 'merge_unverified', `gh reported the merge but PR #${fm.pr} is ${view.state}`); return; }
    const validated = this.validationPointer(id, headSha, baseSha, view.mergeCommit);
    const evidence = validated.run_id ? `CI run ${validated.run_id}${validated.url ? ` (${validated.url})` : ''}` : validated.gate === 'local' ? 'the local gate' : validated.gate === 'not_run' ? 'no CI run (CI does not run for this change)' : 'a CI verdict with no run on record';
    this.ctx.store.mutateItem(id, [
      { transition: { to: 'MERGED', actor: 'engine' } },
      { set: { merged_at: view.mergedAt ? isoLocal(new Date(view.mergedAt)) : this.ctx.now(), validated_by: validated, op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), merge_commit: view.mergeCommit } } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `merged PR #${fm.pr} into ${base}${view.mergeCommit ? ` (${view.mergeCommit.slice(0, 7)})` : ''}; validated by ${evidence} on ${headSha.slice(0, 7)}${baseSha ? ` over ${base}@${baseSha.slice(0, 7)}` : ''}` } },
    ], 'engine', { commit: `${id}: merge` });
    this.ctx.store.journal.end(opId, id, 'ok', { merged: true, validated_by: validated });
    this.ctx.note('info', `${id}: PR #${fm.pr} merged into ${base}`);
    this.ctx.wakeOrchestrator('pr_merged', id);
    this.ctx.announce('on_merge', `${id} merged`, `PR #${fm.pr} merged into ${base}: ${fm.title}`, id);
    await this.ctx.cleanupReconcile.cleanup(id);
  }
}
