import { describe, it, expect, afterEach, vi } from 'vitest';
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
 * A PR closed by a GitHub closing keyword (#205, HH-375): another PR's merge message said "fixes #563", so GitHub
 * closed HH-375's open PR #563 two seconds later. planestro said only "closed without merging", the orchestrator took
 * it for the user's decision, and reopening it took a `gh pr reopen` by hand. The close event names the cause now,
 * and "Reopen and resume" reopens the PR and goes back to waiting for CI.
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
  const gh = new DryRunGhPort(world);
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh, proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const s = store; const e = engine;
  /** An item in review whose PR #563 GitHub has just closed; `closure` is what its close event says. */
  const closed = (closure?: { actor?: string; commit?: string; pr?: number }) => {
    const it = s.createItem({ title: 'Mine cart', description: 'x' });
    const rel = '.claude/worktrees/cart'; const branch = 'tp/cart'; const tip = world.sha();
    const cwd = (e as any).absWorktree(rel) as string;
    world.worktrees.set(cwd, { path: cwd, head: tip, branch }); world.localBranches.add(branch); world.remoteBranches.set(branch, tip);
    world.prs.set(563, { number: 563, url: 'https://github.com/acme/repo/pull/563', state: 'CLOSED', headRefOid: tip, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    if (closure) world.prClosures.set(563, closure);
    s.mutateItem(it.id, [{ set: { status: 'IN_REVIEW', worktree: rel, branch, pr: 563, ci_result: 'pending', ci_head_sha: tip } }], 'engine');
    return { id: it.id, tip };
  };
  return { store: s, engine: e, world, closed };
}
const fm = (id: string) => store!.requireItem(id).file.frontmatter;
const section = (id: string, name: string) => getSection(store!.requireItem(id).file, name);
async function until(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } }

describe('a PR closed outside planestro (#205)', () => {
  it('closed by a commit of another merge: the item says so, names the commit and the PR, and does not call it a decision', async () => {
    const { engine, closed } = await setup();
    const h = closed({ actor: 'gravesisme', commit: 'dc12f31aabbccddeeff00112233445566778899', pr: 565 });
    await engine.reconcile('manual');
    expect(fm(h.id)).toMatchObject({ blocked: true, blocked_reason: 'pr_closed_externally' });
    const note = 'PR #563 was closed by commit dc12f31 (merge of #565): GitHub closing keyword, probably not intended';
    expect(section(h.id, 'Notes')).toContain(note);
    expect(section(h.id, 'Activity')).toContain(`BLOCKED (pr_closed_externally): ${note}`);
    expect(fm(h.id).op_data?.pr_closed_by).toMatchObject({ commit: 'dc12f31aabbccddeeff00112233445566778899', pr: 565 });
  });

  it('closed by a person: says who, and claims no keyword', async () => {
    const { engine, closed } = await setup();
    const h = closed({ actor: 'someone' });
    await engine.reconcile('manual');
    expect(section(h.id, 'Activity')).toContain('BLOCKED (pr_closed_externally): PR #563 was closed without merging, by @someone');
    expect(section(h.id, 'Activity')).not.toContain('closing keyword');
  });

  it('reopen and resume: the PR is reopened and the item waits for CI again, with no orchestrator wake', async () => {
    const { engine, world, closed } = await setup();
    const h = closed({ commit: 'dc12f31aabbccddeeff00112233445566778899', pr: 565 });
    await engine.reconcile('manual');
    const wakes = vi.spyOn(engine as any, 'wakeOrchestrator');
    expect(await engine.reopenPr(h.id)).toMatch(/^reopened PR #563/);
    expect(world.prs.get(563)!.state).toBe('OPEN');
    expect(fm(h.id)).toMatchObject({ status: 'IN_REVIEW', op: 'awaiting_ci', ci_result: 'pending', ci_head_sha: h.tip });
    expect(fm(h.id).blocked).toBeUndefined();
    expect(fm(h.id).triage).toBeUndefined();
    expect(fm(h.id).op_data?.pr_closed_by).toBeUndefined();
    expect(section(h.id, 'Activity')).toContain('reopened PR #563 and resumed the CI wait');
    expect(wakes).not.toHaveBeenCalled();
    await engine.start();
    await until(() => ['MERGED', 'FINISHED'].includes(fm(h.id).status));
    // Its merge is told to the orchestrator as any merge is; nothing before it.
    expect(wakes.mock.calls.filter((c) => c[1] === h.id).map((c) => c[0])).toEqual(['pr_merged']);
  });

  it('refuses an item whose PR is not closed, and the API says why in an error', async () => {
    const { store, engine, closed } = await setup();
    const h = closed({ commit: 'dc12f31aabbccddeeff00112233445566778899', pr: 565 });
    const plain = store.createItem({ title: 'x', description: 'x' });
    expect(await engine.reopenPr(plain.id)).toMatch(/^not possible: .* has no pull request closed outside planestro/);
    const app = apiRoutes(store, engine);
    expect((await app.request(`/items/${plain.id}/reopen-pr`, { method: 'POST' })).status).toBe(400);
    await engine.reconcile('manual');
    const ok = await app.request(`/items/${h.id}/reopen-pr`, { method: 'POST' });
    expect(ok.status).toBe(200); expect((await ok.json()).said).toMatch(/^reopened PR #563/);
  });

  it('the orchestrator can offer it on a card, and the user\'s tap reopens it', async () => {
    const { engine, world, closed } = await setup();
    const h = closed({ commit: 'dc12f31aabbccddeeff00112233445566778899', pr: 565 });
    await engine.reconcile('manual');
    expect(await (engine as any).askUserDecision(h.id, { question: 'Reopen PR #563?', why: 'A closing keyword in #565 closed it.', options: [
      { label: 'Reopen and resume', description: 'Reopen it and wait for CI', recommended: true, action: { tool: 'reopen_pr', args: { id: h.id } } },
      { label: 'Leave it closed', description: 'Discard the item later' },
    ] })).not.toMatch(/cannot|not one an option/);
    await engine.answerDecision(h.id, { choice: 'Reopen and resume' });
    expect(world.prs.get(563)!.state).toBe('OPEN');
    expect(fm(h.id)).toMatchObject({ op: 'awaiting_ci' });
    expect(fm(h.id).blocked).toBeUndefined();
  });
});
