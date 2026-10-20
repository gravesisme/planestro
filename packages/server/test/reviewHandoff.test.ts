import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { getSection, managedLimit } from '@planestro/shared';
import { makeFixture } from './helpers.ts';

/**
 * A worker's hand-off for review (#355, #372): the pictures it attached since its last one, its advisory flags, a hold
 * that names pictures but shows none, and a picture's own size limit.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup() {
  await engine?.stop(); store?.close();
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const it = store.createItem({ title: 'Lamps', description: 'x' });
  store.mutateItem(it.id, [{ set: { status: 'IN_PROGRESS', worktree: '.claude/worktrees/lamps', branch: 'lm/lamps' } }], 'engine');
  const root = (engine as any).absWorktree('.claude/worktrees/lamps') as string;
  mkdirSync(join(root, 'tmp'), { recursive: true });
  const shot = (name: string, bytes = 4) => { writeFileSync(join(root, 'tmp', name), Buffer.alloc(bytes, 1)); return `tmp/${name}`; };
  return { id: it.id, tools: (engine as any).makeTools(it.id), shot };
}
const fm = (id: string) => store!.requireItem(id).file.frontmatter;

describe('a hand-off for review (#355, #372)', () => {
  it('report_done records the pictures it handed off and its flags; the next one only its own', async () => {
    const { id, tools, shot } = await setup();
    const said = await tools.report_done('Lamps.', undefined, undefined, [shot('lamp_4x_before.png'), shot('lamp_4x_after.png')], undefined,
      [{ path: 'tmp/lamp_4x_after.png', cell: 'frame 3', reason: 'the flame floats', severity: 'problem' }, { path: 'art/lamp.png', reason: 'colour drift' }]);
    expect(said).toMatch(/Flagged 2 for a look\. End your turn now\.$/);
    const first = fm(id).review_handoff!;
    expect(first.attached.map((p) => p.split('/').pop())).toEqual([expect.stringMatching(/-tmp-lamp_4x_before\.png$/), expect.stringMatching(/-tmp-lamp_4x_after\.png$/)]);
    expect(first.flags).toEqual([{ path: 'tmp/lamp_4x_after.png', cell: 'frame 3', reason: 'the flame floats', severity: 'problem' }, { path: 'art/lamp.png', reason: 'colour drift' }]);
    expect(getSection(store!.requireItem(id).file, 'Activity')).toMatch(/flagged for a look: tmp\/lamp_4x_after\.png \(frame 3\): the flame floats; art\/lamp\.png: colour drift/);

    store!.mutateItem(id, [{ set: { op_data: {} } }], 'engine'); // a later turn's report, not a retry of this one
    await tools.report_done('Lamps again.', undefined, undefined, [shot('lamp_6x.png')]);
    const second = fm(id).review_handoff!;
    expect(second.attached).toHaveLength(1);
    expect(second.attached[0]).toMatch(/-tmp-lamp_6x\.png$/);
    expect(second.flags).toBeUndefined(); // the flags were the last hand-off's
  });

  it('flags that fail the schema are left out and said; the report still lands', async () => {
    const { id, tools } = await setup();
    const said = await tools.report_done('Done.', undefined, undefined, undefined, undefined, [{ path: 'a.png' }]);
    expect(said).toMatch(/^Recorded\. Flags not recorded: 0\.reason: /);
    expect(fm(id).op_data?.done_summary).toBe('Done.');
    expect(fm(id).review_handoff?.flags).toBeUndefined();
  });

  it("add_note's flags join the hand-off's, one per path and cell", async () => {
    const { id, tools } = await setup();
    await tools.report_done('Done.', undefined, undefined, undefined, undefined, [{ path: 'a.png', reason: 'old reason' }]);
    expect(await tools.add_note('A second look.', undefined, [{ path: 'a.png', reason: 'new reason' }, { path: 'b.png', cell: 'r2c1', reason: 'clipping', severity: 'warn' }])).toMatch(/Flagged 2 for a look\.$/);
    expect(fm(id).review_handoff!.flags).toEqual([{ path: 'a.png', reason: 'new reason' }, { path: 'b.png', cell: 'r2c1', reason: 'clipping', severity: 'warn' }]);
  });

  it('a hold that asks for a look at pictures with none handed off is said to the worker, never refused', async () => {
    const a = await setup();
    const said = await a.tools.report_done('Done.', undefined, 'until the designer reviews the before/after captures');
    expect(said).toMatch(/keeps the pull request out of the merge queue/);
    expect(said).toMatch(/The hold asks for a look at pictures, but this hand-off attached none: attach the whole set/);
    expect(fm(a.id).skip_merge).toBe(true);
    const b = await setup();
    expect(await b.tools.report_done('Done.', undefined, 'until the designer reviews the captures', [b.shot('a.png')])).not.toMatch(/attached none/);
    expect(fm(b.id).skip_merge).toBe(true);
  });

  it('a picture may be up to image_max_bytes; anything else stops at managed_max_bytes', async () => {
    const { id, tools, shot } = await setup();
    store!.updateConfig((doc) => { doc.setIn(['attachments', 'managed_max_bytes'], 10); doc.setIn(['attachments', 'image_max_bytes'], 100); }, 'config: small limits');
    expect(managedLimit(store!.config.attachments, 'x.png')).toBe(100);
    expect(managedLimit(store!.config.attachments, 'x.mov')).toBe(10);
    const said = await tools.add_note('Look.', [shot('big.png', 50), shot('clip.mp4', 50), shot('huge.png', 150)]);
    expect(said).toMatch(/Attached for the user: tmp\/big\.png\./);
    expect(said).toMatch(/tmp\/clip\.mp4 \(50 bytes, over attachments\.managed_max_bytes 10\)/);
    expect(said).toMatch(/tmp\/huge\.png \(150 bytes, over attachments\.image_max_bytes 100\)/);
    expect(fm(id).attachments).toHaveLength(1);
  });
});
