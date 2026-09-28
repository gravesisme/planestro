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
  it('an older dir migrates forward and stamps the version', async () => {
    const { dataDir } = makeFixture({ git: false });
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(`schema_version: ${SCHEMA_VERSION}`, 'schema_version: 0'));
    const r = await migrate(dataDir);
    expect(r.from).toBe(0);
    expect(r.applied).toEqual([1, 2, 3]);
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
    expect(r.applied).toEqual([2, 3]); // and 3, which finds no questions to import
    const text = readFileSync(cfg, 'utf8');
    expect(text).toContain('max_local_jobs: 4');
    expect(text).not.toContain('godot');
    const store = await DataStore.open(dataDir, { lock: false });
    expect(store.readOnly).toBe(false);
    expect(store.config.concurrency.max_local_jobs).toBe(4);
    store.close();
  });
});
