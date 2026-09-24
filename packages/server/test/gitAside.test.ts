import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveGitPort } from '../src/engine/live-ports.ts';
import { git } from './helpers.ts';

describe('setting regenerated files aside (p17)', () => {
  it('splits tracked from untracked, finds what a ref tracks, and moves files without deleting them', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'planestro-aside-'));
    git(repo, 'init', '-q', '-b', 'trunk');
    mkdirSync(join(repo, 'assets'));
    writeFileSync(join(repo, 'assets/a.import'), 'base\n'); writeFileSync(join(repo, 'keep.txt'), 'k\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'rm', '-q', '--cached', 'assets/a.import'); git(repo, 'commit', '-q', '-m', 'untrack');   // HEAD no longer tracks it; trunk~1 does
    writeFileSync(join(repo, 'assets/a.import'), 'regenerated\n'); writeFileSync(join(repo, 'assets/b.import'), 'new\n');
    const port = new LiveGitPort();
    expect(await port.dirtyDetail(repo)).toEqual({ tracked: [], untracked: ['assets/a.import', 'assets/b.import'] });
    expect(await port.trackedAt(repo, 'HEAD~1', ['assets/a.import', 'assets/b.import'])).toEqual(['assets/a.import']);
    const dest = join(repo, '..', `aside-${Date.now()}`);
    await port.moveAside(repo, ['assets/a.import'], dest);
    expect(existsSync(join(repo, 'assets/a.import'))).toBe(false);
    expect(readFileSync(join(dest, 'assets/a.import'), 'utf8')).toBe('regenerated\n');
    writeFileSync(join(repo, 'keep.txt'), 'changed\n');
    expect((await port.dirtyDetail(repo)).tracked).toEqual(['keep.txt']);
  });
});
