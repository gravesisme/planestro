import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ciVerdict, pickUpdate, schemaVersionIn, githubRepoOf, checkForUpdate, readUpdateStatus, type Exec } from '../src/autoUpdate.ts';

const H = 3_600_000;
const green = (at: number) => ({ state: 'green' as const, completedAt: at });

describe('keeping the planestro checkout current (#103): the choices', () => {
  it('reads CI from check runs: all finished and none failed, skipped and neutral are not failures', () => {
    expect(ciVerdict([])).toEqual({ state: 'none' });
    expect(ciVerdict([{ status: 'in_progress', conclusion: null }])).toEqual({ state: 'pending' });
    expect(ciVerdict([{ status: 'completed', conclusion: 'success', completed_at: '2026-09-29T10:00:00Z' }, { status: 'completed', conclusion: 'failure' }])).toEqual({ state: 'red' });
    expect(ciVerdict([{ status: 'completed', conclusion: 'success', completed_at: '2026-09-29T10:00:00Z' }, { status: 'completed', conclusion: 'skipped', completed_at: '2026-09-29T11:00:00Z' }])).toEqual({ state: 'green', completedAt: Date.parse('2026-09-29T11:00:00Z') });
    expect(ciVerdict([{ status: 'completed', conclusion: 'skipped' }])).toEqual({ state: 'none' });
  });

  it('picks the newest green commit past the soak time, never one with an older data schema, and says why it waits', () => {
    const now = 100 * H;
    expect(pickUpdate([], { minAgeMs: 0, now, dataSchema: 3 })).toEqual({ wait: 'already on the newest main' });
    expect(pickUpdate([{ sha: 'b'.repeat(40), ci: { state: 'pending' } }, { sha: 'a'.repeat(40), ci: green(now - 5 * H) }], { minAgeMs: 0, now, dataSchema: 3 })).toEqual({ sha: 'a'.repeat(40) });
    expect(pickUpdate([{ sha: 'b'.repeat(40), ci: green(now - 1 * H) }, { sha: 'a'.repeat(40), ci: green(now - 13 * H) }], { minAgeMs: 12 * H, now, dataSchema: 3 })).toEqual({ sha: 'a'.repeat(40) });
    expect(pickUpdate([{ sha: 'b'.repeat(40), ci: green(now - 1 * H) }], { minAgeMs: 12 * H, now, dataSchema: 3 })).toMatchObject({ wait: expect.stringContaining('soak time') });
    expect(pickUpdate([{ sha: 'b'.repeat(40), ci: green(now), schema: 2 }], { minAgeMs: 0, now, dataSchema: 3 })).toMatchObject({ wait: expect.any(String) });
    expect(pickUpdate([{ sha: 'b'.repeat(40), ci: { state: 'pending' } }], { minAgeMs: 0, now, dataSchema: 3 })).toEqual({ wait: `CI is still running for bbbbbbb` });
    expect(pickUpdate([{ sha: 'b'.repeat(40), ci: { state: 'red' } }], { minAgeMs: 0, now, dataSchema: 3 })).toMatchObject({ wait: expect.stringContaining('is red') });
  });

  it('reads the schema version and the GitHub repository', () => {
    expect(schemaVersionIn('x\nexport const SCHEMA_VERSION = 4;\n')).toBe(4);
    expect(schemaVersionIn('nothing')).toBeUndefined();
    expect(githubRepoOf('git@github.com:gravesisme/planestro.git')).toBe('gravesisme/planestro');
    expect(githubRepoOf('https://github.com/gravesisme/planestro')).toBe('gravesisme/planestro');
    expect(githubRepoOf('/some/local/path')).toBeUndefined();
  });
});

describe('keeping the planestro checkout current (#103): one poll against real git', () => {
  const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  /** An origin with two commits past the clone's head (the second changes the lockfile), a clone at the first, and a data dir. */
  function world(local: string) {
    const origin = mkdtempSync(join(tmpdir(), 'planestro-upd-origin-'));
    g(origin, 'init', '-q', '-b', 'main');
    mkdirSync(join(origin, 'packages/shared/src'), { recursive: true });
    writeFileSync(join(origin, 'packages/shared/src/schema.ts'), 'export const SCHEMA_VERSION = 3;\n');
    writeFileSync(join(origin, 'package-lock.json'), '{"v":1}\n');
    g(origin, 'add', '-A'); g(origin, 'commit', '-q', '-m', 'one');
    const root = join(mkdtempSync(join(tmpdir(), 'planestro-upd-')), 'app');
    execFileSync('git', ['clone', '-q', origin, root]);
    g(root, 'checkout', '-q', '--detach');
    writeFileSync(join(origin, 'README.md'), 'two\n'); g(origin, 'add', '-A'); g(origin, 'commit', '-q', '-m', 'two');
    writeFileSync(join(origin, 'package-lock.json'), '{"v":2}\n'); g(origin, 'add', '-A'); g(origin, 'commit', '-q', '-m', 'three');
    g(root, 'remote', 'set-url', 'origin', origin);
    const dataDir = mkdtempSync(join(tmpdir(), 'planestro-upd-data-'));
    writeFileSync(join(dataDir, 'planestro.yml'), 'schema_version: 3\n');
    writeFileSync(join(dataDir, 'planestro.local.yml'), local);
    const calls: string[] = [];
    // git runs for real; the GitHub remote and npm are stood in for (the origin is a local path).
    const exec: Exec = async (cmd, args, cwd) => {
      if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return 'git@github.com:acme/planestro.git\n';
      if (cmd === 'gh') { calls.push(`gh ${args[1]}`); return JSON.stringify([{ status: 'completed', conclusion: 'success', completed_at: new Date(Date.now() - 2 * H).toISOString() }]); }
      if (cmd === 'npm') { calls.push(`npm ${args.join(' ')}`); return ''; }
      return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
    };
    return { origin, root, dataDir, exec, calls, tip: g(origin, 'rev-parse', 'HEAD'), first: g(root, 'rev-parse', 'HEAD') };
  }

  it('moves to the newest green main, reinstalls when the lockfile changed, and writes what it did', async () => {
    const w = world('update:\n  channel: main-green\n');
    const s = await checkForUpdate({ root: w.root, dataDir: w.dataDir, exec: w.exec });
    expect(s).toMatchObject({ state: 'updated', running: w.tip, target: w.tip });
    expect(g(w.root, 'rev-parse', 'HEAD')).toBe(w.tip);
    expect(w.calls).toContain('npm ci --silent');
    expect(readUpdateStatus(w.dataDir)).toMatchObject({ state: 'updated', running: w.tip, channel: 'main-green' });
    expect((await checkForUpdate({ root: w.root, dataDir: w.dataDir, exec: w.exec })).state).toBe('current');
  });

  it('off does nothing; a soak time waits; local changes and a tree ahead of main are refused', async () => {
    const off = world('');
    expect((await checkForUpdate({ root: off.root, dataDir: off.dataDir, exec: off.exec })).state).toBe('off');
    expect(g(off.root, 'rev-parse', 'HEAD')).toBe(off.first);

    const soak = world('update:\n  channel: main-green\n  min_age_hours: 12\n');
    expect(await checkForUpdate({ root: soak.root, dataDir: soak.dataDir, exec: soak.exec })).toMatchObject({ state: 'waiting', detail: expect.stringContaining('soak time') });
    expect(g(soak.root, 'rev-parse', 'HEAD')).toBe(soak.first);

    const dirty = world('update:\n  channel: main-green\n');
    writeFileSync(join(dirty.root, 'package-lock.json'), '{"edited":true}\n');
    expect((await checkForUpdate({ root: dirty.root, dataDir: dirty.dataDir, exec: dirty.exec })).state).toBe('refused');
    expect(readFileSync(join(dirty.root, 'package-lock.json'), 'utf8')).toBe('{"edited":true}\n');

    const dev = world('update:\n  channel: main-green\n');
    writeFileSync(join(dev.root, 'mine.ts'), 'x'); g(dev.root, 'add', '-A'); g(dev.root, 'commit', '-q', '-m', 'local work');
    expect(await checkForUpdate({ root: dev.root, dataDir: dev.dataDir, exec: dev.exec })).toMatchObject({ state: 'refused', detail: expect.stringContaining('development tree') });
  });
});
