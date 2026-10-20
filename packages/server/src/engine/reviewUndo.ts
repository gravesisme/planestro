import type { DataStore } from '../store/DataStore.ts';
import type { Checkpoint, Ports } from './ports.ts';
import type { ReviewImage, ReviewDiff, UndoTurnPreview } from './Engine.ts';
import { pngSize } from './placeholderPng.ts';
import { reviewKind } from './reviewKind.ts';

/**
 * Review and Undo (#404, seam 2): the user's review panel (what the branch changed, read from git alone, and what a merged
 * branch delivered to its dependents) and Undo last turn (#234: the per-turn checkpoints of a worker's worktree, the undo's
 * preview and restore on positive evidence, and the checkpoint refs' removal at FINISHED, which cleanup calls into).
 * LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface ReviewUndoContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'git' | 'gh'>;
  /** The code repo's main checkout, and its GitHub `owner/name` (throws when code_repo.github is not configured). */
  readonly repo: string;
  readonly github: string;
  /** Turns this engine started: read only, to refuse an undo while one runs. */
  readonly turns: ReadonlyMap<string, unknown>;
  /** Items with a job in flight: an undo holds its item here while it runs. */
  readonly jobs: Pick<Map<string, Promise<void>>, 'has' | 'set' | 'delete'>;
  now(): string;
  absWorktree(rel: string): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  deliverQueued(id: string, when: string): boolean;
}

export class ReviewUndo {
  constructor(private readonly ctx: ReviewUndoContext) {}

  // ---- review: what did the branch make? Answered from git alone; no model is asked.
  reviewRefs(id: string): { cwd: string; base: string; head: string } | undefined {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    const base = this.ctx.store.derived(item).base_branch;
    if (!fm.branch || !base || fm.status === 'FINISHED') return undefined;
    return { cwd: fm.worktree ? this.ctx.absWorktree(fm.worktree) : this.ctx.repo, base: `origin/${base}`, head: fm.branch };
  }

  /**
   * What the review panel reads (#233): the branch while it is the work; once merged, the merge commit against its
   * first parent, from the main checkout (the branch and worktree go at cleanup, and a merged branch is behind its base).
   */
  private mergeCommits = new Map<string, Promise<string | undefined>>();
  private async panelRefs(id: string): Promise<{ cwd: string; base: string; head: string } | undefined> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (fm.status !== 'MERGED' && fm.status !== 'FINISHED') return this.reviewRefs(id);
    const known = fm.op_data?.merge_commit;
    if (typeof known === 'string' && known) return { cwd: this.ctx.repo, base: `${known}^1`, head: known };
    if (!fm.pr || !this.ctx.store.config.code_repo.github) return undefined;
    const key = `${id}#${fm.pr}`;
    let mc = this.mergeCommits.get(key);
    if (!mc) {
      mc = this.ctx.ports.gh.prView(this.ctx.github, fm.pr).then((v) => v.state === 'MERGED' ? v.mergeCommit : undefined);
      this.mergeCommits.set(key, mc); mc.catch(() => this.mergeCommits.delete(key));
    }
    const sha = await mc.catch(() => undefined);
    return sha ? { cwd: this.ctx.repo, base: `${sha}^1`, head: sha } : undefined;
  }

  /** By item, the list for one head and base: the page and every picture on it ask, and a branch with 23 files took seconds each time. */
  private reviewCache = new Map<string, { key: string; files: Promise<ReviewImage[]> }>();
  async reviewImages(id: string): Promise<ReviewImage[]> {
    const refs = await this.panelRefs(id);
    if (!refs) return [];
    const [head, base] = await Promise.all([this.ctx.ports.git.revParse(refs.cwd, refs.head).catch(() => ''), this.ctx.ports.git.revParse(refs.cwd, refs.base).catch(() => '')]);
    const key = `${head}:${base}`;
    const hit = head && base ? this.reviewCache.get(id) : undefined;
    if (hit?.key === key) return hit.files;
    const files = (async () => {
      // Every other file is reviewed as text, by its diff (#233); git says when one is binary.
      const changed = await this.ctx.ports.git.changedFiles(refs.cwd, refs.base, refs.head).catch(() => []);
      return Promise.all(changed.map(async (f) => ({ ...f, kind: reviewKind(f.path) ?? 'text' as const, ...(f.change !== 'deleted' && /\.png$/i.test(f.path) ? pngSize(await this.ctx.ports.git.readBlob(refs.cwd, refs.head, f.path)) : {}) })));
    })();
    if (head && base) { this.reviewCache.set(id, { key, files }); files.catch(() => this.reviewCache.delete(id)); }
    return files;
  }

  /** Only files the branch actually changed can be read through here. */
  async reviewImage(id: string, path: string, side: 'before' | 'after'): Promise<Buffer | null> {
    const refs = await this.panelRefs(id);
    if (!refs || !(await this.reviewImages(id)).some((f) => f.path === path)) return null;
    if (side === 'after') return this.ctx.ports.git.readBlob(refs.cwd, refs.head, path);
    const mb = await this.ctx.ports.git.mergeBase(refs.cwd, refs.base, refs.head);
    return mb ? this.ctx.ports.git.readBlob(refs.cwd, mb, path) : null;
  }

  /** A text file's diff, per file so the panel stays as quick as #159 made it; a huge one is cut, and says so. */
  async reviewDiff(id: string, path: string): Promise<ReviewDiff | null> {
    const refs = await this.panelRefs(id);
    const file = refs && (await this.reviewImages(id)).find((f) => f.path === path);
    if (!refs || !file) return null;
    const full = await this.ctx.ports.git.fileDiff(refs.cwd, refs.base, refs.head, path);
    const max = 1_000_000;
    const truncated = full.length > max;
    const patch = truncated ? full.slice(0, full.lastIndexOf('\n', max) + 1) : full;
    return { path, change: file.change, patch, binary: /^Binary files .* differ$/m.test(patch) && !/^@@ /m.test(patch), truncated };
  }

  async deliveredBy(id: string): Promise<ReviewImage[] | undefined> {
    const refs = this.reviewRefs(id);
    if (!refs) return undefined;
    const files = (await this.ctx.ports.git.changedFiles(refs.cwd, refs.base, refs.head)).slice(0, 200);
    return Promise.all(files.map(async (f) => ({ ...f, ...(f.change !== 'deleted' && /\.png$/i.test(f.path) ? pngSize(await this.ctx.ports.git.readBlob(refs.cwd, refs.head, f.path)) : {}) })));
  }

  // ---- per-turn checkpoints and Undo last turn (#234) ----

  private checkpointPrefix(id: string): string { return `refs/planestro/checkpoints/${id}/`; }
  private checkpointTurnOf(id: string, ref: string): number { return Number(ref.slice(this.checkpointPrefix(id).length).split('/')[0]) || 0; }

  /**
   * The worker's worktree before its turn (`before`, numbered after every checkpoint the item has) and as the turn left it
   * (`after`, under the same number). Refs are only added. A failure is a line in Activity, never a failed turn: that turn
   * just cannot be undone.
   */
  async checkpointTurn(id: string, cwd: string, n: number | undefined, kind: 'before' | 'after'): Promise<number | undefined> {
    try {
      const turn = n ?? 1 + Math.max(0, ...(await this.ctx.ports.git.checkpoints(this.ctx.repo, this.checkpointPrefix(id))).map((c) => this.checkpointTurnOf(id, c.ref)));
      await this.ctx.ports.git.checkpoint(cwd, `${this.checkpointPrefix(id)}${turn}/${kind}`);
      return turn;
    } catch (e) {
      if (this.ctx.store.getItem(id)) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `no checkpoint ${kind === 'before' ? 'before' : 'after'} this turn, so it cannot be undone: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 300)}` } }], 'engine');
      return undefined;
    }
  }

  /** The line a worker's next turn opens with after the user undid its last one; said once. */
  undoneNote(id: string): string | undefined {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const u = fm.op_data?.turn_undone as { turn: number; head?: string } | undefined;
    if (!u) return undefined;
    const { turn_undone: _said, ...rest } = fm.op_data ?? {};
    this.ctx.store.mutateItem(id, [{ set: { op_data: rest } }], 'engine');
    return `[planestro] The user undid your last turn (turn ${u.turn}): the branch, its index and the worktree's files are back as they were before it${u.head ? ` (HEAD ${u.head.slice(0, 7)})` : ''}. What you did in that turn is no longer in the worktree. Look at the worktree as it is now before you go on.`;
  }

  private undoRefusal(id: string, own = false): string | null {
    const item = this.ctx.store.getItem(id);
    if (!item) return `${id} does not exist`;
    const fm = item.file.frontmatter;
    if (this.ctx.store.derived(item).flavor !== 'worker' || !fm.worktree || !fm.branch) return `${id} has no worktree and branch of its own: there is no turn to undo`;
    if (!['IN_PROGRESS', 'IN_REVIEW'].includes(fm.status)) return `${id} is ${fm.status}; a turn is undone only while its work is in progress or in review`;
    if (this.ctx.turns.has(id)) return `${id} has a turn running; undo the last turn once it has ended`;
    if ((!own && this.ctx.jobs.has(id)) || fm.op) return `${id} has a step running (${fm.op?.replace(/_/g, ' ') ?? 'an engine step'}); undo the last turn when that ends`;
    if (fm.triage) return `the orchestrator is triaging ${id}; undo the last turn once it has finished`;
    return null;
  }

  /**
   * Whether the last turn can be undone, on positive evidence only (invariant 7): nothing live on the item, the turn's two
   * checkpoints, the worktree exactly as the turn left it (HEAD on the branch, index and every file git does not ignore),
   * no rebase or merge stopped half-way, and nothing of the turn's on the remote (read fresh: the remote branch is absent,
   * or at an ancestor of where the turn began). Anything else is a refusal that says why; nothing is discarded on doubt.
   */
  private async undoState(id: string, own = false): Promise<{ refusal: string } | { refusal: null; n: number; cwd: string; branch: string; before: Checkpoint; after: Checkpoint }> {
    const no = (refusal: string) => ({ refusal });
    const sync = this.undoRefusal(id, own);
    if (sync) return no(sync);
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const cwd = this.ctx.absWorktree(fm.worktree!); const branch = fm.branch!;
    try {
      const cps = await this.ctx.ports.git.checkpoints(this.ctx.repo, this.checkpointPrefix(id));
      if (!cps.length) return no(`${id} has no turn checkpoints: nothing to undo`);
      const n = Math.max(...cps.map((c) => this.checkpointTurnOf(id, c.ref)));
      const of = (kind: string) => cps.find((c) => c.ref === `${this.checkpointPrefix(id)}${n}/${kind}`);
      const undone = of('undone');
      if (undone) return no(`turn ${n} was already undone; what it left is kept at ${undone.ref} (${undone.sha.slice(0, 7)})`);
      const before = of('before'); const after = of('after');
      if (!before || !after) return no(`turn ${n} has no checkpoint from its ${before ? 'end' : 'start'} (planestro stopped during it, or recording failed): nothing is undone`);
      if (!before.head) return no(`turn ${n} began with no HEAD to go back to`);
      const stopped = await this.ctx.ports.git.inProgressOp(cwd);
      if (stopped) return no(`a ${stopped} is unfinished in the worktree: finish or abort it first; nothing is undone`);
      const now = await this.ctx.ports.git.snapshot(cwd);
      if (now.head !== after.head) return no(`HEAD moved since turn ${n} ended (${after.head?.slice(0, 7)} → ${now.head?.slice(0, 7)}): undoing would discard more than the turn; nothing is undone`);
      if (now.tree !== after.tree || now.index !== after.index) return no(`the worktree changed since turn ${n} ended (a file was edited, staged, added or removed after it): undoing would discard more than the turn; nothing is undone`);
      const tip = await this.ctx.ports.git.revParse(this.ctx.repo, `refs/heads/${branch}`).catch(() => undefined);
      if (tip !== after.head) return no(`the worktree is not on its branch ${branch} at ${after.head?.slice(0, 7)}: nothing is undone`);
      await this.ctx.ports.git.fetch(this.ctx.repo);
      const remote = await this.ctx.ports.git.remoteBranchSha(this.ctx.repo, branch);
      if (remote && !await this.ctx.ports.git.isAncestor(this.ctx.repo, remote, before.head)) return no(`origin/${branch} is at ${remote.slice(0, 7)}, which holds work from turn ${n} or after it: work on the remote is not undone`);
      return { refusal: null, n, cwd, branch, before, after };
    } catch (e) {
      return no(`could not check the worktree and its remote (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 300)}): nothing is undone`);
    }
  }

  /** What the Undo dialog shows: the last turn, the files and patch it would discard, its commits, and the token the undo is confirmed with. */
  async undoTurnPreview(id: string): Promise<UndoTurnPreview> {
    const s = await this.undoState(id);
    if (s.refusal !== null) return { refusal: s.refusal };
    const diff = await this.ctx.ports.git.treeDiff(s.cwd, s.before.tree, s.after.tree);
    const commits = s.before.head !== s.after.head ? await this.ctx.ports.git.log(s.cwd, `${s.before.head}..${s.after.head}`, 30).catch(() => '') : '';
    return { refusal: null, turn: s.n, ...(s.after.at ? { at: s.after.at } : {}), head: s.before.head!, files: diff.files, patch: diff.patch, ...(diff.truncated ? { truncated: true } : {}), commits, expect: s.after.sha };
  }

  /**
   * Undo last turn (#234): the user, having seen what it discards (`expect` is the turn's end checkpoint they were shown),
   * puts the worktree back as it was before the item's last turn: branch tip, index and files. Everything is checked again
   * here, with the item held so nothing starts on it meanwhile. What the turn left is recorded first under `<n>/undone` (so
   * even the undo can be undone) and named in Activity. The worker's next turn is told. User-only. Returns what happened.
   */
  async undoTurn(id: string, expect: string): Promise<string> {
    const early = this.undoRefusal(id);
    if (early) throw new Error(early);
    let release!: () => void;
    this.ctx.jobs.set(id, new Promise<void>((r) => { release = r; }));
    try {
      const s = await this.undoState(id, true);
      if (s.refusal !== null) throw new Error(s.refusal);
      if (s.after.sha !== expect) throw new Error(`the last turn changed since you looked (turn ${s.n} now ends at ${s.after.sha.slice(0, 7)}): look again`);
      const kept = await this.ctx.ports.git.checkpoint(s.cwd, `${this.checkpointPrefix(id)}${s.n}/undone`);
      this.ctx.store.mutateItem(id, [{ activity: { actor: 'user', text: `undoing turn ${s.n}: what it left is kept at ${kept.ref} (${kept.sha}); HEAD ${s.after.head?.slice(0, 7)} → ${s.before.head!.slice(0, 7)}` } }], 'user');
      await this.ctx.ports.git.restoreSnapshot(s.cwd, s.after, s.before);
      const now = await this.ctx.ports.git.snapshot(s.cwd).catch(() => undefined);
      const exact = now && now.head === s.before.head && now.tree === s.before.tree && now.index === s.before.index;
      const said = `undid turn ${s.n}: the worktree is back as it was before it (HEAD ${s.before.head!.slice(0, 7)}); what the turn left is kept at ${kept.ref}${exact ? '' : '. The worktree does not match the checkpoint exactly: look at it before the work goes on'}`;
      const fm = this.ctx.store.requireItem(id).file.frontmatter;
      this.ctx.store.mutateItem(id, [
        { set: { op_data: { ...(fm.op_data ?? {}), turn_undone: { turn: s.n, head: s.before.head, ref: kept.ref, at: this.ctx.now() } } } },
        { activity: { actor: 'user', text: said } },
      ], 'user', { commit: `${id}: undo turn ${s.n}` });
      this.ctx.note('info', `${id}: ${said}`);
      return said;
    } finally {
      this.ctx.jobs.delete(id);
      release();
      this.ctx.deliverQueued(id, 'the undo ended');
    }
  }

  /** At FINISHED, after the cleanup's proof: the item's checkpoint refs go, each leased to its tip, every tip written to Activity first. */
  async dropCheckpoints(id: string): Promise<string | undefined> {
    const prefix = this.checkpointPrefix(id);
    const cps = await this.ctx.ports.git.checkpoints(this.ctx.repo, prefix).catch(() => []);
    if (!cps.length) return undefined;
    this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `dropping ${cps.length} checkpoint refs under ${prefix}: ${cps.map((c) => `${c.ref.slice(prefix.length)} ${c.sha}`).join(', ')}` } }], 'engine');
    let kept = 0;
    for (const c of cps) if (!await this.ctx.ports.git.deleteRef(this.ctx.repo, c.ref, c.sha).catch(() => false)) kept++;
    return kept ? `dropped ${cps.length - kept} checkpoint refs; ${kept} moved or could not be deleted and were kept` : `dropped ${cps.length} checkpoint refs`;
  }
}
