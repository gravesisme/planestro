import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeFixture } from './helpers.ts';
import { startServer } from '../src/server.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { DataStore } from '../src/store/DataStore.ts';
import { OPERATOR_TOOLS, OPERATOR_READ_TOOLS, OPERATOR_WRITE_TOOLS, OPERATOR_DECISION_TOOLS, OPERATOR_SUBMIT_TOOLS, operatorMcpUrl } from '../src/routes/mcp.ts';
import { instancePath } from '../src/instances.ts';

// What the Agent SDK is handed for a worker or orchestrator turn: the MCP servers, and the tools of
// planestro's in-process one. Nothing is spawned; the turn ends on the first message.
const seen = vi.hoisted(() => ({ options: [] as any[], tools: [] as string[][] }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tool: (name: string) => ({ name }),
  createSdkMcpServer: (o: { name: string; tools: { name: string }[] }) => { seen.tools.push(o.tools.map((t) => t.name)); return { type: 'sdk', name: o.name, instance: {} }; },
  query: (a: { options: unknown }) => { seen.options.push(a.options); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1 }; })(); },
}));
const { LiveClaudePort } = await import('../src/engine/sessions/LiveClaudePort.ts');

const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
const text = (r: any) => JSON.parse(r.content[0].text);

describe('the operator MCP endpoint (#175, step 2)', () => {
  it('offers exactly the read-only tools, over streamable HTTP on the running server', async () => {
    const { dataDir } = makeFixture();
    const seed = await DataStore.open(dataDir);
    const epic = seed.createItem({ title: 'Cavern', kind: 'epic' });
    seed.createItem({ title: 'Bats', parent: epic.id });
    const q = seed.createItem({ title: 'Lanterns' });
    seed.mutateItem(q.id, [{ transition: { to: 'QUEUED', actor: 'user' } }], 'user');
    await seed.flushCommits(); seed.close();
    // As `planestro start` records it, so get_state can say which instance this is.
    mkdirSync(join(dataDir, '.planestro'), { recursive: true });
    const port = await freePort();
    const srv = await startServer({ dataDir, port, log: () => {}, engineFactory: (s, em) => new MockEngine(s, em) });
    writeFileSync(instancePath(dataDir), JSON.stringify({ data_dir: dataDir, port, host: '127.0.0.1', url: `http://127.0.0.1:${port}`, pid: process.pid, pgid: process.pid, watch: false, log: 'x', started_at: new Date().toISOString() }));
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const { tools } = await client.listTools();
      // operator_mcp.allow_writes is off by default: only the read-only tools are listed (#232)
      expect(tools.map((t) => t.name).sort()).toEqual([...OPERATOR_READ_TOOLS].sort());
      for (const t of tools) expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });

      const all = text(await client.callTool({ name: 'list_items', arguments: {} }));
      expect(all.map((i: any) => i.title).sort()).toEqual(['Bats', 'Cavern', 'Lanterns']);
      expect(text(await client.callTool({ name: 'list_items', arguments: { epic: epic.id } })).map((i: any) => i.title)).toEqual(['Bats']);
      expect(text(await client.callTool({ name: 'list_items', arguments: { queued: true } })).map((i: any) => i.id)).toEqual([q.id]);
      expect(text(await client.callTool({ name: 'list_items', arguments: { status: 'NOT_YET_SUBMITTED' } })).length).toBe(2);

      const item = text(await client.callTool({ name: 'get_item', arguments: { id: q.id } }));
      expect(item).toMatchObject({ id: q.id, frontmatter: { title: 'Lanterns', status: 'QUEUED' }, derived: { lane: expect.any(String) } });
      expect(item.sections).toHaveProperty('Description');
      const missing = await client.callTool({ name: 'get_item', arguments: { id: 'TP-999' } });
      expect(missing.isError).toBe(true);

      const state = text(await client.callTool({ name: 'get_state', arguments: {} }));
      expect(state).toMatchObject({ project: { name: 'Test Project', id_prefix: 'TP', data_dir: dataDir }, queued: [q.id], counts: { QUEUED: 1, NOT_YET_SUBMITTED: 2 } });
      expect(state.instances.this).toMatchObject({ url: `http://127.0.0.1:${port}`, mcp: `http://127.0.0.1:${port}/mcp` });
      // An MCP client's OAuth discovery gets a plain 404, not the web UI's index.html as a 200 (Claude Code probes it first).
      expect((await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
      // nothing that writes: an unknown tool is an error, not a side door
      await expect(client.callTool({ name: 'approve_plan', arguments: { id: q.id } })).resolves.toMatchObject({ isError: true });
      await expect(client.callTool({ name: 'create_item', arguments: { title: 'Sneaky' } })).resolves.toMatchObject({ isError: true });
      expect(srv.store.listItems().map((i) => i.file.frontmatter.title)).not.toContain('Sneaky');
    } finally { await client.close(); await srv.engine.stop(); srv.server.close(); srv.store.close(); }
  });

  it('create_item, once the project opts in with operator_mcp.allow_writes, files to NOT_YET_SUBMITTED and nothing more (#232)', async () => {
    const { dataDir } = makeFixture();
    const port = await freePort();
    const srv = await startServer({ dataDir, port, log: () => {}, engineFactory: (s, em) => new MockEngine(s, em) });
    const client = new Client({ name: 'test', version: '1' });
    try {
      srv.store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_writes'], true); });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const { tools } = await client.listTools();
      // Filing follow-ups never grants acting on items: those need operator_mcp.allow_actions (#365).
      expect(tools.map((t) => t.name).sort()).toEqual([...OPERATOR_READ_TOOLS, ...OPERATOR_WRITE_TOOLS].sort());
      expect(tools.find((t) => t.name === 'create_item')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      // It takes nothing that would start or change work: no status, no parent, no submit.
      expect(Object.keys((tools.find((t) => t.name === 'create_item')!.inputSchema as any).properties).sort()).toEqual(['category', 'description', 'kind', 'priority', 'title']);

      const made = text(await client.callTool({ name: 'create_item', arguments: { title: 'Follow-up: tidy the cave map', description: 'Seen while reviewing TP-1.', priority: 'low' } }));
      const item = srv.store.getItem(made.id)!;
      expect(item.file.frontmatter).toMatchObject({ title: 'Follow-up: tidy the cave map', status: 'NOT_YET_SUBMITTED', priority: 'low', created_by: 'operator_mcp' });
      expect(item.file.frontmatter.queued_at).toBeUndefined();
      expect(made).toMatchObject({ id: item.id, status: 'NOT_YET_SUBMITTED' });
      // Not the user's word (#73): the Activity says where it came from.
      expect(item.file.sections.find((s) => s.title === 'Activity')!.body).toMatch(/\[app\] created through the operator MCP/);
      await srv.store.flushCommits();
      const { execFileSync } = await import('node:child_process');
      expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dataDir, encoding: 'utf8' }).trim()).toBe(`${item.id}: create item`);

      const bad = await client.callTool({ name: 'create_item', arguments: { title: 'Nowhere', category: 'Nope' } });
      expect(bad.isError).toBe(true);
      expect(text(bad).error).toMatch(/unknown category/);

      // Off again: the tool is gone from the list, and a call is an unknown tool.
      srv.store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_writes'], false); });
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('create_item');
      await expect(client.callTool({ name: 'create_item', arguments: { title: 'Late' } })).resolves.toMatchObject({ isError: true });
      expect(srv.store.listItems().map((i) => i.file.frontmatter.title)).not.toContain('Late');
    } finally { await client.close(); await srv.engine.stop(); srv.server.close(); srv.store.close(); }
  });

  it('edits, note links and decisions: each behind its own opt-in, as the board does them, recorded as [operator]', async () => {
    const { dataDir } = makeFixture();
    const port = await freePort();
    const srv = await startServer({ dataDir, port, log: () => {}, engineFactory: (s, em) => new MockEngine(s, em) });
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
      expect(await names()).toEqual([...OPERATOR_READ_TOOLS].sort());
      srv.store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_writes'], true); d.setIn(['operator_mcp', 'allow_actions'], true); });
      // Acting on items never grants the decisions: those need operator_mcp.allow_decisions.
      for (const t of OPERATOR_DECISION_TOOLS) expect(await names()).not.toContain(t);
      srv.store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_decisions'], true); });
      expect(await names()).toEqual(OPERATOR_TOOLS.filter((t) => !(OPERATOR_SUBMIT_TOOLS as readonly string[]).includes(t)).sort());

      const item = srv.store.createItem({ title: 'Cave map', description: 'old' });
      const edited = text(await client.callTool({ name: 'edit_item', arguments: { id: item.id, priority: 'high', notes: 'Keep the torches.', description: 'new' } }));
      expect(edited).toMatchObject({ id: item.id, priority: 'high' });
      const file = srv.store.requireItem(item.id).file;
      expect(file.sections.find((s) => s.title === 'Notes')!.body).toBe('Keep the torches.');
      expect(file.sections.find((s) => s.title === 'Description')!.body).toBe('new');
      expect((await client.callTool({ name: 'edit_item', arguments: { id: item.id, category: 'Nope' } })).isError).toBe(true);
      // Nothing that starts, holds or merges work is editable here.
      expect(Object.keys(((await client.listTools()).tools.find((t) => t.name === 'edit_item')!.inputSchema as any).properties).sort()).toEqual(['category', 'depends_on', 'description', 'id', 'notes', 'parent', 'priority', 'release', 'title']);

      const note = srv.store.journal.append({ type: 'orchestrator.planestro_note', actor: 'orchestrator', data: { text: 'A tool was missing.' } });
      expect(text(await client.callTool({ name: 'list_notes', arguments: { open: true } }))).toEqual([expect.objectContaining({ ts: note.ts, text: 'A tool was missing.', issues: [], handled: false })]);
      expect(text(await client.callTool({ name: 'mark_note', arguments: { note: note.ts, issues: [42] } }))).toMatchObject({ issues: [{ number: 42 }] });
      expect(text(await client.callTool({ name: 'list_notes', arguments: { open: true } }))).toEqual([]);

      srv.store.mutateItem(item.id, [{ set: { status: 'PLAN_READY' } }], 'engine');
      expect(text(await client.callTool({ name: 'reject_plan', arguments: { id: item.id, message: 'Split the torches out.' } })).item.status).toBe('PLAN_IN_PROGRESS');
      srv.store.mutateItem(item.id, [{ set: { status: 'PLAN_READY' } }], 'engine');
      expect(text(await client.callTool({ name: 'approve_plan', arguments: { id: item.id, notes: 'Go.' } })).item.status).toBe('IN_PROGRESS');
      expect(text(await client.callTool({ name: 'close_as_done', arguments: { id: item.id, reason: 'landed in #9' } })).item.status).toBe('FINISHED');
      const activity = srv.store.requireItem(item.id).file.sections.find((s) => s.title === 'Activity')!.body;
      expect(activity).toMatch(/\[operator\] approval notes: Go\./);
      expect(activity).toMatch(/\[operator\] closed as done without a pull request: landed in #9/);
      expect(srv.store.journal.read({ type: 'operator_mcp.action' }).map((e) => e.data?.tool)).toEqual(['edit_item', 'reject_plan', 'approve_plan', 'close_as_done']);
      // A discard keeps the remote branch: its deletion is the user's tick on the board.
      expect(Object.keys(((await client.listTools()).tools.find((t) => t.name === 'discard_item')!.inputSchema as any).properties).sort()).toEqual(['id', 'reason']);
    } finally { await client.close(); await srv.engine.stop(); srv.server.close(); srv.store.close(); }
  });

  it('submit_item and move_item, behind operator_mcp.allow_submit: file it, queue it, park it, as the board does, recorded as [operator]', async () => {
    const { dataDir } = makeFixture();
    const port = await freePort();
    const srv = await startServer({ dataDir, port, log: () => {}, engineFactory: (s, em) => new MockEngine(s, em) });
    const client = new Client({ name: 'test', version: '1' });
    try {
      srv.store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_writes'], true); });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const names = async () => (await client.listTools()).tools.map((t) => t.name);
      // Filing never grants starting: submit and move need their own opt-in, and the instructions name it while it is off.
      for (const t of OPERATOR_SUBMIT_TOOLS) expect(await names()).not.toContain(t);
      expect(client.getInstructions()).toMatch(/never through planestro's HTTP API/);
      expect(client.getInstructions()).toMatch(/operator_mcp\.allow_submit \(submit_item, move_item\)/);
      srv.store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_submit'], true); });
      for (const t of OPERATOR_SUBMIT_TOOLS) expect(await names()).toContain(t);

      // "File it and queue it": create_item, then submit_item.
      const made = text(await client.callTool({ name: 'create_item', arguments: { title: 'Clip editor' } }));
      const queued = text(await client.callTool({ name: 'submit_item', arguments: { id: made.id } }));
      expect(queued).toMatchObject({ said: `${made.id} is queued for planning`, item: { status: 'QUEUED' } });
      expect((await client.callTool({ name: 'submit_item', arguments: { id: made.id } })).isError).toBe(true);

      // Waiting on an unmerged dependency is refused, as on the board.
      const dep = srv.store.createItem({ title: 'Renderer' });
      const waits = srv.store.createItem({ title: 'Exporter', depends_on: [dep.id] });
      const refused = await client.callTool({ name: 'submit_item', arguments: { id: waits.id } });
      expect(refused.isError).toBe(true);
      expect(text(refused).error).toMatch(/not all merged yet/);

      // Into the Icebox and back; a submit from there says what to do first.
      expect(text(await client.callTool({ name: 'move_item', arguments: { id: made.id, to: 'icebox' } })).item.status).toBe('ICEBOX');
      expect(text(await client.callTool({ name: 'submit_item', arguments: { id: made.id } })).error).toMatch(/move_item it to backlog first/);
      expect(text(await client.callTool({ name: 'move_item', arguments: { id: made.id, to: 'backlog' } })).item.status).toBe('NOT_YET_SUBMITTED');
      expect((await client.callTool({ name: 'move_item', arguments: { id: made.id, to: 'backlog' } })).isError).toBe(true);
      // Order within a column; before/after need an item beside it.
      expect((await client.callTool({ name: 'move_item', arguments: { id: made.id, to: 'before' } })).isError).toBe(true);
      expect(text(await client.callTool({ name: 'move_item', arguments: { id: made.id, to: 'before', ref: dep.id } })).said).toMatch(/moved before/);

      // Started work leaves only through a discard.
      srv.store.mutateItem(dep.id, [{ set: { status: 'IN_PROGRESS' } }], 'engine');
      expect(text(await client.callTool({ name: 'move_item', arguments: { id: dep.id, to: 'icebox' } })).error).toMatch(/discard_item/);
      expect(srv.store.requireItem(dep.id).file.frontmatter.status).toBe('IN_PROGRESS');

      const activity = srv.store.requireItem(made.id).file.sections.find((s) => s.title === 'Activity')!.body;
      expect(activity).toMatch(/\[operator\] status NOT_YET_SUBMITTED → QUEUED/);
      expect(activity).toMatch(/\[operator\] status QUEUED → ICEBOX/);
      expect(activity).not.toMatch(/\[user\]/);
      expect(srv.store.journal.read({ type: 'operator_mcp.action' }).map((e) => [e.data?.tool, e.data?.to])).toEqual([['submit_item', undefined], ['move_item', 'icebox'], ['move_item', 'backlog'], ['move_item', 'before']]);
    } finally { await client.close(); await srv.engine.stop(); srv.server.close(); srv.store.close(); }
  });

  it('knows an operator endpoint by a recorded instance\'s port, and leaves other local MCP servers alone', () => {
    const live = [{ port: 4300 }, { port: 4301 }];
    for (const host of ['0.0.0.0', '0', '[::]', '127.0.0.1']) expect(operatorMcpUrl(`http://${host}:4300/mcp`, live)).toBe(true);
    expect(operatorMcpUrl('http://localhost:4301/mcp/', live)).toBe(true);
    expect(operatorMcpUrl('http://127.0.0.1:4300/api/state', live)).toBe(false);
    expect(operatorMcpUrl('http://127.0.0.1:9000/mcp', live)).toBe(false); // somebody's own local MCP server
    expect(operatorMcpUrl('https://mcp.example.com/mcp', live)).toBe(false);
    expect(operatorMcpUrl('not a url', live)).toBe(false);
  });
});

describe('worker isolation: no worker or orchestrator session can list or call an operator tool (#175)', () => {
  beforeEach(() => { seen.options.length = 0; seen.tools.length = 0; });
  const noop = async () => 'ok';
  const turn = {
    itemId: 'TP-1', phase: 'implement', cwd: '/tmp', prompt: 'go', systemAppend: '', extraDirs: [], allowedTools: [], permissionMode: 'default',
    tools: { submit_plan: noop, submit_breakdown: noop, add_note: noop, append_activity: noop, report_done: noop, report_progress: noop, report_blocked: noop, hand_off: noop, get_item: noop },
    onQuestion: async () => {}, onOutput: () => {}, onPermission: async () => ({ behavior: 'deny', message: 'x' }),
    mcpServers: { sounds: { type: 'http', url: 'https://sounds.example/mcp' } },
  };

  it('a worker turn: only planestro\'s in-process server and the model\'s own, and no user-scope or project MCP config', async () => {
    await new LiveClaudePort().runTurn(turn as any);
    const o = seen.options[0];
    // strictMcpConfig: servers registered with `claude mcp add --scope user` (or a project's .mcp.json) are not loaded.
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settingSources).not.toContain('user');
    expect(Object.keys(o.mcpServers).sort()).toEqual(['planestro', 'sounds']);
    expect(typeof o.canUseTool).toBe('function');   // a worker's permissions go through the callback
    // planestro's worker server has its own tools, none of the operator's backlog-wide ones
    expect(seen.tools[0]).toContain('report_done');
    // (get_item is also a worker tool of its own: the item it is working on, not the backlog.)
    for (const name of OPERATOR_TOOLS.filter((t) => t !== 'get_item')) expect(seen.tools[0]).not.toContain(name);
  });

  it('an orchestrator turn the same', async () => {
    await new LiveClaudePort().runCustomTurn({ label: 'orchestrator', cwd: '/tmp', model: 'm', permissionMode: 'dontAsk', prompt: 'wake', systemAppend: '', allowedTools: [], mcpTools: [{ name: 'list_items_for_triage', description: '', schema: {}, handler: noop } as any], onOutput: () => {} });
    const o = seen.options[0];
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settingSources).not.toContain('user');
    expect(Object.keys(o.mcpServers)).toEqual(['planestro']);
    // dontAsk never consults canUseTool, so none is passed and the SDK prints no CAN_USE_TOOL_SHADOWED (#473)
    expect('canUseTool' in o).toBe(false);
  });
});
