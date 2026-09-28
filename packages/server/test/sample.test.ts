import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { makePorts } from '../src/engine/makePorts.ts';
import { seedSample } from '../src/sample.ts';
import { releaseCandidates } from '@planestro/shared';
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
      expect(by('FINISHED').length).toBe(4);
      const reviewed = by('FINISHED').find((i) => i.file.frontmatter.implementer === 'codex-art')!;
      expect(reviewed.file.frontmatter.delivered).toEqual([expect.objectContaining({ path: 'assets/icon.png', change: 'added' })]);
      expect(reviewed.file.sections.find((x) => x.title === 'Activity')!.body).toContain('review: changes requested');
      expect(store.config.models.find((m) => m.id === 'codex-art')).toMatchObject({ runner: 'codex', hold_for_review: true });
      expect(store.listPrompts().filter((p) => p.file.frontmatter.favorite).map((p) => p.name).sort()).toEqual(['art-item', 'art-repaint', 'audit-recent-code', 'bug-fixes', 'feature']);
      expect(by('ICEBOX').length).toBe(2);
      expect(store.listReleases().map((r) => [r.version, r.file.frontmatter.status])).toEqual([['0.4.0', 'planned'], ['0.3.0', 'released']]);
      expect(store.listQuestions().map((q) => [q.id, q.file.frontmatter.status])).toEqual([['Q-2', 'resolved'], ['Q-1', 'open']]);
      const next = store.getRelease('0.4.0')!;
      expect(next.file.sections.find((x) => x.title === 'Tagline')!.body).toBe('Tide times for the beach you are standing on.'); // carried from 0.3.0
      expect(releaseCandidates('0.4.0', store.listReleases().map((r) => r.file), store.listItems().map((i) => ({ id: i.id, fm: i.file.frontmatter }))).length).toBe(2);
      const epic = store.listItems().find((i) => i.file.frontmatter.kind === 'epic' && i.file.frontmatter.title === 'Offline mode')!;
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

      // the headline: the mixed epic, planned by the planner, art on the Codex runner, code only after it
      const chart = store.listItems().find((i) => i.file.frontmatter.title === 'Tide chart view')!;
      const fmOf = (id: string) => store.getItem(id)!.file.frontmatter;
      const wait = async (what: string, pred: () => boolean) => { for (let i = 0; i < 600 && !pred(); i++) await sleep(20); if (!pred()) throw new Error(`timed out: ${what} :: ${store.listItems().filter((i) => i.file.frontmatter.parent === chart.id || i.id === chart.id).map((i) => `${i.id} ${i.file.frontmatter.status} ${i.file.frontmatter.awaiting ?? ''} ${i.file.frontmatter.blocked_reason ?? ''}`).join(' | ')}`); };
      await engine.planEpic(chart.id);
      await wait('breakdown proposed', () => fmOf(chart.id).awaiting === 'breakdown_approval');
      const kids = await engine.approveBreakdown(chart.id);
      const art = kids.filter((id) => fmOf(id).implementer === 'codex-art'); const code = kids.filter((id) => fmOf(id).implementer !== 'codex-art');
      expect(art.length).toBe(2); expect(code.length).toBe(2);
      for (const id of art) { await wait(`${id} planned`, () => fmOf(id).status === 'PLAN_READY'); await engine.approvePlan(id); }
      await wait('art parked for review', () => art.every((id) => fmOf(id).awaiting === 'review'));
      expect(code.every((id) => fmOf(id).status === 'QUEUED')).toBe(true);          // nothing that waits on art has started
      expect((await engine.reviewImages(art[0]))[0]).toMatchObject({ change: 'added', width: 96 });
      for (const id of art) await engine.releaseHold(id);
      for (const id of code) { await wait(`${id} planned`, () => fmOf(id).status === 'PLAN_READY'); expect(art.every((a) => ['MERGED', 'FINISHED'].includes(fmOf(a).status))).toBe(true); await engine.approvePlan(id); }
      await wait('the epic landed', () => fmOf(chart.id).status === 'FINISHED');
      expect(art.every((id) => fmOf(id).agent_sessions?.codex && fmOf(id).agent_turns === 1)).toBe(true);
      expect(code.every((id) => !fmOf(id).agent_sessions)).toBe(true);
      await engine.stop();
    } finally { store.close(); }
  }, 60000);
});
