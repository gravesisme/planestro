import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
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

  it('filesUnder lists every file under the named paths, ignored or not, and never follows a symlink or leaves the tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'planestro-under-'));
    git(repo, 'init', '-q', '-b', 'trunk');
    mkdirSync(join(repo, 'tmp/src'), { recursive: true }); mkdirSync(join(repo, 'assets'));
    writeFileSync(join(repo, '.gitignore'), 'tmp/\n'); writeFileSync(join(repo, 'tmp/src/raw.png'), 'r'); writeFileSync(join(repo, 'tmp/note.txt'), 'n'); writeFileSync(join(repo, 'assets/a.png'), 'a');
    symlinkSync('/', join(repo, 'tmp/escape'));
    const port = new LiveGitPort();
    expect((await port.filesUnder(repo, ['tmp', './assets/'])).sort()).toEqual(['assets/a.png', 'tmp/note.txt', 'tmp/src/raw.png']);
    expect(await port.filesUnder(repo, ['../', 'missing'])).toEqual([]);
  });

  it('copyInto copies to the same paths, leaves the source, and never overwrites a different file (#72)', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'planestro-copy-wt-')); const checkout = mkdtempSync(join(tmpdir(), 'planestro-copy-co-'));
    mkdirSync(join(wt, 'tmp/raws'), { recursive: true }); mkdirSync(join(checkout, 'tmp/raws'), { recursive: true });
    writeFileSync(join(wt, 'tmp/raws/new.png'), 'new'); writeFileSync(join(wt, 'tmp/raws/same.png'), 'same'); writeFileSync(join(wt, 'tmp/raws/diff.png'), 'mine');
    writeFileSync(join(checkout, 'tmp/raws/same.png'), 'same'); writeFileSync(join(checkout, 'tmp/raws/diff.png'), 'theirs');
    const out = await new LiveGitPort().copyInto(wt, ['tmp/raws/new.png', 'tmp/raws/same.png', 'tmp/raws/diff.png'], checkout);
    expect(out).toEqual({ copied: ['tmp/raws/new.png'], identical: ['tmp/raws/same.png'], collided: ['tmp/raws/diff.png'] });
    expect(readFileSync(join(checkout, 'tmp/raws/new.png'), 'utf8')).toBe('new');
    expect(readFileSync(join(checkout, 'tmp/raws/diff.png'), 'utf8')).toBe('theirs');
    expect(existsSync(join(wt, 'tmp/raws/new.png'))).toBe(true);
  });
});
