import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { getSection, previewOf } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * What the user plays and looks at (#137, LM-38): a held PR's preview deployment was only in a bot's PR
 * comment, and a worker's verification screenshots stayed in its worktree's ignored cache.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
const polls: ReturnType<typeof setInterval>[] = [];
afterEach(async () => { for (const p of polls.splice(0)) clearInterval(p); await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  store.updateConfig((doc) => { doc.setIn(['ci', 'draft_while_held'], false); }, 'config: no drafts');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  const live = engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  polls.push(setInterval(() => (live as any).heldPolledAt.clear(), 30));
  return { store, engine: live, world, dataDir };
}
const fm = (id: string) => store!.requireItem(id).file.frontmatter;
async function until(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } }

describe('preview links and worker attachments (#137)', () => {
  it("a held PR's preview deployment is found for its head, said once, and replaced when the head moves", async () => {
    const { store, engine, world } = await setup();
    const it = store.createItem({ title: 'Lake path', description: 'x' });
    const rel = '.claude/worktrees/lake'; const branch = 'lm/lake'; const tip = world.sha();
    const cwd = (engine as any).absWorktree(rel) as string;
    world.worktrees.set(cwd, { path: cwd, head: tip, branch }); world.remoteBranches.set(branch, tip);
    world.prs.set(300, { number: 300, url: 'u', state: 'OPEN', headRefOid: tip, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    store.mutateItem(it.id, [{ set: { status: 'IN_REVIEW', worktree: rel, branch, pr: 300, skip_merge: true, hold_reason: 'for a playtest' } }], 'engine');
    await engine.start();
    await until(() => (fm(it.id).op_data?.preview as any)?.tries >= 2);
    expect(previewOf(fm(it.id))).toBeUndefined();                       // no deployment yet: asked again on the next poll
    world.previews.set(tip, 'https://lake-pr-300.vercel.app');
    await until(() => previewOf(fm(it.id)) !== undefined);
    expect(previewOf(fm(it.id))).toEqual({ url: 'https://lake-pr-300.vercel.app', sha: tip });
    const activity = () => getSection(store.requireItem(it.id).file, 'Activity');
    await sleep(200);
    expect(activity().match(/preview for \w{7}: https:\/\/lake-pr-300\.vercel\.app/g)).toHaveLength(1);
    const next = world.sha();
    world.worktrees.set(cwd, { path: cwd, head: next, branch }); world.remoteBranches.set(branch, next); world.previews.set(next, 'https://lake-pr-300-2.vercel.app');
    await until(() => previewOf(fm(it.id))?.sha === next);
    expect(previewOf(fm(it.id))!.url).toBe('https://lake-pr-300-2.vercel.app');
  });

  it("report_done's and add_note's attach copy the worktree's pictures onto the item, and refuse what is outside it or not a picture", async () => {
    const { store, engine } = await setup();
    const it = store.createItem({ title: 'Captures', description: 'x' });
    store.mutateItem(it.id, [{ set: { status: 'IN_PROGRESS', worktree: '.claude/worktrees/cap', branch: 'lm/cap' } }], 'engine');
    const root = (engine as any).absWorktree('.claude/worktrees/cap') as string;
    mkdirSync(join(root, 'tools/cache'), { recursive: true });
    writeFileSync(join(root, 'tools/cache/shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, 'notes.txt'), 'x');
    const tools = (engine as any).makeTools(it.id);
    const said = await tools.add_note('Verified the lake path.', ['tools/cache/shot.png', 'notes.txt', '../escape.png']);
    expect(said).toMatch(/Attached for the user: tools\/cache\/shot\.png\./);
    expect(said).toMatch(/notes\.txt \(not an image or video\)/);
    expect(said).toMatch(/\.\.\/escape\.png \(outside your worktree\)/);
    const att = fm(it.id).attachments;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ kind: 'managed' });
    expect(att[0].path).toMatch(/^attachments\/.+-tools-cache-shot\.png$/);
    expect(existsSync(join(store.dataDir, att[0].path))).toBe(true);
    expect(await tools.report_done('Done.', undefined, undefined, ['tools/cache/shot.png'])).toMatch(/Attached for the user: tools\/cache\/shot\.png\. End your turn now\./);
    expect(fm(it.id).attachments).toHaveLength(2);
  });
});
