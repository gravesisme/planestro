import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync, rmSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveGitPort } from '../src/engine/live-ports.ts';
import { venvRoots } from '../src/engine/treeCopy.ts';
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
    // the link is listed as a link (#581); nothing behind it is
    expect((await port.filesUnder(repo, ['tmp', './assets/'])).sort()).toEqual(['assets/a.png', 'tmp/escape', 'tmp/note.txt', 'tmp/src/raw.png']);
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
  it('a merge or rebase git refuses over local changes is a refusal naming the paths, never a conflict in "Aborting" (#212)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'planestro-refuse-'));
    git(repo, 'init', '-q', '-b', 'trunk'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    const write = (f: string, s: string) => { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), s); };
    const commit = (m: string) => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', m); };
    write('src/a.ts', 'a\n'); commit('base');
    git(repo, 'checkout', '-q', '-b', 'work'); write('src/w.ts', 'w\n'); commit('work');
    git(repo, 'checkout', '-q', 'trunk'); write('src/a.ts', 'trunk a\n'); write('art/new.png.import', 'trunk\n'); commit('trunk');
    git(repo, 'checkout', '-q', 'work');
    const port = new LiveGitPort();
    const before = await port.revParse(repo, 'HEAD');
    // a tracked local change the merge would overwrite
    write('src/a.ts', 'local edit\n');
    const tracked = await port.merge(repo, 'trunk');
    expect(tracked).toMatchObject({ ok: false, conflicts: [], head: before, refused: { paths: ['src/a.ts'] } });
    expect(tracked.refused!.message).toMatch(/would be overwritten by merge/);
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toBe('local edit\n');                // nothing touched
    git(repo, 'checkout', '-q', '--', 'src/a.ts');
    // an untracked file the merge would bring in
    write('art/new.png.import', 'regenerated\n');
    const untracked = await port.merge(repo, 'trunk');
    expect(untracked).toMatchObject({ ok: false, conflicts: [], head: before, refused: { paths: ['art/new.png.import'] } });
    expect(untracked.refused!.message).toMatch(/untracked working tree files would be overwritten/);
    const rebased = await port.rebase(repo, 'trunk');
    expect(rebased).toMatchObject({ ok: false, conflicts: [], head: before, refused: { paths: ['art/new.png.import'] } });
    expect(await port.inProgressOp(repo)).toBeNull();
    for (const r of [tracked, untracked, rebased]) expect(r.conflicts).not.toContain('Aborting');
    // a refusal git names no file for: its words, never its last line as a path
    rmSync(join(repo, 'art/new.png.import'));
    write('src/a.ts', 'unstaged\n');
    const unstaged = await port.rebase(repo, 'trunk');
    expect(unstaged).toMatchObject({ ok: false, conflicts: [], head: before, refused: { paths: [] } });
    expect(unstaged.refused!.message).toMatch(/unstaged changes/);
  });
});

describe('a worktree folder git no longer lists (#356)', () => {
  it('setAsideLeftover moves the files left in it, removes the empty folders, and keeps a folder that holds a .git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planestro-leftover-'));
    const left = join(root, 'wt'); const dest = join(root, 'aside');
    mkdirSync(join(left, 'tmp/empty'), { recursive: true }); writeFileSync(join(left, 'CLAUDE.md'), 'rules\n');
    const port = new LiveGitPort();
    expect(await port.setAsideLeftover(left, dest)).toEqual(['CLAUDE.md']);
    expect(existsSync(left)).toBe(false);
    expect(readFileSync(join(dest, 'CLAUDE.md'), 'utf8')).toBe('rules\n');
    expect(await port.setAsideLeftover(left, dest)).toBeUndefined();
    mkdirSync(left); writeFileSync(join(left, '.git'), 'gitdir: elsewhere\n'); writeFileSync(join(left, 'a.txt'), 'a');
    await expect(port.setAsideLeftover(left, dest)).rejects.toThrow(/holds a \.git; kept it/);
    expect(existsSync(join(left, 'a.txt'))).toBe(true);
  });
});

describe('symbolic links in what is copied or set aside (#581)', () => {
  /** A worktree whose tmp/ holds a venv-like folder and one of each kind of link. */
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), 'planestro-links-'));
    const wt = join(root, 'wt'); const outside = join(root, 'outside');
    mkdirSync(join(wt, 'tmp/venv/bin'), { recursive: true }); mkdirSync(join(wt, 'tmp/venv/lib/python3.12/site-packages'), { recursive: true }); mkdirSync(join(wt, 'tmp/real'), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(outside, 'python3.12'), 'interpreter'); writeFileSync(join(outside, 'secret.txt'), 'outside');
    writeFileSync(join(wt, 'tmp/venv/lib/python3.12/site-packages/pkg.py'), 'pkg'); writeFileSync(join(wt, 'tmp/real/in.txt'), 'in'); writeFileSync(join(wt, 'tmp/plain.txt'), 'plain');
    symlinkSync(join(outside, 'python3.12'), join(wt, 'tmp/venv/bin/python3.12'));   // out of the tree, absolute
    symlinkSync('python3.12', join(wt, 'tmp/venv/bin/python'));                      // to a file (itself a link)
    symlinkSync('real', join(wt, 'tmp/dirlink'));                                    // to a folder
    symlinkSync('nowhere/at/all', join(wt, 'tmp/dangling'));                         // dangling
    symlinkSync('../../outside', join(wt, 'tmp/updir'));                             // out of the tree, relative, a folder
    return { root, wt, outside };
  };
  const LINKS: Record<string, string> = { 'tmp/venv/bin/python': 'python3.12', 'tmp/dirlink': 'real', 'tmp/dangling': 'nowhere/at/all', 'tmp/updir': '../../outside' };
  const FILES = ['tmp/plain.txt', 'tmp/real/in.txt', 'tmp/venv/lib/python3.12/site-packages/pkg.py'];
  const expectLinks = (base: string, t: { outside: string }) => {
    for (const [p, target] of Object.entries({ ...LINKS, 'tmp/venv/bin/python3.12': join(t.outside, 'python3.12') })) {
      expect(lstatSync(join(base, p)).isSymbolicLink(), p).toBe(true);
      expect(readlinkSync(join(base, p)), p).toBe(target);
    }
  };

  it('filesUnder lists each link once, as a link, and nothing behind one', async () => {
    const t = tree();
    expect((await new LiveGitPort().filesUnder(t.wt, ['tmp'])).sort()).toEqual([...Object.keys(LINKS), 'tmp/venv/bin/python3.12', ...FILES].sort());
  });

  it('copyInto recreates every link with its target text: none followed, dropped or turned into a copy of its target', async () => {
    const t = tree(); const checkout = join(t.root, 'checkout'); mkdirSync(checkout);
    const port = new LiveGitPort();
    const files = await port.filesUnder(t.wt, ['tmp']);
    const out = await port.copyInto(t.wt, files, checkout);
    expect(out.copied.sort()).toEqual([...files].sort());
    expect(out.collided).toEqual([]);
    expectLinks(checkout, t); expectLinks(t.wt, t);                              // and the source keeps its own
    for (const f of FILES) expect(readFileSync(join(checkout, f), 'utf8')).toBe(readFileSync(join(t.wt, f), 'utf8'));
    expect(readdirSync(t.outside).sort()).toEqual(['python3.12', 'secret.txt']); // nothing written through a link
    expect(existsSync(join(checkout, 'tmp/real/secret.txt'))).toBe(false);
    // a second run finds every link and file already there
    const again = await port.copyInto(t.wt, files, checkout);
    expect(again.copied).toEqual([]); expect(again.collided).toEqual([]); expect(again.identical.sort()).toEqual([...files].sort());
  });

  it('copyInto never writes through a link of the destination: a folder that is one, a link where a file goes, a link to elsewhere', async () => {
    const t = tree(); const checkout = join(t.root, 'checkout'); const elsewhere = join(t.root, 'elsewhere');
    mkdirSync(join(checkout, 'tmp'), { recursive: true }); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(checkout, 'tmp/real'));                              // the folder tmp/real/in.txt would go into
    symlinkSync(join(elsewhere, 'made-by-copy.txt'), join(checkout, 'tmp/plain.txt')); // a dangling link where a file goes
    symlinkSync('other-target', join(checkout, 'tmp/dangling'));                     // a link with another target
    const out = await new LiveGitPort().copyInto(t.wt, ['tmp/real/in.txt', 'tmp/plain.txt', 'tmp/dangling', 'tmp/dirlink'], checkout);
    expect(out).toEqual({ copied: ['tmp/dirlink'], identical: [], collided: ['tmp/real/in.txt', 'tmp/plain.txt', 'tmp/dangling'] });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readlinkSync(join(checkout, 'tmp/dangling'))).toBe('other-target');
    expect(existsSync(join(t.wt, 'tmp/plain.txt'))).toBe(true);
    await expect(new LiveGitPort().copyInto(t.wt, ['tmp/plain.txt'], join(checkout, 'tmp/real'))).resolves.toMatchObject({ copied: ['tmp/plain.txt'] });   // a root that is a link is the caller's root
    expect(await new LiveGitPort().copyInto(t.wt, ['../outside/secret.txt'], checkout)).toMatchObject({ copied: [], collided: ['../outside/secret.txt'] });
    expect(existsSync(join(t.root, 'outside/secret.txt'))).toBe(true);
  });

  it('moveAside moves links as links, a dangling one too, and never onto a dangling link set aside before', async () => {
    const t = tree(); const dest = join(t.root, 'aside');
    const port = new LiveGitPort();
    const files = await port.filesUnder(t.wt, ['tmp']);
    await port.moveAside(t.wt, files, dest);
    expectLinks(dest, t);
    for (const f of files) expect(() => lstatSync(join(t.wt, f)), f).toThrow();
    expect(readFileSync(join(t.outside, 'python3.12'), 'utf8')).toBe('interpreter');   // the targets are untouched
    symlinkSync('second', join(t.wt, 'tmp/dangling'));
    await port.moveAside(t.wt, ['tmp/dangling'], dest);
    expect(readlinkSync(join(dest, 'tmp/dangling'))).toBe('nowhere/at/all');
    expect(readlinkSync(join(dest, 'tmp/dangling.2'))).toBe('second');
  });

  it('venvRoots names each folder that holds a pyvenv.cfg, whatever it is called, and only the outermost', () => {
    expect(venvRoots(['tmp/a/.venv/pyvenv.cfg', 'tmp/a/.venv/bin/python', 'tmp/round_two/pyvenv.cfg', 'tmp/round_two/inner/pyvenv.cfg', 'tmp/notes/pyvenv.cfg.txt', 'pyvenv.cfg'])).toEqual(['tmp/a/.venv', 'tmp/round_two']);
  });
});
