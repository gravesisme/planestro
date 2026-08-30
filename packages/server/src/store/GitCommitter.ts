import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isoLocal } from '@planestro/shared';

const execFileP = promisify(execFile);

export interface GitCommitterOptions { autoCommit: boolean; autoPush: boolean; toolVersion: string; log?: (level: 'info' | 'warn' | 'error', msg: string) => void }

/**
 * Semantic commits in the data dir. Commits are synchronous (small, local, milliseconds)
 * so every mutation's commit captures exactly that mutation — successive changes to the
 * same file never fold into an earlier queued commit. Pushes are asynchronous and queued.
 * Never fatal: a failed commit/push is logged and the data stays on disk.
 */
export class GitCommitter {
  private pushQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string, private readonly opts: GitCommitterOptions) {}

  get enabled(): boolean { return this.opts.autoCommit && existsSync(join(this.dir, '.git')); }

  private gitSync(args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  }
  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileP('git', ['-C', this.dir, ...args], { maxBuffer: 8 * 1024 * 1024 });
  }

  /** Resolves once every queued push has finished (tests, shutdown). */
  async idle(): Promise<void> { await this.pushQueue; }

  async status(): Promise<{ dirty: string[]; branch: string; head?: string; ahead?: number }> {
    if (!existsSync(join(this.dir, '.git'))) return { dirty: [], branch: '(no git)' };
    const { stdout } = await this.git(['status', '--porcelain']);
    const dirty = stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
    const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim();
    const head = (await this.git(['rev-parse', '--short', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim() || undefined;
    let ahead: number | undefined;
    try { ahead = Number((await this.git(['rev-list', '--count', '@{u}..HEAD'])).stdout.trim()); } catch { /* no upstream */ }
    return { dirty, branch, head, ahead };
  }

  /**
   * Commit under `message`. With `paths` (relative to the data dir) only those paths are
   * staged and committed; without, everything dirty is committed (checkpoints, hand edits).
   * Returns false when nothing changed.
   */
  commit(message: string, body?: string, paths?: string[]): boolean {
    if (!this.enabled) return false;
    const scope = paths?.length ? ['--', ...paths] : [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.gitSync(['add', '-A', ...scope]);
        if (!this.gitSync(['status', '--porcelain', ...scope]).trim()) return false;
        const args = ['commit', '-q', '-m', message];
        if (body) args.push('-m', body);
        args.push('-m', `Planestro-Version: ${this.opts.toolVersion}`, ...scope);
        this.gitSync(args);
        this.opts.log?.('info', `git: ${message}`);
        return true;
      } catch (e) {
        const msg = String((e as any).stderr ?? (e as Error).message).split('\n')[0];
        if (/index\.lock/.test(msg) && attempt < 2) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1)); continue; }
        this.opts.log?.('error', `git commit failed: ${msg}`);
        return false;
      }
    }
    return false;
  }

  checkpoint(): boolean {
    return this.commit(`planestro: checkpoint ${isoLocal()}`);
  }

  push(): Promise<boolean> {
    if (!this.enabled || !this.opts.autoPush) return Promise.resolve(false);
    const run = this.pushQueue.then(async () => {
      try {
        const { ahead } = await this.status();
        if (ahead === undefined) return false;
        if (ahead === 0) return true;
        await this.git(['push', '-q']);
        this.opts.log?.('info', `git: pushed ${ahead} commit(s)`);
        return true;
      } catch (e) {
        this.opts.log?.('warn', `git push failed: ${String(e).split('\n')[0]}`);
        return false;
      }
    });
    this.pushQueue = run.catch(() => undefined);
    return run;
  }
}
