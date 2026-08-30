import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { makeFixture, git, sleep } from './helpers.ts';
import { parseItemFile, getSection } from '@planestro/shared';

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
