import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { operatorServer, OPERATOR_READ_TOOLS, OPERATOR_WRITE_TOOLS, OPERATOR_ACTION_TOOLS } from '../src/routes/mcp.ts';
import type { Ports } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

// #365: a supervising session acts on items through the operator MCP, not the board's HTTP API: the same engine calls,
// behind operator_mcp.allow_actions (not allow_writes, which only files items), and its Activity lines say [operator], never [user].

let store: DataStore | undefined; let engine: LiveEngine | undefined; let client: Client | undefined;
afterEach(async () => { await client?.close(); await engine?.stop(); store?.close(); store = undefined; engine = undefined; client = undefined; });

async function setup(actions = true, writes = false) {
  const { dataDir } = makeFixture();
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  mkdirSync(join(store.codeRepoPath(), '.git', 'info'), { recursive: true });
  if (actions) store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_actions'], true); });
  if (writes) store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_writes'], true); });
  return { store, engine };
}
/** A client of a fresh operator server, as `/mcp` makes one per request (so a config change applies to the next). */
async function connect(s: DataStore, e: LiveEngine) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await operatorServer(s, e).connect(a);
  client = new Client({ name: 'operator-test', version: '1' });
  await client.connect(b);
  return client;
}
async function waitFor(pred: () => boolean, ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const text = (r: any) => JSON.parse(r.content[0].text);

async function planned(s: DataStore, e: LiveEngine, title: string) {
  const item = s.createItem({ title, description: 'x' });
  s.transition(item.id, 'QUEUED', 'user');
  await e.start();
  await waitFor(() => fmOf(s, item.id).status === 'PLAN_READY');
  return item.id;
}

describe('operator MCP item actions (#365)', () => {
  it('with actions off, none of them is listed and a call is an unknown tool, even with writes on', async () => {
    const { store, engine } = await setup(false, true);
    const c = await connect(store, engine);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...OPERATOR_READ_TOOLS, ...OPERATOR_WRITE_TOOLS].sort());
    const item = store.createItem({ title: 'Blocked', description: 'x' });
    store.mutateItem(item.id, [{ set: { blocked: true, blocked_reason: 'agent_blocked' } }], 'engine');
    await expect(c.callTool({ name: 'unblock_item', arguments: { id: item.id } })).resolves.toMatchObject({ isError: true });
    expect(fmOf(store, item.id).blocked).toBe(true);
  });

  it('with actions on, every action is listed, with validated input, and create_item is not', async () => {
    const { store, engine } = await setup();
    const c = await connect(store, engine);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...OPERATOR_READ_TOOLS, ...OPERATOR_ACTION_TOOLS].sort());
    // Plan approval, merges and discards stay on the board.
    for (const name of ['approve_plan', 'merge', 'discard_item', 'close_as_done']) expect(tools.map((t) => t.name)).not.toContain(name);
    const bad = await c.callTool({ name: 'send_message', arguments: { id: 'TP-1', message: '' } });
    expect(bad.isError).toBe(true);
    const missing = await c.callTool({ name: 'send_message', arguments: { id: 'TP-999', message: 'hello' } });
    expect(missing.isError).toBe(true);
    expect(text(missing).error).toMatch(/no item TP-999/);
  });

  it('unblock_item takes the board\'s engine path, and Activity says [operator], not [user]', async () => {
    const { store, engine } = await setup();
    const id = await planned(store, engine, 'Stuck');
    store.mutateItem(id, [{ set: { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }], 'engine');
    const c = await connect(store, engine);
    const r = await c.callTool({ name: 'unblock_item', arguments: { id, message: 'render with Blender, allow once' } });
    expect(r.isError).toBeFalsy();
    expect(fmOf(store, id).blocked).toBeUndefined();
    const activity = activityOf(store, id);
    expect(activity).toMatch(/\[operator\] unblocked: render with Blender, allow once/);
    expect(activity).not.toMatch(/\[user\] unblocked/);
    expect(store.journal.read({ type: 'operator_mcp.action', item: id }).map((e) => e.data)).toEqual([{ tool: 'unblock_item', message: 'render with Blender, allow once' }]);
  });

  it('send_message and answer_question take the board\'s paths, attributed to the operator; the user\'s own stays [user]', async () => {
    const { store, engine } = await setup();
    const id = await planned(store, engine, 'Talk');
    store.mutateItem(id, [{ set: { awaiting: 'question', awaiting_data: { questions: [{ question: 'Which cave?' }] } } }], 'engine');
    const c = await connect(store, engine);
    const sent = await c.callTool({ name: 'send_message', arguments: { id, message: 'also cover the cave' } });
    expect(sent.isError, JSON.stringify(sent)).toBeFalsy();
    await engine.message(id, 'from the board');
    const answered = await c.callTool({ name: 'answer_question', arguments: { id, answers: { 'Which cave?': 'North' } } });
    expect(answered.isError, JSON.stringify(answered)).toBeFalsy();
    expect(fmOf(store, id).awaiting).toBeUndefined();
    const activity = activityOf(store, id);
    expect(activity).toMatch(/\[operator\] message queued: also cover the cave/);
    expect(activity).toMatch(/\[user\] message queued: from the board/);
    expect(activity).toMatch(/\[operator\] answered: North \(with 2 queued messages\)/);
    expect((await c.callTool({ name: 'answer_question', arguments: { id, answers: {} } })).isError).toBe(true);
  });

  it('decide_permission denies, and allows only with operator_mcp.allow_permissions', async () => {
    const { store, engine } = await setup();
    const id = await planned(store, engine, 'Permission');
    const c = await connect(store, engine);
    const allow = await c.callTool({ name: 'decide_permission', arguments: { id, decision: 'allow' } });
    expect(allow.isError).toBe(true);
    expect(text(allow).error).toMatch(/operator_mcp\.allow_permissions/);
    // 'always' (an allow rule) is never on offer.
    expect((await c.callTool({ name: 'decide_permission', arguments: { id, decision: 'always' } })).isError).toBe(true);
    // Deny reaches the engine's own check: nothing is parked here.
    const deny = await c.callTool({ name: 'decide_permission', arguments: { id, decision: 'deny', reason: 'no' } });
    expect(text(deny).error).toMatch(/not awaiting a permission decision/);
    store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_permissions'], true); });
    const allowed = await c.callTool({ name: 'decide_permission', arguments: { id, decision: 'allow' } });
    expect(text(allowed).error).toMatch(/not awaiting a permission decision/);
  });

  it('answer_decision answers a card, but an option carrying an action is the user\'s to pick on the board', async () => {
    const { store, engine } = await setup();
    const item = store.createItem({ title: 'Card', description: 'x' });
    const decision = { question: 'File the follow-up?', why: 'seen in review', allow_free_text: true, options: [{ label: 'File it', action: { tool: 'create_item', args: { title: 'Follow-up' } } }, { label: 'Leave it' }] };
    store.mutateItem(item.id, [{ set: { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user', awaiting_data: { decision } } }], 'engine');
    const c = await connect(store, engine);
    const refused = await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'File it' } });
    expect(text(refused).error).toMatch(/carries an action \(create_item\); pick it on the board/);
    expect(store.listItems().map((i) => i.file.frontmatter.title)).not.toContain('Follow-up');
    expect((await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'Leave it' } })).isError).toBeFalsy();
    expect(activityOf(store, item.id)).toMatch(/\[operator\] .*Leave it/);
  });

  it('rerun_ci and sync_item say why not, in words, as errors', async () => {
    const { store, engine } = await setup();
    const item = store.createItem({ title: 'Nothing to run', description: 'x' });
    const c = await connect(store, engine);
    const rerun = await c.callTool({ name: 'rerun_ci', arguments: { id: item.id } });
    expect(rerun.isError).toBe(true);
    expect(text(rerun).error).toMatch(/^not possible/);
    const sync = await c.callTool({ name: 'sync_item', arguments: { id: item.id } });
    expect(sync.isError).toBe(true);
  });
});
