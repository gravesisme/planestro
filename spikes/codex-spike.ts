#!/usr/bin/env -S npx tsx
/**
 * Codex CLI spike — the questions planestro's Codex runner depends on. Findings live in
 * docs/notes/codex-spike.md; packages/server/src/compat.ts pins the version this validated.
 *
 *   npm run spike:codex -- <step> [<step>…]     steps: basic i2i sandbox resume-missing kill-resume agents-md catalogue
 *
 * Runs real Codex sessions (your login, your quota) in a throwaway repo under spikes/out/codex.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT = join(import.meta.dirname, 'out', 'codex');
const REPO = join(OUT, 'repo');
const SCHEMA = join(OUT, 'schema.json');
const STATE = join(OUT, 'state.json');
const state: Record<string, string> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

interface Run { code: number | null; signal: string | null; events: any[]; last?: any; stderr: string; ms: number }

/** One `codex exec`. stdin is ignored on purpose: with a pipe Codex waits on it forever. */
function codex(args: string[], prompt: string, opts: { killAfterMs?: number; schema?: boolean } = {}): Promise<Run> {
  const lastFile = join(OUT, `last-${Date.now()}.json`);
  const full = ['exec', ...args, '--json', '-o', lastFile, ...(opts.schema === false ? [] : ['--output-schema', SCHEMA]), prompt];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('codex', full, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (opts.killAfterMs) setTimeout(() => child.kill('SIGTERM'), opts.killAfterMs);
    child.on('close', (code, signal) => {
      const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { type: 'unparsed', raw: l }; } });
      let last: any; try { last = JSON.parse(readFileSync(lastFile, 'utf8')); } catch { /* no final message */ }
      resolve({ code, signal, events, last, stderr: err, ms: Date.now() - t0 });
    });
  });
}

function report(step: string, r: Run, extra: Record<string, unknown> = {}) {
  const types = new Map<string, number>();
  for (const e of r.events) { const k = e.item?.type ? `${e.type}:${e.item.type}` : e.type; types.set(k, (types.get(k) ?? 0) + 1); }
  const summary = { step, exit: r.code, signal: r.signal, seconds: Math.round(r.ms / 1000), thread: r.events.find((e) => e.type === 'thread.started')?.thread_id, last: r.last, events: Object.fromEntries(types), errors: r.events.filter((e) => /error|failed/.test(e.type)).map((e) => e.message ?? e.error ?? e), stderrTail: r.stderr.split('\n').filter((l) => l && !/rmcp::transport/.test(l)).slice(-3), ...extra };
  writeFileSync(join(OUT, `${step}.json`), JSON.stringify({ summary, events: r.events }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function setup() {
  if (existsSync(join(REPO, '.git'))) return;
  mkdirSync(REPO, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', REPO, '-c', 'user.name=spike', '-c', 'user.email=spike@planestro.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(REPO, 'AGENTS.md'), '# Rules\n\nEnd the `summary` of every final message with the single word WALRUS.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
}

const STEPS: Record<string, () => Promise<void>> = {
  async basic() {
    const r = await codex(['-s', 'workspace-write', '-C', REPO], 'Create hello.txt containing the single word PELICAN and commit it. Then, using your built-in image generation tool (not code), generate a small game icon of a red health potion on a transparent background and save it as potion.png (do not commit it). Reply per the schema.');
    const s = report('basic', r, { potion: existsSync(join(REPO, 'potion.png')) });
    if (s.thread) { state.thread = s.thread; save(); }
  },
  async i2i() {
    if (!existsSync(join(REPO, 'potion.png'))) throw new Error('run `basic` first (needs potion.png)');
    const r = await codex(['-s', 'workspace-write', '-C', REPO, '-i', join(REPO, 'potion.png')], 'The attached image is potion.png. Using your built-in image generation/editing tool (not code, not a drawing script), produce an EDITED version of THAT image: the same bottle, cork and pose, but the liquid is blue instead of red. Save it as potion_blue.png. In the summary say plainly whether your tool edited from the attached image or only generated a new image from a text description of it.');
    report('i2i', r, { produced: existsSync(join(REPO, 'potion_blue.png')) });
  },
  async sandbox() {
    const outside = join(homedir(), '.planestro-codex-spike-outside.txt');
    rmSync(outside, { force: true });
    const r = await codex(['-s', 'workspace-write', '-C', REPO], `Do these two things and report exactly what happened for each, including any error text: (1) write the word OUTSIDE to the file ${outside}; (2) run: curl -sS -m 10 https://example.com -o /dev/null -w "%{http_code}". Do not try to work around a refusal. Reply per the schema.`);
    report('sandbox', r, { wroteOutside: existsSync(outside) });
    rmSync(outside, { force: true });
  },
  async 'resume-missing'() {
    const r = await codex(['resume', '00000000-0000-7000-8000-000000000000'], 'Say hello per the schema.', { schema: false });
    report('resume-missing', r);
  },
  async 'kill-resume'() {
    const r1 = await codex(['-s', 'workspace-write', '-C', REPO], 'Remember the codeword HERON. Then count slowly from 1 to 40 by running `sleep 2; echo N` once per number, one command per number. Reply per the schema when finished.', { killAfterMs: 25_000 });
    const s1 = report('kill', r1);
    if (!s1.thread) return;
    const r2 = await codex(['resume', s1.thread], 'You were interrupted. Do not continue counting. What was the codeword? Reply per the schema.', { schema: false });
    report('kill-resume', r2);
  },
  async 'agents-md'() {
    const a = await codex(['-s', 'read-only', '-C', REPO], 'Reply per the schema with outcome done and a one-sentence summary of what this repository is.');
    report('agents-md-default', a);
    const b = await codex(['-s', 'read-only', '-C', REPO, '--ignore-user-config'], 'Reply per the schema with outcome done and a one-sentence summary of what this repository is.');
    report('agents-md-ignore-user-config', b, { mcpNoise: /rmcp::transport/.test(b.stderr) });
  },
  async catalogue() {
    const seen = new Map<string, unknown>();
    for (const f of ['basic', 'i2i', 'sandbox', 'kill', 'kill-resume', 'agents-md-default']) {
      const p = join(OUT, `${f}.json`); if (!existsSync(p)) continue;
      for (const e of JSON.parse(readFileSync(p, 'utf8')).events) { const k = e.item?.type ? `${e.type}:${e.item.type}` : e.type; if (!seen.has(k)) seen.set(k, e); }
    }
    for (const [k, e] of seen) console.log(k, '\n  ', JSON.stringify(e).slice(0, 400));
  },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(SCHEMA, JSON.stringify({ type: 'object', properties: { outcome: { type: 'string', enum: ['done', 'blocked', 'question'] }, summary: { type: 'string' }, question: { type: ['string', 'null'] } }, required: ['outcome', 'summary', 'question'], additionalProperties: false }));
setup();
console.log(execFileSync('codex', ['--version']).toString().trim());
for (const step of process.argv.slice(2)) {
  if (!STEPS[step]) { console.error(`unknown step ${step}; steps: ${Object.keys(STEPS).join(' ')}`); process.exit(2); }
  console.log(`\n=== ${step}`);
  await STEPS[step]();
}
