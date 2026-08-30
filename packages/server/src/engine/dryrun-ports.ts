import type { GitPort, GhPort, ProcPort, ClaudePort, WorktreeEntry, RebaseResult, CiStatus, PrInfo, TurnOptions, TurnResult } from './ports.ts';

/**
 * An in-memory world so a dry run advances end to end: worktrees, branches, PRs whose CI
 * goes green after a couple of polls (or red once with PLANESTRO_DRYRUN_CI=red-once), and a
 * fake Claude that submits a canned plan, "commits", and reports done. Every action is logged
 * as `Would …`.
 */
export class FakeWorld {
  worktrees = new Map<string, WorktreeEntry>();
  localBranches = new Set<string>();
  remoteBranches = new Map<string, string>();     // branch → sha
  commits = new Map<string, number>();            // worktree → commits ahead
  dirty = new Set<string>();
  prs = new Map<number, PrInfo & { polls: number; failOnce: boolean }>();
  nextPr = 100;
  seq = 0;
  ciMode: 'green' | 'red-once' | 'conflict-once' = (process.env.PLANESTRO_DRYRUN_CI as any) ?? 'green';
  conflictArmed = this.ciMode === 'conflict-once';
  constructor(readonly log: (msg: string) => void, readonly baseBranches: Record<string, string> = {}) {}
  sha(): string { return (0x100000 + ++this.seq).toString(16).padStart(40, '0'); }
}

export class DryRunGitPort implements GitPort {
  constructor(private readonly w: FakeWorld) {}
  private say(m: string) { this.w.log(`Would ${m}`); }
  async fetch(repo: string) { this.say(`git fetch origin (in ${repo})`); }
  async revParse(cwd: string, ref: string) { if (ref === 'HEAD') return this.w.worktrees.get(cwd)?.head ?? this.w.sha(); return this.w.remoteBranches.get(ref.replace(/^origin\//, '')) ?? this.w.baseBranches[ref] ?? this.w.sha(); }
  async refExists(_repo: string, ref: string) { return this.w.remoteBranches.has(ref.replace(/^(origin|refs\/heads)\//, '')) || ref.startsWith('origin/'); }
  async worktreeAdd(_repo: string, path: string, branch: string, startRef: string) { this.say(`git worktree add -b ${branch} ${path} ${startRef}`); this.w.worktrees.set(path, { path, head: this.w.sha(), branch }); this.w.localBranches.add(branch); }
  async worktreeRemove(_repo: string, path: string, force: boolean) { this.say(`git worktree remove${force ? ' --force' : ''} ${path}`); this.w.worktrees.delete(path); }
  async worktreePrune() { this.say('git worktree prune'); }
  async worktreeList() { return [...this.w.worktrees.values()]; }
  async status(cwd: string) { return { clean: !this.w.dirty.has(cwd), dirty: this.w.dirty.has(cwd) ? ['src/fake.ts'] : [] }; }
  async aheadBehind(cwd: string) { return { ahead: this.w.commits.get(cwd) ?? 0, behind: 0 }; }
  async rebase(cwd: string, onto: string): Promise<RebaseResult> {
    if (this.w.conflictArmed) { this.w.conflictArmed = false; this.say(`git rebase ${onto} in ${cwd} → CONFLICT (simulated)`); return { ok: false, conflicts: ['src/conflicted.ts'], head: this.w.worktrees.get(cwd)?.head ?? '' }; }
    this.say(`git rebase ${onto} in ${cwd}`); const wt = this.w.worktrees.get(cwd); const head = this.w.sha(); if (wt) wt.head = head; return { ok: true, conflicts: [], head };
  }
  async inProgressOp() { return null; }
  async abortInProgress() {}
  async pushForceWithLease(cwd: string, branch: string) { this.say(`git push --force-with-lease origin ${branch} (from ${cwd})`); this.w.remoteBranches.set(branch, this.w.worktrees.get(cwd)?.head ?? this.w.sha()); }
  async pushSetUpstream(cwd: string, branch: string) { this.say(`git push -u origin ${branch} (from ${cwd})`); this.w.remoteBranches.set(branch, this.w.worktrees.get(cwd)?.head ?? this.w.sha()); }
  async pushRef(_repo: string, src: string, dst: string) { this.say(`git push origin ${src}:refs/heads/${dst}`); this.w.remoteBranches.set(dst, this.w.sha()); }
  async remoteBranchSha(_repo: string, branch: string) { return this.w.remoteBranches.get(branch) ?? null; }
  async deleteRemoteBranch(_repo: string, branch: string) { this.say(`git push origin --delete ${branch}`); this.w.remoteBranches.delete(branch); }
  async localBranchExists(_repo: string, branch: string) { return this.w.localBranches.has(branch); }
  async deleteLocalBranch(_repo: string, branch: string) { this.say(`git branch -D ${branch}`); this.w.localBranches.delete(branch); }
  async isAncestor() { return true; }
  async log() { return 'abc1234 (dry-run) fake commit'; }
}

export class DryRunGhPort implements GhPort {
  constructor(private readonly w: FakeWorld) {}
  private say(m: string) { this.w.log(`Would ${m}`); }
  async createPr(repo: string, a: { base: string; head: string; title: string }) {
    const number = this.w.nextPr++;
    this.say(`gh pr create --base ${a.base} --head ${a.head} --title "${a.title}"`);
    this.w.prs.set(number, { number, url: `https://github.com/${repo}/pull/${number}`, state: 'OPEN', headRefOid: this.w.remoteBranches.get(a.head) ?? this.w.sha(), headRefName: a.head, baseRefName: a.base, polls: 0, failOnce: this.w.ciMode === 'red-once' });
    return { number, url: `https://github.com/${repo}/pull/${number}` };
  }
  async prView(_repo: string, number: number) { const p = this.w.prs.get(number); if (!p) throw new Error(`no PR ${number}`); p.headRefOid = this.w.remoteBranches.get(p.headRefName) ?? p.headRefOid; return { ...p }; }
  async prList(_repo: string, f: { head?: string; base?: string }) { return [...this.w.prs.values()].filter((p) => (!f.head || p.headRefName === f.head) && (!f.base || p.baseRefName === f.base)); }
  async ciForSha(_repo: string, branch: string, sha: string): Promise<CiStatus> {
    const p = [...this.w.prs.values()].find((x) => x.headRefName === branch);
    if (!p) return { state: 'none', sha };
    p.polls += 1;
    if (p.polls < 2) return { state: 'pending', runId: 1, sha, url: 'https://example/run/1' };
    if (p.failOnce) { p.failOnce = false; p.polls = 0; return { state: 'failure', runId: 2, sha, url: 'https://example/run/2' }; }
    return { state: 'success', runId: 3, sha, url: 'https://example/run/3' };
  }
  async runFailedLog() { return '[fake-check] FAIL: simulated failure (PLANESTRO_DRYRUN_CI=red-once)'; }
  async isBillingBlocked() { return false; }
  async mergePr(_repo: string, number: number, opts: { deleteBranch: boolean }) {
    this.say(`gh pr merge ${number} --merge${opts.deleteBranch ? ' --delete-branch' : ''}`);
    const p = this.w.prs.get(number)!; p.state = 'MERGED'; p.mergedAt = new Date().toISOString(); p.mergeCommit = this.w.sha();
    if (opts.deleteBranch) this.w.remoteBranches.delete(p.headRefName);
  }
  async branchCi(): Promise<CiStatus> { return { state: 'success' }; }
}

export class DryRunProcPort implements ProcPort {
  constructor(private readonly w: FakeWorld) {}
  async run(command: string, opts: { cwd: string }) { this.w.log(`Would run \`${command}\` in ${opts.cwd}`); return { code: 0, stdout: '', stderr: '' }; }
}

/** Fake Claude: plans, "commits", and reports done, exercising the same tool surface as the SDK path. */
export class DryRunClaudePort implements ClaudePort {
  constructor(private readonly w: FakeWorld) {}
  async runTurn(o: TurnOptions): Promise<TurnResult> {
    this.w.log(`Would run a ${o.phase} turn for ${o.itemId} with ${o.model} (${o.permissionMode}) in ${o.cwd}${o.resume ? `, resuming ${o.resume.slice(0, 8)}` : ''}`);
    const sessionId = o.resume ?? `dryrun-${o.itemId}-${this.w.sha().slice(-6)}`;
    const base: TurnResult = { sessionId, subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
    o.onOutput(`(dry-run) prompt: ${o.prompt.slice(0, 120).replace(/\n/g, ' ')}…`);
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
