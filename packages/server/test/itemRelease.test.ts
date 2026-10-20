import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { releaseView } from '../src/routes/views.ts';
import { makeFixture, git } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

async function open(releasesDefault?: string): Promise<{ store: DataStore; dataDir: string }> {
  const { dataDir } = makeFixture();
  if (releasesDefault) {
    const yml = readFileSync(join(dataDir, 'planestro.yml'), 'utf8');
    writeFileSync(join(dataDir, 'planestro.yml'), /^releases:\n/m.test(yml) ? yml.replace(/^releases:\n/m, `releases:\n  default: ${releasesDefault}\n`) : `${yml.trimEnd()}\nreleases:\n  default: ${releasesDefault}\n`);
    git(dataDir, 'commit', '-qam', 'config');
  }
  store = await DataStore.open(dataDir);
  return { store, dataDir };
}

describe('items target a release (#375)', () => {
  it('a new item takes releases.default (next: the earliest planned), an epic child takes the epic\'s, and asking wins', async () => {
    const { store } = await open('next');
    expect(store.createItem({ title: 'before any release' }).file.frontmatter.release).toBeUndefined();
    store.createRelease({ version: '2.0.0' });
    store.createRelease({ version: '1.6.0' });
    store.createRelease({ version: '1.5.0', status: 'released', date: '2026-09-01' });
    expect(store.createItem({ title: 'new' }).file.frontmatter.release).toBe('1.6.0');
    expect(store.createItem({ title: 'asked', release: '2.0.0' }).file.frontmatter.release).toBe('2.0.0');
    expect(store.createItem({ title: 'none', release: null }).file.frontmatter.release).toBeUndefined();
    expect(() => store.createItem({ title: 'unknown', release: '9.0.0' })).toThrow(/unknown release 9\.0\.0/);
    const epic = store.createItem({ title: 'epic', kind: 'epic', release: '2.0.0' });
    expect(store.createItem({ title: 'child', parent: epic.id }).file.frontmatter.release).toBe('2.0.0');
  });

  it('with no default, nothing changes: new items target no release', async () => {
    const { store } = await open();
    store.createRelease({ version: '1.0.0' });
    expect(store.createItem({ title: 'x' }).file.frontmatter.release).toBeUndefined();
  });

  it('a release lists what is planned for it, and only items with no release are date hints', async () => {
    const { store } = await open();
    store.createRelease({ version: '1.0.0' });
    store.createRelease({ version: '2.0.0' });
    const a = store.createItem({ title: 'a', release: '1.0.0' });
    const b = store.createItem({ title: 'b', release: '1.0.0' });
    const loose = store.createItem({ title: 'loose' });
    const elsewhere = store.createItem({ title: 'elsewhere', release: '2.0.0' });
    for (const it of [a, loose, elsewhere]) store.mutateItem(it.id, [{ set: { status: 'FINISHED', merged_at: '2026-09-10T10:00:00-04:00' } }], 'user');
    const v = releaseView(store, store.requireRelease('1.0.0'));
    expect(v.planned).toEqual([a.id, b.id]);
    expect(v.landed).toEqual([a.id]);
    expect(v.candidates).toEqual([loose.id]);
    store.editRelease('1.0.0', { fields: { items: [a.id] } });
    expect(releaseView(store, store.requireRelease('1.0.0')).landed).toEqual([]);
  });

  it('a renamed or cancelled release moves or clears its items only when asked, in one commit', async () => {
    const { store, dataDir } = await open();
    store.createRelease({ version: '1.0.0' });
    const a = store.createItem({ title: 'a', release: '1.0.0' });
    const b = store.createItem({ title: 'b', release: '1.0.0' });
    store.editRelease('1.0.0', { fields: { version: '1.1.0' } });
    expect(store.requireItem(a.id).file.frontmatter.release).toBe('1.0.0'); // nothing changes silently
    expect(store.retargetItems('1.0.0', '1.1.0')).toEqual([a.id, b.id]);
    expect(store.requireItem(b.id).file.frontmatter.release).toBe('1.1.0');
    await store.git.idle();
    expect(git(dataDir, 'log', '-1', '--format=%s').trim()).toBe('releases: move 2 items 1.0.0 → 1.1.0');
    expect(store.requireItem(a.id).file.sections.find((s) => s.title === 'Activity')!.body).toContain('release 1.0.0 → 1.1.0');
    expect(() => store.retargetItems('1.1.0', '3.0.0')).toThrow(/unknown release 3\.0\.0/);
    expect(store.retargetItems('1.1.0', null)).toEqual([a.id, b.id]);
    expect(store.requireItem(a.id).file.frontmatter.release).toBeUndefined();
    expect(readFileSync(store.requireItem(a.id).path, 'utf8')).not.toMatch(/^release:/m);
  });
});
