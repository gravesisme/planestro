import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { GitPort, GhPort, ProcPort, WorktreeEntry, RebaseResult, CiStatus, PrInfo, ChangedFile } from './ports.ts';

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[], allowFail = false): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await execFileP('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { ...r, code: 0 };
  } catch (e: any) {
    if (allowFail) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(e.stderr || e.message || '').trim().split('\n').slice(-3).join(' | ')}`);
  }
}
async function gh(args: string[]): Promise<string> {
  try { return (await execFileP('gh', args, { maxBuffer: 32 * 1024 * 1024 })).stdout; }
  catch (e: any) { throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(e.stderr || e.message || '').trim().split('\n').slice(-2).join(' | ')}`); }
}

/**
 * What git and gh say when the answer is "try again", not "this is wrong": another process held a
 * ref lock (a fetch racing a merge's push, HH-124), or the network or GitHub blinked (a `gh pr
 * view` timeout, HH-123). Anything else fails at once, as before.
 */
export const TRANSIENT = /cannot lock ref|unable to update local ref|could not resolve host|connection (timed out|reset|refused|closed)|operation timed out|timed out|i\/o timeout|early EOF|RPC failed|remote end hung up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake|unexpected EOF|HTTP 50[0234]|Bad Gateway|Service Unavailable|Gateway Timeout|secondary rate limit/i;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Retry `fn` after each delay while it fails with a TRANSIENT message. Exported for tests. */
export async function retrying<T>(fn: () => Promise<T>, delaysMs: number[], sleep: (ms: number) => Promise<void> = pause): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) { if (attempt >= delaysMs.length || !TRANSIENT.test(String((e as Error).message))) throw e; await sleep(delaysMs[attempt]); }
  }
}
/** A git operation that races only with itself: a couple of seconds covers a lock held by a sibling. */
const GIT_RETRY_MS = [2_000, 5_000];
/** A read from GitHub: three tries over about a minute before the caller sees the error. */
const GH_RETRY_MS = [5_000, 15_000, 40_000];

let refQueue: Promise<unknown> = Promise.resolve();
/**
 * One ref-updating git operation at a time. The main checkout and every worktree share one ref
 * store, so a fetch (which rewrites refs/remotes/origin/*), a push (which updates the pushed
 * branch's tracking ref) and a worktree add (which creates a branch) race when two engine jobs run
 * them at once. Exported for tests.
 */
export function refLocked<T>(fn: () => Promise<T>): Promise<T> {
  const run = refQueue.then(fn, fn);
  refQueue = run.catch(() => undefined);
  return run;
}
const ghRead = (args: string[]) => retrying(() => gh(args), GH_RETRY_MS);

export class LiveGitPort implements GitPort {
  async changedFiles(cwd: string, base: string, head: string): Promise<ChangedFile[]> {
    const out = (await git(cwd, ['diff', '--name-status', '--no-renames', '-z', `${base}...${head}`])).stdout.split('\0');
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const change = out[i][0] === 'A' ? 'added' : out[i][0] === 'D' ? 'deleted' : 'modified';
      const path = out[i + 1];
      const size = change === 'deleted' ? undefined : Number((await git(cwd, ['cat-file', '-s', `${head}:${path}`], true)).stdout.trim()) || undefined;
      files.push({ path, change, bytes: size });
    }
    return files;
  }
  async mergeBase(cwd: string, a: string, b: string) { const r = await git(cwd, ['merge-base', a, b], true); return r.code === 0 ? r.stdout.trim() : null; }
  async readBlob(cwd: string, ref: string, path: string): Promise<Buffer | null> {
    try { return (await execFileP('git', ['-C', cwd, 'show', `${ref}:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })).stdout as unknown as Buffer; } catch { return null; }
  }
  async fetch(repo: string) { await refLocked(() => retrying(() => git(repo, ['fetch', '--prune', 'origin']), GIT_RETRY_MS)); }
  async revParse(cwd: string, ref: string) { return (await git(cwd, ['rev-parse', ref])).stdout.trim(); }
  async refExists(repo: string, ref: string) { return (await git(repo, ['rev-parse', '--verify', '--quiet', ref], true)).code === 0; }
  async worktreeAddDetached(repo: string, path: string, ref: string) { await refLocked(() => git(repo, ['worktree', 'add', '--detach', path, ref])); }
  async worktreeAdd(repo: string, path: string, branch: string, startRef: string) {
    await refLocked(async () => {
      const exists = await this.localBranchExists(repo, branch);
      await git(repo, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, startRef]);
    });
  }
  async worktreeRemove(repo: string, path: string, force: boolean) { if (existsSync(path)) await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]); }
  async worktreePrune(repo: string) { await git(repo, ['worktree', 'prune']); }
  async worktreeList(repo: string): Promise<WorktreeEntry[]> {
    const out = (await git(repo, ['worktree', 'list', '--porcelain'])).stdout;
    const entries: WorktreeEntry[] = [];
    let cur: WorktreeEntry | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: '' }; entries.push(cur); }
      else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (cur && line === 'bare') cur.bare = true;
      else if (cur && line.startsWith('prunable')) cur.prunable = true;
    }
    return entries;
  }
  async status(cwd: string) { const dirty = (await git(cwd, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean).map((l) => l.slice(3)); return { clean: dirty.length === 0, dirty }; }
  async aheadBehind(cwd: string, base: string, head: string) {
    const [behind, ahead] = (await git(cwd, ['rev-list', '--left-right', '--count', `${base}...${head}`])).stdout.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }
  async rebase(cwd: string, onto: string): Promise<RebaseResult> {
    const r = await git(cwd, ['rebase', onto], true);
    if (r.code === 0) return { ok: true, conflicts: [], head: await this.revParse(cwd, 'HEAD') };
    const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'], true)).stdout.split('\n').filter(Boolean);
    await git(cwd, ['rebase', '--abort'], true);
    return { ok: false, conflicts: conflicts.length ? conflicts : [r.stderr.trim().split('\n').pop() ?? 'unknown conflict'], head: await this.revParse(cwd, 'HEAD') };
  }
  async merge(cwd: string, ref: string): Promise<RebaseResult> {
    const r = await git(cwd, ['merge', '--no-edit', ref], true);
    if (r.code === 0) return { ok: true, conflicts: [], head: await this.revParse(cwd, 'HEAD') };
    const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'], true)).stdout.split('\n').filter(Boolean);
    await git(cwd, ['merge', '--abort'], true);
    return { ok: false, conflicts: conflicts.length ? conflicts : [r.stderr.trim().split('\n').pop() ?? 'unknown conflict'], head: await this.revParse(cwd, 'HEAD') };
  }
  async inProgressOp(cwd: string) {
    const dir = (await git(cwd, ['rev-parse', '--git-dir'])).stdout.trim();
    const abs = dir.startsWith('/') ? dir : `${cwd}/${dir}`;
    if (existsSync(`${abs}/rebase-merge`) || existsSync(`${abs}/rebase-apply`)) return 'rebase';
    if (existsSync(`${abs}/MERGE_HEAD`)) return 'merge';
    return null;
  }
  async abortInProgress(cwd: string) { const op = await this.inProgressOp(cwd); if (op === 'rebase') await git(cwd, ['rebase', '--abort'], true); if (op === 'merge') await git(cwd, ['merge', '--abort'], true); }
  async pushForceWithLease(cwd: string, branch: string, expected: string | null) {
    await refLocked(() => retrying(() => git(cwd, ['push', '--force-with-lease=' + (expected ? `${branch}:${expected}` : branch), 'origin', `HEAD:refs/heads/${branch}`]), GIT_RETRY_MS));
  }
  async pushSetUpstream(cwd: string, branch: string) { await refLocked(() => retrying(() => git(cwd, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]), GIT_RETRY_MS)); }
  async pushRef(repo: string, srcRef: string, dstBranch: string) { await refLocked(() => retrying(() => git(repo, ['push', 'origin', `${srcRef}:refs/heads/${dstBranch}`]), GIT_RETRY_MS)); }
  async remoteHeads(repo: string): Promise<Map<string, string>> {
    const out = (await retrying(() => git(repo, ['ls-remote', '--heads', 'origin']), GIT_RETRY_MS)).stdout;
    const map = new Map<string, string>();
    for (const line of out.split('\n')) { const m = /^(\S+)\s+refs\/heads\/(.+)$/.exec(line); if (m) map.set(m[2], m[1]); }
    return map;
  }
  async remoteBranchSha(repo: string, branch: string) { const out = (await retrying(() => git(repo, ['ls-remote', '--heads', 'origin', branch]), GIT_RETRY_MS)).stdout.trim(); return out ? out.split(/\s+/)[0] : null; }
  async deleteRemoteBranch(repo: string, branch: string) {
    await refLocked(() => retrying(async () => { const r = await git(repo, ['push', 'origin', '--delete', branch], true); if (r.code !== 0 && !/remote ref does not exist/.test(r.stderr)) throw new Error(`delete remote ${branch}: ${r.stderr.trim()}`); }, GIT_RETRY_MS));
  }
  async localBranchExists(repo: string, branch: string) { return this.refExists(repo, `refs/heads/${branch}`); }
  async deleteLocalBranch(repo: string, branch: string) { if (await this.localBranchExists(repo, branch)) await git(repo, ['branch', '-D', branch]); }
  async isAncestor(repo: string, ancestor: string, descendant: string) { return (await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant], true)).code === 0; }
  async log(cwd: string, range: string, n: number) { return (await git(cwd, ['log', '--oneline', `-n${n}`, range], true)).stdout.trim(); }
}

const PR_FIELDS = 'number,url,state,mergedAt,headRefOid,headRefName,baseRefName,mergeCommit,title,isDraft';
function toPr(p: any): PrInfo { return { number: p.number, url: p.url, state: p.state, mergedAt: p.mergedAt ?? undefined, headRefOid: p.headRefOid, headRefName: p.headRefName, baseRefName: p.baseRefName, mergeCommit: p.mergeCommit?.oid, title: p.title, isDraft: Boolean(p.isDraft) }; }

export class LiveGhPort implements GhPort {
  async createPr(repo: string, a: { base: string; head: string; title: string; body: string; draft?: boolean }) {
    const url = (await gh(['pr', 'create', '--repo', repo, '--base', a.base, '--head', a.head, '--title', a.title, '--body', a.body, ...(a.draft ? ['--draft'] : [])])).trim().split('\n').pop()!;
    const number = Number(url.split('/').pop());
    return { number, url };
  }
  async setDraft(repo: string, number: number, draft: boolean) { await gh(['pr', 'ready', String(number), '--repo', repo, ...(draft ? ['--undo'] : [])]); }
  async prView(repo: string, number: number) { return toPr(JSON.parse(await ghRead(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]))); }
  async prList(repo: string, f: { head?: string; base?: string; state?: 'open' | 'merged' | 'closed' | 'all' }) {
    const args = ['pr', 'list', '--repo', repo, '--json', PR_FIELDS, '--limit', '50', '--state', f.state ?? 'all'];
    if (f.head) args.push('--head', f.head); if (f.base) args.push('--base', f.base);
    return (JSON.parse(await ghRead(args)) as any[]).map(toPr);
  }
  async ciForSha(repo: string, branch: string, sha: string, workflow: string): Promise<CiStatus> {
    const runs = JSON.parse(await ghRead(['run', 'list', '--repo', repo, '--branch', branch, '--workflow', workflow, '--limit', '10', '--json', 'databaseId,status,conclusion,headSha,url,createdAt'])) as any[];
    const run = runs.find((r) => r.headSha === sha);
    if (!run) return { state: 'none', sha };
    const base = { runId: run.databaseId, url: run.url, sha, startedAt: run.createdAt };
    if (run.status !== 'completed') return { ...base, state: 'pending' };
    if (run.conclusion === 'success') return { ...base, state: 'success' };
    if (run.conclusion === 'cancelled') return { ...base, state: 'cancelled' };
    return { ...base, state: 'failure' };
  }
  async runFailedLog(repo: string, runId: number, maxLines: number) {
    const log = await ghRead(['run', 'view', String(runId), '--repo', repo, '--log-failed']).catch((e) => `(could not fetch log: ${e.message})`);
    const lines = log.split('\n').map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+\s?/, '')).filter((l) => l.trim());
    const fails = lines.filter((l) => /FAIL|Error|error:|assert/i.test(l));
    const tail = lines.slice(-maxLines);
    return [...new Set([...fails.slice(-40), '…', ...tail])].join('\n');
  }
  async isBillingBlocked(repo: string, runId: number) {
    try {
      const view = JSON.parse(await ghRead(['run', 'view', String(runId), '--repo', repo, '--json', 'jobs,status']));
      if (view.status !== 'completed') return false; // an in-progress (re-)run is never a billing block
      for (const j of (view.jobs as any[]) ?? []) {
        const steps = j.steps ?? [];
        const ran = steps.some((s: any) => s.conclusion && s.conclusion !== 'skipped');
        if (j.conclusion !== 'failure' || ran) continue;
        // Zero executed steps alone is NOT proof (the API often omits steps for old
        // attempts): require the billing wording, or a job that died within seconds.
        const ann = await gh(['api', `repos/${repo}/check-runs/${j.databaseId}/annotations`]).catch(() => '[]');
        if (/payments? (have|has) failed|spending limit|job was not started/i.test(ann)) return true;
        const started = Date.parse(j.startedAt ?? '');
        const finished = Date.parse(j.completedAt ?? '');
        if (Number.isFinite(started) && Number.isFinite(finished) && finished - started < 30_000 && steps.length === 0) return true;
      }
    } catch { /* fall through */ }
    return false;
  }
  async mergePr(repo: string, number: number, opts: { deleteBranch: boolean }) {
    await gh(['pr', 'merge', String(number), '--repo', repo, '--merge', ...(opts.deleteBranch ? ['--delete-branch'] : [])]);
  }
  async branchCi(repo: string, branch: string, workflow: string): Promise<CiStatus> {
    const runs = JSON.parse(await ghRead(['run', 'list', '--repo', repo, '--branch', branch, '--workflow', workflow, '--event', 'push', '--limit', '1', '--json', 'databaseId,status,conclusion,headSha,url,createdAt'])) as any[];
    const run = runs[0];
    if (!run) return { state: 'none' };
    const base = { runId: run.databaseId, url: run.url, sha: run.headSha, startedAt: run.createdAt };
    if (run.status !== 'completed') return { ...base, state: 'pending' };
    return { ...base, state: run.conclusion === 'success' ? 'success' : run.conclusion === 'cancelled' ? 'cancelled' : 'failure' };
  }
}

export class LiveProcPort implements ProcPort {
  async run(command: string, opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> }) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile('/bin/bash', ['-lc', command], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60 * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...opts.env } }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}
