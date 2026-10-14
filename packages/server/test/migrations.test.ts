import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, currentVersion } from '../src/migrations/index.ts';
import { makeFixture } from './helpers.ts';
import { SCHEMA_VERSION } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';

describe('migrations', () => {
  it('a current dir is a no-op; a newer dir is refused and opens read-only', async () => {
    const { dataDir } = makeFixture({ git: false });
    expect(currentVersion(dataDir)).toBe(SCHEMA_VERSION);
    const r = await migrate(dataDir);
    expect(r.applied).toEqual([]);
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(`schema_version: ${SCHEMA_VERSION}`, `schema_version: ${SCHEMA_VERSION + 1}`));
    await expect(migrate(dataDir)).rejects.toThrow(/upgrade the tool/);
    const store = await DataStore.open(dataDir, { lock: false });
    expect(store.readOnly).toBe(true);
    expect(() => store.createItem({ title: 'x' })).toThrow(/read-only/);
    store.close();
  });
  it('schema 4 converts legacy session strings without replacing the item or its art thread', async () => {
    const { dataDir } = makeFixture({ git: false });
    let store = await DataStore.open(dataDir, { lock: false });
    const item = store.createItem({ title: 'Legacy art' });
    store.mutateItem(item.id, [{ set: { session_id: 'old-claude', cost_usd: 4, agent_sessions: { codex: { session_id: 'old-art', role: 'implement', tool_contract: 'exec-v1', transport: 'exec' } } } }, { section: 'Notes', body: 'Keep this context' }], 'user');
    const path = item.path; store.close();
    const yaml = readFileSync(path, 'utf8').replace(/agent_sessions:\n  codex:\n(?:    .*\n)+/, 'agent_sessions:\n  codex: old-art\n');
    writeFileSync(path, yaml);
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(`schema_version: ${SCHEMA_VERSION}`, 'schema_version: 3'));
    expect((await migrate(dataDir)).applied).toEqual([4, 5, 6, 7, 8, 9]);
    store = await DataStore.open(dataDir, { lock: false });
    expect(store.requireItem(item.id).file.frontmatter).toMatchObject({ session_id: 'old-claude', cost_usd: 4, agent_sessions: { codex: { session_id: 'old-art', transport: 'exec', tool_contract: 'exec-v1' } } });
    expect(readFileSync(path, 'utf8')).toContain('Keep this context');
    store.close();
    expect((await migrate(dataDir)).applied).toEqual([]);
  });
  it('schema 9 suggests a distinct color for each category without one and keeps the ones set', async () => {
    const { dataDir } = makeFixture({ git: false });
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(`schema_version: ${SCHEMA_VERSION}`, 'schema_version: 8').replace(/^category_colors:\n(?:  .*\n)+/m, 'category_colors:\n  Game: "#ff0000"\n'));
    expect((await migrate(dataDir)).applied).toEqual([9]);
    const store = await DataStore.open(dataDir, { lock: false });
    const colors = store.config.category_colors;
    expect(colors.Game).toBe('#ff0000');
    expect(Object.keys(colors).sort()).toEqual([...store.config.categories].sort());
    expect(new Set(Object.values(colors)).size).toBe(store.config.categories.length);
    store.close();
  });
  it('an older dir migrates forward and stamps the version', async () => {
    const { dataDir } = makeFixture({ git: false });
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(`schema_version: ${SCHEMA_VERSION}`, 'schema_version: 0'));
    const r = await migrate(dataDir);
    expect(r.from).toBe(0);
    expect(r.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(currentVersion(dataDir)).toBe(SCHEMA_VERSION);
    expect(readFileSync(cfg, 'utf8')).toContain('# planestro project config'); // comments preserved
  });
  it('schema 2 renames the local job limit, keeps its value, and the dir opens writable again', async () => {
    const { dataDir } = makeFixture({ git: false });
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(`schema_version: ${SCHEMA_VERSION}`, 'schema_version: 1').replace('max_local_jobs: 1', 'max_godot_jobs: 4'));
    const before = await DataStore.open(dataDir, { lock: false });
    expect(before.readOnly).toBe(true); // an older dir is never rewritten behind the user's back
    before.close();
    const r = await migrate(dataDir);
    expect(r.applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9]); // and 3, which finds no questions to import
    const text = readFileSync(cfg, 'utf8');
    expect(text).toContain('max_local_jobs: 4');
    expect(text).not.toContain('godot');
    const store = await DataStore.open(dataDir, { lock: false });
    expect(store.readOnly).toBe(false);
    expect(store.config.concurrency.max_local_jobs).toBe(4);
    store.close();
  });
});
