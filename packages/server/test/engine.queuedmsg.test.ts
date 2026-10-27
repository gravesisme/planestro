import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * #128 (HH-259): a message to a session parked on its question was refused ("answer that first"), so a designer
 * decision that changed the brief waited on the answer; and a child not started yet never saw the decisions
 * written on its epic. Now the message rides with the answer, and a child's prompts carry its epic's Notes.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(world);
  const prompts: string[] = [];
  const claude: Ports['agents']['claude'] = { async runTurn(o: TurnOptions) { prompts.push(o.prompt); return inner.runTurn(o); }, runCustomTurn: (o) => inner.runCustomTurn(o) };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world, prompts };
}

describe('messages wait with a parked question; children read their epic (#128)', () => {
  it('a message to a session parked on its question is queued and goes with the answer', async () => {
    const { store, engine, world, prompts } = await setup();
    const it = store.createItem({ title: 'Siren art', description: 'x' });
    const rel = '.claude/worktrees/siren'; const cwd = (engine as any).absWorktree(rel);
    world.worktrees.set(cwd, { path: cwd, head: world.sha(), branch: 'tp/siren' });
    store.mutateItem(it.id, [{ set: { status: 'IN_PROGRESS', worktree: rel, branch: 'tp/siren', session_id: 's1', awaiting: 'question', awaiting_data: { kind: 'question', questions: [{ question: 'Red or blue?', header: 'Colour', options: [] }] } } }], 'engine');
    await engine.message(it.id, 'Designer: no lamps on the siren.');
    let fm = store.requireItem(it.id).file.frontmatter;
    expect(fm.awaiting).toBe('question');
    expect((fm.op_data as any).pending_messages).toEqual(['Designer: no lamps on the siren.']);
    expect(getSection(store.requireItem(it.id).file, 'Activity')).toContain('message queued: Designer: no lamps on the siren. (it reaches the session with the answer to its question)');
    await engine.respond(it.id, { kind: 'question', answers: { 'Red or blue?': 'Red' } });
    const t0 = Date.now(); while (!prompts.length) { if (Date.now() - t0 > 4000) throw new Error('no turn'); await sleep(20); }
    expect(prompts[0]).toMatch(/Answers to your questions:[\s\S]*Red[\s\S]*Also, from the user while you waited[\s\S]*- Designer: no lamps on the siren\./);
    fm = store.requireItem(it.id).file.frontmatter;
    expect((fm.op_data as any)?.pending_messages ?? []).toEqual([]);
  });

  it('a block over a message the session has not read is refused, and the message is its next turn (#491, LM-66)', async () => {
    const { store, engine } = await setup();
    const it = store.createItem({ title: 'Rain art', description: 'x' });
    store.mutateItem(it.id, [{ set: { status: 'IN_PROGRESS', op_data: { pending_messages: ['Attach the takes with add_note.'] } } }], 'engine');
    const tools = (engine as any).makeTools(it.id);
    const answer = await tools.report_blocked('cannot attach images');
    expect(answer).toMatch(/^Not recorded: the user wrote to you while you worked \(1 message\)[\s\S]*it reaches you as your next message/);
    const fm = store.requireItem(it.id).file.frontmatter;
    expect(fm.blocked).toBeFalsy();
    expect((fm.op_data as any).pending_messages).toEqual(['Attach the takes with add_note.']);
    expect(getSection(store.requireItem(it.id).file, 'Activity')).toContain('report_blocked refused: 1 message from the user is waiting for the session');
    store.mutateItem(it.id, [{ set: { op_data: {} } }], 'engine');
    expect(await tools.report_blocked('cannot attach images')).toMatch(/^Recorded/);
    expect(store.requireItem(it.id).file.frontmatter.blocked_reason).toBe('agent_blocked');
  });

  it("a child's prompt context carries its epic's Notes after its own", async () => {
    const { store } = await setup();
    const epic = store.createItem({ title: 'Surface update', description: 'x', kind: 'epic' } as any);
    store.mutateItem(epic.id, [{ section: 'Notes', body: '**Designer decision:** no treasure for Hometown.' }], 'user');
    const child = store.createItem({ title: 'Hometown layout', description: 'x', parent: epic.id });
    store.mutateItem(child.id, [{ section: 'Notes', body: 'Keep the fountain.' }], 'user');
    const notes = (store.promptContext(store.requireItem(child.id)) as any).item.notes as string;
    expect(notes).toBe(`Keep the fountain.\n\nFrom its epic ${epic.id} ("Surface update"), which these apply to as well:\n\n**Designer decision:** no treasure for Hometown.`);
    const lone = store.createItem({ title: 'Lone', description: 'x' });
    expect((store.promptContext(store.requireItem(lone.id)) as any).item.notes).toBe('');
  });
});
