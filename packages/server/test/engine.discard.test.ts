import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * Discard (#135, HH-286): the designer dropped a held child and found no way out of review. Discard closes
 * the pull request, takes the item off its epic (so the epic finishes without it) and ices it; the branch
 * on GitHub goes only on the user's word, leased to the tip they were shown.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const s = store; const e = engine;
  /** An epic with one merged child and one held in review on PR #300, its branch pushed at `tip`. */
  const held = () => {
    const epic = s.createItem({ title: 'Surface', description: 'x', kind: 'epic' } as any);
    const done = s.createItem({ title: 'Layout', description: 'x', parent: epic.id });
    const child = s.createItem({ title: 'Siren art', description: 'x', parent: epic.id });
    world.remoteBranches.set('feature/surface', world.sha());
    s.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/surface' } }], 'engine');
    s.mutateItem(done.id, [{ set: { status: 'FINISHED' } }], 'engine');
    const rel = '.claude/worktrees/siren'; const branch = 'tp/siren'; const tip = world.sha();
    const cwd = (e as any).absWorktree(rel) as string;
    world.worktrees.set(cwd, { path: cwd, head: tip, branch }); world.localBranches.add(branch); world.remoteBranches.set(branch, tip);
    world.prs.set(300, { number: 300, url: 'u', state: 'OPEN', headRefOid: tip, headRefName: branch, baseRefName: 'feature/surface', polls: 0, failOnce: false });
    s.mutateItem(child.id, [{ set: { status: 'IN_REVIEW', worktree: rel, branch, pr: 300, ci_result: 'green', skip_merge: true, hold_reason: 'for the designer' } }], 'engine');
    return { epic: epic.id, child: child.id, cwd, branch, tip };
  };
  return { store: s, engine: e, world, held };
}
const fm = (id: string) => store!.requireItem(id).file.frontmatter;
const activity = (id: string) => getSection(store!.requireItem(id).file, 'Activity');

describe('discard (#135)', () => {
  it('closes the PR, deletes the branch at the tip shown, sets uncommitted files aside, and the epic finishes without it', async () => {
    const { engine, world, held } = await setup();
    const h = held();
    world.untracked.set(h.cwd, ['tmp/raw.png']);
    expect(await engine.discardPreview(h.child)).toEqual({ refusal: null, branch: h.branch, remote_sha: h.tip, pr: 300 });
    const said = await engine.discard(h.child, 'the designer went another way', { deleteBranch: true, expectSha: h.tip });
    expect(said).toContain(`taken off epic ${h.epic}`);
    expect(world.prs.get(300)!.state).toBe('CLOSED');
    expect(world.remoteBranches.has(h.branch)).toBe(false);
    expect(world.worktrees.has(h.cwd)).toBe(false);
    expect(world.localBranches.has(h.branch)).toBe(false);
    const f = fm(h.child);
    expect(f.status).toBe('ICEBOX');
    for (const k of ['parent', 'pr', 'worktree', 'branch', 'skip_merge', 'hold_reason', 'blocked']) expect((f as any)[k], k).toBeUndefined();
    expect(activity(h.child)).toContain('discarded: the designer went another way');
    expect(activity(h.child)).toContain(`deleting branch ${h.branch}: remote tip ${h.tip}`);   // written before the delete: the branch can be restored
    expect(activity(h.child)).toMatch(/set 1 uncommitted file aside in .*\.displaced/);
    expect(activity(h.epic)).toContain(`${h.child} discarded: the designer went another way`);
    // The epic no longer waits on it: its only other child has finished, so its PR opens.
    await engine.start();
    await (async () => { const t0 = Date.now(); while (!['IN_REVIEW', 'MERGED', 'FINISHED'].includes(fm(h.epic).status)) { if (Date.now() - t0 > 5000) throw new Error(`epic is ${fm(h.epic).status}`); await sleep(20); } })();
  });

  it('keeps the branch when it moved after the user looked, and without the box ticked; removes the worktree only when everything is on the remote', async () => {
    const { engine, world, held } = await setup();
    const a = held();
    world.remoteBranches.set(a.branch, 'b'.repeat(40));                       // a push landed after the dialog opened
    expect(await engine.discard(a.child, 'not needed', { deleteBranch: true, expectSha: a.tip })).toMatch(/kept branch tp\/siren: it moved to bbbbbbb after you looked/);
    expect(world.remoteBranches.get(a.branch)).toBe('b'.repeat(40));
    expect(world.worktrees.has(a.cwd)).toBe(true);                            // local head is not what the remote holds now
    expect(world.prs.get(300)!.state).toBe('CLOSED');
    expect(fm(a.child).status).toBe('ICEBOX');
    expect(fm(a.child).worktree).toBe('.claude/worktrees/siren');            // kept, and the item still points at it
  });

  it('without delete: the remote branch stays and a clean, fully pushed worktree goes; a merged PR or an epic is refused with nothing changed', async () => {
    const { store, engine, world, held } = await setup();
    const h = held();
    expect(await engine.discard(h.child, 'dropped', {})).toContain('removed its worktree and local branch (everything is on the remote branch tp/siren, which is kept)');
    expect(world.remoteBranches.get(h.branch)).toBe(h.tip);
    const again = store.createItem({ title: 'B', description: 'x' });
    store.mutateItem(again.id, [{ set: { status: 'IN_REVIEW', pr: 301, branch: 'tp/b', worktree: '.claude/worktrees/b' } }], 'engine');
    world.prs.set(301, { number: 301, url: 'u', state: 'MERGED', mergedAt: new Date().toISOString(), headRefOid: 'c'.repeat(40), headRefName: 'tp/b', baseRefName: 'trunk', polls: 0, failOnce: false });
    await expect(engine.discard(again.id, 'x')).rejects.toThrow(/has merged/);
    expect(fm(again.id).status).toBe('IN_REVIEW');
    await expect(engine.discard(h.epic, 'x')).rejects.toThrow(/is an epic/);
    await expect(engine.discard(again.id, '  ')).rejects.toThrow(/say why/);
  });

  it('an iceboxed child holds its epic and says so; discarding it lets the epic finish', async () => {
    const { store, engine } = await setup();
    const epic = store.createItem({ title: 'E', description: 'x', kind: 'epic' } as any);
    const a = store.createItem({ title: 'A', description: 'x', parent: epic.id });
    const b = store.createItem({ title: 'B', description: 'x', parent: epic.id });
    store.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/e' } }], 'engine');
    store.mutateItem(a.id, [{ set: { status: 'FINISHED' } }], 'engine');
    store.mutateItem(b.id, [{ set: { status: 'ICEBOX' } }], 'engine');
    await engine.start();
    await (async () => { const t0 = Date.now(); while (!activity(epic.id).includes(`still waiting on ${b.id} (iceboxed)`)) { if (Date.now() - t0 > 3000) throw new Error('no note'); await sleep(20); } })();
    expect(fm(epic.id).status).toBe('IN_PROGRESS');
    await engine.discard(b.id, 'not this time');
    expect(fm(b.id)).toMatchObject({ status: 'ICEBOX' }); expect(fm(b.id).parent).toBeUndefined();
    await (async () => { const t0 = Date.now(); while (!['IN_REVIEW', 'MERGED', 'FINISHED'].includes(fm(epic.id).status)) { if (Date.now() - t0 > 5000) throw new Error(`epic is ${fm(epic.id).status}`); await sleep(20); } })();
  });

  it('out of review only by Discard: a plain move to the icebox is refused there; the API discards', async () => {
    const { store, engine, held } = await setup();
    const h = held();
    const app = apiRoutes(store, engine);
    const r = await app.request(`/items/${h.child}/transition`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'ICEBOX' }) });
    expect(r.status).toBe(400); expect((await r.json()).error).toMatch(/use Discard/);
    const t = await (await app.request(`/items/${h.child}/transitions`)).json();
    expect(t).toContainEqual({ to: 'ICEBOX', label: 'discard' });
    const d = await app.request(`/items/${h.child}/discard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'dropped', delete_branch: true, expect_sha: h.tip }) });
    expect(d.status).toBe(200); expect((await d.json()).said).toContain('deleted branch tp/siren on the remote');
  });

  it('a decision card option that discards is carried out as the user, once', async () => {
    const { store, engine, world, held } = await setup();
    const h = held();
    store.mutateItem(h.child, [{ set: { blocked: true, blocked_reason: 'agent_blocked' } }], 'engine');
    await (engine as any).askUserDecision(h.child, { question: 'Drop the siren?', why: 'The designer chose another objective.', options: [
      { label: 'Discard it and delete its branch', description: 'Closes PR #300', recommended: true, action: { tool: 'discard_item', args: { id: h.child, reason: 'another objective', delete_branch: true } } },
      { label: 'Keep it', description: 'Leave it held' },
    ] });
    await engine.answerDecision(h.child, { choice: 'Discard it and delete its branch' });
    expect(fm(h.child).status).toBe('ICEBOX');
    expect(world.prs.get(300)!.state).toBe('CLOSED');
    expect(world.remoteBranches.has(h.branch)).toBe(false);
    expect(activity(h.child)).toContain('discarded by your answer on');
    expect(activity(h.child)).toMatch(/decided: Drop the siren\? → Discard it and delete its branch \(done for you: .* discarded/);
  });
});
