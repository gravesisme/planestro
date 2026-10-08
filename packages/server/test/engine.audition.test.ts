import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { workerTools } from '../src/engine/sessions/workerTools.ts';
import type { Ports, TurnOptions, TurnResult, TurnTools } from '../src/engine/ports.ts';
import { getSection, needsYou } from '@planestro/shared';
import { itemWait } from '../src/engine/needsYou.ts';
import { makeFixture, sleep } from './helpers.ts';

/**
 * #207 (HH-428): a sound worker that made 18 takes in its worktree's gitignored tmp/ had no way to let the designer hear
 * them before it built from one. AskUserQuestion was a blind a/b/c, and afplay played on the Mac, not the designer's
 * phone. `request_audition` parks the item on the takes, the item page plays them, and the picks resume the worker.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup(onTurn?: (o: TurnOptions) => Promise<TurnResult | undefined>) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(world);
  const prompts: string[] = [];
  const wakes: string[] = [];
  const claude: Ports['agents']['claude'] = { async runTurn(o: TurnOptions) { prompts.push(o.prompt); return (await onTurn?.(o)) ?? inner.runTurn(o); }, runCustomTurn: async (o) => { wakes.push(o.label); return inner.runCustomTurn(o); } };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const it = store.createItem({ title: 'Desert SFX', description: 'six sounds for the desert' });
  const rel = '.claude/worktrees/desert'; const cwd = (engine as any).absWorktree(rel) as string;
  world.worktrees.set(cwd, { path: cwd, head: world.sha(), branch: 'tp/desert' });
  // The takes are in a folder git ignores: they are never committed, and the pick is needed before anything is built.
  mkdirSync(join(cwd, 'tmp', 'desert_sfx'), { recursive: true });
  for (const t of ['wind_a', 'wind_b', 'wind_c', 'sand_a', 'sand_b']) writeFileSync(join(cwd, 'tmp', 'desert_sfx', `${t}.mp3`), `ID3 ${t}`);
  writeFileSync(join(cwd, 'secret.txt'), 'not for the phone');
  store.mutateItem(it.id, [{ set: { status: 'IN_PROGRESS', worktree: rel, branch: 'tp/desert', session_id: 's1' } }], 'engine');
  const tools = (engine as any).makeTools(it.id) as TurnTools;
  return { store, engine, world, prompts, wakes, id: it.id, cwd, tools };
}

const AUDITION = {
  title: 'Desert ambience',
  roles: [
    { id: 'wind', name: 'Wind loop', where: 'desert overworld', prompt: 'dry wind over dunes', takes: ['tmp/desert_sfx/wind_a.mp3', 'tmp/desert_sfx/wind_b.mp3', 'tmp/desert_sfx/wind_c.mp3'] },
    { id: 'sand', name: 'Sand step', takes: ['tmp/desert_sfx/sand_a.mp3', 'tmp/desert_sfx/sand_b.mp3'] },
  ],
  allow_regenerate: true,
};

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(20); }
}

describe('mid-build auditions (#207)', () => {
  it('request_audition parks the item on the takes for the user, never the orchestrator', async () => {
    const { store, engine, id, tools, wakes } = await setup();
    const said = await tools.request_audition(AUDITION);
    expect(said).toMatch(/^Audition recorded by planestro/);
    const fm = store.requireItem(id).file.frontmatter;
    expect(fm.awaiting).toBe('audition');
    expect((fm.awaiting_data as any).audition.roles.map((r: any) => r.id)).toEqual(['wind', 'sand']);
    expect(fm.triage).toBeUndefined();
    expect(needsYou(fm)).toBe(true);
    expect(itemWait(fm)?.path).toBe(`/items/${id}#audition`);
    expect(getSection(store.requireItem(id).file, 'Activity')).toContain('parked: audition "Desert ambience" (2 roles, 5 takes)');
    // Listening and choosing is the designer's: the orchestrator cannot answer it.
    await expect(engine.respond(id, { kind: 'audition', picks: { wind: { take: 'tmp/desert_sfx/wind_a.mp3' }, sand: { take: 'tmp/desert_sfx/sand_b.mp3' } } }, 'orchestrator')).rejects.toThrow(/only the user/);
    await sleep(150);
    expect(wakes).toEqual([]);
  });

  it('serves the listed takes, including ignored files, and nothing else', async () => {
    const { engine, id, tools, cwd } = await setup();
    expect(await engine.auditionFile(id, 'tmp/desert_sfx/wind_a.mp3')).toBeNull();   // nothing is served before an audition
    await tools.request_audition(AUDITION);
    expect((await engine.auditionFile(id, 'tmp/desert_sfx/wind_b.mp3'))?.toString()).toBe('ID3 wind_b');
    expect(await engine.auditionFile(id, 'secret.txt')).toBeNull();
    expect(await engine.auditionFile(id, 'tmp/desert_sfx/../../secret.txt')).toBeNull();
    expect(await engine.auditionFile(id, join(cwd, 'secret.txt'))).toBeNull();
  });

  it('refuses an audition whose takes are missing or outside the worktree, and parks nothing', async () => {
    const { store, id, tools, cwd } = await setup();
    writeFileSync(join(cwd, '..', 'outside.mp3'), 'ID3 outside');
    symlinkSync(join(cwd, '..'), join(cwd, 'tmp', 'escape'));
    for (const takes of [['tmp/desert_sfx/nope.mp3'], ['../outside.mp3'], ['/etc/hosts'], ['tmp/escape/outside.mp3'], ['secret.txt']]) {
      const said = await tools.request_audition({ title: 'x', roles: [{ id: 'wind', name: 'Wind', takes }] });
      expect(said).toMatch(/^Rejected:/);
    }
    expect(await tools.request_audition({ title: 'x', roles: [] })).toMatch(/^Rejected:/);
    expect(await tools.request_audition({ title: 'x', roles: [{ id: 'a', name: 'A', takes: ['tmp/desert_sfx/wind_a.mp3'] }, { id: 'a', name: 'B', takes: ['tmp/desert_sfx/wind_b.mp3'] }] })).toMatch(/^Rejected:.*role id/);
    expect(store.requireItem(id).file.frontmatter.awaiting).toBeUndefined();
  });

  it("the user's picks resume the worker, one line per role, and are kept on the item", async () => {
    const { store, engine, id, tools, prompts } = await setup();
    await tools.request_audition(AUDITION);
    await engine.message(id, 'Keep it quieter than the city.');
    expect(store.requireItem(id).file.frontmatter.awaiting).toBe('audition');
    // Every role needs a pick from its own takes, or a regenerate.
    await expect(engine.respond(id, { kind: 'audition', picks: { wind: { take: 'tmp/desert_sfx/wind_a.mp3' } } })).rejects.toThrow(/sand/);
    await expect(engine.respond(id, { kind: 'audition', picks: { wind: { take: 'tmp/desert_sfx/sand_a.mp3' }, sand: { take: 'tmp/desert_sfx/sand_a.mp3' } } })).rejects.toThrow(/wind/);
    await engine.respond(id, { kind: 'audition', picks: { wind: { take: 'tmp/desert_sfx/wind_b.mp3' }, sand: { regenerate: 'softer, less crunch' } } });
    await until(() => prompts.length > 0);
    expect(prompts[0]).toContain('Audition picks from the user (Desert ambience):\n\nwind keep tmp/desert_sfx/wind_b.mp3\nsand regenerate 1 more: softer, less crunch');
    expect(prompts[0]).toContain('- Keep it quieter than the city.');
    const item = store.requireItem(id);
    expect(item.file.frontmatter.awaiting).not.toBe('audition');
    expect(getSection(item.file, 'Activity')).toContain('audition picked: wind keep tmp/desert_sfx/wind_b.mp3; sand regenerate 1 more: softer, less crunch');
    expect(getSection(item.file, 'Notes')).toContain('**Audition: Desert ambience**');
    expect(getSection(item.file, 'Notes')).toContain('- Wind loop (`wind`): `tmp/desert_sfx/wind_b.mp3`');
    // Answered, the takes are no longer served.
    expect(await engine.auditionFile(id, 'tmp/desert_sfx/wind_b.mp3')).toBeNull();
  });

  it('in rounds: the user keeps 2 of 3 and regenerates with a note, the worker re-auditions, one more pick completes it (#318)', async () => {
    const gust = (i: number) => `tmp/desert_sfx/gust_${i}.wav`;
    const round2 = { title: 'Gusts', roles: [{ id: 'gust', name: 'Gust', pick: 3, kept: [gust(0), gust(3)], takes: [gust(10), gust(11), gust(12)] }] };
    let said2 = '';
    const { store, engine, id, tools, prompts, cwd } = await setup(async (o) => {
      if (!o.prompt.includes('regenerate 1 more')) return undefined;
      // The worker makes new takes from the note and puts them up beside the ones already kept.
      said2 = await o.tools.request_audition(round2);
      return { sessionId: 's1', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'audition' };
    });
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12]) writeFileSync(join(cwd, gust(i)), `RIFF ${i}`);
    expect(await tools.request_audition({ title: 'Gusts', roles: [{ id: 'gust', name: 'Gust', pick: 3, takes: [0, 1, 2, 3, 4, 5, 6, 7].map(gust) }] })).toMatch(/^Audition recorded by planestro/);
    await expect(engine.respond(id, { kind: 'audition', picks: { gust: { takes: [gust(0), gust(1), gust(2), gust(3)] } } })).rejects.toThrow(/at most 3/);
    await engine.respond(id, { kind: 'audition', picks: { gust: { takes: [gust(0), gust(3)], regenerate: 'less reverb' } } });
    await until(() => store.requireItem(id).file.frontmatter.awaiting === 'audition' && prompts.length === 1);
    expect(said2).toMatch(/^Audition recorded by planestro/);
    expect(prompts[0]).toContain(`gust keep ${gust(0)} ${gust(3)}; regenerate 1 more: less reverb`);
    expect(prompts[0]).toMatch(/kept/);
    // Round two: the kept takes still play, and only the new ones are picked from.
    expect((await engine.auditionFile(id, gust(3)))?.toString()).toBe('RIFF 3');
    expect(await engine.auditionFile(id, gust(5))).toBeNull();
    await expect(engine.respond(id, { kind: 'audition', picks: { gust: { takes: [gust(10), gust(11)] } } })).rejects.toThrow(/at most 1/);
    await engine.respond(id, { kind: 'audition', picks: { gust: { takes: [gust(11)] } } });
    await until(() => prompts.length > 1);
    expect(prompts[1]).toContain(`gust keep ${gust(0)} ${gust(3)} ${gust(11)}`);
    expect(prompts[1]).not.toMatch(/regenerate \d+ more/);
    const notes = getSection(store.requireItem(id).file, 'Notes');
    expect(notes).toContain('regenerate 1 more: less reverb');
    expect(notes).toContain(`- Gust (\`gust\`): \`${gust(0)}\`, \`${gust(3)}\`, \`${gust(11)}\` (3 of 3)`);
  });

  it('an audition parked in the #207 shape still takes its answer (#318)', async () => {
    const { store, engine, id, prompts } = await setup();
    store.mutateItem(id, [{ set: { awaiting: 'audition', awaiting_data: { audition: AUDITION, requested_at: '2026-10-01T00:00:00Z', park: 'p1' } } }], 'engine');
    await engine.respond(id, { kind: 'audition', picks: { wind: { take: 'tmp/desert_sfx/wind_b.mp3' }, sand: { regenerate: 'softer' } } });
    await until(() => prompts.length > 0);
    expect(prompts[0]).toContain('wind keep tmp/desert_sfx/wind_b.mp3\nsand regenerate 1 more: softer');
  });

  it('the worker tool ends the turn as parked once the audition is recorded', async () => {
    const result: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '' };
    let answer = 'Rejected: no takes';
    const o = { phase: 'implement', tools: { request_audition: async () => answer } } as unknown as TurnOptions;
    const tool = workerTools(o, result).find((t) => t.name === 'request_audition')!;
    await tool.handler({ title: 't', roles: [{ id: 'a', name: 'A', takes: ['x.mp3'] }] });
    expect(result.parked).toBeUndefined();
    answer = 'Audition recorded by planestro. End your turn now.';
    await tool.handler({ title: 't', roles: [{ id: 'a', name: 'A', takes: ['x.mp3'] }] });
    expect(result.parked).toBe('audition');
  });
});
