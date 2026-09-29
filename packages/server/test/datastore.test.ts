import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { makeFixture, git, sleep } from './helpers.ts';
import { parseItemFile, getSection, getReleaseSection, isoLocal } from '@planestro/shared';
import type { StoredRelease } from '../src/store/DataStore.ts';
import { DataDirInUseError } from '../src/exitCodes.ts';

const getReleaseSectionOf = (r: StoredRelease, title: string) => getReleaseSection(r.file, title);

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

async function settled(s: DataStore) { await s.git.idle(); }

describe('DataStore', () => {
  it('init seeds a valid dir, check loads it, ids allocate from counter and never reuse', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    expect(store.config.project.id_prefix).toBe('TP');
    expect(store.listPrompts().length).toBeGreaterThan(5);
    expect(store.invalid).toEqual([]);
    const a = store.createItem({ title: 'First thing', description: 'do it' });
    const b = store.createItem({ title: 'Second', category: 'Tools' });
    expect(a.id).toBe('TP-1'); expect(b.id).toBe('TP-2');
    expect(readFileSync(join(dataDir, 'counter'), 'utf8')).toBe('3\n');
    store.deleteItem('TP-2');
    expect(store.createItem({ title: 'Third' }).id).toBe('TP-3');
    expect(b.file.frontmatter.rank).toBeGreaterThan(a.file.frontmatter.rank!);
    expect(() => store!.createItem({ title: 'x', category: 'Nope' })).toThrow(/unknown category/);
  });

  it('mutations re-read the file, write atomically, journal, and commit only when semantic', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const a = store.createItem({ title: 'Thing' });
    await settled(store);
    const before = git(dataDir, 'log', '--oneline').split('\n').filter(Boolean).length;
    // external-ish edit on disk between reads: the mutation must see it
    writeFileSync(a.path, readFileSync(a.path, 'utf8').replace('# Notes\n', '# Notes\n\nhand note\n'));
    store.editItem('TP-1', [{ section: 'Description', body: 'edited' }]);
    const reread = parseItemFile(readFileSync(a.path, 'utf8'));
    expect(getSection(reread, 'Notes')).toBe('hand note');
    expect(getSection(reread, 'Description')).toBe('edited');
    await settled(store);
    expect(git(dataDir, 'log', '--oneline').split('\n').filter(Boolean).length).toBe(before); // edit is debounced, not committed yet
    store.transition('TP-1', 'QUEUED', 'user');
    await settled(store);
    const log = git(dataDir, 'log', '--format=%s');
    expect(log.split('\n')[0]).toBe('TP-1: queued');
    expect(store.getItem('TP-1')!.file.frontmatter.queued_at).toBeDefined();
    const journal = store.journal.read({ item: 'TP-1' });
    expect(journal.map((e) => e.type)).toEqual(['item.created', 'item.updated', 'item.updated']);
    expect(journal[2].data).toMatchObject({ from: 'NOT_YET_SUBMITTED', to: 'QUEUED' });
    expect(getSection(store.getItem('TP-1')!.file, 'Activity')).toMatch(/\[user\] status NOT_YET_SUBMITTED → QUEUED$/);
  });

  it('illegal transitions throw and write nothing', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const a = store.createItem({ title: 'Thing' });
    const text = readFileSync(a.path, 'utf8');
    expect(() => store!.transition('TP-1', 'IN_PROGRESS', 'user')).toThrow(/may not/);
    expect(readFileSync(a.path, 'utf8')).toBe(text);
  });

  it('moves: top/bottom/before/after touch only the mover; icebox/backlog are transitions; renormalizes when tight', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const ids = ['A', 'B', 'C', 'D'].map((t) => store!.createItem({ title: t }).id);
    const order = () => store!.laneItems('board').map((s) => s.file.frontmatter.title).join('');
    expect(order()).toBe('ABCD');
    store.move(ids[3], 'top'); expect(order()).toBe('DABC');
    store.move(ids[0], 'bottom'); expect(order()).toBe('DBCA');
    store.move(ids[1], 'before', ids[0]); expect(order()).toBe('DCBA');
    store.move(ids[3], 'after', ids[0]); expect(order()).toBe('CBAD');
    const updatedBefore = store.getItem(ids[0])!.file.frontmatter.updated_at;
    await sleep(1100);
    store.move(ids[1], 'top');
    expect(store.getItem(ids[0])!.file.frontmatter.updated_at).toBe(updatedBefore); // untouched
    store.move(ids[2], 'icebox');
    expect(store.getItem(ids[2])!.file.frontmatter.status).toBe('ICEBOX');
    expect(store.laneItems('icebox').map((s) => s.id)).toEqual([ids[2]]);
    store.move(ids[2], 'backlog');
    expect(store.getItem(ids[2])!.file.frontmatter.status).toBe('NOT_YET_SUBMITTED');
    // force a tight gap then insert between
    store.mutateItem(ids[0], [{ rank: 10 }], 'user'); store.mutateItem(ids[1], [{ rank: 11 }], 'user');
    store.mutateItem(ids[2], [{ rank: 12 }], 'user'); store.mutateItem(ids[3], [{ rank: 13 }], 'user');
    store.move(ids[3], 'before', ids[1]);
    const ranks = store.laneItems('board').map((s) => s.file.frontmatter.rank);
    expect(ranks).toEqual([1000, 2000, 3000, 4000]);
    expect(store.laneItems('board').map((s) => s.id)).toEqual([ids[0], ids[3], ids[1], ids[2]]);
  });

  it('search, derived values, epics and children, categories', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const epic = store.createItem({ title: 'World 2', kind: 'epic' });
    const child = store.createItem({ title: 'Shadow gate', parent: epic.id, description: 'a level with sirens' });
    expect(() => store!.createItem({ title: 'x', parent: child.id })).toThrow(/not an epic/);
    expect(store.search('sirens').map((s) => s.id)).toEqual([child.id]);
    expect(store.search('gate', { category: 'Tools' })).toEqual([]);
    const d = store.derived(child);
    expect(d.base_branch).toBeUndefined();
    expect(d.base_branch_error).toMatch(/integration branch/);
    store.mutateItem(epic.id, [{ set: { branch: 'feature/world-2' } }], 'engine');
    expect(store.derived(store.getItem(child.id)!).base_branch).toBe('feature/world-2');
    expect(store.derived(store.getItem(epic.id)!).children).toEqual([child.id]);
    expect(store.derived(store.getItem(epic.id)!).flavor).toBe('epic');
    expect(() => store!.deleteItem(epic.id)).toThrow(/children/);
    expect(store.renameCategory('Tools', 'Tooling')).toBe(0);
    expect(store.config.categories).toContain('Tooling');
    store.mutateItem(child.id, [{ set: { category: 'Tooling' } }], 'user');
    expect(store.removeCategory('Tooling', 'Game')).toBe(1);
    expect(store.getItem(child.id)!.file.frontmatter.category).toBe('Game');
    expect(store.config.categories).not.toContain('Tooling');
  });

  it('prompts can be created and favorited; the favorite key is true or absent, and a title with a colon survives', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const made = store.createPrompt({ name: 'weekly-audit', title: 'Audit: the last week', kind: 'template', description: 'What landed', body: 'Review since {{since}}.' });
    expect(made.file.frontmatter).toMatchObject({ name: 'weekly-audit', kind: 'template', title: 'Audit: the last week', description: 'What landed' });
    expect(() => store!.createPrompt({ name: 'weekly-audit', title: 'again', kind: 'template', body: 'x' })).toThrow(/already exists/);
    const raw = () => readFileSync(join(dataDir, 'prompts', 'weekly-audit.md'), 'utf8');
    expect(raw()).not.toContain('favorite');
    expect(store.setPromptFavorite('weekly-audit', true).file.frontmatter.favorite).toBe(true);
    expect(raw()).toContain('favorite: true');
    expect(store.setPromptFavorite('weekly-audit', false).file.frontmatter.favorite).toBeUndefined();
    expect(raw()).not.toContain('favorite');
    expect(raw()).toContain('Review since {{since}}.');
    expect(() => store!.setPromptFavorite('nope', true)).toThrow(/unknown prompt/);
  });

  it('prompt rendering uses the item context and fails on gaps', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const a = store.createItem({ title: 'Add flag', description: 'add --version' });
    expect(() => store!.renderPrompt('plan-item', a)).toThrow(/unresolved placeholders.*worktree/);
    store.mutateItem(a.id, [{ set: { branch: 'tp/1-add-flag', worktree: '.claude/worktrees/tp-1-add-flag' } }], 'engine');
    const text = store.renderPrompt('plan-item', store.getItem(a.id));
    expect(text).toContain('TP-1');
    expect(text).toContain('add --version');
    expect(text).toContain('`trunk`');
    expect(text).toContain('/repo/.claude/worktrees/tp-1-add-flag');
  });

  it('releases: store copy carries forward, shipping records the day, renames and item changes commit at once', async () => {
    const { dataDir } = makeFixture();
    writeFileSync(join(dataDir, 'planestro.yml'), readFileSync(join(dataDir, 'planestro.yml'), 'utf8').replace(/^releases:\n(?:  .*\n)+/m, '') + 'releases:\n  sections:\n    - { title: Release notes }\n    - { title: Subtitle, max_chars: 30, carry: true }\n');
    git(dataDir, 'commit', '-qam', 'config');
    store = await DataStore.open(dataDir);
    expect(existsSync(join(dataDir, 'releases'))).toBe(false); // nothing on disk until the first release
    const done = store.createItem({ title: 'Map' });
    store.mutateItem(done.id, [{ set: { status: 'FINISHED', merged_at: '2026-09-10T10:00:00-04:00' } }], 'user');
    store.createRelease({ version: '1.4.0', date: '2026-09-05', status: 'released' });
    store.editRelease('1.4.0', { sections: { Subtitle: 'Survive the storm.', 'Release notes': '* boss polish' } });
    const next = store.createRelease({ version: '1.5.0' });
    expect(getReleaseSectionOf(next, 'Subtitle')).toBe('Survive the storm.');
    expect(getReleaseSectionOf(next, 'Release notes')).toBe('');
    expect(readFileSync(next.path, 'utf8')).toContain('# Release notes\n\n# Subtitle\n\nSurvive the storm.\n');
    await settled(store);
    expect(git(dataDir, 'log', '-1', '--format=%s%n%b')).toMatch(/^releases: add 1\.5\.0\nStore copy carried from 1\.4\.0\./);

    store.editRelease('1.5.0', { fields: { date: '2999-01-01' } });
    const shipped = store.editRelease('1.5.0', { fields: { status: 'released', items: [done.id] } });
    expect(shipped.file.frontmatter.date).toBe(isoLocal().slice(0, 10)); // the target was still ahead: it shipped today
    await settled(store);
    expect(git(dataDir, 'log', '-1', '--format=%s').trim()).toBe(`releases: 1.5.0 released; add ${done.id}`);
    expect(() => store!.editRelease('1.5.0', { fields: { items: ['TP-999'] } })).toThrow(/unknown item/);

    store.editRelease('1.5.0', { fields: { version: '1.5.1', title: 'Map update' } });
    await settled(store);
    expect(existsSync(join(dataDir, 'releases', '1.5.0.md'))).toBe(false);
    expect(store.listReleases().map((r) => r.version)).toEqual(['1.5.1', '1.4.0']);
    expect(git(dataDir, 'status', '--porcelain', 'releases/1.5.0.md', 'releases/1.5.1.md')).toBe(''); // the rename is one commit
    expect(() => store!.createRelease({ version: '1.4.0' })).toThrow(/already exists/);
    expect(() => store!.createRelease({ version: '../x' })).toThrow(/version/);
    store.deleteRelease('1.4.0');
    store.close(); store = await DataStore.open(dataDir);
    expect(store.invalid).toEqual([]);
    expect(store.getRelease('1.5.1')!.file.frontmatter).toMatchObject({ title: 'Map update', status: 'released', items: [done.id] });
  });

  it('startup commits hand edits and flags invalid files without touching them', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const a = store.createItem({ title: 'Thing' });
    await settled(store);
    store.close(); store = undefined;
    writeFileSync(a.path, readFileSync(a.path, 'utf8').replace('title: Thing', 'title: Thing (hand edited)'));
    const s2 = await DataStore.open(dataDir);
    await settled(s2);
    expect(git(dataDir, 'log', '--format=%s').split('\n')[0]).toMatch(/^manual: 1 file/);
    expect(s2.getItem('TP-1')!.file.frontmatter.title).toBe('Thing (hand edited)');
    s2.close();
    writeFileSync(join(dataDir, 'items', 'TP-9.md'), '---\nid: TP-9\n---\n# Description\n');
    const s3 = await DataStore.open(dataDir);
    expect(s3.invalid).toHaveLength(1);
    expect(s3.invalid[0].error).toMatch(/invalid frontmatter/);
    expect(readFileSync(join(dataDir, 'items', 'TP-9.md'), 'utf8')).toContain('id: TP-9');
    s3.close();
  });

  it('lock refuses a foreign live pid and ignores a stale one', async () => {
    const { dataDir } = makeFixture();
    const lock = join(dataDir, '.planestro', 'lock');
    mkdirSync(join(dataDir, '.planestro'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.ppid })); // our parent is alive and is not us
    await expect(DataStore.open(dataDir)).rejects.toThrow(/in use/);
    await expect(DataStore.open(dataDir)).rejects.toBeInstanceOf(DataDirInUseError); // its own exit code under serve --watch (#85)
    writeFileSync(lock, JSON.stringify({ pid: 2147483000 })); // nobody
    store = await DataStore.open(dataDir);
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    store.close();
    expect(existsSync(lock)).toBe(false);
    store = undefined;
  });

  it('managed attachments are size-capped; references are pointers', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const a = store.createItem({ title: 'Shot' });
    const m = store.addManagedAttachment(a.id, 'my shot.png', Buffer.from('png'));
    expect(existsSync(join(dataDir, m.path))).toBe(true);
    expect(m.path).toMatch(/^attachments\/TP-1\/\d{8}-\d{6}-my-shot\.png$/);
    expect(() => store!.addManagedAttachment(a.id, 'big.mov', Buffer.alloc(store!.config.attachments.managed_max_bytes + 1))).toThrow(/managed_max_bytes/);
    const r = store.addReferenceAttachment(a.id, '/tmp/big.mov');
    expect(store.getItem(a.id)!.file.frontmatter.attachments.map((x) => x.kind)).toEqual(['managed', 'reference']);
    expect(store.attachmentAbsPath(r)).toBe('/tmp/big.mov');
    store.removeAttachment(a.id, m.path);
    expect(existsSync(join(dataDir, m.path))).toBe(false);
  });
});

describe('defaults.auto_approve_plan (plan review by the orchestrator on by default)', () => {
  it('ticks new items implemented on Claude; never art on another runner, an epic, or an explicit untick', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    expect(store.createItem({ title: 'Off by default' }).file.frontmatter.auto_approve_plan).toBeUndefined();
    store.updateConfig((doc) => {
      doc.setIn(['defaults', 'auto_approve_plan'], true);
      doc.set('models', [...(doc.toJS().models as unknown[]), { id: 'codex-art', label: 'Codex Art', runner: 'codex' }]);
    }, 'config: plan review default');
    expect(store.createItem({ title: 'Wiring' }).file.frontmatter.auto_approve_plan).toBe(true);
    expect(store.createItem({ title: 'Frog sheet', implementer: 'codex-art' }).file.frontmatter.auto_approve_plan).toBeUndefined();
    expect(store.createItem({ title: 'Big', kind: 'epic' } as any).file.frontmatter.auto_approve_plan).toBeUndefined();
    expect(store.createItem({ title: 'Mine', extra: { auto_approve_plan: false } } as any).file.frontmatter.auto_approve_plan).toBe(false);
  });
});

describe('a base that was a merged epic\'s branch (p45)', () => {
  it('follows to that epic\'s own base, as far as it goes', async () => {
    const { dataDir } = makeFixture();
    const store = await DataStore.open(dataDir);
    try {
      const outer = store.createItem({ title: 'Crystal Cavern', description: 'x', kind: 'epic' });
      store.mutateItem(outer.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/crystal-cavern' } }], 'engine');
      const inner = store.createItem({ title: 'Animate the enemies', description: 'x', kind: 'epic' });
      store.mutateItem(inner.id, [{ set: { base_branch_override: 'feature/crystal-cavern', branch: 'feature/animate' } }], 'user');
      const child = store.createItem({ title: 'Walk cycle', description: 'x', parent: inner.id });
      const base = (id: string) => store.derived(store.getItem(id)!).base_branch;
      expect(base(inner.id)).toBe('feature/crystal-cavern');            // the outer epic is still open: its branch is the base
      store.mutateItem(outer.id, [{ set: { status: 'MERGED' } }], 'engine');
      expect(base(inner.id)).toBe('trunk');                             // merged and deleted: its own base
      expect(base(child.id)).toBe('feature/animate');                   // the inner epic is open: unchanged
      store.mutateItem(inner.id, [{ set: { status: 'FINISHED' } }], 'engine');
      expect(base(child.id)).toBe('trunk');                             // followed through both
    } finally { store.close(); }
  });
});


describe('activity lines (p49)', () => {
  it('an app line identical to one of the last two entries is not appended again; people and the orchestrator always are', async () => {
    const { dataDir } = makeFixture();
    const store = await DataStore.open(dataDir);
    try {
      const { id } = store.createItem({ title: 'Polled', description: 'x' });
      const waiting = 'already on trunk@abc1234; no sync needed, reusing CI for def5678; waiting for CI outside the merge queue';
      const same = 'same red run 42 re-observed for def5678; not counted again (waiting for a re-run or a new push)';
      for (let i = 0; i < 5; i++) { store.mutateItem(id, [{ activity: { actor: 'app', text: waiting } }], 'engine'); store.mutateItem(id, [{ activity: { actor: 'app', text: same } }], 'engine'); }
      const lines = () => getSection(store.getItem(id)!.file, 'Activity').split('\n');
      expect(lines().filter((l) => l.endsWith(waiting))).toHaveLength(1);
      expect(lines().filter((l) => l.endsWith(same))).toHaveLength(1);
      for (let i = 0; i < 2; i++) store.mutateItem(id, [{ activity: { actor: 'user', text: 'unblocked' } }], 'user');
      expect(lines().filter((l) => l.endsWith('[user] unblocked'))).toHaveLength(2);
      // Out of the window, the same line is news again.
      store.mutateItem(id, [{ activity: { actor: 'app', text: waiting } }], 'engine');
      expect(lines().filter((l) => l.endsWith(waiting))).toHaveLength(2);
    } finally { store.close(); }
  });
});
