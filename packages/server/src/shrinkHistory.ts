import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { planestroHome } from './machinePolicy.ts';
import { pidAlive, takePidLock } from './store/pidLock.ts';
import { supervisorLockPath } from './supervise.ts';

// ---- shrinking a planning repository that tracked its journal (#409) ----
// The journal is untracked since #400, but a repository that committed it hourly keeps that weight in its history
// (one passed 3 GiB). Taking it out means rewriting history, so this follows invariant 7 to the letter: a dry run by
// default, only the data dir's own branch is rewritten (a planning branch can share its object store with the code
// repository), a verified bundle of that branch is written first, the checked-out tree must come out identical, and
// nothing is ever pushed: the force push, leased to the remote tip seen here, is printed for the user to run.

const JOURNAL = 'journal';

export type ShrinkTool = 'filter-repo' | 'filter-branch';

export interface ShrinkReport {
  dataDir: string;
  branch?: string;
  upstream?: { remote: string; ref: string; sha: string };
  /** Why it cannot run now; empty when it can. */
  refusals: string[];
  /** Commits on the branch that touch journal/: zero means there is nothing to rewrite. */
  journalCommits: number;
  commits: number;
  /** Bytes of the journal versions the branch's history holds (uncompressed, unique blobs). */
  journalBytes: number;
  /** The repository's object store on disk (shared with the code repo when the data dir is a linked worktree). */
  storeBytes: number;
  shared: boolean;
  tool: ShrinkTool;
  /** Refs besides the branch and its upstream that hold journal history: they keep its objects alive. */
  otherHolders: string[];
}

const run = (cwd: string, args: string[], env?: Record<string, string>): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env }).trim();
const tryRun = (cwd: string, args: string[]): string | undefined => { try { return run(cwd, args); } catch { return undefined; } };

export function storeBytes(dir: string): number {
  const v = Object.fromEntries(run(dir, ['count-objects', '-v']).split('\n').map((l) => l.split(': ') as [string, string]));
  return (Number(v['size-pack'] ?? 0) + Number(v.size ?? 0) + Number(v['size-garbage'] ?? 0)) * 1024;
}

export const human = (n: number): string => n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GiB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${Math.round(n / 1024)} KiB`;

function filterRepoAvailable(dir: string): boolean { return tryRun(dir, ['filter-repo', '--version']) !== undefined; }

/** A live holder of the data dir: its server, or a `--watch` supervisor between two children. */
function liveHolder(dataDir: string): string | undefined {
  for (const [what, path] of [['a planestro server', join(dataDir, '.planestro', 'lock')], ['a planestro --watch supervisor', supervisorLockPath(dataDir)]] as const) {
    if (!existsSync(path)) continue;
    try { const pid = JSON.parse(readFileSync(path, 'utf8')).pid; if (typeof pid === 'number' && pid !== process.pid && pidAlive(pid)) return `${what} (pid ${pid}) holds ${dataDir}: stop it first (planestro stop ${dataDir})`; } catch { /* unreadable: stale */ }
  }
  return undefined;
}

/** What a rewrite would do, and every reason it cannot run now. Reads only (plus a fetch of the upstream when `fetch`). */
export function inspectShrink(dataDirIn: string, o: { fetch?: boolean; tool?: ShrinkTool; afterRewrite?: boolean } = {}): ShrinkReport {
  const dataDir = resolve(dataDirIn);
  const r: ShrinkReport = { dataDir, refusals: [], journalCommits: 0, commits: 0, journalBytes: 0, storeBytes: 0, shared: false, tool: o.tool ?? 'filter-branch', otherHolders: [] };
  const top = tryRun(dataDir, ['rev-parse', '--show-toplevel']);
  if (!top || realpathSync(top) !== realpathSync(dataDir)) { r.refusals.push(`${dataDir} is not the top of a git checkout`); return r; }
  r.tool = o.tool ?? (filterRepoAvailable(dataDir) ? 'filter-repo' : 'filter-branch');
  const holder = liveHolder(dataDir); if (holder) r.refusals.push(holder);
  const branch = tryRun(dataDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch) { r.refusals.push('HEAD is detached: check out the planning branch'); return r; }
  r.branch = branch;
  const gitDir = run(dataDir, ['rev-parse', '--absolute-git-dir']);
  const common = resolve(dataDir, run(dataDir, ['rev-parse', '--git-common-dir']));
  r.shared = realpathSync(gitDir) !== realpathSync(common) || run(dataDir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length > 1;
  for (const f of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) if (existsSync(join(gitDir, f))) r.refusals.push(`a git operation is in progress (${f}): finish or abort it`);
  if (run(dataDir, ['status', '--porcelain', '--untracked-files=normal'])) r.refusals.push('the working tree has changes: commit or move them first (planestro commits its own at startup)');
  if (run(dataDir, ['ls-files', '--cached', '--', JOURNAL]) || tryRun(dataDir, ['cat-file', '-e', `HEAD:${JOURNAL}`]) !== undefined) r.refusals.push('journal/ is still tracked: start planestro once and stop it (it commits "planestro: stop tracking journal"), then run this again');
  if (tryRun(dataDir, ['rev-parse', '-q', '--verify', 'refs/stash'])) r.refusals.push('there are stash entries: apply or drop them first (git stash list)');
  if (r.tool === 'filter-branch' && tryRun(dataDir, ['rev-parse', '-q', '--verify', `refs/original/refs/heads/${branch}`])) r.refusals.push(`refs/original/refs/heads/${branch} is left from an earlier rewrite: check it, then delete it (git update-ref -d refs/original/refs/heads/${branch})`);

  const remote = tryRun(dataDir, ['config', `branch.${branch}.remote`]);
  const merge = tryRun(dataDir, ['config', `branch.${branch}.merge`]);
  if (remote && remote !== '.' && merge) {
    const short = merge.replace(/^refs\/heads\//, '');
    if (o.fetch) { try { run(dataDir, ['fetch', '-q', remote, `+${merge}:refs/remotes/${remote}/${short}`]); } catch (e) { r.refusals.push(`git fetch ${remote} ${short} failed (${String((e as Error).message).split('\n')[0]}): the remote's tip must be known before a rewrite`); } }
    const sha = tryRun(dataDir, ['rev-parse', '-q', '--verify', `refs/remotes/${remote}/${short}`]);
    if (sha) {
      r.upstream = { remote, ref: short, sha };
      if (!o.afterRewrite && tryRun(dataDir, ['merge-base', '--is-ancestor', sha, branch]) === undefined) r.refusals.push(`${remote}/${short} has commits ${branch} lacks: pull them in first (a rewrite would drop them from the remote at the force push)`);
    }
  }

  r.commits = Number(run(dataDir, ['rev-list', '--count', branch]));
  r.journalCommits = Number(run(dataDir, ['rev-list', '--count', branch, '--', JOURNAL]));
  if (r.journalCommits) {
    const blobs = new Set<string>();
    for (const line of run(dataDir, ['log', branch, '--format=', '--raw', '--no-abbrev', '--no-renames', '--', JOURNAL]).split('\n')) {
      const sha = line.split(' ')[3]; if (sha && !/^0+$/.test(sha)) blobs.add(sha);
    }
    if (blobs.size) {
      const sizes = execFileSync('git', ['cat-file', '--batch-check=%(objectsize)'], { cwd: dataDir, input: [...blobs].join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 30 });
      r.journalBytes = sizes.split('\n').reduce((s, n) => s + (Number(n) || 0), 0);
    }
    r.otherHolders = holdersOfJournal(dataDir, [`refs/heads/${branch}`, ...(r.upstream ? [`refs/remotes/${r.upstream.remote}/${r.upstream.ref}`] : [])]);
  }
  r.storeBytes = storeBytes(dataDir);
  return r;
}

/** Refs other than `skip` that reach a commit touching journal/ (one pass: the newest such commit of every other ref). */
function holdersOfJournal(dir: string, skip: string[]): string[] {
  const refs = run(dir, ['for-each-ref', '--format=%(refname)']).split('\n').filter((x) => x && !skip.includes(x) && !x.startsWith('refs/original/'));
  if (!refs.length) return [];
  const touching = tryRun(dir, ['rev-list', '-1', ...refs, '--', JOURNAL]);
  if (!touching) return [];
  return run(dir, ['for-each-ref', '--contains', touching, '--format=%(refname)']).split('\n').filter((x) => x && refs.includes(x));
}

export function formatInspect(r: ShrinkReport): string[] {
  const out = [`shrink-history: ${r.dataDir}${r.branch ? ` (branch ${r.branch})` : ''}`];
  if (r.branch) {
    out.push(`  ${r.journalCommits} of ${r.commits} commits touch journal/; its versions in history total ${human(r.journalBytes)} uncompressed`);
    out.push(`  object store on disk: ${human(r.storeBytes)}${r.shared ? ' (shared with the code repository: only this branch is rewritten)' : ''}`);
    out.push(`  rewrite with: git ${r.tool}${r.tool === 'filter-branch' ? ' (git filter-repo is faster: pip install git-filter-repo)' : ''}`);
    if (r.upstream) out.push(`  upstream: ${r.upstream.remote}/${r.upstream.ref} at ${r.upstream.sha.slice(0, 12)}`);
    if (r.otherHolders.length) out.push(`  also holding the old journal history (their objects stay until they go): ${r.otherHolders.join(', ')}`);
  }
  for (const x of r.refusals) out.push(`  REFUSED: ${x}`);
  if (!r.refusals.length) out.push(r.journalCommits ? '  dry run: nothing changed. --apply backs the branch up to a bundle, rewrites it, and prints the push for you to run.' : '  nothing to do: no commit on the branch touches journal/.');
  return out;
}

export interface ShrinkResult { bundle: string; before: { tip: string; commits: number }; after: { tip: string; commits: number }; push?: string; next: string[] }

/**
 * Back up, rewrite and verify. Holds the data-dir lock throughout, so planestro cannot start under it. Throws (with
 * how to restore) on anything unexpected; after the rewrite, only on evidence it went wrong.
 */
export function applyShrink(dataDirIn: string, o: { backupDir?: string; tool?: ShrinkTool; now?: () => Date; log?: (m: string) => void } = {}): ShrinkResult {
  const log = o.log ?? (() => {});
  const r = inspectShrink(dataDirIn, { fetch: true, tool: o.tool });
  if (r.refusals.length) throw new Error(`refused:\n- ${r.refusals.join('\n- ')}`);
  if (!r.journalCommits) throw new Error('nothing to do: no commit on the branch touches journal/');
  const dataDir = r.dataDir, branch = r.branch!;
  const lockPath = join(dataDir, '.planestro', 'lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  const got = takePidLock(lockPath, { pid: process.pid, started_at: new Date().toISOString(), by: 'shrink-history' });
  if (!got.ok) throw new Error(`a planestro server (pid ${got.holder.pid}) holds ${dataDir}: stop it first`);
  try {
    const tip = run(dataDir, ['rev-parse', branch]);
    const tree = run(dataDir, ['rev-parse', 'HEAD^{tree}']);
    const onDisk = journalFiles(dataDir);

    // 1. The backup, verified to hold the branch tip before anything is rewritten.
    const stamp = (o.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    // Never beside the data dir: a planning worktree's parent is the code repository's working tree (#409).
    const backupDir = resolve(o.backupDir ?? join(planestroHome(), 'backups'));
    mkdirSync(backupDir, { recursive: true });
    const bundle = join(backupDir, `${basename(dirname(dataDir))}-${basename(dataDir)}-${branch.replace(/[\/\\]/g, '-')}-before-shrink-${stamp}.bundle`);
    log(`backing up ${branch} to ${bundle}`);
    run(dataDir, ['bundle', 'create', bundle, branch]);
    run(dataDir, ['bundle', 'verify', '-q', bundle]);
    if (!run(dataDir, ['bundle', 'list-heads', bundle]).split('\n').some((l) => l.startsWith(`${tip} `))) throw new Error(`${bundle} does not hold ${branch} at ${tip}: nothing was rewritten`);

    // 2. The rewrite of this branch alone. Commits that only touched the journal (the hourly checkpoints) go empty and are dropped.
    log(`rewriting ${branch} with git ${r.tool} (${r.commits} commits; this can take a while)`);
    if (r.tool === 'filter-repo') run(dataDir, ['filter-repo', '--force', '--invert-paths', '--path', `${JOURNAL}/`, '--refs', branch]);
    else {
      const scratch = mkdtempSync(join(tmpdir(), 'planestro-shrink-'));
      try { run(dataDir, ['filter-branch', '-f', '-d', join(scratch, 'rewrite'), '--index-filter', `git rm -r -q --cached --ignore-unmatch -- ${JOURNAL}`, '--prune-empty', '--', branch], { FILTER_BRANCH_SQUELCH_WARNING: '1' }); }
      finally { rmSync(scratch, { recursive: true, force: true }); }
    }

    // 3. Positive evidence before the old tip is let go: the same checked-out tree, no journal left, the files still on disk.
    const restore = `restore with: git -C ${dataDir} fetch ${bundle} +${branch}:${branch} --update-head-ok && git -C ${dataDir} reset --hard ${branch}`;
    const newTip = run(dataDir, ['rev-parse', branch]);
    const problems: string[] = [];
    if (run(dataDir, ['rev-parse', 'HEAD^{tree}']) !== tree) problems.push('the checked-out tree changed');
    if (Number(run(dataDir, ['rev-list', '--count', branch, '--', JOURNAL]))) problems.push('journal/ is still in the history');
    if (journalFiles(dataDir) !== onDisk) problems.push('the journal files on disk changed');
    if (run(dataDir, ['status', '--porcelain', '--', '.', ':!.planestro'])) problems.push('the working tree is not clean'); // .planestro: the lock held here
    if (problems.length) throw new Error(`the rewrite did not check out: ${problems.join('; ')}. Nothing was pushed; ${restore}`);
    tryRun(dataDir, ['update-ref', '-d', `refs/original/refs/heads/${branch}`]);
    const after = { tip: newTip, commits: Number(run(dataDir, ['rev-list', '--count', branch])) };
    log(`rewritten: ${r.commits} → ${after.commits} commits, the checked-out tree unchanged; the backup is ${bundle}`);

    const push = r.upstream ? `git -C ${dataDir} push --force-with-lease=${r.upstream.ref}:${r.upstream.sha} ${r.upstream.remote} ${branch}:${r.upstream.ref}` : undefined;
    const next = [
      ...(push ? [`1. Push it (the lease refuses if ${r.upstream!.remote}/${r.upstream!.ref} moved since ${r.upstream!.sha.slice(0, 12)}): ${push}`,
        `   Do this before starting planestro again: its checkpoint push would be refused until the remote has the new history.`,
        `   Any other clone of this branch must be re-cloned or reset to the new tip (git fetch && git reset --hard ${r.upstream!.remote}/${r.upstream!.ref}); the remote keeps the old objects until its own garbage collection.`] : []),
      `${push ? '2' : '1'}. Reclaim the space: planestro shrink-history ${dataDir} --gc`,
      `   Keep ${bundle} until you are satisfied; ${restore}`,
    ];
    return { bundle, before: { tip, commits: r.commits }, after, push, next };
  } finally {
    try { const h = JSON.parse(readFileSync(lockPath, 'utf8')); if (h.pid === process.pid) unlinkSync(lockPath); } catch { /* gone */ }
  }
}

/**
 * After the push: drop what still points at the old history from this branch (its reflog, the upstream's, this
 * worktree's HEAD log) and collect it. Unreachable objects younger than an hour are kept, so git work in the code
 * repository's other worktrees is never pruned from under it.
 */
export function gcShrunk(dataDirIn: string, o: { log?: (m: string) => void } = {}): { before: number; after: number; otherHolders: string[] } {
  const log = o.log ?? (() => {});
  const r = inspectShrink(dataDirIn, { fetch: true, afterRewrite: true });
  const blocking = r.refusals.filter((x) => !x.startsWith('there are stash entries'));
  if (blocking.length) throw new Error(`refused:\n- ${blocking.join('\n- ')}`);
  if (r.journalCommits) throw new Error(`${r.branch} still carries journal/ (${r.journalCommits} commits): run --apply first`);
  if (r.upstream && run(r.dataDir, ['rev-parse', r.branch!]) !== r.upstream.sha) throw new Error(`${r.upstream.remote}/${r.upstream.ref} is not at ${r.branch}'s tip: push the rewritten branch first (the command --apply printed)`);
  const before = storeBytes(r.dataDir);
  const refs = [`refs/heads/${r.branch}`, ...(r.upstream ? [`refs/remotes/${r.upstream.remote}/${r.upstream.ref}`] : []), 'HEAD'];
  log(`expiring the reflogs of ${refs.join(', ')} and collecting garbage`);
  run(r.dataDir, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', ...refs]);
  run(r.dataDir, ['gc', '-q', '--prune=1.hour.ago']);
  const after = storeBytes(r.dataDir);
  return { before, after, otherHolders: holdersOfJournal(r.dataDir, refs.filter((x) => x !== 'HEAD')) };
}

/** A fingerprint of journal/ on disk (names and sizes): the rewrite must leave the files exactly as they were. */
function journalFiles(dataDir: string): string {
  const dir = join(dataDir, JOURNAL);
  if (!existsSync(dir)) return '';
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [`${join(d, e.name).slice(dir.length)}:${statSync(join(d, e.name)).size}`]);
  return walk(dir).sort().join('\n');
}
