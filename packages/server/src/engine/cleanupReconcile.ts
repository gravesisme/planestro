import { join, relative, basename } from 'node:path';
import { isoLocal } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Ports, RebaseResult } from './ports.ts';
import type { ReviewUndo } from './reviewUndo.ts';
import { RESUMABLE_TURN_OPS } from './resumableOps.ts';

/**
 * A folder name planestro's `worktrees.dir_pattern` could have made (#416): the shared `.claude/worktrees` root also holds
 * other tools' worktrees (Claude Code's agent-*, a person's perf-*), which no item can own, so they are listed, never woken on.
 */
export function plannedWorktreeName(pattern: string, prefixLower: string): RegExp {
  const parts = pattern.split(/(\{\{\s*\w+\s*\}\})/).map((p) => {
    const ph = /^\{\{\s*(\w+)\s*\}\}$/.exec(p)?.[1];
    if (!ph) return p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return ph === 'prefix_lower' ? prefixLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ph === 'number' ? '\\d+' : '.*';
  });
  return new RegExp(`^${parts.join('')}$`);
}

/**
 * Cleanup and reconcile (#404, seam 4): every destructive git operation the engine's cleanup paths perform, in one file
 * so invariant 7 (destructive operations require positive evidence) is audited in one place. Cleanup after a merge
 * (positive evidence, keep_on_remove / byproducts set aside, leftover folders, the branches), the reconciler (stale ops,
 * PR and worktree truth, the FINISHED leftover-branch marker, orphan worktrees), the move-asides a sync makes
 * (`clearForSync`, a refused sync set aside and run once more, an epic's `merge-<id>` worktree), and the release of a
 * worktree that holds no work. LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface CleanupReconcileContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'git' | 'gh'>;
  /** The code repo's main checkout, and its GitHub `owner/name` (throws when code_repo.github is not configured). */
  readonly repo: string;
  readonly github: string;
  /** Turns this engine started and items with a job in flight: read only, so nothing driven is reconciled under it. */
  readonly turns: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<string, unknown>;
  /** Cleanup drops an item's Undo checkpoints at FINISHED, after the worktree and branches. */
  readonly reviewUndo: Pick<ReviewUndo, 'dropCheckpoints'>;
  now(): string;
  absWorktree(rel: string): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  block(id: string, reason: string, detail: string): void;
  runJob(id: string, fn: () => Promise<unknown>): void;
  blockClosedPr(id: string, n: number): Promise<void>;
  wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void;
  /** `worktrees.byproducts`, and a worktree's dirt less them: reads shared with turns and commits, so they stay on the engine. */
  isByproduct(path: string): boolean;
  worktreeDirt(cwd: string): Promise<{ clean: boolean; dirty: string[]; byproducts: string[] }>;
}

export class CleanupReconcile {
  constructor(private readonly ctx: CleanupReconcileContext) {}
  /**
   * Before a worktree goes: what `worktrees.keep_on_remove` names is set aside (dogfood p40: a merge
   * removed HH-161's worktree and the art worker's raw sources in its git-ignored tmp/ with it).
   * Moved, never deleted (invariant 7), to a folder the Activity log names. Returns that line.
   */
  async setAsideBeforeRemove(id: string, cwd: string): Promise<string | undefined> {
    const keep = this.keptPaths();
    const byproducts = this.ctx.store.config.worktrees.byproducts.length ? (await this.ctx.worktreeDirt(cwd).catch(() => ({ byproducts: [] as string[] }))).byproducts : [];
    if (!keep.length && !byproducts.length) return undefined;
    // Only what git does not track: a tracked file (HH's tmp/.gdignore) moved away is a deletion,
    // which leaves the worktree dirty and `git worktree remove` refuses it (dogfood p46). The
    // branch is merged, so its tracked files are safe in history anyway.
    const under = keep.length ? await this.ctx.ports.git.filesUnder(cwd, keep).catch(() => [] as string[]) : [];
    const tracked = new Set(under.length ? await this.ctx.ports.git.trackedAt(cwd, 'HEAD', under).catch(() => under) : []);
    const files = under.filter((f) => !tracked.has(f));
    // Byproducts are untracked by definition; `git worktree remove` refuses a tree that has them.
    const regenerated = byproducts.filter((f) => !files.includes(f));
    if (!files.length && !regenerated.length) return undefined;
    const dest = join(this.ctx.store.worktreesRoot(), '.displaced', `${id.toLowerCase()}-${this.ctx.now().replace(/[:+]/g, '-')}`);
    await this.ctx.ports.git.moveAside(cwd, [...files, ...regenerated], dest);
    const n = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`;
    const what = [
      ...(files.length ? [`${n(files.length, 'file')} under ${keep.join(', ')} (worktrees.keep_on_remove)`] : []),
      ...(regenerated.length ? [`${n(regenerated.length, 'byproduct')} (worktrees.byproducts)`] : []),
    ];
    return `set aside ${what.join(' and ')} before removing the worktree: ${dest}`;
  }

  /**
   * A merged item's worktree folder that git no longer lists (#356: a `git worktree remove` that dropped the registration
   * and left files behind, so every retry failed with "is not a working tree"). Unlisted and holding no `.git`, it is not a
   * worktree any more: its files are moved to `.displaced/`, never deleted (invariant 7), and the empty folder goes.
   */
  private async setAsideLeftover(id: string, cwd: string): Promise<void> {
    const dest = this.displacedDir(id);
    const files = await this.ctx.ports.git.setAsideLeftover(cwd, dest);
    if (!files) return;
    const n = files.length;
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `the worktree ${cwd} was already unregistered in git; ${n ? `moved the ${n} file${n === 1 ? '' : 's'} left in it to ${dest} (${files.slice(0, 12).join(', ')}${n > 12 ? ', …' : ''}) and ` : ''}removed the empty folder` } }], 'engine');
  }

  /** What is set aside when a worktree goes: keep_on_remove, and what copy_to_checkout copies (a copy keeps its original too). */
  private keptPaths(): string[] {
    const w = this.ctx.store.config.worktrees;
    return [...new Set([...w.keep_on_remove, ...w.copy_to_checkout])];
  }

  /**
   * After a merge, before the worktree goes (#72): the untracked files under `worktrees.copy_to_checkout`
   * are copied to the same paths in the main checkout. A sandboxed worker (the art runner) cannot write
   * there, and every art brief's "copy the raws into the main tmp/" step waited on a person. Never
   * over a file with other content: that one stays only in .displaced/. Throws when a copy fails.
   */
  private async copyToCheckout(cwd: string): Promise<string | undefined> {
    const paths = this.ctx.store.config.worktrees.copy_to_checkout;
    if (!paths.length) return undefined;
    const under = await this.ctx.ports.git.filesUnder(cwd, paths);
    const tracked = new Set(under.length ? await this.ctx.ports.git.trackedAt(cwd, 'HEAD', under) : []);
    const files = under.filter((f) => !tracked.has(f) && !this.ctx.isByproduct(f));
    if (!files.length) return undefined;
    const { copied, identical, collided } = await this.ctx.ports.git.copyInto(cwd, files, this.ctx.repo);
    const n = (k: number) => `${k} file${k === 1 ? '' : 's'}`;
    return [
      `copied ${n(copied.length)} under ${paths.join(', ')} into the main checkout (worktrees.copy_to_checkout)`,
      ...(identical.length ? [`${n(identical.length)} already there`] : []),
      ...(collided.length ? [`${n(collided.length)} not copied because the checkout has a different file at that path, kept only in .displaced/: ${collided.slice(0, 10).join(', ')}${collided.length > 10 ? ', …' : ''}`] : []),
    ].join('; ');
  }

  async cleanup(id: string): Promise<void> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    // Only a merged item is cleaned up: a second cleanup queued behind one that already finished it has nothing to do (#214).
    if (fm.status !== 'MERGED') return;
    // A person may be standing in the worktree: it and the branch stay until the item is handed back.
    if (fm.taken_over) { this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: 'merged; its worktree and branch stay until you hand the item back' } }], 'engine'); return; }
    const d = this.ctx.store.derived(item);
    if (d.flavor === 'external' && (fm.merge_policy ?? 'watch') === 'watch') {
      this.ctx.store.mutateItem(id, [{ transition: { to: 'FINISHED', actor: 'engine' } }, { activity: { actor: 'app', text: 'externally driven: no local resources to clean (the remote branch is not planestro\'s to delete)' } }], 'engine', { commit: `${id}: finish` });
      return;
    }
    const base = d.base_branch!;
    const opId = this.ctx.store.journal.begin('cleaning_up', id, { branch: fm.branch });
    this.ctx.store.mutateItem(id, [{ set: { op: 'cleaning_up', op_started_at: this.ctx.now() } }], 'engine');
    // invariant 7: positive evidence before anything is deleted
    try {
      // No worktree path left means it was already removed, like a worktree missing from `git worktree list`.
      const cwd = fm.worktree ? this.ctx.absWorktree(fm.worktree) : undefined;
      await this.ctx.ports.git.fetch(this.ctx.repo);
      const view = await this.ctx.ports.gh.prView(this.ctx.github, fm.pr!);
      // The proof covers exactly what is about to be deleted — the worktree's HEAD and the
      // local and remote branch tips, whichever still exist — never a remembered sha: a branch
      // pushed or merged outside planestro leaves ci_head_sha stale (dogfood p39). When all
      // three are already gone (removed by hand), a merged PR leaves nothing to prove.
      const tips: Array<[string, string]> = [];
      const worktrees = await this.ctx.ports.git.worktreeList(this.ctx.repo);
      if (cwd && worktrees.some((w) => w.path === cwd)) tips.push(['worktree HEAD', await this.ctx.ports.git.revParse(cwd, 'HEAD')]);
      const localTip = fm.branch && await this.ctx.ports.git.localBranchExists(this.ctx.repo, fm.branch) ? await this.ctx.ports.git.revParse(this.ctx.repo, `refs/heads/${fm.branch}`) : null;
      if (localTip) tips.push([fm.branch!, localTip]);
      const remoteTip = fm.branch ? await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, fm.branch) : null;
      if (remoteTip) tips.push([`origin/${fm.branch}`, remoteTip]);
      const stranded: string[] = [];
      for (const [what, sha] of tips) if (!await this.ctx.ports.git.isAncestor(this.ctx.repo, sha, `origin/${base}`)) stranded.push(`${what} ${sha.slice(0, 7)}`);
      if (view.state !== 'MERGED' || stranded.length) { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'unverifiable', stranded }); this.ctx.block(id, 'cleanup_unverifiable', view.state !== 'MERGED' ? `PR #${fm.pr} is ${view.state}; nothing was deleted` : `cannot prove ${stranded.join(', ')} reachable from origin/${base}; nothing was deleted`); return; }
      const { clean } = cwd && worktrees.some((w) => w.path === cwd) ? await this.ctx.worktreeDirt(cwd) : { clean: true };
      if (!clean) { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'dirty' }); this.ctx.block(id, 'cleanup_dirty', 'the worktree has uncommitted changes after the merge; remove it by hand or discard them'); return; }
      if (cwd && !worktrees.some((w) => w.path === cwd)) await this.setAsideLeftover(id, cwd);
      else if (cwd) {
        let copied: string | undefined;
        try { copied = await this.copyToCheckout(cwd); }
        catch (e) { this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'copy_failed' }); this.ctx.block(id, 'cleanup_dirty', `copying ${this.ctx.store.config.worktrees.copy_to_checkout.join(', ')} into the main checkout failed (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)}); nothing was removed`); return; }
        if (copied) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: copied } }], 'engine');
        const kept = await this.setAsideBeforeRemove(id, cwd);
        if (kept) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: kept } }], 'engine');
        try { await this.ctx.ports.git.worktreeRemove(this.ctx.repo, cwd, false); }
        catch (e) {
          // Git can drop the registration and still fail to delete the folder (#356): unlisted now, what is left is a leftover.
          if ((await this.ctx.ports.git.worktreeList(this.ctx.repo)).some((w) => w.path === cwd)) throw e;
          await this.setAsideLeftover(id, cwd);
        }
      }
      await this.ctx.ports.git.worktreePrune(this.ctx.repo);
      await this.ctx.ports.git.deleteLocalBranch(this.ctx.repo, fm.branch!, localTip);
      if (d.flavor !== 'external') await this.ctx.ports.git.deleteRemoteBranch(this.ctx.repo, fm.branch!, remoteTip);
      const dropped = await this.ctx.reviewUndo.dropCheckpoints(id);
      this.ctx.store.mutateItem(id, [
        { transition: { to: 'FINISHED', actor: 'engine' } },
        { unset: ['op', 'op_started_at'] },
        { activity: { actor: 'app', text: `removed worktree and branch ${fm.branch} (local + remote)${dropped ? `; ${dropped}` : ''}` } },
      ], 'engine', { commit: `${id}: finish` });
      this.ctx.store.journal.end(opId, id, 'ok');
      this.ctx.note('info', `${id}: finished`);
    } catch (e) {
      this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'verification_failed' });
      this.ctx.block(id, 'cleanup_unverifiable', `cleanup stopped; remaining resources were kept: ${(e as Error).message}`);
    }
  }

  // ---- reconciliation (Phase 5): cross-check persisted state against the world ----
  /**
   * Never assumes an operation completed and never deletes on its own authority
   * (invariant 7 — deletions still go through cleanup's positive-evidence checks).
   * Every correction is logged to the item's Activity as `reconcile: …`.
   * One pass at a time: its GitHub reads retry for about a minute each, and during an outage the five-minute timer stacked passes.
   */
  private reconciling?: Promise<string[]>;
  reconcile(source: 'startup' | 'periodic' | 'manual'): Promise<string[]> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileOnce(source).finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async reconcileOnce(source: 'startup' | 'periodic' | 'manual'): Promise<string[]> {
    const corrections: string[] = [];
    const correct = (id: string, text: string, ops: ItemOp[] = []) => {
      corrections.push(`${id}: ${text}`);
      this.ctx.store.mutateItem(id, [...ops, { activity: { actor: 'app', text: `reconcile: ${text}` } }], 'engine');
    };
    await this.ctx.ports.git.fetch(this.ctx.repo).catch(() => undefined);
    const worktrees = await this.ctx.ports.git.worktreeList(this.ctx.repo).catch(() => []);
    const remoteHeads = await this.ctx.ports.git.remoteHeads(this.ctx.repo).catch(() => new Map<string, string>());
    const github = this.ctx.store.config.code_repo.github;
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      const id = item.id;
      const d = this.ctx.store.derived(item);
      const wtAbs = fm.worktree ? this.ctx.absWorktree(fm.worktree) : undefined;
      const wtEntry = wtAbs ? worktrees.find((w) => w.path === wtAbs) : undefined;
      try {
        // stale in-flight ops (turn ops are handled by resumeInterrupted)
        if (fm.op && !RESUMABLE_TURN_OPS.has(fm.op) && !this.ctx.jobs.has(id) && !this.ctx.turns.has(id)) {
          if (fm.op === 'rebasing' || fm.op === 'syncing_base') {
            // A sync between turns (syncWithBase) has no CI verdict to reset; the merge step's does.
            const pendingCi: ItemOp[] = fm.status === 'IN_REVIEW' ? [{ set: { ci_result: 'pending' } }] : [];
            if (wtAbs && wtEntry && await this.ctx.ports.git.inProgressOp(wtAbs)) { await this.ctx.ports.git.abortInProgress(wtAbs); correct(id, `aborted a half-done ${fm.op} left by a crash`, [{ unset: ['op', 'op_started_at'] }, ...pendingCi]); }
            else correct(id, `cleared stale op ${fm.op}`, [{ unset: ['op', 'op_started_at'] }, ...pendingCi]);
          } else if (fm.op === 'pushing' || fm.op === 'creating_pr') {
            const pr = github && fm.branch ? (await this.ctx.ports.gh.prList(github, { head: fm.branch, state: 'open' }))[0] : undefined;
            if (pr && fm.status === 'IN_PROGRESS') correct(id, `adopted PR #${pr.number} opened before the crash`, [{ transition: { to: 'IN_REVIEW', actor: 'engine' } }, { set: { pr: pr.number, ci_result: 'pending' } }, { unset: ['op', 'op_started_at'] }]);
            else correct(id, `cleared stale op ${fm.op}; the pipeline will retry`, [{ unset: ['op', 'op_started_at'] }]);
          } else if (fm.op === 'merging' || fm.op === 'cleaning_up' || fm.op === 'awaiting_ci' || fm.op === 'running_local_checks') {
            correct(id, `cleared stale op ${fm.op}`, [{ unset: ['op', 'op_started_at'] }, ...(fm.status === 'IN_REVIEW' ? [{ set: { ci_result: 'pending' as const } }] : [])]);
          } else if (fm.op === 'creating_worktree' || fm.op === 'importing') {
            correct(id, `restart during ${fm.op}; re-running setup`, [{ unset: ['op', 'op_started_at'] }]);
            if (fm.status === 'PLAN_IN_PROGRESS' && !wtEntry) this.ctx.store.mutateItem(id, [{ transition: { to: 'QUEUED', actor: 'engine' } }], 'engine');
          }
        }
        // pull request truth
        // Not while a job or turn drives the item: the merge queue merging it is not "merged outside planestro".
        if (fm.pr && github && (fm.status === 'IN_REVIEW' || fm.status === 'MERGED' || fm.status === 'IN_PROGRESS') && !this.ctx.jobs.has(id) && !this.ctx.turns.has(id)) {
          const pr = await this.ctx.ports.gh.prView(github, fm.pr).catch(() => undefined);
          // The item as it is after that wait, not as it was read before it: LM-22's merge job moved it to MERGED in the
          // same second, and the stale IN_REVIEW read tried MERGED → MERGED and blocked a finished item as engine_error.
          const now = this.ctx.store.getItem(id)?.file.frontmatter;
          if (!now || now.status !== fm.status || this.ctx.jobs.has(id) || this.ctx.turns.has(id)) continue;
          if (pr?.state === 'MERGED' && (fm.status === 'IN_REVIEW' || fm.status === 'IN_PROGRESS')) {
            if (fm.status === 'IN_PROGRESS') this.ctx.store.mutateItem(id, [{ transition: { to: 'IN_REVIEW', actor: 'engine' } }], 'engine');
            correct(id, `PR #${fm.pr} was merged outside planestro`, [{ transition: { to: 'MERGED', actor: 'engine' } }, { set: { merged_at: pr.mergedAt ? isoLocal(new Date(pr.mergedAt)) : this.ctx.now(), ci_result: 'green' } }]);
            this.ctx.runJob(id, () => this.cleanup(id));
          } else if (pr?.state === 'CLOSED' && fm.status === 'IN_REVIEW' && !fm.blocked && !fm.taken_over) {
            await this.ctx.blockClosedPr(id, fm.pr);
            corrections.push(`${id}: PR #${fm.pr} closed externally`);
          } else if (pr?.state === 'OPEN' && fm.status === 'IN_REVIEW' && fm.ci_head_sha && pr.headRefOid !== fm.ci_head_sha && fm.ci_result !== 'pending') {
            correct(id, `branch tip moved (${pr.headRefOid.slice(0, 7)}); CI verdict discarded`, [{ set: { ci_result: 'pending' } }]);
          }
        }
        // worktree truth (never recreate silently: local commits could be lost). Not while a job owns the item or
        // its worktree is being made, and only on a fresh read: the list and `fm` above can predate the
        // `git worktree add` of startItem / recreateWorktree / planEpic (dogfood p55, LM-12).
        const gone = d.flavor === 'worker' && wtAbs && !wtEntry && !this.ctx.jobs.has(id) && !(await this.ctx.ports.git.worktreeList(this.ctx.repo).catch(() => worktrees)).some((w) => w.path === wtAbs);
        const cur = gone && !this.ctx.jobs.has(id) ? this.ctx.store.getItem(id)?.file.frontmatter : undefined;
        if (cur && cur.worktree === fm.worktree && cur.op !== 'creating_worktree' && cur.op !== 'importing' && ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'].includes(cur.status) && !cur.blocked && !cur.taken_over) {
          this.ctx.block(id, 'worktree_missing', `the worktree ${fm.worktree} no longer exists; status preserved, nothing recreated`);
          corrections.push(`${id}: worktree missing`);
        }
        // MERGED but never finished, or FINISHED leftovers
        if (fm.status === 'MERGED' && !fm.op && !this.ctx.jobs.has(id) && !fm.blocked && !fm.taken_over) { corrections.push(`${id}: resuming cleanup`); this.ctx.runJob(id, () => this.cleanup(id)); }
        // Said once per tip: every five minutes it rewrote the item, its journal and a commit, forever.
        const leftTip = fm.status === 'FINISHED' && fm.branch && d.flavor !== 'external' ? remoteHeads.get(fm.branch) : undefined;
        if (leftTip && fm.op_data?.leftover_branch !== leftTip) correct(id, `remote branch ${fm.branch} still exists after finish (left in place; delete by hand or re-run cleanup)`, [{ set: { op_data: { ...(fm.op_data ?? {}), leftover_branch: leftTip } } }]);
      } catch (e) { corrections.push(`${id}: reconcile error ${(e as Error).message}`); }
    }
    // orphans: worktrees under our root that no item references
    const root = this.ctx.store.worktreesRoot();
    const referenced = new Set(this.ctx.store.listItems().map((i) => i.file.frontmatter.worktree && this.ctx.absWorktree(i.file.frontmatter.worktree!)).filter(Boolean));
    // A worktree inside an item's worktree is that item's (a project tool made it: LM-24's look-compare baseline), not an orphan (#100).
    const inReferenced = (p: string) => [...referenced].some((r) => p.startsWith(`${r}/`));
    const orphans = worktrees.filter((w) => w.path.startsWith(root + '/') && !referenced.has(w.path) && !inReferenced(w.path));
    if (orphans.length) {
      corrections.push(`orphan worktrees: ${orphans.map((o) => o.path).join(', ')}`);
      // Wake the orchestrator only for an orphan it has not been told about: a wake per reconcile pass would re-ask the same
      // question every five minutes, and one per change re-asked about LM's four July worktrees whenever a fifth came and went.
      // Only a folder planestro's dir_pattern could have made is woken on: other tools share the root (#416, HH's agent-*).
      const key = orphans.map((o) => o.path).sort().join('|');
      const last = this.ctx.store.journal.read({ type: 'reconcile.orphans_reported', limit: 1 })[0];
      const told = new Set(String(last?.data?.key ?? '').split('|').filter(Boolean));
      const ours = plannedWorktreeName(this.ctx.store.config.worktrees.dir_pattern, this.ctx.store.config.project.id_prefix.toLowerCase());
      const prefix = this.ctx.store.config.project.id_prefix.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const epicMerge = new RegExp(`^merge-${prefix}-\\d+$`); // an epic's own merge worktree (mergeEpic) is planestro's too
      const planned = orphans.filter((o) => ours.test(relative(root, o.path)) || epicMerge.test(relative(root, o.path)));
      if (planned.some((o) => !told.has(o.path))) {
        this.ctx.store.journal.append({ type: 'reconcile.orphans_reported', actor: 'engine', data: { key, count: orphans.length } });
        this.ctx.wakeOrchestrator('orphans_found', undefined, { worktrees: planned.map((o) => `${o.path} (${o.branch ?? o.head})`).join('\n') });
      }
    }
    this.ctx.store.journal.append({ type: 'reconcile.done', actor: 'engine', data: { source, corrections } });
    if (corrections.length) this.ctx.note('warn', `reconcile (${source}): ${corrections.length} correction(s): ${corrections.slice(0, 5).join(' | ')}`);
    else if (source === 'manual') this.ctx.note('info', 'reconcile: everything matches');
    return corrections;
  }

  // ---- move-asides a sync makes (invariant 7): what is in its way goes to `.displaced/`, never deleted ----
  /**
   * Clear the way for a sync, and return what is still in it (empty: go on). The one dirty tree the
   * sync may clear by itself (dogfood p17): every change is an untracked file that the base now
   * tracks under the same path. Those are artefacts regenerated in this worktree (a Godot import run
   * leaves .import sidecars) that collide with the copies another item just merged. They are moved
   * aside to a folder outside the worktree, never deleted (invariant 7), and the Activity log names
   * them and where they went. Untracked byproducts are not in the way unless they collide too.
   * Anything else leaves the tree as it is.
   */
  async clearForSync(id: string, cwd: string, base: string): Promise<string[]> {
    const { tracked, untracked } = await this.ctx.ports.git.dirtyDetail(cwd);
    const work = untracked.filter((f) => !this.ctx.isByproduct(f));
    if (tracked.length) return [...tracked, ...work];
    if (!untracked.length) return [];
    await this.ctx.ports.git.fetch(this.ctx.repo);
    const colliding = await this.ctx.ports.git.trackedAt(cwd, `origin/${base}`, untracked);
    const hit = new Set(colliding);
    const stays = work.filter((f) => !hit.has(f));
    if (stays.length) return stays;
    if (!colliding.length) return [];
    const dest = this.displacedDir(id);
    await this.ctx.ports.git.moveAside(cwd, colliding, dest);
    const left = (await this.ctx.worktreeDirt(cwd)).dirty;
    if (left.length) return left;
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `moved ${colliding.length} untracked file${colliding.length === 1 ? '' : 's'} that ${base} now tracks out of the way (regenerated copies; nothing deleted) to ${dest}: ${colliding.slice(0, 12).join(', ')}${colliding.length > 12 ? ', …' : ''}` } }], 'engine', { commit: `${id}: set regenerated files aside` });
    return [];
  }

  /** Where a sync sets an item's files aside: outside every worktree, never deleted (invariant 7). */
  private displacedDir(id: string): string {
    return join(this.ctx.store.worktreesRoot(), '.displaced', `${id.toLowerCase()}-${this.ctx.now().replace(/[:+]/g, '-')}`);
  }

  /**
   * Run a sync, and once more if git refused it only over untracked files it would overwrite (#212): files the
   * incoming side now tracks (a byproduct regenerated here, an epic's child adding what this worktree made). They
   * are set aside as clearForSync sets them aside, moved and never deleted. Any other refusal is returned as it is.
   */
  async syncAside(id: string, cwd: string, run: () => Promise<RebaseResult>): Promise<RebaseResult> {
    const r = await run();
    const paths = r.refused?.paths ?? [];
    if (!paths.length) return r;
    const { untracked } = await this.ctx.ports.git.dirtyDetail(cwd);
    if (!paths.every((p) => untracked.includes(p))) return r;
    const dest = this.displacedDir(id);
    await this.ctx.ports.git.moveAside(cwd, paths, dest);
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `git would not overwrite ${paths.length} untracked file${paths.length === 1 ? '' : 's'} the sync brings in; moved ${paths.length === 1 ? 'it' : 'them'} aside (nothing deleted) to ${dest}: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ', …' : ''}; syncing again` } }], 'engine', { commit: `${id}: set untracked files aside` });
    return run();
  }

  /**
   * An epic's merge worktree (`merge-<id>`) is written only by planestro and its one-shot sessions, so changes
   * left in it are leftovers, not work (HH-260: a conflict session pushed, left the tree dirty, and the next sync
   * was refused). Before merging, they are set aside (#212): the tips are logged first, untracked files are moved
   * and changed tracked files copied to `.displaced/`, then the tree goes back to its own HEAD. Returns what is
   * still in the way (empty: go on); a merge or rebase left half-done, or a path that cannot be copied, stays.
   */
  async clearMergeWorktree(id: string, cwd: string, branch: string): Promise<string[]> {
    if (basename(cwd) !== `merge-${id.toLowerCase()}`) return [];
    const { tracked, untracked } = await this.ctx.ports.git.dirtyDetail(cwd);
    const loose = untracked.filter((f) => !this.ctx.isByproduct(f));
    const dirt = [...tracked, ...loose];
    if (!dirt.length) return [];
    // A rename shows as `old -> new`; a quoted path (unusual characters) cannot be copied by name, so a person looks.
    const changed = tracked.flatMap((t) => t.split(' -> '));
    if (changed.some((t) => t.startsWith('"')) || await this.ctx.ports.git.inProgressOp(cwd)) return dirt;
    const head = await this.ctx.ports.git.revParse(cwd, 'HEAD');
    const remote = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch);
    const dest = this.displacedDir(id);
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `the merge worktree ${cwd} has changes nothing committed (${dirt.slice(0, 12).join(', ')}${dirt.length > 12 ? ', …' : ''}) at ${head.slice(0, 7)}, origin/${branch} at ${remote ? remote.slice(0, 7) : '(not pushed)'}; setting them aside to ${dest} (nothing deleted) and putting the tree back on ${head.slice(0, 7)} before merging` } }], 'engine', { commit: `${id}: set merge worktree changes aside` });
    if (loose.length) await this.ctx.ports.git.moveAside(cwd, loose, dest);
    const files = await this.ctx.ports.git.filesUnder(cwd, changed);
    if (files.length && (await this.ctx.ports.git.copyInto(cwd, files, dest)).collided.length) return dirt;
    await this.ctx.ports.git.resetHard(cwd, head);
    return (await this.ctx.worktreeDirt(cwd)).dirty;
  }

  // ---- releasing a worktree and branch that hold no work (close as done, kind conversion): removed only on positive evidence ----
  /** Returns the Activity line describing what was removed, or what was left in place and why. */
  async releaseUnusedWorktree(cwd: string, branch: string, base: string | undefined): Promise<string> {
    const unused = await this.unusedWorktree(cwd, branch, base);
    return 'keep' in unused ? `left worktree ${cwd} and branch ${branch} in place: ${unused.keep}` : this.removeUnusedWorktree(cwd, branch, base!, unused.remote, unused.local);
  }

  /** Positive evidence that a worktree and its branch hold no work (invariant 7): a clean tree and nothing ahead of a freshly fetched base. Otherwise why not. */
  async unusedWorktree(cwd: string, branch: string, base: string | undefined): Promise<{ keep: string } | { remote: string | null; local: string | null }> {
    if (!base) return { keep: 'the base branch could not be resolved' };
    try {
      const { clean, dirty } = await this.ctx.worktreeDirt(cwd);
      if (!clean) return { keep: `uncommitted changes (${dirty.slice(0, 5).join(', ')})` };
      await this.ctx.ports.git.fetch(this.ctx.repo);
      const { ahead } = await this.ctx.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
      if (ahead > 0) return { keep: `${ahead} commit(s) are not on origin/${base}` };
      const remote = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch);
      if (remote && !await this.ctx.ports.git.isAncestor(this.ctx.repo, remote, `origin/${base}`)) return { keep: `the pushed branch has commits that are not on origin/${base}` };
      const local = await this.ctx.ports.git.localBranchExists(this.ctx.repo, branch) ? await this.ctx.ports.git.revParse(this.ctx.repo, `refs/heads/${branch}`) : null;
      if (local && !await this.ctx.ports.git.isAncestor(this.ctx.repo, local, `origin/${base}`)) return { keep: 'the local branch has unmerged commits' };
      return { remote, local };
    } catch (e) { return { keep: `could not verify it is unused (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)})` }; }
  }

  async removeUnusedWorktree(cwd: string, branch: string, base: string, remote: string | null, local: string | null): Promise<string> {
    const brief = (e: unknown) => (e as Error).message.replace(/\s+/g, ' ').slice(0, 200);
    let kept: string | undefined;
    try {
      kept = await this.setAsideBeforeRemove(branch.replace(/[\/\\]/g, '-'), cwd);
      await this.ctx.ports.git.worktreeRemove(this.ctx.repo, cwd, false);
      await this.ctx.ports.git.worktreePrune(this.ctx.repo);
      await this.ctx.ports.git.deleteLocalBranch(this.ctx.repo, branch, local);
      await this.ctx.ports.git.deleteRemoteBranch(this.ctx.repo, branch, remote);
    } catch (e) { return `removing the unused worktree ${cwd} / branch ${branch} stopped partway (${brief(e)}); finish it by hand`; }
    return `removed unused worktree and branch ${branch} (clean, nothing ahead of origin/${base})${kept ? `; ${kept}` : ''}`;
  }
}
