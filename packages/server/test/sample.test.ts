import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { makePorts } from '../src/engine/makePorts.ts';
import { seedSample } from '../src/sample.ts';
import { sleep } from './helpers.ts';

describe('planestro sample', () => {
  it('seeds a valid, varied backlog without registering itself, and the dry-run engine can finish an item from it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'planestro-home-'));
    process.env.PLANESTRO_HOME = home;
    const out = join(mkdtempSync(join(tmpdir(), 'planestro-sample-')), 'sample');
    const r = await seedSample(out);
    expect(r.items).toBeGreaterThan(8);
    expect((await seedSample(out)).items).toBe(0); // second run leaves it alone

    const store = await DataStore.open(r.dataDir);
    try {
      expect(store.invalid).toEqual([]);
      expect(store.readOnly).toBe(false);
      const by = (s: string) => store.listItems().filter((i) => i.file.frontmatter.status === s);
      expect(by('FINISHED').length).toBe(3);
      expect(by('ICEBOX').length).toBe(2);
      const epic = store.listItems().find((i) => i.file.frontmatter.kind === 'epic')!;
      expect(store.derived(epic).children.length).toBe(2);
      const waiting = store.listItems().find((i) => i.file.frontmatter.depends_on.length)!;
      expect(store.derived(waiting).deps_satisfied).toBe(false);
      expect(store.config.engine.mode).toBe('dry-run');

      const engine = new LiveEngine(store, makePorts('dry-run', () => {}, store), () => {}, { sleep: async () => {}, tickMs: 50 });
      const item = by('NOT_YET_SUBMITTED').find((i) => i.file.frontmatter.kind === 'item' && !i.file.frontmatter.parent)!;
      store.transition(item.id, 'QUEUED', 'user');
      await engine.start();
      const until = async (s: string) => { for (let i = 0; i < 400 && store.getItem(item.id)!.file.frontmatter.status !== s; i++) await sleep(20); expect(store.getItem(item.id)!.file.frontmatter.status).toBe(s); };
      await until('PLAN_READY');
      await engine.approvePlan(item.id);
      await until('FINISHED');
      await engine.stop();
    } finally { store.close(); }
  });
});
