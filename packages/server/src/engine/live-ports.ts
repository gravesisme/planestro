import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfs } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, rmSync, renameSync, copyFileSync, unlinkSync, lstatSync, readdirSync, readFileSync, statSync, constants as fsConstants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { matchesPathPattern } from './ports.ts';
import type { GitPort, GhPort, ProcPort, WorktreeEntry, RebaseResult, ContinueResult, CiStatus, CiQueue, PrInfo, ChangedFile, IssueInfo, PrClosure, RunnerReport, RunnerInfo, OpenJob, WorktreeSnapshot, Checkpoint } from './ports.ts';

const execFileP = promisify(execFile);

/** The files a stopped rebase or merge left unmerged. */
async function unmerged(cwd: string): Promise<string[]> {
  return (await git(cwd, ['diff', '--name-only', '--diff-filter=U'], true)).stdout.split('\n').filter(Boolean);
}

/** What the commit a rebase stopped on changes against HEAD, in the index or the tree, unmerged paths included (HH-532). */
async function stepFiles(cwd: string): Promise<string[]> {
  return [...new Set([...(await git(cwd, ['diff', '--name-only', 'HEAD'], true)).stdout.split('\n'), ...(await unmerged(cwd))].filter(Boolean))];
}

/**
 * A sync git stopped with no unmerged path: it refused to overwrite files in the worktree (#212). The paths are the
 * ones it listed under "… would be overwritten by …"; none when it listed none (an unstaged change a rebase will not
 * start over), and `message` is what it said. Its last line ("Aborting") is never taken for a file.
 */
export function refusalOf(stderr: string): { paths: string[]; message: string } {
  const lines = stderr.split('\n');
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/would be overwritten by/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]) && lines[j].trim(); j++) if (!paths.includes(lines[j].trim())) paths.push(lines[j].trim());
  }
  const message = lines.map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 500);
  return { paths, message: message || 'git gave no reason' };
}

/** Resolve a conflict with one side's copy, only when every conflicted file is one `patterns` names; false when it cannot. */
async function takeSide(cwd: string, conflicts: string[], patterns: string[], side: '--ours' | '--theirs'): Promise<boolean> {
  if (!patterns.length || !conflicts.length || !conflicts.every((f) => patterns.some((p) => matchesPathPattern(f, p)))) return false;
  // A delete on one side has no copy to take: that is a decision, not a regeneration.
  if ((await git(cwd, ['checkout', side, '--', ...conflicts], true)).code !== 0) return false;
  return (await git(cwd, ['add', '--', ...conflicts], true)).code === 0;
}

async function git(cwd: string, args: string[], allowFail = false, env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await execFileP('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
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

/** Who checkpoint commits are by: they are planestro's, and a machine with no git identity (CI) can still make them. */
const CHECKPOINT_IDENTITY = { GIT_AUTHOR_NAME: 'planestro', GIT_AUTHOR_EMAIL: 'planestro@localhost', GIT_COMMITTER_NAME: 'planestro', GIT_COMMITTER_EMAIL: 'planestro@localhost' };

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
    const rows: { path: string; change: ChangedFile['change'] }[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) rows.push({ path: out[i + 1], change: out[i][0] === 'A' ? 'added' : out[i][0] === 'D' ? 'deleted' : 'modified' });
    // Every size in one `ls-tree -l` per 200 paths, not a `cat-file -s` per file: 23 files took HH-328's review panel 6 s.
    const sizes = new Map<string, number>();
    const kept = rows.filter((r) => r.change !== 'deleted').map((r) => r.path);
    for (let i = 0; i < kept.length; i += 200) {
      const ls = (await git(cwd, ['ls-tree', '-r', '-l', '-z', head, '--', ...kept.slice(i, i + 200)], true)).stdout.split('\0');
      for (const line of ls) { const m = /^\S+ blob \S+\s+(\d+)\t(.+)$/.exec(line); if (m) sizes.set(m[2], Number(m[1])); }
    }
    return rows.map((r) => ({ ...r, bytes: r.change === 'deleted' ? undefined : sizes.get(r.path) || undefined }));
  }
  async mergeBase(cwd: string, a: string, b: string) { const r = await git(cwd, ['merge-base', a, b], true); return r.code === 0 ? r.stdout.trim() : null; }
  async readBlob(cwd: string, ref: string, path: string): Promise<Buffer | null> {
    try { return (await execFileP('git', ['-C', cwd, 'show', `${ref}:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })).stdout as unknown as Buffer; } catch { return null; }
  }
  async fileDiff(cwd: string, base: string, head: string, path: string): Promise<string> {
    return (await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', `${base}...${head}`, '--', path])).stdout;
  }
  /** A copy of the real index takes `add -A`, so the worktree's own index and files are never touched (#234). */
  async snapshot(cwd: string): Promise<WorktreeSnapshot> {
    const head = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)).stdout.trim() || null;
    const real = resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'index'])).stdout.trim());
    const dir = mkdtempSync(join(tmpdir(), 'planestro-snapshot-'));
    try {
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      if (existsSync(real)) copyFileSync(real, env.GIT_INDEX_FILE);
      const index = (await git(cwd, ['write-tree'], false, env)).stdout.trim();
      await git(cwd, ['add', '-A'], false, env);
      return { head, index, tree: (await git(cwd, ['write-tree'], false, env)).stdout.trim() };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  /** The files' tree, with HEAD and a commit of the index as its parents so nothing it names is ever garbage. Created, never moved. */
  async checkpoint(cwd: string, ref: string): Promise<Checkpoint> {
    const s = await this.snapshot(cwd);
    const commit = async (tree: string, parents: string[], message: string) => (await git(cwd, ['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], false, CHECKPOINT_IDENTITY)).stdout.trim();
    const indexCommit = await commit(s.index, [], `planestro: index at ${ref}`);
    const sha = await commit(s.tree, [...(s.head ? [s.head] : []), indexCommit], `planestro: checkpoint ${ref}\n\nhead: ${s.head ?? '(none)'}\nindex: ${s.index}`);
    await refLocked(() => git(cwd, ['update-ref', ref, sha, '']));
    return { ...s, ref, sha };
  }
  async checkpoints(repo: string, prefix: string): Promise<Checkpoint[]> {
    const rows = (await git(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(tree)%09%(parent)%09%(creatordate:iso-strict)', prefix])).stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
    if (!rows.length) return [];
    // The index commit is the last parent; HEAD the first, when there was one.
    const indexTrees = (await git(repo, ['rev-parse', ...rows.map((r) => `${r[3].split(' ').pop()}^{tree}`)])).stdout.trim().split('\n');
    return rows.map(([ref, sha, tree, parents, at], i) => { const p = parents.split(' '); return { ref, sha, tree, head: p.length > 1 ? p[0] : null, index: indexTrees[i], at }; });
  }
  /** One zero-context diff of the snapshot's tree against the merge base, limited by `-G` to the files whose changes hold the needle (#240). */
  async addedLinesWith(cwd: string, base: string, needle: string): Promise<{ path: string; line: number; text: string }[]> {
    const { tree } = await this.snapshot(cwd);
    const from = (await this.mergeBase(cwd, base, 'HEAD')) ?? base;
    const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patch = (await git(cwd, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', `-G${pattern}`, from, tree])).stdout;
    const hits: { path: string; line: number; text: string }[] = [];
    let path = ''; let line = 0; let header = false;
    for (const l of patch.split('\n')) {
      if (l.startsWith('diff --git ')) { header = true; path = ''; continue; }
      if (l.startsWith('@@')) { header = false; line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0); continue; }
      if (header) { if (l.startsWith('+++ ')) path = l === '+++ /dev/null' ? '' : l.slice(4).replace(/^"?b\//, '').replace(/"$/, ''); continue; }
      if (l.startsWith('+')) { if (path && l.includes(needle)) hits.push({ path, line, text: l.slice(1) }); line += 1; }
      else if (l.startsWith(' ')) line += 1;
    }
    return hits;
  }
  async treeDiff(cwd: string, from: string, to: string, maxBytes = 200_000) {
    const out = (await git(cwd, ['diff', '--name-status', '--no-renames', '-z', from, to])).stdout.split('\0');
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) files.push({ path: out[i + 1], change: out[i][0] === 'A' ? 'added' : out[i][0] === 'D' ? 'deleted' : 'modified' });
    const patch = (await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', from, to])).stdout;
    return { files, patch: patch.slice(0, maxBytes), ...(patch.length > maxBytes ? { truncated: true } : {}) };
  }
  /**
   * The files first (a two-tree read-tree from `from`, which git refuses before it writes anything, e.g. over an ignored file in
   * the way: the index is put back and nothing has moved), then the index, then the branch tip.
   */
  async restoreSnapshot(cwd: string, from: WorktreeSnapshot, to: WorktreeSnapshot) {
    if (!to.head) throw new Error('the checkpoint has no HEAD to go back to');
    await refLocked(async () => {
      await git(cwd, ['read-tree', from.tree]);
      await git(cwd, ['update-index', '-q', '--refresh'], true);
      const r = await git(cwd, ['read-tree', '-m', '-u', from.tree, to.tree], true);
      if (r.code !== 0) { await git(cwd, ['read-tree', from.index]); await git(cwd, ['update-index', '-q', '--refresh'], true); throw new Error(`git would not restore the files: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`); }
      await git(cwd, ['read-tree', to.index]);
      if (to.head !== from.head) await git(cwd, ['reset', '-q', '--soft', to.head!]);
      await git(cwd, ['update-index', '-q', '--refresh'], true);
    });
  }
  async deleteRef(repo: string, ref: string, expected: string) { return (await refLocked(() => git(repo, ['update-ref', '-d', ref, expected], true))).code === 0; }
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
  async dirtyDetail(cwd: string) {
    const tracked = (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout.split('\n').filter(Boolean);
    return { tracked, untracked };
  }
  async trackedAt(cwd: string, ref: string, paths: string[]) {
    const out: string[] = [];
    for (let i = 0; i < paths.length; i += 200) out.push(...(await git(cwd, ['ls-tree', '-r', '--name-only', ref, '--', ...paths.slice(i, i + 200)])).stdout.split('\n').filter(Boolean));
    return out;
  }
  async filesUnder(cwd: string, paths: string[]) {
    const out: string[] = [];
    const walk = (rel: string) => {
      const abs = join(cwd, rel);
      let st; try { st = lstatSync(abs); } catch { return; }
      if (st.isSymbolicLink()) return;
      if (st.isFile()) { out.push(rel); return; }
      if (st.isDirectory()) for (const name of readdirSync(abs)) walk(join(rel, name));
    };
    for (const p of paths) { const rel = p.replace(/^\.?\/+/, '').replace(/\/+$/, ''); if (rel && !rel.split('/').includes('..')) walk(rel); }
    return out;
  }
  async moveAside(cwd: string, paths: string[], dest: string) {
    for (const p of paths) {
      const to = join(dest, p);
      mkdirSync(dirname(to), { recursive: true });
      try { renameSync(join(cwd, p), to); } catch { copyFileSync(join(cwd, p), to); unlinkSync(join(cwd, p)); } // another volume
    }
  }
  async copyInto(cwd: string, paths: string[], destRoot: string) {
    const out = { copied: [] as string[], identical: [] as string[], collided: [] as string[] };
    for (const p of paths) {
      const from = join(cwd, p); const to = join(destRoot, p);
      if (existsSync(to)) { (readFileSync(to).equals(readFileSync(from)) ? out.identical : out.collided).push(p); continue; }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
      if (statSync(to).size !== statSync(from).size) throw new Error(`copy of ${p} is ${statSync(to).size} bytes, not ${statSync(from).size}`);
      out.copied.push(p);
    }
    return out;
  }
  async commitAll(cwd: string, message: string, leave: string[] = []) {
    await git(cwd, ['add', '-A']);
    for (let i = 0; i < leave.length; i += 200) await git(cwd, ['reset', '-q', '--', ...leave.slice(i, i + 200)]);
    await git(cwd, ['commit', '-q', '-m', message]); return this.revParse(cwd, 'HEAD'); }
  async aheadBehind(cwd: string, base: string, head: string) {
    const [behind, ahead] = (await git(cwd, ['rev-list', '--left-right', '--count', `${base}...${head}`])).stdout.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }
  async rebase(cwd: string, onto: string, takeBase: string[] = [], opts: { stop?: boolean } = {}): Promise<RebaseResult> {
    let r = await git(cwd, ['rebase', onto], true);
    const took = new Set<string>();
    // Each replayed commit can stop on its own conflict; in a rebase `--ours` is the base being rebased onto (#63).
    for (let step = 0; r.code !== 0 && step < 500; step++) {
      const conflicts = await unmerged(cwd);
      if (!(await takeSide(cwd, conflicts, takeBase, '--ours'))) {
        // Left stopped for a session to resolve (HH-532): only a real conflict, never a refusal (nothing is in progress then).
        if (opts.stop && conflicts.length) return { ok: false, conflicts, head: await this.revParse(cwd, 'HEAD'), stopped: true, stepFiles: await stepFiles(cwd), ...(took.size ? { tookBase: [...took] } : {}) };
        await git(cwd, ['rebase', '--abort'], true);
        return { ok: false, conflicts, head: await this.revParse(cwd, 'HEAD'), ...(conflicts.length ? {} : { refused: refusalOf(r.stderr) }) };
      }
      conflicts.forEach((f) => took.add(f));
      // A commit that only changed a generated file is empty once the base's copy is taken: skip it, the regenerate step remakes the file.
      const staged = (await git(cwd, ['diff', '--cached', '--quiet'], true)).code !== 0;
      r = staged ? await git(cwd, ['-c', 'core.editor=true', 'rebase', '--continue'], true) : await git(cwd, ['rebase', '--skip'], true);
    }
    if (r.code !== 0) { await git(cwd, ['rebase', '--abort'], true); return { ok: false, conflicts: [...took], head: await this.revParse(cwd, 'HEAD') }; }
    return { ok: true, conflicts: [], head: await this.revParse(cwd, 'HEAD'), ...(took.size ? { tookBase: [...took] } : {}) };
  }
  async continueRebase(cwd: string, takeBase: string[], step: { conflicts: string[]; files: string[]; head: string }): Promise<ContinueResult> {
    const took = new Set<string>();
    const tookBase = () => (took.size ? { tookBase: [...took] } : {});
    let { conflicts, files } = step;
    for (let n = 0; n < 500; n++) {
      const head = await this.revParse(cwd, 'HEAD');
      if ((await this.inProgressOp(cwd)) !== 'rebase') return { state: 'done', files: [], head, ...tookBase() };
      // The session continued the rebase itself and it stopped again at a later commit: that commit's conflict is a new one.
      if (n === 0 && head !== step.head) {
        const now = await unmerged(cwd);
        if (now.length) return { state: 'stopped', files: now, stepFiles: await stepFiles(cwd), head, ...tookBase() };
        files = await stepFiles(cwd); conflicts = files;
      }
      // What this step changes now, against what it changed when it stopped (the commit's own auto-merged files included).
      const changed = await stepFiles(cwd);
      const outside = changed.filter((f) => !files.includes(f) && !conflicts.includes(f));
      if (outside.length) return { state: 'outside', files: outside, head, ...tookBase() };
      const marked = conflicts.filter((f) => { try { return /^(<{7}|>{7})( |$)/m.test(readFileSync(join(cwd, f), 'utf8')); } catch { return false; } });
      if (marked.length) return { state: 'markers', files: marked, head, ...tookBase() };
      if (changed.length) await git(cwd, ['add', '-A', '--', ...changed]);
      // A step left empty by the resolution is already in the base: skipped, as the sync's own loop does.
      const staged = (await git(cwd, ['diff', '--cached', '--quiet'], true)).code !== 0;
      const r = staged ? await git(cwd, ['-c', 'core.editor=true', 'rebase', '--continue'], true) : await git(cwd, ['rebase', '--skip'], true);
      if (r.code === 0) continue;
      const next = await unmerged(cwd);
      if (!next.length) {
        if ((await this.inProgressOp(cwd)) !== 'rebase') continue;
        return { state: 'failed', files: [], head: await this.revParse(cwd, 'HEAD'), message: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300), ...tookBase() };
      }
      if (await takeSide(cwd, next, takeBase, '--ours')) { next.forEach((f) => took.add(f)); conflicts = []; files = await stepFiles(cwd); continue; }
      return { state: 'stopped', files: next, stepFiles: await stepFiles(cwd), head: await this.revParse(cwd, 'HEAD'), ...tookBase() };
    }
    return { state: 'failed', files: [], head: await this.revParse(cwd, 'HEAD'), message: 'the rebase did not finish in 500 steps', ...tookBase() };
  }
  async merge(cwd: string, ref: string, takeBase: string[] = []): Promise<RebaseResult> {
    const r = await git(cwd, ['merge', '--no-edit', ref], true);
    if (r.code === 0) return { ok: true, conflicts: [], head: await this.revParse(cwd, 'HEAD') };
    const conflicts = await unmerged(cwd);
    // In a merge `--theirs` is the ref merged in: the base (#63).
    if (await takeSide(cwd, conflicts, takeBase, '--theirs') && (await git(cwd, ['-c', 'core.editor=true', 'commit', '--no-edit'], true)).code === 0) {
      return { ok: true, conflicts: [], head: await this.revParse(cwd, 'HEAD'), tookBase: conflicts };
    }
    await git(cwd, ['merge', '--abort'], true);
    return { ok: false, conflicts, head: await this.revParse(cwd, 'HEAD'), ...(conflicts.length ? {} : { refused: refusalOf(r.stderr) }) };
  }
  async resetHard(cwd: string, sha: string) { await git(cwd, ['reset', '-q', '--hard', sha]); }
  async commitPaths(cwd: string, paths: string[], message: string) {
    await git(cwd, ['add', '--', ...paths]);
    await git(cwd, ['commit', '-q', '-m', message, '--', ...paths]);
    return this.revParse(cwd, 'HEAD');
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
  async deleteRemoteBranch(repo: string, branch: string, expected: string | null) {
    if (expected === null) {
      if (await this.remoteBranchSha(repo, branch)) throw new Error(`remote branch ${branch} appeared after verification; kept it`);
    } else if (await this.deleteRemoteBranchAt(repo, branch, expected) === 'moved') {
      throw new Error(`remote branch ${branch} moved after verification; kept it`);
    }
  }
  async deleteRemoteBranchAt(repo: string, branch: string, sha: string): Promise<'deleted' | 'moved' | 'gone'> {
    return refLocked(() => retrying(async () => {
      const r = await git(repo, ['push', `--force-with-lease=refs/heads/${branch}:${sha}`, 'origin', `:refs/heads/${branch}`], true);
      if (r.code === 0) return 'deleted' as const;
      // A retry after a successful deletion may report stale info, not "ref does not exist".
      const now = await this.remoteBranchSha(repo, branch);
      if (now === null) return 'gone' as const;
      if (now !== sha) return 'moved' as const;
      throw new Error(`delete remote ${branch}: ${r.stderr.trim()}`);
    }, GIT_RETRY_MS));
  }
  async localBranchExists(repo: string, branch: string) { return this.refExists(repo, `refs/heads/${branch}`); }
  async deleteLocalBranch(repo: string, branch: string, expected: string | null) {
    await refLocked(async () => {
      if (!await this.localBranchExists(repo, branch)) return;
      if (!expected) throw new Error(`local branch ${branch} appeared after verification; kept it`);
      if ((await this.worktreeList(repo)).some((w) => w.branch === branch)) throw new Error(`local branch ${branch} is checked out; kept it`);
      // Compare-and-delete under Git's ref lock, rather than force-deleting whichever tip is there.
      const r = await git(repo, ['update-ref', '--no-deref', '-d', `refs/heads/${branch}`, expected], true);
      if (r.code !== 0) throw new Error(`local branch ${branch} could not be deleted at its verified tip; kept it: ${r.stderr.trim()}`);
    });
  }
  async isAncestor(repo: string, ancestor: string, descendant: string) { return (await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant], true)).code === 0; }
  async log(cwd: string, range: string, n: number) { return (await git(cwd, ['log', '--oneline', `-n${n}`, range], true)).stdout.trim(); }
}

/**
 * The verdict of a head's runs, newest first. A run whose jobs were all skipped (conclusion
 * `skipped`: a draft guard, a path filter) checked nothing, so it is never red: a real run for
 * the same head wins over it, and a head with only skipped runs is `skipped`, which waits.
 */
export function ciFromRuns(runs: any[], sha: string): CiStatus {
  const run = runs.find((r) => r.conclusion !== 'skipped') ?? runs[0];
  if (!run) return { state: 'none', sha };
  const base = { runId: run.databaseId, url: run.url, sha, startedAt: run.createdAt, ...(run.attempt ? { attempt: run.attempt } : {}) };
  // queued, waiting, requested, pending: no runner has picked it up, so its clock has not started (#170).
  if (run.status !== 'completed') return { ...base, state: 'pending', ...(run.status !== 'in_progress' ? { queued: true } : {}) };
  if (run.conclusion === 'success') return { ...base, state: 'success' };
  if (run.conclusion === 'cancelled') return { ...base, state: 'cancelled' };
  if (run.conclusion === 'skipped') return { ...base, state: 'skipped' };
  return { ...base, state: 'failure' };
}

/** A job conclusion that did not fail the run: it succeeded, or it never ran. */
const ok = (c: string | null | undefined) => !c || c === 'success' || c === 'skipped' || c === 'neutral';
/**
 * A completed run GitHub calls `failure` whose jobs only ended cancelled or skipped (a job's
 * `timeout-minutes`, a cancelled job a `needs:` job waits on) checked nothing and failed nothing:
 * it is cancelled, which is re-run once and then `ci_cancelled`, never a fix turn (#213, HH-344).
 */
export function onlyCancelled(jobs: any[]): boolean {
  return jobs.some((j) => j.conclusion === 'cancelled') && jobs.every((j) => j.conclusion === 'cancelled' || ok(j.conclusion));
}
/** The jobs and steps of a run that did not succeed, as `job: conclusion` and `job › step: conclusion` (#213). */
export function unsuccessful(jobs: any[]): string[] {
  return jobs.filter((j) => !ok(j.conclusion)).flatMap((j) => {
    const steps = ((j.steps ?? []) as any[]).filter((st) => !ok(st.conclusion));
    return steps.length ? steps.map((st) => `${j.name} › ${st.name}: ${st.conclusion}`) : [`${j.name}: ${j.conclusion}`];
  });
}

const PR_FIELDS = 'number,url,state,mergedAt,headRefOid,headRefName,baseRefName,mergeCommit,title,isDraft,author,updatedAt';
function toPr(p: any): PrInfo { return { number: p.number, url: p.url, state: p.state, mergedAt: p.mergedAt ?? undefined, headRefOid: p.headRefOid, headRefName: p.headRefName, baseRefName: p.baseRefName, mergeCommit: p.mergeCommit?.oid, title: p.title, isDraft: Boolean(p.isDraft), author: p.author?.login ?? undefined, updatedAt: p.updatedAt ?? undefined }; }

const issueOf = (i: any): IssueInfo => ({ number: i.number, title: i.title ?? '', body: i.body ?? '', url: i.url, state: i.state, labels: (i.labels ?? []).map((l: { name: string }) => l.name) });

export class LiveGhPort implements GhPort {
  async prDetails(repo: string, number: number) { return ghRead(['pr', 'view', String(number), '--repo', repo, '--json', 'number,url,title,body,state,headRefName,headRefOid,baseRefName,comments,reviews,reviewDecision']); }
  async prDiff(repo: string, number: number) { return (await ghRead(['pr', 'diff', String(number), '--repo', repo])).slice(0, 100_000); }
  async runView(repo: string, runId: number) { return ghRead(['run', 'view', String(runId), '--repo', repo, '--json', 'status,conclusion,jobs,headSha,url']); }
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
    const runs = JSON.parse(await ghRead(['run', 'list', '--repo', repo, '--branch', branch, '--workflow', workflow, '--limit', '10', '--json', 'databaseId,status,conclusion,headSha,url,createdAt,attempt'])) as any[];
    const ci = ciFromRuns(runs.filter((r) => r.headSha === sha), sha);
    if (ci.state !== 'failure' || !ci.runId) return ci;
    // GitHub's `failure` is not proof that anything failed: read the jobs (#213).
    const jobs = await ghRead(['run', 'view', String(ci.runId), '--repo', repo, '--json', 'jobs']).then((v) => (JSON.parse(v).jobs ?? []) as any[], () => []);
    return onlyCancelled(jobs) ? { ...ci, state: 'cancelled', timedOut: true } : ci;
  }
  async ciQueue(repo: string, workflow: string): Promise<CiQueue> {
    const count = async (status: string) => (JSON.parse(await ghRead(['run', 'list', '--repo', repo, '--workflow', workflow, '--status', status, '--limit', '100', '--json', 'databaseId'])) as any[]).length;
    const [queued, running] = await Promise.all([count('queued'), count('in_progress')]);
    return { queued, running };
  }
  async runners(repo: string, workflow: string): Promise<RunnerReport> {
    // Repository runners, else the organization's (runners shared across its repositories); neither readable is an error, not "none".
    const list = async (path: string) => (JSON.parse(await ghRead(['api', `${path}?per_page=100`])).runners ?? []) as any[];
    let raw: any[] | undefined = await list(`repos/${repo}/actions/runners`).catch(() => undefined);
    if (!raw?.length) raw = await list(`orgs/${repo.split('/')[0]}/actions/runners`).catch(() => raw);
    if (!raw) throw new Error(`cannot read the runners of ${repo} (gh needs admin access to the repository)`);
    const runners: RunnerInfo[] = raw.map((r) => ({ name: String(r.name), online: r.status === 'online', busy: Boolean(r.busy), labels: ((r.labels ?? []) as any[]).map((l) => String(l.name)) }));
    const open = await Promise.all(['queued', 'in_progress'].map((st) => ghRead(['run', 'list', '--repo', repo, '--workflow', workflow, '--status', st, '--limit', '20', '--json', 'databaseId']).then((v) => JSON.parse(v) as any[])));
    const jobs: OpenJob[] = [];
    for (const run of open.flat().slice(0, 20)) {
      const js = (JSON.parse(await ghRead(['api', `repos/${repo}/actions/runs/${run.databaseId}/jobs?filter=latest&per_page=100`])).jobs ?? []) as any[];
      for (const j of js) if (j.status !== 'completed') jobs.push({ runId: run.databaseId, status: j.status === 'in_progress' ? 'in_progress' : 'queued', labels: ((j.labels ?? []) as any[]).map(String), ...(j.runner_name ? { runner: String(j.runner_name) } : {}) });
    }
    return { runners, jobs };
  }
  async runFailedLog(repo: string, runId: number, maxLines: number) {
    const log = await ghRead(['run', 'view', String(runId), '--repo', repo, '--log-failed']).catch((e) => `(could not fetch log: ${e.message})`);
    const lines = log.split('\n').map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+\s?/, '')).filter((l) => l.trim());
    const fails = lines.filter((l) => /FAIL|Error|error:|assert/i.test(l));
    const tail = lines.slice(-maxLines);
    // What did not succeed leads, so an empty log is never a bare "…" (#213).
    const view = await ghRead(['run', 'view', String(runId), '--repo', repo, '--json', 'jobs,url']).then((v) => JSON.parse(v), () => ({}));
    const jobs = (view.jobs ?? []) as any[];
    const head = [...unsuccessful(jobs), ...(view.url ? [`run: ${view.url}`] : [])];
    const count = (c: string) => jobs.filter((j) => j.conclusion === c).length;
    const plural = (n: number, c: string) => `${n} ${n === 1 ? 'job' : 'jobs'} ${c}`;
    const empty = `GitHub returned no failed-job log: ${[plural(count('cancelled'), 'cancelled'), `${count('skipped')} skipped`].join(', ')}`;
    const body = lines.length ? [...fails.slice(-40), ...(fails.length ? ['…'] : []), ...tail] : [empty];
    return [...new Set([...head, ...body])].join('\n');
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
  async rerunFailed(repo: string, runId: number) { await gh(['run', 'rerun', String(runId), '--repo', repo, '--failed']); }
  async rerunAll(repo: string, runId: number) { await gh(['run', 'rerun', String(runId), '--repo', repo]); }
  async previewUrl(repo: string, sha: string): Promise<string | null> {
    const deployments = JSON.parse(await ghRead(['api', `repos/${repo}/deployments?sha=${sha}&per_page=5`])) as { id: number }[];
    for (const d of deployments.slice(0, 3)) {
      const statuses = JSON.parse(await ghRead(['api', `repos/${repo}/deployments/${d.id}/statuses?per_page=5`])) as { state: string; environment_url?: string; target_url?: string }[];
      const ok = statuses.find((x) => x.state === 'success' && (x.environment_url || x.target_url));
      if (ok) return ok.environment_url || ok.target_url || null;
    }
    return null;
  }
  async issueList(repo: string, opts: { limit: number; state?: 'open' | 'all'; label?: string }): Promise<IssueInfo[]> {
    return (JSON.parse(await ghRead(['issue', 'list', '--repo', repo, '--state', opts.state ?? 'all', '--limit', String(opts.limit), ...(opts.label ? ['--label', opts.label] : []), '--json', 'number,title,body,url,state,labels'])) as any[]).map(issueOf);
  }
  async issueView(repo: string, number: number): Promise<IssueInfo | null> {
    try { return issueOf(JSON.parse(await ghRead(['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,body,url,state,labels']))); }
    catch (e) { if (/could not resolve|not found/i.test((e as Error).message)) return null; throw e; }
  }
  async issueCreate(repo: string, a: { title: string; body: string }) {
    const url = (await gh(['issue', 'create', '--repo', repo, '--title', a.title, '--body', a.body])).trim().split('\n').pop()!;
    return { number: Number(url.split('/').pop()), url };
  }
  async closePr(repo: string, number: number, comment: string) { await gh(['pr', 'close', String(number), '--repo', repo, '--comment', comment]); }
  async reopenPr(repo: string, number: number) { await gh(['pr', 'reopen', String(number), '--repo', repo]); }
  async prClosedBy(repo: string, number: number): Promise<PrClosure | null> {
    // One line per `closed` event, page by page; the last is the close that stands.
    const lines = (await ghRead(['api', '--paginate', `repos/${repo}/issues/${number}/events?per_page=100`, '--jq', '.[] | select(.event == "closed") | {actor: .actor.login, commit: .commit_id, at: .created_at}'])).trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    const ev = JSON.parse(lines[lines.length - 1]) as { actor?: string | null; commit?: string | null; at?: string | null };
    const closure: PrClosure = { ...(ev.actor ? { actor: ev.actor } : {}), ...(ev.commit ? { commit: ev.commit } : {}), ...(ev.at ? { at: ev.at } : {}) };
    if (!ev.commit) return closure;
    // The commit's own pull request: the merge whose message carried the closing keyword.
    const pr = (await ghRead(['api', `repos/${repo}/commits/${ev.commit}/pulls`, '--jq', `[.[] | select(.number != ${number})][0].number // empty`]).catch(() => '')).trim();
    return pr && /^\d+$/.test(pr) ? { ...closure, pr: Number(pr) } : closure;
  }
  async mergePr(repo: string, number: number, opts: { headSha: string }): Promise<'merged' | 'head_moved'> {
    try {
      await gh(['pr', 'merge', String(number), '--repo', repo, '--merge', '--match-head-commit', opts.headSha]);
      return 'merged';
    } catch (e) {
      // A mismatched head is a validation stop, not a reason to retry against a new head.
      const view = await this.prView(repo, number);
      if (view.state === 'OPEN' && view.headRefOid !== opts.headSha) return 'head_moved';
      throw e;
    }
  }
  async branchCi(repo: string, branch: string, workflow: string): Promise<CiStatus> {
    const runs = JSON.parse(await ghRead(['run', 'list', '--repo', repo, '--branch', branch, '--workflow', workflow, '--event', 'push', '--limit', '5', '--json', 'databaseId,status,conclusion,headSha,url,createdAt'])) as any[];
    const latest = runs.find((r) => r.conclusion !== 'skipped') ?? runs[0];
    return latest ? ciFromRuns([latest], latest.headSha) : { state: 'none' };
  }
}

export class LiveProcPort implements ProcPort {
  async freeBytes(path: string) { try { const s = await statfs(path); return Number(s.bavail) * Number(s.bsize); } catch { return undefined; } }
  async run(command: string, opts: { cwd: string; timeoutMs?: number; env?: Record<string, string>; cleanEnv?: boolean }) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile('/bin/bash', ['-lc', command], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60 * 60_000, maxBuffer: 64 * 1024 * 1024, env: opts.cleanEnv ? { ...opts.env } : { ...process.env, ...opts.env } }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}
