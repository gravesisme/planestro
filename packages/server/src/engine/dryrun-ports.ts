import { placeholderPng } from './placeholderPng.ts';
import { matchesPathPattern } from './ports.ts';
import type { GitPort, GhPort, ProcPort, ClaudePort, AgentPort, AgentTurnOptions, WorktreeEntry, RebaseResult, CiStatus, PrInfo, IssueInfo, RunnerReport, TurnOptions, TurnResult, CustomTurnOptions } from './ports.ts';

/**
 * An in-memory world so a dry run advances end to end: worktrees, branches, PRs whose CI
 * goes green after a couple of polls (or red once with PLANESTRO_DRYRUN_CI=red-once), and a
 * fake Claude that submits a canned plan, "commits", and reports done. Every action is logged
 * as `Would …`.
 */
export class FakeWorld {
  worktrees = new Map<string, WorktreeEntry>();
  localBranches = new Set<string>();
  localTips = new Map<string, string>();
  remoteBranches = new Map<string, string>();     // branch → sha
  commits = new Map<string, number>();            // worktree → commits ahead
  /** Files a fake agent "committed", by branch — so a dry run has real images to review. */
  files = new Map<string, Map<string, Buffer>>();
  dirty = new Set<string>();
  /** Shas the fake base does not contain (isAncestor answers false for them). */
  unreachable = new Set<string>();
  prs = new Map<number, PrInfo & { polls: number; failOnce: boolean; attempt?: number; staleFailures?: number; cancelled?: boolean }>();
  /** Polls after a re-run request that still report the old, failed attempt (GitHub's lag). */
  rerunLagPolls = 0;
  /** A re-run of failed jobs fails again (a real failure, not a flake). */
  rerunFailsAgain = false;
  /** What `gh run view --log-failed` shows for a red run (#204: the files a failing check names); unset, the simulated line. */
  failedLog: string | undefined = undefined;
  /** The next PR's first run is cancelled and nothing replaces it (HH-321), until its failed jobs are re-run. */
  ciCancelOnce = false;
  /** Free space the disk guard reads (#161): undefined is "cannot tell", which never pauses. */
  freeBytes: number | undefined = undefined;
  /** Preview deployments by commit (#137): what previewUrl reports. */
  previews = new Map<string, string>();
  /** Untracked files by worktree, and the paths the base branch tracks (for regenerated files that collide with it). */
  untracked = new Map<string, string[]>();
  baseFiles = new Set<string>();
  /** Files git ignores, by worktree: invisible to status, gone with the worktree unless set aside (p40). */
  ignored = new Map<string, string[]>();
  /** Files present in a main checkout, by its path: what copy_to_checkout copied there (#72), or a test put there. */
  checkout = new Map<string, Set<string>>();
  /** Issues of the feedback repo (#231): what issueList reports and issueCreate adds to. */
  issues: IssueInfo[] = [];
  nextIssue = 1;
  nextPr = 100;
  seq = 0;
  ciMode: 'green' | 'red-once' | 'conflict-once' = (process.env.PLANESTRO_DRYRUN_CI as any) ?? 'green';
  conflictArmed = this.ciMode === 'conflict-once';
  /** The files a simulated conflict is in. */
  conflictFiles: string[] = ['src/conflicted.ts'];
  /**
   * Files git would not overwrite (#212): a sync is refused while one of them is dirty in the worktree (a tracked
   * change is `src/fake.ts`), as git refuses it. `refuseArmed` refuses the next sync once, over files it names none of.
   */
  refuseFor: string[] = [];
  refuseArmed = false;
  /** Tracked files a regenerate command changed, by worktree (#63): set by a test's proc port, shown by dirtyDetail. */
  regenerated = new Map<string, string[]>();
  /** Commits a worktree is behind its base (default 1: the base is assumed to have moved, so every dry run exercises the sync). A sync puts it on the tip; a merge moves the tip under the others. */
  behind = new Map<string, number>();
  /** How many `gh pr view` polls after a push still report the replaced head — GitHub's real propagation lag. */
  headLagPolls = 0;
  /** CI polls that found a draft PR (and so no run). */
  ciPolledWhileDraft = 0;
  staleHeads = new Map<string, { sha: string; polls: number }>();
  /**
   * A workflow with a draft guard, as GitHub runs it (HH-180): a push to a draft PR, or a
   * ready_for_review that lands while `gh pr view` still shows the replaced head, leaves only
   * skipped runs for the pushed head; a push to a ready PR, or ready_for_review on that head, runs it.
   */
  draftGuard = false;
  /** With draftGuard: which heads have a real run (the rest have only skipped runs). */
  realRuns = new Set<string>();
  /** The self-hosted runners and the CI workflow's open jobs (#216): what `runners` reports. None, as a GitHub-hosted project has. */
  runnerReport: RunnerReport = { runners: [], jobs: [] };
  /** ready_for_review events sent (`gh pr ready`). */
  readyEvents = 0;
  constructor(readonly log: (msg: string) => void, readonly baseBranches: Record<string, string> = {}) {}
  sha(): string { return (0x100000 + ++this.seq).toString(16).padEnd(40, '0'); }  // unique in its first seven characters, as short shas in Activity lines are
}

export class DryRunGitPort implements GitPort {
  constructor(private readonly w: FakeWorld) {}
  async changedFiles(_cwd: string, _base: string, head: string) { return [...(this.w.files.get(head.replace(/^origin\//, '')) ?? new Map<string, Buffer>()).entries()].map(([path, buf]) => ({ path, change: 'added' as const, bytes: buf.length })); }
  async mergeBase() { return null; }
  async readBlob(_cwd: string, ref: string, path: string) { return this.w.files.get(ref.replace(/^origin\//, ''))?.get(path) ?? null; }
  /** Every dry-run file is new: its diff adds each line. */
  async fileDiff(_cwd: string, _base: string, head: string, path: string) {
    const buf = this.w.files.get(head.replace(/^origin\//, ''))?.get(path);
    if (!buf) return '';
    if (buf.includes(0)) return `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`;
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join('')}`;
  }
  private say(m: string) { this.w.log(`Would ${m}`); }
  async fetch(repo: string) { this.say(`git fetch origin (in ${repo})`); }
  async revParse(cwd: string, ref: string) {
    if (ref === 'HEAD') return this.w.worktrees.get(cwd)?.head ?? this.w.sha();
    if (ref.startsWith('refs/heads/')) {
      const branch = ref.slice('refs/heads/'.length);
      const tip = [...this.w.worktrees.values()].find((w) => w.branch === branch)?.head ?? this.w.localTips.get(branch) ?? this.w.remoteBranches.get(branch) ?? this.w.sha();
      this.w.localTips.set(branch, tip); return tip;
    }
    return this.w.remoteBranches.get(ref.replace(/^origin\//, '')) ?? this.w.baseBranches[ref] ?? this.w.sha();
  }
  async refExists(_repo: string, ref: string) { return this.w.remoteBranches.has(ref.replace(/^(origin|refs\/heads)\//, '')) || ref.startsWith('origin/'); }
  async worktreeAddDetached(_repo: string, path: string, ref: string) { this.say(`git worktree add --detach ${path} ${ref}`); this.w.worktrees.set(path, { path, head: this.w.sha() }); }
  async worktreeAdd(_repo: string, path: string, branch: string, startRef: string) { this.say(`git worktree add -b ${branch} ${path} ${startRef}`); this.w.worktrees.set(path, { path, head: this.w.sha(), branch }); this.w.localBranches.add(branch); }
  async worktreeRemove(_repo: string, path: string, force: boolean) { this.say(`git worktree remove${force ? ' --force' : ''} ${path}`); const wt = this.w.worktrees.get(path); if (wt?.branch) this.w.localTips.set(wt.branch, wt.head); this.w.worktrees.delete(path); }
  async worktreePrune() { this.say('git worktree prune'); }
  async worktreeList() { return [...this.w.worktrees.values()]; }
  async status(cwd: string) { const u = this.w.untracked.get(cwd) ?? []; const dirty = [...(this.w.dirty.has(cwd) ? ['src/fake.ts'] : []), ...u]; return { clean: dirty.length === 0, dirty }; }
  async dirtyDetail(cwd: string) { return { tracked: [...(this.w.dirty.has(cwd) ? ['src/fake.ts'] : []), ...(this.w.regenerated.get(cwd) ?? [])], untracked: [...(this.w.untracked.get(cwd) ?? [])] }; }
  async trackedAt(_cwd: string, _ref: string, paths: string[]) { return paths.filter((p) => this.w.baseFiles.has(p)); }
  async moveAside(cwd: string, paths: string[], dest: string) { this.say(`move ${paths.join(', ')} from ${cwd} to ${dest}`); this.w.untracked.set(cwd, (this.w.untracked.get(cwd) ?? []).filter((p) => !paths.includes(p))); this.w.ignored.set(cwd, (this.w.ignored.get(cwd) ?? []).filter((p) => !paths.includes(p))); }
  async copyInto(cwd: string, paths: string[], destRoot: string) {
    this.say(`copy ${paths.join(', ')} from ${cwd} into ${destRoot}`);
    const have = this.w.checkout.get(destRoot) ?? new Set<string>(); this.w.checkout.set(destRoot, have);
    const collided = paths.filter((p) => have.has(p)); const copied = paths.filter((p) => !have.has(p));
    for (const p of copied) have.add(p);
    return { copied, identical: [], collided };
  }
  async filesUnder(cwd: string, paths: string[]) { const under = (f: string) => paths.some((p) => f === p || f.startsWith(`${p.replace(/\/+$/, '')}/`)); return [...this.w.baseFiles, ...(this.w.untracked.get(cwd) ?? []), ...(this.w.ignored.get(cwd) ?? [])].filter(under); }
  async commitAll(cwd: string, message: string, _leave: string[] = []) { this.say(`git add -A && git commit -m "${message.split('\n')[0]}" (in ${cwd})`); this.w.dirty.delete(cwd); this.w.commits.set(cwd, (this.w.commits.get(cwd) ?? 0) + 1); const wt = this.w.worktrees.get(cwd); const head = this.w.sha(); if (wt) wt.head = head; return head; }
  async aheadBehind(cwd: string) { return { ahead: this.w.commits.get(cwd) ?? 0, behind: this.w.behind.get(cwd) ?? 1 }; }
  /** A simulated conflict in `w.conflictFiles`: taken from the base when every one of them is a takeBase pattern's (#63). */
  private conflict(cwd: string, what: string, takeBase: string[]): RebaseResult | undefined {
    const dirt = [...(this.w.dirty.has(cwd) ? ['src/fake.ts'] : []), ...(this.w.untracked.get(cwd) ?? [])];
    const over = this.w.refuseFor.filter((p) => dirt.includes(p));
    if (over.length || this.w.refuseArmed) {
      this.w.refuseArmed = false;
      this.say(`${what} in ${cwd} → refused: local changes would be overwritten (simulated)`);
      return { ok: false, conflicts: [], head: this.w.worktrees.get(cwd)?.head ?? '', refused: { paths: over, message: over.length ? `error: Your local changes to the following files would be overwritten by merge: ${over.join(' ')} Aborting` : 'error: cannot rebase: You have unstaged changes.' } };
    }
    if (!this.w.conflictArmed) return undefined;
    this.w.conflictArmed = false;
    const files = this.w.conflictFiles;
    if (takeBase.length && files.every((f) => takeBase.some((p) => matchesPathPattern(f, p)))) {
      this.say(`${what} in ${cwd} → CONFLICT in ${files.join(', ')} (simulated); took the base's copy`);
      const wt = this.w.worktrees.get(cwd); const head = this.w.sha(); if (wt) wt.head = head; this.w.behind.set(cwd, 0);
      return { ok: true, conflicts: [], head, tookBase: [...files] };
    }
    this.say(`${what} in ${cwd} → CONFLICT (simulated)`);
    return { ok: false, conflicts: [...files], head: this.w.worktrees.get(cwd)?.head ?? '' };
  }
  async resetHard(cwd: string, sha: string) { this.say(`git reset --hard ${sha.slice(0, 7)} (in ${cwd})`); const wt = this.w.worktrees.get(cwd); if (wt) wt.head = sha; this.w.regenerated.delete(cwd); this.w.dirty.delete(cwd); }
  async commitPaths(cwd: string, paths: string[], message: string) {
    this.say(`git commit -m "${message.split('\n')[0]}" -- ${paths.join(' ')} (in ${cwd})`);
    // What was named is committed: the fake's one tracked change, and any untracked file among them.
    this.w.regenerated.delete(cwd);
    if (paths.includes('src/fake.ts')) this.w.dirty.delete(cwd);
    if (this.w.untracked.has(cwd)) this.w.untracked.set(cwd, this.w.untracked.get(cwd)!.filter((p) => !paths.includes(p)));
    this.w.commits.set(cwd, (this.w.commits.get(cwd) ?? 0) + 1);
    const wt = this.w.worktrees.get(cwd); const head = this.w.sha(); if (wt) wt.head = head; return head;
  }
  async rebase(cwd: string, onto: string, takeBase: string[] = []): Promise<RebaseResult> {
    const c = this.conflict(cwd, `git rebase ${onto}`, takeBase); if (c) return c;
    this.say(`git rebase ${onto} in ${cwd}`); const wt = this.w.worktrees.get(cwd); const head = this.w.sha(); if (wt) wt.head = head; this.w.behind.set(cwd, 0); return { ok: true, conflicts: [], head };
  }
  async merge(cwd: string, ref: string, takeBase: string[] = []): Promise<RebaseResult> {
    const c = this.conflict(cwd, `git merge ${ref}`, takeBase); if (c) return c;
    this.say(`git merge ${ref} in ${cwd}`); const wt = this.w.worktrees.get(cwd); const head = this.w.sha(); if (wt) wt.head = head;
    // Taking in the branch's own remote copy says nothing about the base; merging the base puts it on the tip.
    if (ref !== `origin/${wt?.branch}`) this.w.behind.set(cwd, 0);
    return { ok: true, conflicts: [], head };
  }
  async inProgressOp() { return null; }
  async abortInProgress() {}
  private setRemote(branch: string, sha: string) {
    const previous = this.w.remoteBranches.get(branch);
    if (previous && previous !== sha && this.w.headLagPolls > 0) this.w.staleHeads.set(branch, { sha: previous, polls: this.w.headLagPolls });
    this.w.remoteBranches.set(branch, sha);
    const pr = [...this.w.prs.values()].find((p) => p.headRefName === branch && p.state === 'OPEN');
    if (pr && !pr.isDraft) this.w.realRuns.add(sha);
  }
  async pushForceWithLease(cwd: string, branch: string) { this.say(`git push --force-with-lease origin ${branch} (from ${cwd})`); this.setRemote(branch, this.w.worktrees.get(cwd)?.head ?? this.w.sha()); }
  async pushSetUpstream(cwd: string, branch: string) { this.say(`git push -u origin ${branch} (from ${cwd})`); this.setRemote(branch, this.w.worktrees.get(cwd)?.head ?? this.w.sha()); }
  async pushRef(_repo: string, src: string, dst: string) { this.say(`git push origin ${src}:refs/heads/${dst}`); this.w.remoteBranches.set(dst, this.w.sha()); }
  async remoteHeads(): Promise<Map<string, string>> { return new Map(this.w.remoteBranches); }
  async remoteBranchSha(_repo: string, branch: string) { return this.w.remoteBranches.get(branch) ?? null; }
  async deleteRemoteBranch(repo: string, branch: string, expected: string | null) {
    if (expected === null) { if (this.w.remoteBranches.has(branch)) throw new Error(`remote branch ${branch} appeared after verification; kept it`); }
    else if (await this.deleteRemoteBranchAt(repo, branch, expected) === 'moved') throw new Error(`remote branch ${branch} moved after verification; kept it`);
  }
  async deleteRemoteBranchAt(_repo: string, branch: string, sha: string): Promise<'deleted' | 'moved' | 'gone'> {
    const now = this.w.remoteBranches.get(branch);
    if (now === undefined) return 'gone';
    if (now !== sha) return 'moved';
    this.say(`git push --force-with-lease=refs/heads/${branch}:${sha} origin :refs/heads/${branch}`); this.w.remoteBranches.delete(branch); return 'deleted';
  }
  async localBranchExists(_repo: string, branch: string) { return this.w.localBranches.has(branch); }
  async deleteLocalBranch(repo: string, branch: string, expected: string | null) {
    if (!this.w.localBranches.has(branch)) return;
    if (!expected || await this.revParse(repo, `refs/heads/${branch}`) !== expected) throw new Error(`local branch ${branch} moved after verification; kept it`);
    if ([...this.w.worktrees.values()].some((w) => w.branch === branch)) throw new Error(`local branch ${branch} is checked out; kept it`);
    this.say(`git update-ref -d refs/heads/${branch} ${expected}`); this.w.localBranches.delete(branch); this.w.localTips.delete(branch);
  }
  async isAncestor(_repo: string, ancestor: string) { return !this.w.unreachable.has(ancestor); }
  async log() { return 'abc1234 (dry-run) fake commit'; }
}

export class DryRunGhPort implements GhPort {
  async prDetails(repo: string, number: number) { return `Would read PR #${number} details in ${repo}`; }
  async prDiff(repo: string, number: number) { return `Would read PR #${number} diff in ${repo}`; }
  async runView(repo: string, runId: number) { return `Would read run ${runId} in ${repo}`; }
  constructor(private readonly w: FakeWorld) {}
  private say(m: string) { this.w.log(`Would ${m}`); }
  async createPr(repo: string, a: { base: string; head: string; title: string; draft?: boolean }) {
    const number = this.w.nextPr++;
    this.say(`gh pr create --base ${a.base} --head ${a.head} --title "${a.title}"${a.draft ? ' --draft' : ''}`);
    this.w.prs.set(number, { number, url: `https://github.com/${repo}/pull/${number}`, state: 'OPEN', isDraft: Boolean(a.draft), headRefOid: this.w.remoteBranches.get(a.head) ?? this.w.sha(), headRefName: a.head, baseRefName: a.base, polls: 0, failOnce: this.w.ciMode === 'red-once', cancelled: this.w.ciCancelOnce });
    this.w.ciCancelOnce = false;
    return { number, url: `https://github.com/${repo}/pull/${number}` };
  }
  async setDraft(_repo: string, number: number, draft: boolean) {
    this.say(`gh pr ready ${number}${draft ? ' --undo' : ''}`); const p = this.w.prs.get(number); if (!p) return;
    p.isDraft = draft;
    if (draft) return;
    this.w.readyEvents += 1;
    // The event's run is for the head GitHub shows right now, which lags a push.
    const stale = this.w.staleHeads.get(p.headRefName);
    this.w.realRuns.add(stale && stale.polls > 0 ? stale.sha : this.w.remoteBranches.get(p.headRefName) ?? p.headRefOid);
  }
  async prView(_repo: string, number: number) {
    const p = this.w.prs.get(number); if (!p) throw new Error(`no PR ${number}`);
    const stale = this.w.staleHeads.get(p.headRefName);
    if (stale && stale.polls > 0) { stale.polls -= 1; return { ...p, headRefOid: stale.sha }; }
    p.headRefOid = this.w.remoteBranches.get(p.headRefName) ?? p.headRefOid; return { ...p };
  }
  async prList(_repo: string, f: { head?: string; base?: string }) { return [...this.w.prs.values()].filter((p) => (!f.head || p.headRefName === f.head) && (!f.base || p.baseRefName === f.base)); }
  async ciForSha(_repo: string, branch: string, sha: string): Promise<CiStatus> {
    const p = [...this.w.prs.values()].find((x) => x.headRefName === branch);
    if (!p) return { state: 'none', sha };
    if (this.w.draftGuard && !this.w.realRuns.has(sha)) { if (p.isDraft) this.w.ciPolledWhileDraft += 1; return { state: 'skipped', runId: 4, sha, url: 'https://example/run/4' }; }
    if (p.isDraft && !this.w.draftGuard) { this.w.ciPolledWhileDraft += 1; return { state: 'none', sha }; } // CI skips drafts (dogfood f6)
    p.polls += 1;
    const attempt = p.attempt ?? 1;
    if (p.staleFailures) { p.staleFailures -= 1; return { state: 'failure', runId: 2, sha, url: 'https://example/run/2', attempt: attempt - 1 }; }
    if (p.cancelled) return { state: 'cancelled', runId: 5, sha, url: 'https://example/run/5', attempt };
    if (p.polls < 2) return { state: 'pending', runId: 1, sha, url: 'https://example/run/1', attempt };
    if (p.failOnce) { p.failOnce = false; p.polls = 0; return { state: 'failure', runId: 2, sha, url: 'https://example/run/2', attempt }; }
    return { state: 'success', runId: 3, sha, url: 'https://example/run/3', attempt };
  }
  async runFailedLog() { return this.w.failedLog ?? '[fake-check] FAIL: simulated failure (PLANESTRO_DRYRUN_CI=red-once)'; }
  async isBillingBlocked() { return false; }
  async rerunFailed(_repo: string, runId: number) {
    this.say(`gh run rerun ${runId} --failed`);
    for (const p of this.w.prs.values()) { p.attempt = (p.attempt ?? 1) + 1; p.polls = 0; p.staleFailures = this.w.rerunLagPolls; if (this.w.rerunFailsAgain) { p.failOnce = true; this.w.rerunFailsAgain = false; } }
  }
  async rerunAll(_repo: string, runId: number) { this.say(`gh run rerun ${runId}`); for (const p of this.w.prs.values()) if (p.cancelled) { p.cancelled = false; p.attempt = (p.attempt ?? 1) + 1; p.polls = 0; } }
  async previewUrl(_repo: string, sha: string): Promise<string | null> { return this.w.previews.get(sha) ?? null; }
  async issueList(_repo: string, opts: { limit: number }): Promise<IssueInfo[]> { return [...this.w.issues].sort((a, b) => b.number - a.number).slice(0, opts.limit); }
  async issueCreate(repo: string, a: { title: string; body: string }) {
    const number = Math.max(this.w.nextIssue++, ...this.w.issues.map((i) => i.number + 1));
    this.say(`gh issue create --repo ${repo} --title "${a.title}"`);
    const url = `https://github.com/${repo}/issues/${number}`;
    this.w.issues.push({ number, title: a.title, body: a.body, url, state: 'OPEN' });
    return { number, url };
  }
  async closePr(_repo: string, number: number, comment: string) { this.say(`gh pr close ${number} --comment "${comment}"`); const p = this.w.prs.get(number); if (p) p.state = 'CLOSED'; }
  async mergePr(_repo: string, number: number, opts: { headSha: string }): Promise<'merged' | 'head_moved'> {
    const p = this.w.prs.get(number)!;
    const head = this.w.remoteBranches.get(p.headRefName) ?? p.headRefOid;
    if (head !== opts.headSha) return 'head_moved';
    this.say(`gh pr merge ${number} --merge --match-head-commit ${opts.headSha}`);
    p.headRefOid = head; p.state = 'MERGED'; p.mergedAt = new Date().toISOString(); p.mergeCommit = this.w.sha();
    // The base moved: every other branch is behind it now, and syncs again before it merges.
    for (const [cwd, wt] of this.w.worktrees) if (wt.branch !== p.headRefName) this.w.behind.set(cwd, Math.max(1, this.w.behind.get(cwd) ?? 1));
    return 'merged';
  }
  async branchCi(): Promise<CiStatus> { return { state: 'success' }; }
  async runners(): Promise<RunnerReport> { return structuredClone(this.w.runnerReport); }
}

export class DryRunProcPort implements ProcPort {
  constructor(private readonly w: FakeWorld) {}
  async run(command: string, opts: { cwd: string }) { this.w.log(`Would run \`${command}\` in ${opts.cwd}`); return { code: 0, stdout: '', stderr: '' }; }
  /** A test sets `freeBytes` on the world to fill the disk (#161); otherwise there is plenty. */
  async freeBytes() { return this.w.freeBytes; }
}

/** The Codex runner's stand-in: implements only, reports through its result like the live port's closing JSON. */
export class DryRunCodexPort implements AgentPort {
  constructor(private readonly w: FakeWorld) {}
  async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> { return { ...await new DryRunClaudePort(this.w).runCustomTurn(o), tokens: 1500 }; }
  async runTurn(o: AgentTurnOptions | TurnOptions): Promise<TurnResult> {
    if (o.transport === 'app-server') return { ...await new DryRunClaudePort(this.w).runTurn(o as TurnOptions), tokens: 1500 };
    this.w.log(`Would run codex exec${o.resume ? ` resume ${o.resume.slice(0, 8)}` : ''} for ${o.itemId} (${o.phase}) in ${o.cwd} under the workspace-write sandbox${o.images?.length ? ` with ${o.images.length} image(s)` : ''}`);
    const sessionId = o.resume ?? `dryrun-codex-${o.itemId}-${this.w.sha().slice(-6)}`;
    o.onOutput(`(dry-run codex) prompt: ${o.prompt.slice(0, 120).replace(/\n/g, ' ')}…`);
    await o.tools.append_activity('dry-run codex: pretended to generate the assets and commit them');
    this.w.commits.set(o.cwd, (this.w.commits.get(o.cwd) ?? 0) + 1);
    // A picture per turn, so reviewing (and sending back) shows something real in a dry run.
    const branch = this.w.worktrees.get(o.cwd)?.branch;
    if (branch) {
      const files = this.w.files.get(branch) ?? new Map<string, Buffer>();
      const path = [...files.keys()][0] ?? `assets/${o.itemId.toLowerCase()}.png`;
      files.set(path, placeholderPng(`${o.itemId}#${this.w.commits.get(o.cwd)}`));
      this.w.files.set(branch, files);
    }
    const summary = `Dry-run Codex turn for ${o.itemId}: assets generated and committed (simulated).`;
    await o.tools.report_done(summary);
    return { sessionId, subtype: 'success', isError: false, costUsd: 0, tokens: 1500, numTurns: 1, text: summary, done: summary };
  }
}

/** Fake Claude: plans, "commits", and reports done, exercising the same tool surface as the SDK path. */
export class DryRunClaudePort implements ClaudePort {
  constructor(private readonly w: FakeWorld) {}

  /** Fake orchestrator: approves the plans whose approval was delegated to it, annotates nothing else, and closes with done_with_wake. */
  async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
    this.w.log(`Would run an orchestrator wake (${o.label}) with ${o.model}${o.resume ? `, resuming ${o.resume.slice(0, 8)}` : ''}${o.images?.length ? ` with ${o.images.length} image(s)` : ''}`);
    o.onOutput(`(dry-run) wake: ${o.prompt.slice(0, 120).replace(/\n/g, ' ')}…`);
    const approve = o.mcpTools.find((t) => t.name === 'approve_plan');
    const convert = o.mcpTools.find((t) => t.name === 'convert_item');
    const approved: string[] = [];
    for (const packet of o.prompt.split('\n\n---\n\n')) {
      const id = /^Item: (\S+)/m.exec(packet)?.[1];
      if (!id || !packet.includes('Plan approval: DELEGATED TO YOU')) continue;
      // A plan that reads as an epic is converted, never approved (#69, HH-198).
      if (packet.includes('THIS IS AN EPIC') && convert) { await convert.handler({ id, to: 'epic', reason: 'dry-run: the plan is an epic breakdown' }); continue; }
      if (approve && String(await approve.handler({ id, notes: 'dry-run: approved without reading' })).startsWith('approved')) approved.push(id);
    }
    // A chat message gets an answer, so the demo's chat is not a dead end.
    const said = /^message: (.*)$/m.exec(o.prompt)?.[1];
    const reply = o.mcpTools.find((t) => t.name === 'reply_to_user');
    if (said !== undefined && /Event: user_message/.test(o.prompt) && reply) await reply.handler({ text: `(dry-run) I would read the backlog and answer: “${said.slice(0, 200)}”. Switch to live mode for a real reply.` });
    // So is a question's thread: the demo's question page gets an answer where the user asked.
    const onQuestion = /^Event: question_message\nQuestion (Q-\d+)/m.exec(o.prompt)?.[1];
    const replyOn = o.mcpTools.find((t) => t.name === 'reply_on_question');
    if (onQuestion && replyOn) await replyOn.handler({ id: onQuestion, text: '(dry-run) I would weigh your answer against the item and carry it out. Switch to live mode for a real reply.' });
    const done = o.mcpTools.find((t) => t.name === 'done_with_wake');
    if (done) await done.handler({ summary: approved.length ? `dry-run: approved ${approved.join(', ')}` : 'dry-run: reviewed the wake, no action needed' });
    return { sessionId: o.resume ?? `dryrun-orch-${this.w.sha().slice(-6)}`, subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: 'wake handled (dry-run)' };
  }
  async runTurn(o: TurnOptions): Promise<TurnResult> {
    this.w.log(`Would run a ${o.phase} turn for ${o.itemId} with ${o.model} (${o.permissionMode}) in ${o.cwd}${o.resume ? `, resuming ${o.resume.slice(0, 8)}` : ''}`);
    const sessionId = o.resume ?? `dryrun-${o.itemId}-${this.w.sha().slice(-6)}`;
    const base: TurnResult = { sessionId, subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
    o.onOutput(`(dry-run) prompt: ${o.prompt.slice(0, 120).replace(/\n/g, ' ')}…`);
    if (o.phase === 'plan' && /## Break this epic down/.test(o.prompt)) {
      const ids = [...o.prompt.matchAll(/^- `([^`]+)` — .*\(runner (\w+)\)/gm)].map((m) => ({ id: m[1], runner: m[2] }));
      const art = ids.find((m) => m.runner !== 'claude')?.id; const code = ids.find((m) => m.runner === 'claude')?.id ?? ids[0]?.id ?? 'unknown';
      const title = /^You are planning EPIC \S+ — "(.*)"/m.exec(o.prompt)?.[1] ?? 'the epic';
      const children = art ? [
        { title: `${title}: icon`, description: `Draw the icon for "${title}" and save it as assets/icon.png (256×256 PNG, transparent background), matching the existing art.`, implementer: art, depends_on: [] },
        { title: `${title}: illustration`, description: `Draw the header illustration for "${title}" and save it as assets/header.png (1200×400 PNG), matching the existing art.`, implementer: art, depends_on: [] },
        { title: `${title}: implementation`, description: `Implement "${title}". It uses assets/icon.png and assets/header.png, which the art children deliver; do not create or edit them.`, implementer: code, depends_on: [0, 1] },
        { title: `${title}: docs`, description: `Document "${title}" in the README, with the header illustration at assets/header.png.`, implementer: code, depends_on: [1, 2] },
      ] : [
        { title: `${title}: implementation`, description: `Implement "${title}" as described in the epic, with tests.`, implementer: code, depends_on: [] },
        { title: `${title}: docs`, description: `Document "${title}" in the README once the implementation has landed.`, implementer: code, depends_on: [0] },
      ];
      const plan = `# Epic plan (dry-run)\n\n${art ? 'Art first, in parallel, on the art implementer; then the code that consumes it; docs last.' : 'Implementation, then docs.'} Children never share files.`;
      const answer = await o.tools.submit_breakdown(plan, children);
      return { ...base, planSubmitted: answer.startsWith('Rejected') ? undefined : plan, text: answer };
    }
    if (o.phase === 'plan') {
      const plan = `# Plan (dry-run)\n\n1. Inspect the code the request touches.\n2. Make the change.\n3. Run the project's checks.\n\nRequest:\n${o.prompt.split('## Request')[1]?.split('##')[0]?.trim() ?? ''}`;
      await o.tools.submit_plan(plan);
      return { ...base, planSubmitted: plan, text: 'Plan submitted (dry-run).' };
    }
    await o.tools.append_activity('dry-run: pretended to edit files and run checks');
    this.w.commits.set(o.cwd, (this.w.commits.get(o.cwd) ?? 0) + 1);
    const wt = this.w.worktrees.get(o.cwd); if (wt) wt.head = this.w.sha();
    const summary = o.phase === 'fix' ? 'Fixed the simulated failure and committed.' : 'Implemented the plan and committed (dry-run).';
    await o.tools.report_done(summary);
    return { ...base, done: summary, text: summary };
  }
}
