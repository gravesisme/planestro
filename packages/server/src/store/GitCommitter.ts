import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isoLocal } from '@planestro/shared';

const execFileP = promisify(execFile);

export interface GitCommitterOptions { autoCommit: boolean; autoPush: boolean; toolVersion: string; log?: (level: 'info' | 'warn' | 'error', msg: string) => void }

/**
 * Semantic commits in the data dir. Only meaningful events commit (`HH-143: approve plan`);
 * telemetry sits uncommitted until a checkpoint (`planestro: checkpoint <ts>`).
 * Never fatal: a failed commit/push is logged and the data stays on disk.
 */
export class GitCommitter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string, private readonly opts: GitCommitterOptions) {}

  get enabled(): boolean { return this.opts.autoCommit && existsSync(join(this.dir, '.git')); }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileP('git', ['-C', this.dir, ...args], { maxBuffer: 8 * 1024 * 1024 });
  }

  /** Serialize git operations so two mutations never race on the index. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Resolves once every queued git operation has finished (tests, shutdown). */
  async idle(): Promise<void> { await this.queue; }

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

  /** Commit everything currently dirty under `message`; returns false when nothing changed. */
  commit(message: string, body?: string): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    return this.enqueue(async () => {
      try {
        await this.git(['add', '-A']);
        const { stdout } = await this.git(['status', '--porcelain']);
        if (!stdout.trim()) return false;
        const args = ['commit', '-q', '-m', message];
        if (body) args.push('-m', body);
        args.push('-m', `Planestro-Version: ${this.opts.toolVersion}`);
        await this.git(args);
        this.opts.log?.('info', `git: ${message}`);
        return true;
      } catch (e) {
        this.opts.log?.('error', `git commit failed: ${String(e).split('\n')[0]}`);
        return false;
      }
    });
  }

  checkpoint(): Promise<boolean> {
    return this.commit(`planestro: checkpoint ${isoLocal()}`);
  }

  push(): Promise<boolean> {
    if (!this.enabled || !this.opts.autoPush) return Promise.resolve(false);
    return this.enqueue(async () => {
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
  }
}
