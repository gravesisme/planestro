import { it, expect, vi, beforeEach } from 'vitest';
import { externalTools } from '../src/engine/sessions/externalTools.ts';
import { ScopedTools } from '../src/engine/sessions/CodexAppServerPort.ts';
import type { TurnOptions } from '../src/engine/ports.ts';
const calls = vi.hoisted(() => ({ forwarded: 0, closed: 0, connected: 0 }));
vi.mock('../src/instances.ts', () => ({ listInstances: () => ({ live: [{ port: 4300, url: 'http://machine.example.test:4300' }] }) }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  async connect() { calls.connected++; }
  async listTools() { return { tools: [{ name: 'create', description: 'Create a resource', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false } }] }; }
  async callTool() { calls.forwarded++; return { content: [{ type: 'text', text: 'created' }] }; }
  async close() { calls.closed++; }
} }));
beforeEach(() => { calls.forwarded = calls.closed = calls.connected = 0; });
const base = { phase: 'implement', mcpServers: { service: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'parent-only-secret' } } } } as unknown as TurnOptions;
it('enforces external permission/call budgets before forwarding, scopes calls, and closes turn clients', async () => {
  let used = 0, parked = false;
  const bridge = await externalTools({ ...base, onPermission: async () => ++used <= 1 ? { action: 'allow' } : { action: 'park' } }, () => { parked = true; });
  const scope = new ScopedTools('thread', 'turn', bridge.tools);
  const request = { threadId: 'thread', turnId: 'turn', callId: 'one', tool: 'mcp__service__create', arguments: { prompt: 'synthetic' } };
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
it.each(['http://127.0.0.1:4300/mcp', 'http://localhost:4300/mcp/', 'http://[::1]:4300/mcp', 'http://machine.example.test:4300/mcp', 'http://private-alias.test:4300/mcp'])('rejects operator aliases before making a client: %s', async (url) => {
  await expect(externalTools({ ...base, operatorHosts: ['private-alias.test'], mcpServers: { otherName: { type: 'http', url } } })).rejects.toThrow('operator');
  expect(calls.connected).toBe(0);
});
it('does not offer external services to a read-only planner or expose operator tools', async () => {
  await expect(externalTools({ ...base, phase: 'plan' })).rejects.toThrow('read-only');
  const bridge = await externalTools({ ...base, onPermission: async () => ({ action: 'deny', message: 'Denied' }) });
  expect(bridge.tools.map((t) => t.name)).toEqual(['mcp__service__create']);
  await bridge.close();
});
