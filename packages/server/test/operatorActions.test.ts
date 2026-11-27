import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { operatorServer, OPERATOR_TOOLS, OPERATOR_READ_TOOLS, OPERATOR_WRITE_TOOLS, OPERATOR_ACTION_TOOLS } from '../src/routes/mcp.ts';
import type { Ports } from '../src/engine/ports.ts';
import { decisionOf, parseThread, SETTINGS } from '@planestro/shared';
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
  return { store, engine, world };
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
    // Off, the refusal says where the switch is, as the Settings page names it, and what is left from here (#577).
    expect(text(allow).error).toMatch(/operator_mcp\.allow_permissions; it is off \(Settings → Project → "Your own MCP clients" → "May allow a permission request once"\).*deny with a reason is the only other path/);
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
    expect(text(refused).error).toMatch(/carries an action \(create_item\), which is the user's own tap: picking it from here needs operator_mcp\.allow_card_actions; it is off \(Settings → Project → "Your own MCP clients" → "May take card actions and answer auditions"\)/);
    expect(decisionOf(fmOf(store, item.id))?.question).toBe('File the follow-up?');
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

// #577: the decisions a supervising session could not relay for a user who is away from the board.
describe('operator MCP: question cards, card actions and auditions (#577)', () => {
  const card = (s: DataStore, id: string, options: unknown[]) => s.mutateItem(id, [{ set: { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user', awaiting_data: { decision: { question: 'Ship it?', why: 'art is late', allow_free_text: true, options } } } }], 'engine');
  const actions = (s: DataStore, id?: string) => s.journal.read({ type: 'operator_mcp.action', ...(id ? { item: id } : {}) }).map((e) => e.data);

  it('answer_question_card: the answer goes in the card\'s thread and wakes the orchestrator, or closes the card; Activity says [operator]', async () => {
    const { store, engine } = await setup();
    const item = store.createItem({ title: 'Held in review', description: 'x' });
    const q = store.askQuestion({ item: item.id, headline: 'Ship without the art?', summary: 'A: ship now. B: wait for the art.', recommendation: 'B' });
    const loose = store.askQuestion({ headline: 'Which palette?', summary: 'Blue or green.' });
    const wakes: any[] = []; const orch = (engine as any).orchestrator; const wake = orch.wake.bind(orch);
    orch.wake = (ev: any) => { wakes.push(ev); };
    const c = await connect(store, engine);
    try {
      // The card is readable from here, and an answer aimed at the item says where it belongs.
      expect(text(await c.callTool({ name: 'list_questions', arguments: {} })).map((x: any) => x.id).sort()).toEqual([loose.id, q.id].sort());
      expect(text(await c.callTool({ name: 'list_questions', arguments: { item: item.id } }))).toEqual([expect.objectContaining({ id: q.id, status: 'open', item: item.id, headline: 'Ship without the art?', summary: 'A: ship now. B: wait for the art.', recommendation: 'B', thread: [] })]);
      const wrong = await c.callTool({ name: 'answer_question', arguments: { id: item.id, answers: { 'Ship without the art?': 'B' } } });
      expect(text(wrong).error).toMatch(new RegExp(`; ${q.id} is an open question card about it: answer_question_card$`));
      expect(text(await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'B' } })).error).toMatch(/no decision waiting.*answer_question_card/);

      const posted = await c.callTool({ name: 'answer_question_card', arguments: { question: q.id, answer: 'B' } });
      expect(posted.isError, JSON.stringify(posted)).toBeFalsy();
      const thread = parseThread(store.requireQuestion(q.id).file);
      expect(thread.map((t) => [t.actor, t.text])).toEqual([['user', "B (the user's word, relayed through the operator MCP)"]]);
      expect(store.requireQuestion(q.id).file.frontmatter.status).toBe('open');
      // The board's own wake: the orchestrator carries the answer out and closes the card.
      expect(wakes).toEqual([{ type: 'question_message', data: { question: q.id, message: "B (the user's word, relayed through the operator MCP)" } }]);
      expect(activityOf(store, item.id)).toMatch(new RegExp(`\\[operator\\] answered ${q.id} \\(Ship without the art\\?\\): B`));
      expect(activityOf(store, item.id)).not.toMatch(/\[user\] answered/);
      expect(actions(store, item.id)).toEqual([{ tool: 'answer_question_card', question: q.id, answer: 'B' }]);

      // close: the answer was already carried out, so the card is closed with it and nobody is woken.
      const closed = await c.callTool({ name: 'answer_question_card', arguments: { question: loose.id, answer: 'Blue', close: true } });
      expect(text(closed).question).toMatchObject({ id: loose.id, status: 'resolved' });
      expect(store.requireQuestion(loose.id).file.frontmatter).toMatchObject({ status: 'resolved', resolution: "Blue (the user's word, relayed through the operator MCP)" });
      expect(wakes.length).toBe(1);
      expect(actions(store).at(-1)).toEqual({ tool: 'answer_question_card', question: loose.id, answer: 'Blue', close: true });
      expect(text(await c.callTool({ name: 'answer_question_card', arguments: { question: loose.id, answer: 'Green', close: true } })).error).toMatch(/already resolved/);
      expect(text(await c.callTool({ name: 'answer_question_card', arguments: { question: 'Q-99', answer: 'x' } })).error).toMatch(/unknown question Q-99/);
      expect((await c.callTool({ name: 'answer_question_card', arguments: { question: item.id, answer: 'x' } })).isError).toBe(true);
    } finally { orch.wake = wake; }
  });

  it('answer_question_card is an item action: off with allow_actions, where list_questions still reads', async () => {
    const { store, engine } = await setup(false);
    const q = store.askQuestion({ headline: 'Which palette?', summary: 'Blue or green.' });
    const c = await connect(store, engine);
    expect(text(await c.callTool({ name: 'list_questions', arguments: {} })).map((x: any) => x.id)).toEqual([q.id]);
    await expect(c.callTool({ name: 'answer_question_card', arguments: { question: q.id, answer: 'Blue', close: true } })).resolves.toMatchObject({ isError: true });
    expect(store.requireQuestion(q.id).file.frontmatter.status).toBe('open');
    expect(parseThread(store.requireQuestion(q.id).file)).toEqual([]);
  });

  it('a card option that carries an action: refused with allow_card_actions off, performed as the board\'s tap with it on, recorded as [operator]', async () => {
    const { store, engine } = await setup();
    const item = store.createItem({ title: 'Card', description: 'x' });
    card(store, item.id, [{ label: 'Ship, file the art', action: { tool: 'create_item', args: { title: 'Art follow-up', description: 'the late art', depends_on: [item.id] } } }, { label: 'Wait' }]);
    const c = await connect(store, engine);
    // Off (the default): nothing is filed, the card stands, and the refusal says where the switch is.
    expect(store.config.operator_mcp.allow_card_actions).toBe(false);
    const refused = await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'Ship, file the art', text: '812 A' } });
    expect(refused.isError).toBe(true);
    expect(text(refused).error).toMatch(/operator_mcp\.allow_card_actions; it is off \(Settings → Project → "Your own MCP clients" → "May take card actions and answer auditions"\), so nothing was done.*only other path/);
    expect(store.listItems().map((i) => i.file.frontmatter.title)).not.toContain('Art follow-up');
    expect(decisionOf(fmOf(store, item.id))).toBeTruthy();
    expect(actions(store, item.id)).toEqual([]);
    expect((await c.listTools()).tools.find((t) => t.name === 'answer_decision')!.description).toMatch(/operator_mcp\.allow_card_actions, which is off/);

    // On, read on the next call: the card's own action, with its wiring, performed by planestro as the tap performs it.
    store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_card_actions'], true); });
    const picked = await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'Ship, file the art', text: '812 A' } });
    expect(picked.isError, JSON.stringify(picked)).toBeFalsy();
    const made = store.listItems().find((i) => i.file.frontmatter.title === 'Art follow-up')!;
    expect(made.file.frontmatter).toMatchObject({ status: 'NOT_YET_SUBMITTED', depends_on: [item.id] });
    expect(decisionOf(fmOf(store, item.id))).toBeUndefined();
    expect(activityOf(store, item.id)).toMatch(new RegExp(`\\[operator\\] decided: Ship it\\? → Ship, file the art — 812 A \\(done for you: created ${made.id} \\("Art follow-up"\\), not submitted yet\\)`));
    expect(activityOf(store, item.id)).not.toMatch(/\[user\] decided/);
    expect(activityOf(store, made.id)).toMatch(/\[operator\] created by your answer on/);
    expect(actions(store, item.id)).toEqual([{ tool: 'answer_decision', choice: 'Ship, file the art', text: '812 A', action: 'create_item' }]);
    expect(store.journal.read({ type: 'orchestrator.decision_answered', item: item.id }).at(-1)!.data).toMatchObject({ action: 'create_item' });
  });

  it('with allow_card_actions on, the tap\'s own refusals still apply, a discard needs allow_decisions, and a branch deletion stays on the board', async () => {
    const { store, engine } = await setup();
    store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_card_actions'], true); });
    const item = store.createItem({ title: 'Card', description: 'x' });
    const other = store.createItem({ title: 'Follow-up', description: 'x' });
    const doomed = store.createItem({ title: 'Doomed', description: 'x' });
    store.transition(doomed.id, 'QUEUED', 'user');
    card(store, item.id, [
      { label: 'Start the follow-up', action: { tool: 'submit_item', args: { id: other.id } } },
      { label: 'Drop it', action: { tool: 'discard_item', args: { id: doomed.id, reason: 'not wanted' } } },
      { label: 'Drop it and its branch', action: { tool: 'discard_item', args: { id: doomed.id, reason: 'not wanted', delete_branch: true } } },
    ]);
    // The backlog moved since the card was filed: the tap refuses (actionRefusal), from here as on the board, and the card stands.
    store.mutateItem(other.id, [{ set: { status: 'ICEBOX' } }], 'engine');
    const c = await connect(store, engine);
    const stale = await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'Start the follow-up' } });
    expect(text(stale).error).toMatch(/cannot be carried out any more: .* is ICEBOX; only an item that is not submitted yet can be submitted/);
    expect(fmOf(store, other.id).status).toBe('ICEBOX');
    expect(decisionOf(fmOf(store, item.id))).toBeTruthy();
    const discard = await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'Drop it' } });
    expect(text(discard).error).toMatch(/carries discard_item, which also needs operator_mcp\.allow_decisions; it is off \(Settings → Project → "Your own MCP clients" → "May make decisions on items"\)/);
    store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_decisions'], true); });
    expect(text(await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'Drop it and its branch' } })).error).toMatch(/deletes a remote branch, which stays the user's tick on the board/);
    expect(fmOf(store, doomed.id).status).toBe('QUEUED');
    expect(actions(store, item.id)).toEqual([]);
    // The submit, once nothing refuses it: the item is queued as its page's Submit queues it.
    store.mutateItem(other.id, [{ set: { status: 'NOT_YET_SUBMITTED' } }], 'engine');
    const ok = await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'Start the follow-up', text: 'go' } });
    expect(ok.isError, JSON.stringify(ok)).toBeFalsy();
    expect(fmOf(store, other.id).status).not.toBe('NOT_YET_SUBMITTED');
    expect(activityOf(store, item.id)).toMatch(new RegExp(`\\[operator\\] decided: .*done for you: ${other.id} is queued for planning`));
  });

  it('answer_audition: refused with allow_card_actions off; on, the user\'s picks resume the worker under the board\'s rules, recorded as [operator]', async () => {
    const { store, engine, world } = await setup();
    const item = store.createItem({ title: 'Desert SFX', description: 'x' });
    const rel = '.claude/worktrees/desert'; const cwd = (engine as any).absWorktree(rel) as string;
    world.worktrees.set(cwd, { path: cwd, head: world.sha(), branch: 'tp/desert' });
    const audition = { title: 'Desert ambience', roles: [{ id: 'wind', name: 'Wind loop', pick: 2, kept: ['tmp/wind_k.mp3'], takes: ['tmp/wind_a.mp3', 'tmp/wind_b.mp3'] }, { id: 'sand', name: 'Sand step', takes: ['tmp/sand_a.mp3', 'tmp/sand_b.mp3'] }] };
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', worktree: rel, branch: 'tp/desert', session_id: 's1', awaiting: 'audition', awaiting_data: { audition } } }], 'engine');
    const c = await connect(store, engine);
    // The other answers say where this one goes.
    expect(text(await c.callTool({ name: 'answer_decision', arguments: { id: item.id, choice: 'B' } })).error).toMatch(/no decision waiting.*it waits on an audition: answer_audition/);
    const picks = { wind: { takes: ['tmp/wind_b.mp3'] }, sand: { takes: [], regenerate: 'softer' } };
    const refused = await c.callTool({ name: 'answer_audition', arguments: { id: item.id, picks, word: 'wind B, redo the sand softer' } });
    expect(refused.isError).toBe(true);
    expect(text(refused).error).toMatch(/operator_mcp\.allow_card_actions; it is off \(Settings → Project → "Your own MCP clients" → "May take card actions and answer auditions"\), so nothing was picked/);
    expect(fmOf(store, item.id).awaiting).toBe('audition');
    expect(actions(store, item.id)).toEqual([]);

    store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_card_actions'], true); });
    // The board's own rules: a role needs its picks or a regenerate, from its own takes, never more than it still needs (pick less kept).
    expect(text(await c.callTool({ name: 'answer_audition', arguments: { id: item.id, picks: { wind: { takes: ['tmp/wind_b.mp3'] } }, word: 'wind B' } })).error).toMatch(/Sand step/);
    expect(text(await c.callTool({ name: 'answer_audition', arguments: { id: item.id, picks: { wind: { takes: ['tmp/wind_a.mp3', 'tmp/wind_b.mp3'] }, sand: { takes: ['tmp/sand_a.mp3'] } }, word: 'both winds' } })).error).toMatch(/at most 1 more/);
    expect((await c.callTool({ name: 'answer_audition', arguments: { id: item.id, picks } })).isError).toBe(true);   // the user's word is required
    expect(fmOf(store, item.id).awaiting).toBe('audition');
    const ok = await c.callTool({ name: 'answer_audition', arguments: { id: item.id, picks, word: 'wind B, redo the sand softer' } });
    expect(ok.isError, JSON.stringify(ok)).toBeFalsy();
    expect(fmOf(store, item.id).awaiting).not.toBe('audition');
    const activity = activityOf(store, item.id);
    expect(activity).toMatch(/\[operator\] audition picked: wind keep tmp\/wind_k\.mp3 tmp\/wind_b\.mp3; sand regenerate 1 more: softer/);
    expect(activity).toMatch(/\[operator\] audition picks relayed on the user's word: wind B, redo the sand softer/);
    expect(activity).not.toMatch(/\[user\] audition/);
    expect(actions(store, item.id)).toEqual([{ tool: 'answer_audition', picks, word: 'wind B, redo the sand softer' }]);
  });

  it('the new opt-in is off by default, a Settings toggle beside the others, and no operator tool writes settings', async () => {
    const { store, engine } = await setup(true, true);
    expect(store.config.operator_mcp).toMatchObject({ allow_card_actions: false, allow_permissions: false });
    expect(SETTINGS.find((d) => d.key === 'operator_mcp.allow_card_actions')).toMatchObject({ tab: 'project', group: 'Your own MCP clients', label: 'May take card actions and answer auditions', control: 'toggle' });
    store.updateConfig((d) => { for (const k of ['allow_decisions', 'allow_submit']) d.setIn(['operator_mcp', k], true); });
    const c = await connect(store, engine);
    expect(c.getInstructions()).toMatch(/operator_mcp\.allow_card_actions \(a decision-card option that carries an action/);
    // No tool takes a setting: the switches are written through Settings or the file, never from this endpoint.
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...OPERATOR_TOOLS].sort());
    for (const t of tools) for (const arg of Object.keys((t.inputSchema as any).properties ?? {})) expect(arg).not.toMatch(/^allow_|operator_mcp|setting|config/);
  });
});

