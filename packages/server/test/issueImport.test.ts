import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { closesLine } from '../src/engine/issueImport.ts';
import type { Ports } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

/**
 * GitHub issues imported as items (#231, milestone 2): selected issues, or every open issue with the configured label,
 * of the repo the project's gh port is bound to (`code_repo.github`). Each becomes a not-yet-submitted item carrying
 * `source: {github_issue: N}`; importing it again finds that item and files nothing. Its PR says `Closes #N` only when
 * asked. Everything goes through the dry-run gh port, never GitHub.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup(github?: string) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  if (github) store.updateConfig((doc) => { doc.setIn(['code_repo', 'github'], github); }, 'config: github');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const app = apiRoutes(store, engine);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  const issue = (number: number, title: string, labels: string[] = [], state = 'OPEN') => world.issues.push({ number, title, body: `Body of ${title}.`, url: `https://github.com/${github}/issues/${number}`, state, labels });
  return { store, engine, world, call, issue };
}

async function waitFor(pred: () => boolean, ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const bySource = (s: DataStore, n: number) => s.listItems().filter((i) => (i.file.frontmatter.source as { github_issue?: number } | undefined)?.github_issue === n);

describe('importing GitHub issues as items (#231)', () => {
  it("is refused while the project names no GitHub repo: issues come only from the project's own", async () => {
    const { call } = await setup();
    const r = await call('POST', '/issues/import', { issues: [1] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/code_repo\.github/);
  });

  it('files selected issues as items with their source, unsubmitted; importing again files nothing', async () => {
    const { call, issue, store } = await setup('acme/app');
    issue(5, 'Search ignores accents'); issue(6, 'Export to CSV');
    const r = await call('POST', '/issues/import', { issues: [5] });
    expect(r.status).toBe(200);
    expect(r.body.imported).toHaveLength(1);
    const [it5] = bySource(store, 5);
    expect(it5.file.frontmatter).toMatchObject({ title: 'Search ignores accents', status: 'NOT_YET_SUBMITTED', source: { github_issue: 5 } });
    expect(it5.file.frontmatter.source).not.toHaveProperty('closes');
    const desc = it5.file.sections.find((s) => s.title === 'Description')!.body;
    expect(desc).toContain('Body of Search ignores accents.');
    expect(desc).toContain('https://github.com/acme/app/issues/5');
    expect(bySource(store, 6)).toHaveLength(0);

    const again = await call('POST', '/issues/import', { issues: [5, 6] });
    expect(again.body.imported.map((x: any) => x.issue)).toEqual([6]);
    expect(again.body.skipped).toEqual([expect.objectContaining({ issue: 5, item: it5.id })]);
    expect(bySource(store, 5)).toHaveLength(1);
    expect(store.listItems().every((i) => i.file.frontmatter.status === 'NOT_YET_SUBMITTED')).toBe(true);
  });

  it('files every open issue with the configured label, and lists what is importable', async () => {
    const { call, issue, store } = await setup('acme/app');
    store.updateConfig((doc) => { doc.setIn(['issues', 'import_label'], 'planestro'); }, 'config: import label');
    issue(1, 'Labelled one', ['planestro']); issue(2, 'Not labelled', ['bug']); issue(3, 'Labelled but closed', ['planestro'], 'CLOSED'); issue(4, 'Labelled two', ['bug', 'planestro']);
    const list = await call('GET', '/issues/importable');
    expect(list.body).toMatchObject({ repo: 'acme/app', label: 'planestro' });
    expect(list.body.issues.map((i: any) => i.number).sort()).toEqual([1, 2, 4]);
    const r = await call('POST', '/issues/import', {});
    expect(r.body.imported.map((x: any) => x.issue).sort()).toEqual([1, 4]);
    expect(bySource(store, 2)).toHaveLength(0); expect(bySource(store, 3)).toHaveLength(0);
    const after = await call('GET', '/issues/importable');
    expect(after.body.issues.find((i: any) => i.number === 1).item).toBe(bySource(store, 1)[0].id);
    expect((await call('POST', '/issues/import', {})).body.imported).toEqual([]);
  });

  it('with no label configured and none selected, says what to do', async () => {
    const { call } = await setup('acme/app');
    const r = await call('POST', '/issues/import', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/issues\.import_label/);
  });

  it('a closed or missing issue that was selected is skipped with the reason', async () => {
    const { call, issue } = await setup('acme/app');
    issue(9, 'Done already', [], 'CLOSED');
    const r = await call('POST', '/issues/import', { issues: [9, 77] });
    expect(r.body.imported).toEqual([]);
    expect(r.body.skipped).toEqual([expect.objectContaining({ issue: 9, reason: expect.stringMatching(/closed/) }), expect.objectContaining({ issue: 77, reason: expect.stringMatching(/not found/) })]);
  });

  it('the PR says Closes #N only when asked: at import, or later on the item', async () => {
    expect(closesLine({ source: { github_issue: 5 } })).toBe('');
    expect(closesLine({ source: { github_issue: 5, closes: true } })).toBe('\n\nCloses #5');
    expect(closesLine({})).toBe('');
    const { call, issue, store, engine, world } = await setup('acme/app');
    issue(12, 'Dark mode'); issue(13, 'Light mode');
    await call('POST', '/issues/import', { issues: [12], closes: true });
    await call('POST', '/issues/import', { issues: [13] });
    const [a] = bySource(store, 12); const [b] = bySource(store, 13);
    expect(a.file.frontmatter.source).toEqual({ github_issue: 12, closes: true });
    // Asked for later, on the item page.
    const patched = await call('PATCH', `/items/${b.id}`, { fields: { source: { github_issue: 13, closes: true } } });
    expect(patched.status).toBe(200);
    expect(store.getItem(b.id)!.file.frontmatter.source).toEqual({ github_issue: 13, closes: true });
    await call('PATCH', `/items/${b.id}`, { fields: { source: { github_issue: 13 } } });
    store.transition(a.id, 'QUEUED', 'user'); store.transition(b.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(a.id)!.file.frontmatter.status === 'PLAN_READY' && store.getItem(b.id)!.file.frontmatter.status === 'PLAN_READY');
    await engine.approvePlan(a.id); await engine.approvePlan(b.id);
    await waitFor(() => Boolean(store.getItem(a.id)!.file.frontmatter.pr && store.getItem(b.id)!.file.frontmatter.pr));
    expect(world.prs.get(store.getItem(a.id)!.file.frontmatter.pr!)!.body).toContain('Closes #12');
    expect(world.prs.get(store.getItem(b.id)!.file.frontmatter.pr!)!.body).not.toMatch(/Closes #13/);
  });
});
