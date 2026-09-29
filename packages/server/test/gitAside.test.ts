import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
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

  it('a rebase or merge that conflicts only in a takeBase file takes the base copy; any other conflict aborts as before (#63)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'planestro-gen-'));
    git(repo, 'init', '-q', '-b', 'trunk'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');   // the port commits with the repo's identity (CI has none)
    const write = (f: string, s: string) => { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), s); };
    const commit = (m: string) => { git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', m); };
    write('i18n/messages.pot', 'base\n'); write('src/a.ts', 'a\n'); commit('base');
    git(repo, 'checkout', '-q', '-b', 'work');
    write('i18n/messages.pot', 'work\n'); commit('pot only');                  // a commit that only regenerated the pot
    write('i18n/messages.pot', 'work2\n'); write('src/b.ts', 'b\n'); commit('feature');
    git(repo, 'checkout', '-q', 'trunk'); write('i18n/messages.pot', 'trunk\n'); commit('trunk pot');
    git(repo, 'checkout', '-q', 'work');
    const port = new LiveGitPort();
    const before = await port.revParse(repo, 'HEAD');
    const refused = await port.rebase(repo, 'trunk');                                // no patterns: as before
    expect(refused).toMatchObject({ ok: false, conflicts: ['i18n/messages.pot'], head: before });
    const r = await port.rebase(repo, 'trunk', ['messages.pot']);
    expect(r).toMatchObject({ ok: true, conflicts: [], tookBase: ['i18n/messages.pot'] });
    expect(readFileSync(join(repo, 'i18n/messages.pot'), 'utf8')).toBe('trunk\n');
    expect(readFileSync(join(repo, 'src/b.ts'), 'utf8')).toBe('b\n');
    expect(git(repo, 'log', '--format=%s', 'trunk..HEAD').trim()).toBe('feature');   // the pot-only commit became empty and was skipped
    await port.resetHard(repo, before);
    expect(readFileSync(join(repo, 'i18n/messages.pot'), 'utf8')).toBe('work2\n');
    // a merge (integration branches) takes the base side too, and commits the merge
    const m = await port.merge(repo, 'trunk', ['messages.pot']);
    expect(m).toMatchObject({ ok: true, tookBase: ['i18n/messages.pot'] });
    expect(readFileSync(join(repo, 'i18n/messages.pot'), 'utf8')).toBe('trunk\n');
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    // another file in the conflict: aborted, untouched
    await port.resetHard(repo, before);
    git(repo, 'checkout', '-q', 'trunk'); write('src/b.ts', 'trunk b\n'); commit('trunk b');
    git(repo, 'checkout', '-q', 'work');
    const mixed = await port.rebase(repo, 'trunk', ['messages.pot']);
    expect(mixed.ok).toBe(false);
    expect(mixed.conflicts).toContain('i18n/messages.pot');
    expect(await port.revParse(repo, 'HEAD')).toBe(before);
    expect(await port.inProgressOp(repo)).toBeNull();
  });

  it('commitPaths commits only the named paths', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'planestro-cp-'));
    git(repo, 'init', '-q', '-b', 'trunk'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.pot'), '1'); writeFileSync(join(repo, 'b.ts'), '1');
    git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
    writeFileSync(join(repo, 'a.pot'), '2'); writeFileSync(join(repo, 'b.ts'), '2');
    const port = new LiveGitPort();
    await port.commitPaths(repo, ['a.pot'], 'TP-1: regenerate a.pot');
    expect((await port.dirtyDetail(repo)).tracked).toEqual(['b.ts']);
  });

  it('commitPaths takes a file git has never seen, a deletion and a path with a space, and leaves what was staged but not named (#64)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'planestro-cp-'));
    git(repo, 'init', '-q', '-b', 'trunk'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'old.ts'), '1'); writeFileSync(join(repo, 'kept.ts'), '1');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
    mkdirSync(join(repo, 'art'), { recursive: true });
    writeFileSync(join(repo, 'art', 'the door.png'), 'png'); writeFileSync(join(repo, 'stray.log'), 'x');
    rmSync(join(repo, 'old.ts'));
    writeFileSync(join(repo, 'kept.ts'), '2'); git(repo, 'add', 'kept.ts');       // staged by a session that never committed
    const port = new LiveGitPort();
    const before = (await port.dirtyDetail(repo));
    expect(before.untracked.sort()).toEqual(['art/the door.png', 'stray.log']);
    const head = await port.commitPaths(repo, ['art/the door.png', 'old.ts'], 'TP-1: the door\n\nCommitted by planestro.');
    expect(git(repo, 'show', '--name-status', '--format=%s', head).trim().split('\n').filter(Boolean)).toEqual(['TP-1: the door', 'A\tart/the door.png', 'D\told.ts']);
    const after = await port.dirtyDetail(repo);
    expect(after.tracked).toEqual(['kept.ts']);
    expect(after.untracked).toEqual(['stray.log']);
  });
});
