#!/usr/bin/env node
// The plugin's MCP server: a stdio bridge to the operator endpoint (/mcp) of THIS project's running planestro.
//
// A fixed URL (`${PLANESTRO_URL:-http://127.0.0.1:4300}/mcp`) sent every Claude Code session to whichever server held
// 4300: a session in Lake Monomonac read Hurricane Harrison's backlog (LM-71, LM-72). The project is found as the
// script's `locate` finds it (planestro.yml or planning/planestro.yml up from the session's directory, a linked
// worktree's main checkout), and its server from the record `planestro start` keeps beside it
// (<data dir>/.planestro/instance.json), read on every message, so a server started, moved or restarted after the
// session began is still the one reached. The record's pid is no evidence (a start that found the server already up
// left one naming a process long gone), so the server is asked instead: its initialize answer names the data dir it
// serves, and another project's is refused. PLANESTRO_URL, when set, wins.
//
// The endpoint is stateless streamable HTTP with JSON responses: each JSON-RPC line from stdin is one POST, and its
// answer one line on stdout. A notification gets 202 and no answer.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'planestro');
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** This project's data dir, or undefined outside a planestro project. */
export function dataDir(cwd = projectDir) {
  try { return execFileSync(SCRIPT, ['locate'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
}

/** Where to send: PLANESTRO_URL, else the running instance recorded in the data dir; or why there is nowhere. */
export function target(env = process.env, cwd = projectDir) {
  if (env.PLANESTRO_URL) return { url: `${env.PLANESTRO_URL.replace(/\/+$/, '')}/mcp` };
  const data = dataDir(cwd);
  if (!data) return { why: `no planestro project at ${cwd} (no planestro.yml or planning/planestro.yml); set PLANESTRO_URL to reach a server` };
  let rec;
  try { rec = JSON.parse(readFileSync(join(data, '.planestro', 'instance.json'), 'utf8')); } catch { /* none */ }
  if (!rec?.url) return { why: `planestro has not been started for ${data}: start it (/planestro start, or the repo's start-planestro.sh)` };
  return { url: `${String(rec.url).replace(/\/+$/, '')}/mcp`, data };
}

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** One JSON-RPC message, answered from the server; with no server, initialize still succeeds so the session says why. */
async function forward(msg) {
  const t = target();
  if (!t.url) {
    if (msg.id === undefined) return;
    if (msg.method === 'initialize') return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'planestro', version: 'proxy' }, instructions: `No planestro backlog is reachable: ${t.why}.` } });
    if (msg.method === 'tools/list') return out({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
    return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: t.why } });
  }
  try {
    const r = await fetch(t.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(120_000) });
    if (msg.id === undefined) return;
    const body = await r.text();
    // A streamed answer carries its message on `data:` lines.
    const text = (r.headers.get('content-type') ?? '').includes('text/event-stream') ? body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).at(-1) ?? '' : body;
    if (!text) return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `${t.url} answered ${r.status} with nothing` } });
    const answer = JSON.parse(text);
    // The server on the recorded port must be this project's: its instructions name the data dir it serves.
    const says = answer.result?.instructions;
    if (msg.method === 'initialize' && t.data && typeof says === 'string' && !says.includes(`(${t.data})`)) {
      return out({ ...answer, result: { ...answer.result, capabilities: { tools: {} }, instructions: `No planestro backlog is reachable: ${t.url} serves another project ("${says.slice(0, 120)}"), not ${t.data}; start this project's server.` } });
    }
    out(answer);
  } catch (e) {
    if (msg.id === undefined) return;
    if (msg.method === 'initialize') return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'planestro', version: 'proxy' }, instructions: `No planestro backlog is reachable: planestro at ${t.url} did not answer (${e.message}); start it (/planestro start, or the repo's start-planestro.sh).` } });
    out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `planestro at ${t.url} did not answer: ${e.message}` } });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mcp-proxy.mjs')) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // Batches are not part of the current protocol; each message stands alone.
    void forward(msg);
  });
}
