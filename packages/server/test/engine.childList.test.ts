import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { childrenFromList, getSection } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * #239: children rendered from a list are reviewed in the breakdown panel, and only the user's tap creates them, under
 * the epic, independent unless the list said otherwise. Nothing is queued unless the user asked (#73).
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
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, app: apiRoutes(store, engine) };
}

async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const post = (body: unknown) => ({ method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const LIST = 'name,depends_on\nshared,\nserver,\nweb,1';
const TEMPLATE = 'Bump the lint config in packages/{{name}} and fix what it flags there.';

describe('children from a list (#239)', () => {
  it('creates exactly the reviewed children under an epic not yet started, and queues nothing unless asked', async () => {
    const { store, engine, app } = await setup();
    const epic = store.createItem({ title: 'Lint everywhere', description: 'Bump lint in every package.', kind: 'epic', category: 'Chores' });
    const { children, problem } = childrenFromList({ template: TEMPLATE, title: 'Lint {{name}}', list: LIST, format: 'csv', implementer: store.config.defaults.implementer });
    expect(problem).toBeNull();
    const res = await app.request(`/items/${epic.id}/children`, post({ children: [...children.slice(0, 2), { ...children[2], hold_for_review: true }] }));
    expect(res.status).toBe(200);
    const { created } = await res.json() as { created: string[] };
    expect(created).toHaveLength(3);
    const kids = created.map((id) => fmOf(store, id));
    expect(kids.map((k) => k.title)).toEqual(['Lint shared', 'Lint server', 'Lint web']);
    expect(kids.every((k) => k.parent === epic.id && k.status === 'NOT_YET_SUBMITTED' && k.category === 'Chores')).toBe(true);
    expect(kids.map((k) => k.depends_on)).toEqual([[], [], [created[0]]]);
    expect(kids[2].review_hold).toBe(true);
    expect(fmOf(store, epic.id).status).toBe('NOT_YET_SUBMITTED');   // its merge semantics are untouched: queuing a child opens it
    expect(getSection(store.getItem(epic.id)!.file, 'Activity')).toContain(`added 3 children from a list: ${created.join(', ')}`);
    void engine;
  });

  it('queues them when the user ticks it, and the epic opens for them', async () => {
    const { store, engine } = await setup();
    const epic = store.createItem({ title: 'Lint everywhere', description: 'Bump lint in every package.', kind: 'epic' });
    const { children } = childrenFromList({ template: TEMPLATE.replace('{{name}}', '{{item}}'), list: 'shared\nweb', implementer: store.config.defaults.implementer });
    await engine.start();
    const created = await engine.addChildren(epic.id, children, { queue: true });
    await waitFor(() => fmOf(store, epic.id).status === 'IN_PROGRESS');
    expect(fmOf(store, epic.id).branch).toBe('feature/lint-everywhere');
    expect(created.map((id) => fmOf(store, id).parent)).toEqual([epic.id, epic.id]);
  });

  it('is refused for an iceboxed epic, a plain item and children the breakdown rules refuse', async () => {
    const { store, engine } = await setup();
    const { children } = childrenFromList({ template: TEMPLATE.replace('{{name}}', '{{item}}'), list: 'shared', implementer: store.config.defaults.implementer });
    const done = store.createItem({ title: 'Iceboxed epic', description: 'x', kind: 'epic', status: 'ICEBOX' });
    const item = store.createItem({ title: 'Plain', description: 'x' });
    await expect(engine.addChildren(done.id, children)).rejects.toThrow(/ICEBOX/);
    await expect(engine.addChildren(item.id, children)).rejects.toThrow(/not an epic/);
    const epic = store.createItem({ title: 'Lint everywhere', description: 'x', kind: 'epic' });
    await expect(engine.addChildren(epic.id, [{ ...children[0], implementer: 'nobody' }])).rejects.toThrow(/not one of/);
    expect(store.listItems().filter((i) => i.file.frontmatter.parent)).toHaveLength(0);
  });
});
