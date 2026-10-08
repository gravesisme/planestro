/**
 * Worker MCP servers from Settings (#237): add, edit, turn off, remove, test, and import from
 * Claude Code's `~/.claude.json` and Codex's `~/.codex/config.toml`. They live in
 * planestro.local.yml (machine-local, gitignored); their env values and headers are keys, so
 * nothing here returns or logs one: the page sends new values and learns only names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalConfig } from '@planestro/shared';
import type { DataStore } from './store/DataStore.ts';

export type McpServer = LocalConfig['mcp_servers'][string];

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FIELDS = new Set(['command', 'args', 'env', 'url', 'headers', 'enabled']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Add or change one server. Fields left out keep their value; `env` and `headers` are patches:
 * a value replaces, `null` removes, an empty string keeps what is there (the page never had it).
 * A `url` makes it an HTTP server and a `command` a stdio one, dropping the other kind's fields.
 */
export function putMcpServer(store: DataStore, name: string, body: unknown): LocalConfig {
  if (!NAME.test(name)) throw new Error('an MCP server name is letters, digits, dashes and underscores');
  if (!isObj(body)) throw new Error('expected an MCP server');
  const extra = Object.keys(body).filter((k) => !FIELDS.has(k));
  if (extra.length) throw new Error(`${extra.join(', ')}: not a field Settings sets`);
  const was = store.local.mcp_servers[name];
  const s: McpServer = was ? structuredClone(was) : { args: [], env: {}, headers: {} };
  const text = (k: string) => { const v = body[k]; if (v !== undefined && v !== null && typeof v !== 'string') throw new Error(`${k}: expected text`); return typeof v === 'string' ? v.trim() : v; };
  const url = text('url'); const command = text('command');
  if (url && command) throw new Error('a server has a command or a url, not both');
  if (url) { s.url = url; delete s.command; s.args = []; s.env = {}; }
  else if (url === null || url === '') delete s.url;
  if (command) { s.command = command; delete s.url; s.headers = {}; }
  else if (command === null || command === '') delete s.command;
  if (body.args !== undefined) {
    if (!Array.isArray(body.args) || body.args.some((a) => typeof a !== 'string')) throw new Error('args: expected a list of text');
    s.args = body.args as string[];
  }
  for (const [field, re] of [['env', ENV_KEY], ['headers', HEADER]] as const) {
    const patch = body[field];
    if (patch === undefined) continue;
    if (!isObj(patch)) throw new Error(`${field}: expected names with values`);
    const next = { ...s[field] };
    for (const [k0, v] of Object.entries(patch)) {
      const k = k0.trim();
      if (!re.test(k)) throw new Error(`${field}: "${k}" is not a valid name`);
      if (v === null) delete next[k];
      else if (typeof v !== 'string') throw new Error(`${field}.${k}: expected text`);
      else if (v.trim()) next[k] = v.trim();
      else if (!(k in next)) throw new Error(`${field}.${k}: needs a value`);
    }
    s[field] = next;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled: expected on or off');
    if (body.enabled) delete s.enabled; else s.enabled = false;
  }
  if (!s.command && !s.url) throw new Error(`${name}: needs a command (a stdio server) or a url (an HTTP one)`);
  if (s.url) { try { if (!/^https?:$/.test(new URL(s.url).protocol)) throw new Error(); } catch { throw new Error('url: expected an http(s) address'); } }
  return write(store, { ...store.local.mcp_servers, [name]: s });
}

/** Remove a server no model names. One that was imported leaves a marker, so an import does not bring it back. */
export function removeMcpServer(store: DataStore, name: string): LocalConfig {
  const s = store.local.mcp_servers[name];
  if (!s) throw new Error(`no MCP server ${name} on this machine`);
  const users = store.config.models.filter((m) => m.mcp.includes(name)).map((m) => m.label);
  if (users.length) throw new Error(`${users.join(', ')} ${users.length > 1 ? 'name' : 'names'} ${name} in ${users.length > 1 ? 'their' : 'its'} MCP list: take it off there first, or turn the server off`);
  const { [name]: _gone, ...rest } = store.local.mcp_servers;
  const skip = s.source ? [...new Set([...(store.local.mcp_import_skip ?? []), `${s.source}:${name}`])] : store.local.mcp_import_skip;
  return write(store, rest, skip);
}

function write(store: DataStore, servers: LocalConfig['mcp_servers'], skip = store.local.mcp_import_skip): LocalConfig {
  const parsed = LocalConfig.safeParse({ ...store.local, mcp_servers: servers, mcp_import_skip: skip });
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return store.updateLocal({ mcp_servers: parsed.data.mcp_servers, ...(skip ? { mcp_import_skip: skip } : {}) });
}

// ---- test connection

/**
 * Connect the way a session would and list the server's tools. A stdio server is started with its
 * env on top of the SDK's default environment; the error says why, with every key it was given cut out.
 */
export async function testMcpServer(spec: McpServer, timeoutMs = 20_000): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
  const secrets = [...Object.values(spec.env ?? {}), ...Object.values(spec.headers ?? {})].filter((v) => v.length >= 4);
  const scrub = (m: string) => secrets.reduce((t, v) => t.split(v).join('…'), m);
  const client = new Client({ name: 'planestro-settings', version: '1' });
  let stderr = '';
  const transport = spec.url
    ? new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } })
    : new StdioClientTransport({ command: spec.command!, args: spec.args, env: { ...getDefaultEnvironment(), ...spec.env }, stderr: 'pipe' });
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-400); });
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = (async () => { await client.connect(transport); return (await client.listTools()).tools.map((t) => t.name); })();
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); });
    return { ok: true, tools: await Promise.race([run, timeout]) };
  } catch (e) {
    const why = (e as Error).message ?? String(e);
    return { ok: false, error: scrub(stderr.trim() ? `${why} — ${stderr.trim()}` : why) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

// ---- import

export interface ImportCandidate {
  source: string;
  name: string;
  kind: 'stdio' | 'http';
  command?: string;
  url?: string;
  /** Names only: the values are keys. */
  env: string[];
  headers: string[];
  /** new: can be imported; present: this machine has a server by that name; duplicate: an earlier source has it;
   * removed: you removed it after importing it; unsupported: planestro cannot run it (`note` says why). */
  status: 'new' | 'present' | 'duplicate' | 'removed' | 'unsupported';
  note?: string;
}

interface Found { candidate: ImportCandidate; spec?: McpServer }

const CLAUDE = '~/.claude.json';
const CODEX = '~/.codex/config.toml';

export interface ImportHome { home: string; codexHome: string }
/** The home folder an import reads, from the environment at the time of the request. */
export const importHome = (): ImportHome => { const home = process.env.HOME || homedir(); return { home, codexHome: process.env.CODEX_HOME || join(home, '.codex') }; };

function scan(store: DataStore, at: ImportHome): Found[] {
  const out: Found[] = [];
  const add = (source: string, name: string, raw: Record<string, unknown>, map: (r: Record<string, unknown>) => { spec?: McpServer; note?: string }) => {
    const { spec, note } = map(raw);
    const strs = (v: unknown) => (isObj(v) ? Object.keys(v) : []);
    const candidate: ImportCandidate = {
      source, name, kind: spec?.url || typeof raw.url === 'string' ? 'http' : 'stdio',
      ...(typeof raw.command === 'string' ? { command: raw.command } : {}), ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
      env: strs(raw.env), headers: strs(raw.headers ?? raw.http_headers),
      status: !spec || !NAME.test(name) ? 'unsupported'
        : (store.local.mcp_import_skip ?? []).includes(`${source}:${name}`) ? 'removed'
        : store.local.mcp_servers[name] ? 'present'
        : out.some((f) => f.candidate.name === name && f.spec) ? 'duplicate' : 'new',
      ...(note ? { note } : !NAME.test(name) ? { note: 'its name has characters planestro does not allow' } : {}),
    };
    out.push({ candidate, spec });
  };
  const strRecord = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean').map(([k, x]) => [k, String(x)])) : {});
  const args = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

  const claudePath = join(at.home, '.claude.json');
  if (existsSync(claudePath)) {
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(readFileSync(claudePath, 'utf8')); } catch { throw new Error(`${CLAUDE} could not be read as JSON`); }
    const project = isObj(json.projects) ? json.projects[store.codeRepoPath()] : undefined;
    const servers = { ...(isObj(json.mcpServers) ? json.mcpServers : {}), ...(isObj(project) && isObj(project.mcpServers) ? project.mcpServers : {}) };
    for (const [name, raw] of Object.entries(servers)) if (isObj(raw)) add(CLAUDE, name, raw, (r) => {
      const type = typeof r.type === 'string' ? r.type : r.url ? 'http' : 'stdio';
      if (type === 'stdio' && typeof r.command === 'string') return { spec: { command: r.command, args: args(r.args), env: strRecord(r.env), headers: {}, source: CLAUDE } };
      if (type === 'http' && typeof r.url === 'string') return { spec: { url: r.url, args: [], env: {}, headers: strRecord(r.headers), source: CLAUDE } };
      return { note: type === 'sse' ? 'an SSE server: planestro runs stdio and HTTP ones' : `a ${type} server: planestro runs stdio and HTTP ones` };
    });
  }

  const codexPath = join(at.codexHome, 'config.toml');
  if (existsSync(codexPath)) {
    let toml: Record<string, unknown>;
    try { toml = parseTomlSubset(readFileSync(codexPath, 'utf8')); } catch (e) { throw new Error(`${CODEX} could not be read: ${(e as Error).message}`); }
    for (const [name, raw] of Object.entries(isObj(toml.mcp_servers) ? toml.mcp_servers : {})) if (isObj(raw)) add(CODEX, name, raw, (r) => {
      const off = r.enabled === false ? { enabled: false } : {};
      const bearer = typeof r.bearer_token_env_var === 'string' ? `reads its token from $${r.bearer_token_env_var}: add an Authorization header after importing` : undefined;
      if (typeof r.command === 'string') return { spec: { command: r.command, args: args(r.args), env: strRecord(r.env), headers: {}, ...off, source: CODEX } };
      if (typeof r.url === 'string') return { spec: { url: r.url, args: [], env: {}, headers: strRecord(r.http_headers), ...off, source: CODEX }, note: bearer };
      return { note: 'it has neither a command nor a url' };
    });
  }
  return out;
}

/** What an import would bring in, by name and source: never a key's value. */
export function importCandidates(store: DataStore, at: ImportHome = importHome()): ImportCandidate[] {
  return scan(store, at).map((f) => f.candidate);
}

/** Import the new servers (all of them, or those `pick`ed as `<source>:<name>`), in one write. */
export function importMcpServers(store: DataStore, body: unknown, at: ImportHome = importHome()): { local: LocalConfig; added: string[] } {
  const pick = isObj(body) && Array.isArray(body.pick) ? new Set(body.pick.filter((p): p is string => typeof p === 'string')) : undefined;
  const take = scan(store, at).filter((f) => f.spec && f.candidate.status === 'new' && (!pick || pick.has(`${f.candidate.source}:${f.candidate.name}`)));
  if (!take.length) return { local: store.local, added: [] };
  const local = write(store, { ...store.local.mcp_servers, ...Object.fromEntries(take.map((f) => [f.candidate.name, f.spec!])) });
  return { local, added: take.map((f) => f.candidate.name) };
}

// ---- the part of TOML a Codex config uses

/**
 * A TOML reader for what Codex's config.toml holds: tables (`[a.b]`, `[a."b c"]`), dotted keys,
 * basic and literal strings, arrays across lines, inline tables, booleans and numbers. Arrays of
 * tables (`[[x]]`) are skipped. Throws on what it cannot read.
 */
export function parseTomlSubset(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table: Record<string, unknown> | undefined = root;
  let i = 0;
  const fail = (what: string): never => { throw new Error(`line ${text.slice(0, i).split('\n').length}: ${what}`); };
  const ws = () => { for (;;) { const c = text[i]; if (c === ' ' || c === '\t' || c === '\r') i++; else if (c === '#') { while (i < text.length && text[i] !== '\n') i++; } else return; } };
  const wsnl = () => { for (;;) { ws(); if (text[i] === '\n') i++; else return; } };
  const str = (): string => {
    const q = text[i];
    if (text.startsWith(q.repeat(3), i)) {
      i += 3; const end = text.indexOf(q.repeat(3), i); if (end < 0) fail('an unclosed string');
      let s = text.slice(i, end); i = end + 3; if (s.startsWith('\n')) s = s.slice(1);
      return q === '"' ? unescape(s) : s;
    }
    i++;
    let s = '';
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\n') fail('an unclosed string');
      if (q === '"' && text[i] === '\\') { s += text.slice(i, i + 2); if (text[i + 1] === 'u') { s += text.slice(i + 2, i + 6); i += 4; } else if (text[i + 1] === 'U') { s += text.slice(i + 2, i + 10); i += 8; } i += 2; }
      else s += text[i++];
    }
    if (text[i] !== q) fail('an unclosed string');
    i++;
    return q === '"' ? unescape(s) : s;
  };
  const unescape = (s: string) => s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' } as Record<string, string>)[e] ?? fail(`an unknown escape \\${e}`));
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      ws();
      if (text[i] === '"' || text[i] === "'") parts.push(str());
      else { const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i)); if (!m) fail('a key was expected'); parts.push(m![0]); i += m![0].length; }
      ws();
      if (text[i] === '.') { i++; continue; }
      return parts;
    }
  };
  const at = (obj: Record<string, unknown>, path: string[]): Record<string, unknown> => {
    let cur = obj;
    for (const p of path) { if (!isObj(cur[p])) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
    return cur;
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++; const arr: unknown[] = [];
      for (;;) { wsnl(); if (text[i] === ']') { i++; return arr; } arr.push(value()); wsnl(); if (text[i] === ',') i++; else if (text[i] !== ']') fail('"," or "]" was expected'); }
    }
    if (c === '{') {
      i++; const obj: Record<string, unknown> = {};
      for (;;) { ws(); if (text[i] === '}') { i++; return obj; } const k = key(); if (text[i] !== '=') fail('"=" was expected'); i++; at(obj, k.slice(0, -1))[k.at(-1)!] = value(); ws(); if (text[i] === ',') i++; else if (text[i] !== '}') fail('"," or "}" was expected'); }
    }
    const m = /^[^\s,\]}#]+/.exec(text.slice(i));
    if (!m) fail('a value was expected');
    i += m![0].length;
    if (m![0] === 'true') return true;
    if (m![0] === 'false') return false;
    const n = Number(m![0].replace(/_/g, ''));
    return Number.isFinite(n) ? n : m![0];
  };
  for (;;) {
    wsnl();
    if (i >= text.length) return root;
    if (text[i] === '[') {
      const many = text[i + 1] === '[';
      i += many ? 2 : 1;
      const k = key();
      if (!text.startsWith(many ? ']]' : ']', i)) fail('"]" was expected');
      i += many ? 2 : 1;
      table = many ? undefined : at(root, k);
    } else {
      const k = key();
      if (text[i] !== '=') fail('"=" was expected');
      i++;
      const v = value();
      if (table) at(table, k.slice(0, -1))[k.at(-1)!] = v;
    }
    ws();
    if (i < text.length && text[i] !== '\n') fail('the line goes on after its value');
  }
}
