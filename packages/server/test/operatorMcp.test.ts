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
import { OPERATOR_TOOLS, OPERATOR_READ_TOOLS, operatorMcpUrl } from '../src/routes/mcp.ts';
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
      expect(tools.map((t) => t.name).sort()).toEqual([...OPERATOR_TOOLS].sort());
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
  });
});
