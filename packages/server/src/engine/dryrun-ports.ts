import { placeholderPng } from './placeholderPng.ts';
import type { GitPort, GhPort, ProcPort, ClaudePort, AgentPort, AgentTurnOptions, WorktreeEntry, RebaseResult, CiStatus, PrInfo, TurnOptions, TurnResult, CustomTurnOptions } from './ports.ts';

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
  /** Files a fake agent "committed", by branch — so a dry run has real images to review. */
  files = new Map<string, Map<string, Buffer>>();
  dirty = new Set<string>();
  /** Shas the fake base does not contain (isAncestor answers false for them). */
  unreachable = new Set<string>();
  prs = new Map<number, PrInfo & { polls: number; failOnce: boolean; attempt?: number; staleFailures?: number }>();
  /** Polls after a re-run request that still report the old, failed attempt (GitHub's lag). */
  rerunLagPolls = 0;
  /** A re-run of failed jobs fails again (a real failure, not a flake). */
  rerunFailsAgain = false;
  /** Untracked files by worktree, and the paths the base branch tracks (for regenerated files that collide with it). */
  untracked = new Map<string, string[]>();
  baseFiles = new Set<string>();
  /** Files git ignores, by worktree: invisible to status, gone with the worktree unless set aside (p40). */
  ignored = new Map<string, string[]>();
  nextPr = 100;
  seq = 0;
  ciMode: 'green' | 'red-once' | 'conflict-once' = (process.env.PLANESTRO_DRYRUN_CI as any) ?? 'green';
  conflictArmed = this.ciMode === 'conflict-once';
  /** Commits a worktree is behind its base (default 1: the base is assumed to have moved, so every dry run exercises the sync). */
  behind = new Map<string, number>();
  /** How many `gh pr view` polls after a push still report the replaced head — GitHub's real propagation lag. */
  headLagPolls = 0;
  /** CI polls that found a draft PR (and so no run). */
  ciPolledWhileDraft = 0;
  staleHeads = new Map<string, { sha: string; polls: number }>();
  constructor(readonly log: (msg: string) => void, readonly baseBranches: Record<string, string> = {}) {}
  sha(): string { return (0x100000 + ++this.seq).toString(16).padStart(40, '0'); }
}

export class DryRunGitPort implements GitPort {
  constructor(private readonly w: FakeWorld) {}
  async changedFiles(_cwd: string, _base: string, head: string) { return [...(this.w.files.get(head.replace(/^origin\//, '')) ?? new Map<string, Buffer>()).entries()].map(([path, buf]) => ({ path, change: 'added' as const, bytes: buf.length })); }
  async mergeBase() { return null; }
  async readBlob(_cwd: string, ref: string, path: string) { return this.w.files.get(ref.replace(/^origin\//, ''))?.get(path) ?? null; }
  private say(m: string) { this.w.log(`Would ${m}`); }
  async fetch(repo: string) { this.say(`git fetch origin (in ${repo})`); }
  async revParse(cwd: string, ref: string) { if (ref === 'HEAD') return this.w.worktrees.get(cwd)?.head ?? this.w.sha(); return this.w.remoteBranches.get(ref.replace(/^origin\//, '')) ?? this.w.baseBranches[ref] ?? this.w.sha(); }
  async refExists(_repo: string, ref: string) { return this.w.remoteBranches.has(ref.replace(/^(origin|refs\/heads)\//, '')) || ref.startsWith('origin/'); }
  async worktreeAddDetached(_repo: string, path: string, ref: string) { this.say(`git worktree add --detach ${path} ${ref}`); this.w.worktrees.set(path, { path, head: this.w.sha() }); }
  async worktreeAdd(_repo: string, path: string, branch: string, startRef: string) { this.say(`git worktree add -b ${branch} ${path} ${startRef}`); this.w.worktrees.set(path, { path, head: this.w.sha(), branch }); this.w.localBranches.add(branch); }
  async worktreeRemove(_repo: string, path: string, force: boolean) { this.say(`git worktree remove${force ? ' --force' : ''} ${path}`); this.w.worktrees.delete(path); }
  async worktreePrune() { this.say('git worktree prune'); }
  async worktreeList() { return [...this.w.worktrees.values()]; }
  async status(cwd: string) { const u = this.w.untracked.get(cwd) ?? []; const dirty = [...(this.w.dirty.has(cwd) ? ['src/fake.ts'] : []), ...u]; return { clean: dirty.length === 0, dirty }; }
  async dirtyDetail(cwd: string) { return { tracked: this.w.dirty.has(cwd) ? ['src/fake.ts'] : [], untracked: [...(this.w.untracked.get(cwd) ?? [])] }; }
  async trackedAt(_cwd: string, _ref: string, paths: string[]) { return paths.filter((p) => this.w.baseFiles.has(p)); }
  async moveAside(cwd: string, paths: string[], dest: string) { this.say(`move ${paths.join(', ')} from ${cwd} to ${dest}`); this.w.untracked.set(cwd, (this.w.untracked.get(cwd) ?? []).filter((p) => !paths.includes(p))); this.w.ignored.set(cwd, (this.w.ignored.get(cwd) ?? []).filter((p) => !paths.includes(p))); }
  async filesUnder(cwd: string, paths: string[]) { const under = (f: string) => paths.some((p) => f === p || f.startsWith(`${p.replace(/\/+$/, '')}/`)); return [...(this.w.untracked.get(cwd) ?? []), ...(this.w.ignored.get(cwd) ?? [])].filter(under); }
  async aheadBehind(cwd: string) { return { ahead: this.w.commits.get(cwd) ?? 0, behind: this.w.behind.get(cwd) ?? 1 }; }
  async rebase(cwd: string, onto: string): Promise<RebaseResult> {
    if (this.w.conflictArmed) { this.w.conflictArmed = false; this.say(`git rebase ${onto} in ${cwd} → CONFLICT (simulated)`); return { ok: false, conflicts: ['src/conflicted.ts'], head: this.w.worktrees.get(cwd)?.head ?? '' }; }
    this.say(`git rebase ${onto} in ${cwd}`); const wt = this.w.worktrees.get(cwd); const head = this.w.sha(); if (wt) wt.head = head; return { ok: true, conflicts: [], head };
  }
  async merge(cwd: string, ref: string): Promise<RebaseResult> {
    if (this.w.conflictArmed) { this.w.conflictArmed = false; this.say(`git merge ${ref} in ${cwd} → CONFLICT (simulated)`); return { ok: false, conflicts: ['src/conflicted.ts'], head: this.w.worktrees.get(cwd)?.head ?? '' }; }
    this.say(`git merge ${ref} in ${cwd}`); const wt = this.w.worktrees.get(cwd); const head = this.w.sha(); if (wt) wt.head = head; return { ok: true, conflicts: [], head };
  }
  async inProgressOp() { return null; }
  async abortInProgress() {}
  private setRemote(branch: string, sha: string) {
    const previous = this.w.remoteBranches.get(branch);
    if (previous && previous !== sha && this.w.headLagPolls > 0) this.w.staleHeads.set(branch, { sha: previous, polls: this.w.headLagPolls });
    this.w.remoteBranches.set(branch, sha);
  }
  async pushForceWithLease(cwd: string, branch: string) { this.say(`git push --force-with-lease origin ${branch} (from ${cwd})`); this.setRemote(branch, this.w.worktrees.get(cwd)?.head ?? this.w.sha()); }
  async pushSetUpstream(cwd: string, branch: string) { this.say(`git push -u origin ${branch} (from ${cwd})`); this.setRemote(branch, this.w.worktrees.get(cwd)?.head ?? this.w.sha()); }
  async pushRef(_repo: string, src: string, dst: string) { this.say(`git push origin ${src}:refs/heads/${dst}`); this.w.remoteBranches.set(dst, this.w.sha()); }
  async remoteHeads(): Promise<Map<string, string>> { return new Map(this.w.remoteBranches); }
  async remoteBranchSha(_repo: string, branch: string) { return this.w.remoteBranches.get(branch) ?? null; }
  async deleteRemoteBranch(_repo: string, branch: string) { this.say(`git push origin --delete ${branch}`); this.w.remoteBranches.delete(branch); }
  async localBranchExists(_repo: string, branch: string) { return this.w.localBranches.has(branch); }
  async deleteLocalBranch(_repo: string, branch: string) { this.say(`git branch -D ${branch}`); this.w.localBranches.delete(branch); }
  async isAncestor(_repo: string, ancestor: string) { return !this.w.unreachable.has(ancestor); }
  async log() { return 'abc1234 (dry-run) fake commit'; }
}

export class DryRunGhPort implements GhPort {
  constructor(private readonly w: FakeWorld) {}
  private say(m: string) { this.w.log(`Would ${m}`); }
  async createPr(repo: string, a: { base: string; head: string; title: string; draft?: boolean }) {
    const number = this.w.nextPr++;
    this.say(`gh pr create --base ${a.base} --head ${a.head} --title "${a.title}"${a.draft ? ' --draft' : ''}`);
    this.w.prs.set(number, { number, url: `https://github.com/${repo}/pull/${number}`, state: 'OPEN', isDraft: Boolean(a.draft), headRefOid: this.w.remoteBranches.get(a.head) ?? this.w.sha(), headRefName: a.head, baseRefName: a.base, polls: 0, failOnce: this.w.ciMode === 'red-once' });
    return { number, url: `https://github.com/${repo}/pull/${number}` };
  }
  async setDraft(_repo: string, number: number, draft: boolean) { this.say(`gh pr ready ${number}${draft ? ' --undo' : ''}`); const p = this.w.prs.get(number); if (p) p.isDraft = draft; }
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
    if (p.isDraft) { this.w.ciPolledWhileDraft += 1; return { state: 'none', sha }; } // CI skips drafts (dogfood f6)
    p.polls += 1;
    const attempt = p.attempt ?? 1;
    if (p.staleFailures) { p.staleFailures -= 1; return { state: 'failure', runId: 2, sha, url: 'https://example/run/2', attempt: attempt - 1 }; }
    if (p.polls < 2) return { state: 'pending', runId: 1, sha, url: 'https://example/run/1', attempt };
    if (p.failOnce) { p.failOnce = false; p.polls = 0; return { state: 'failure', runId: 2, sha, url: 'https://example/run/2', attempt }; }
    return { state: 'success', runId: 3, sha, url: 'https://example/run/3', attempt };
  }
  async runFailedLog() { return '[fake-check] FAIL: simulated failure (PLANESTRO_DRYRUN_CI=red-once)'; }
  async isBillingBlocked() { return false; }
  async rerunFailed(_repo: string, runId: number) {
    this.say(`gh run rerun ${runId} --failed`);
    for (const p of this.w.prs.values()) { p.attempt = (p.attempt ?? 1) + 1; p.polls = 0; p.staleFailures = this.w.rerunLagPolls; if (this.w.rerunFailsAgain) { p.failOnce = true; this.w.rerunFailsAgain = false; } }
  }
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

/** The Codex runner's stand-in: implements only, reports through its result like the live port's closing JSON. */
export class DryRunCodexPort implements AgentPort<AgentTurnOptions> {
  constructor(private readonly w: FakeWorld) {}
  async runTurn(o: AgentTurnOptions): Promise<TurnResult> {
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
    this.w.log(`Would run an orchestrator wake (${o.label}) with ${o.model}${o.resume ? `, resuming ${o.resume.slice(0, 8)}` : ''}`);
    o.onOutput(`(dry-run) wake: ${o.prompt.slice(0, 120).replace(/\n/g, ' ')}…`);
    const approve = o.mcpTools.find((t) => t.name === 'approve_plan');
    const approved: string[] = [];
    for (const packet of o.prompt.split('\n\n---\n\n')) {
      const id = /^Item: (\S+)/m.exec(packet)?.[1];
      if (id && approve && packet.includes('Plan approval: DELEGATED TO YOU') && String(await approve.handler({ id, notes: 'dry-run: approved without reading' })) === 'approved') approved.push(id);
    }
    // A chat message gets an answer, so the demo's chat is not a dead end.
    const said = /^message: (.*)$/m.exec(o.prompt)?.[1];
    const reply = o.mcpTools.find((t) => t.name === 'reply_to_user');
    if (said !== undefined && /Event: user_message/.test(o.prompt) && reply) await reply.handler({ text: `(dry-run) I would read the backlog and answer: “${said.slice(0, 200)}”. Switch to live mode for a real reply.` });
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
