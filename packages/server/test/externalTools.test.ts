import { it, expect, vi, beforeEach } from 'vitest';
import { externalTools } from '../src/engine/sessions/externalTools.ts';
import { ScopedTools } from '../src/engine/sessions/CodexAppServerPort.ts';
import type { TurnOptions } from '../src/engine/ports.ts';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolText } from '../src/engine/sessions/externalTools.ts';
const calls = vi.hoisted(() => ({ forwarded: 0, closed: 0, connected: 0, result: undefined as unknown }));
vi.mock('../src/instances.ts', () => ({ listInstances: () => ({ live: [{ port: 4300, url: 'http://machine.example.test:4300' }] }) }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  async connect() { calls.connected++; }
  async listTools() { return { tools: [{ name: 'create', description: 'Create a resource', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false } }] }; }
  async callTool() { calls.forwarded++; return calls.result ?? { content: [{ type: 'text', text: 'created' }] }; }
  async close() { calls.closed++; }
} }));
beforeEach(() => { calls.forwarded = calls.closed = calls.connected = 0; calls.result = undefined; });
const base = { phase: 'implement', mcpServers: { service: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'parent-only-secret' } } } } as unknown as TurnOptions;
it('enforces external permission/call budgets before forwarding, scopes calls, and closes turn clients', async () => {
  let used = 0, parked = false;
  const bridge = await externalTools({ ...base, onPermission: async () => ++used <= 1 ? { action: 'allow' } : { action: 'park' } }, () => { parked = true; });
  const scope = new ScopedTools('thread', 'turn', bridge.tools);
  const request = { threadId: 'thread', turnId: 'turn', callId: 'one', tool: 'service__create', arguments: { prompt: 'synthetic' } };
  await scope.call(request); await scope.call(request);
  expect(calls.forwarded).toBe(1); expect(used).toBe(1);
  expect(await scope.call({ ...request, callId: 'two' })).toContain('Recorded by planestro');
  expect(parked).toBe(true); expect(calls.forwarded).toBe(1);
  await expect(scope.call({ ...request, turnId: 'another' })).rejects.toThrow('foreign');
  expect(JSON.stringify(bridge.tools)).not.toContain('parent-only-secret');
  scope.close(); await bridge.close();
  await expect(scope.call(request)).rejects.toThrow('stale');
  expect(calls.closed).toBe(1);
});
it.each(['http://0.0.0.0:4300/mcp', 'http://0:4300/mcp', 'http://[::]:4300/mcp', 'http://127.0.0.1:4300/mcp', 'http://localhost:4300/mcp/', 'http://[::1]:4300/mcp', 'http://machine.example.test:4300/mcp', 'http://private-alias.test:4300/mcp'])('rejects operator aliases before making a client: %s', async (url) => {
  await expect(externalTools({ ...base, operatorHosts: ['private-alias.test'], mcpServers: { otherName: { type: 'http', url } } })).rejects.toThrow('operator');
  expect(calls.connected).toBe(0);
});
it('does not offer external services to a read-only planner or expose operator tools', async () => {
  await expect(externalTools({ ...base, phase: 'plan' })).rejects.toThrow('read-only');
  const bridge = await externalTools({ ...base, onPermission: async () => ({ action: 'deny', message: 'Denied' }) });
  expect(bridge.tools.map((t) => t.name)).toEqual(['service__create']);
  await bridge.close();
});
it("returns the tool's text, and a tool error as a failed call rather than a success (#366)", async () => {
  const bridge = await externalTools({ ...base, onPermission: async () => ({ action: 'allow' }) });
  const scope = new ScopedTools('thread', 'turn', bridge.tools);
  const request = { threadId: 'thread', turnId: 'turn', callId: 'one', tool: 'service__create', arguments: { prompt: 'synthetic' } };
  expect(await scope.call(request)).toBe('created');
  calls.result = { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] };
  await expect(scope.call({ ...request, callId: 'two' })).rejects.toThrow('service reported an error: quota exceeded');
  scope.close(); await bridge.close();
});
it('saves media to a file and names it, never base64 in the conversation (#366)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-media-'));
  const audio = Buffer.from('RIFF-fake-wav').toString('base64');
  const text = await toolText({ content: [{ type: 'text', text: 'Generated 1 take' }, { type: 'audio', data: audio, mimeType: 'audio/wav' }, { type: 'resource_link', uri: 'file:///x.mp3', name: 'take' }] }, 'service', dir);
  expect(text).not.toContain(audio);
  const file = /saved to (\S+\.wav);/.exec(text)?.[1];
  expect(file?.startsWith(dir)).toBe(true);
  expect(readFileSync(file!, 'utf8')).toBe('RIFF-fake-wav');
  expect(text).toContain('Generated 1 take');
  expect(text).toContain('[take: file:///x.mp3]');
  expect(await toolText({ content: [], structuredContent: { ok: 1 } }, 'service', dir)).toBe('{"ok":1}');
});
it("offers Codex names it accepts, never its reserved mcp__ prefix, and asks planestro under the MCP name (#366, Codex 0.162)", async () => {
  const asked: string[] = [];
  const bridge = await externalTools({ ...base, onPermission: async (r) => { asked.push(r.tool); return { action: 'allow' }; } });
  expect(bridge.tools.every((t) => t.name !== 'mcp' && !t.name.startsWith('mcp__') && /^[A-Za-z0-9_-]{1,128}$/.test(t.name))).toBe(true);
  const scope = new ScopedTools('thread', 'turn', bridge.tools);
  await scope.call({ threadId: 'thread', turnId: 'turn', callId: 'one', tool: 'service__create', arguments: { prompt: 'x' } });
  expect(asked).toEqual(['mcp__service__create']);
  scope.close(); await bridge.close();
  const { dynamicName } = await import('../src/engine/sessions/externalTools.ts');
  expect(dynamicName('mcp', 'x', [])).toBe('ext_mcp__x');
  expect(dynamicName('svc', 'a.b c', [])).toBe('svc__a_b_c');
  expect(dynamicName('svc', 'a.b', [{ name: 'svc__a_b' }])).toBe('svc__a_b_2');
});
