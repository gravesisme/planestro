import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveCodexPort, FINAL_SCHEMA, parseFinal, describeEvent, classifyFailure, gitWritableRoots } from '../src/engine/sessions/LiveCodexPort.ts';
import type { AgentTurnOptions, TurnTools } from '../src/engine/ports.ts';

/**
 * A stand-in `codex` that replays what spikes/codex-spike.ts recorded from the real CLI: it WAITS ON
 * STDIN like the real one (so a port that hands it a pipe hangs this test), streams NDJSON, writes
 * the `-o` file, exits 0 on SIGTERM without a final message, and fails a resume of an unknown thread.
 */
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const out = args[args.indexOf('-o') + 1];
const say = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
fs.writeFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(args));
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', run);
function run() {
  const resumeAt = args.indexOf('resume');
  if (resumeAt >= 0 && args[resumeAt + 1] === 'gone') { process.stderr.write('Error: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)\\n'); process.exit(1); }
  say({ type: 'thread.started', thread_id: resumeAt >= 0 ? args[resumeAt + 1] : 'thread-1' });
  say({ type: 'turn.started' });
  say({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Drawing the icon.' } });
  say({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'git add -A && git commit -m icon'", status: 'in_progress' } });
  say({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'x', aggregated_output: '', exit_code: 0 } });
  process.stdout.write('this line is not json\\n');
  if (/HANG/.test(prompt)) { process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); return; }
  say({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } });
  const final = /ASK/.test(prompt) ? { outcome: 'question', summary: 'need a call', question: 'Pixel art or painted?' }
    : /STUCK/.test(prompt) ? { outcome: 'blocked', summary: 'the sandbox refused the network', question: null }
    : /WAIT/.test(prompt) ? { outcome: 'done', summary: 'Generated icon.png and committed it.', question: null, hold: 'until the header art has merged' }
    : /GIVE/.test(prompt) ? { outcome: 'done', summary: 'Generated icon.png and committed it.', question: null, hand_off: { to: 'TP-2', paths: ['icon.png'], note: 'the icon' } }
    : { outcome: 'done', summary: 'Generated icon.png and committed it.', question: null };
  if (!/SILENT/.test(prompt)) fs.writeFileSync(out, JSON.stringify(final));
  process.exit(0);
}
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'planestro-fakecodex-'));
  const bin = join(dir, 'codex'); writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  process.env.FAKE_CODEX_ARGS = join(dir, 'args.json');
  const calls: string[] = []; const output: string[] = []; const questions: unknown[][] = [];
  const tools = { report_done: async (s: string, _parts?: unknown, hold?: string) => { calls.push(`done:${s}${hold ? ` (hold: ${hold})` : ''}`); return 'ok'; }, report_blocked: async (s: string) => { calls.push(`blocked:${s}`); return 'ok'; }, hand_off: async (to: string, paths: string[], note: string) => { calls.push(`hand_off:${to}:${paths.join(',')}:${note}`); return 'Delivered'; } } as unknown as TurnTools;
  const opts = (prompt: string, extra: Partial<AgentTurnOptions> = {}): AgentTurnOptions => ({ itemId: 'TP-1', phase: 'implement', cwd: dir, prompt, systemAppend: 'RULES', extraDirs: ['/data'], tools, onQuestion: async (q) => { questions.push(q); }, onOutput: (t) => output.push(t), ...extra });
  const args = () => JSON.parse(readFileSync(process.env.FAKE_CODEX_ARGS!, 'utf8')) as string[];
  return { port: new LiveCodexPort(bin), opts, calls, output, questions, args, dir };
}

describe('LiveCodexPort (against a recorded fake codex)', () => {
  it('runs a fresh turn sandboxed, never feeds stdin, streams readable output and reports done with tokens', async () => {
    const t = setup();
    const r = await t.port.runTurn(t.opts('draw it', { model: 'gpt-art', images: ['/ref/rig.png'] }));
    expect(r).toMatchObject({ subtype: 'success', isError: false, sessionId: 'thread-1', done: 'Generated icon.png and committed it.', tokens: 150, numTurns: 1, costUsd: 0 });
    expect(t.calls).toEqual(['done:Generated icon.png and committed it.']);
    const a = t.args();
    expect(a.slice(0, 5)).toEqual(['exec', '-s', 'workspace-write', '-C', t.dir]);
    for (const flag of ['--json', '--ignore-user-config', '--output-schema', '-m', '-i']) expect(a, flag).toContain(flag);
    expect(a).not.toContain('--add-dir');                       // it grants write access; the data dir stays read-only to a worker
    expect(a[a.length - 1]).toMatch(/^RULES\n\n## Your image tool\n[\s\S]*\$CODEX_HOME\/generated_images[\s\S]*\n\n---\n\ndraw it/);   // HH-274: its staging is not a write of the worker's
    // `-i` takes one or more files: without `--` the prompt after it is read as another image and codex waits on stdin
    expect(a[a.length - 2]).toBe('--');
    expect(a.indexOf('-i')).toBeLessThan(a.indexOf('--'));
    expect(t.output).toEqual(['Drawing the icon.', "→ 'git add -A && git commit -m icon'"]);
  });

  it("a linked worktree's git dirs are writable roots on fresh and resumed turns; the shared dir itself, config and hooks are not (HH-281)", async () => {
    const t = setup();
    expect(gitWritableRoots(t.dir)).toEqual([]);               // not a repository: nothing to add
    const repo = join(t.dir, 'repo'); mkdirSync(repo);
    const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    g(repo, 'init', '-q'); g(repo, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
    expect(gitWritableRoots(repo)).toEqual([]);                // its .git is inside the workspace already
    g(repo, 'worktree', 'add', '-q', '.claude/worktrees/w1', '-b', 'w1');
    const wt = join(repo, '.claude/worktrees/w1');
    const common = realpathSync(join(repo, '.git'));
    const roots = gitWritableRoots(wt);
    expect(roots).toEqual([join(common, 'worktrees/w1'), join(common, 'objects'), join(common, 'refs/heads'), join(common, 'logs/refs/heads')]);
    for (const opts of [t.opts('draw it', { cwd: wt }), t.opts('draw it', { cwd: wt, resume: 'thread-9' })]) {
      await t.port.runTurn(opts);
      const a = t.args();
      expect(a).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
      expect(a).not.toContain('--add-dir');                    // resume does not take it
    }
  });

  it('a hand_off in the final message reaches the tool before the outcome', async () => {
    const t = setup();
    const r = await t.port.runTurn(t.opts('GIVE it away'));
    expect(r.done).toBe('Generated icon.png and committed it.');
    expect(t.calls).toEqual(['hand_off:TP-2:icon.png:the icon', 'done:Generated icon.png and committed it.']);
    expect(FINAL_SCHEMA.required).toContain('hand_off'); // structured output: every property is required, so the field is always there (null when unused)
  });

  it('a hold in the final message reaches report_done; null or blank is no hold (#97)', async () => {
    const t = setup();
    const r = await t.port.runTurn(t.opts('WAIT for the art'));
    expect(r.done).toBe('Generated icon.png and committed it.');
    expect(t.calls).toEqual(['done:Generated icon.png and committed it. (hold: until the header art has merged)']);
    expect(FINAL_SCHEMA.required).toContain('hold');
    expect(FINAL_SCHEMA.properties.hold.type).toEqual(['string', 'null']);
    expect(parseFinal('{"outcome":"done","summary":"s","question":null,"hold":null}')?.hold).toBeUndefined();
    expect(parseFinal('{"outcome":"done","summary":"s","question":null,"hold":"  "}')?.hold).toBeUndefined();
    expect(parseFinal('{"outcome":"done","summary":"s","question":null,"hold":" until X "}')?.hold).toBe('until X');
  });

  it('resumes by thread id without re-stating the sandbox; a question parks, blocked reports', async () => {
    const t = setup();
    const q = await t.port.runTurn(t.opts('ASK', { resume: 'thread-9' }));
    expect(q).toMatchObject({ parked: 'question', sessionId: 'thread-9', isError: false });
    expect(t.questions[0]).toEqual([{ question: 'Pixel art or painted?', header: 'Codex asks', options: [] }]);
    const a = t.args();
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9']);
    expect(a).not.toContain('-s'); expect(a).not.toContain('-C');
    expect(a[a.indexOf('-c') + 1]).toBe('sandbox_mode="workspace-write"'); // a resumed thread comes back read-only otherwise
    expect(a).toContain('--output-schema');
    const b = await t.port.runTurn(t.opts('STUCK'));
    expect(b.blocked).toBe('the sandbox refused the network');
    expect(t.calls).toEqual(['blocked:the sandbox refused the network']);
  });

  it('abort is "killed" although codex exits 0; silence is an error; a lost thread and a missing binary say so', async () => {
    const t = setup();
    const ac = new AbortController();
    // Aborted once the turn is under way (its first readable line), not on a timer: under the full suite's load a
    // 300 ms timer fired before the fake had even started its thread (#144).
    expect(await t.port.runTurn(t.opts('HANG', { signal: ac.signal, onOutput: () => ac.abort() }))).toMatchObject({ subtype: 'killed', isError: false, sessionId: 'thread-1' });
    expect(await t.port.runTurn(t.opts('SILENT'))).toMatchObject({ subtype: 'no_final_message', isError: true });
    expect(await t.port.runTurn(t.opts('x', { resume: 'gone' }))).toMatchObject({ subtype: 'session_lost', isError: true });
    expect(await new LiveCodexPort('/nonexistent/codex').runTurn(t.opts('x'))).toMatchObject({ subtype: 'spawn_error', isError: true });
    expect(t.calls).toEqual([]);
  });

  it('pure helpers: final-message parsing is lenient, failures are classified, unknown events are skipped', () => {
    expect(parseFinal('{"outcome":"done","summary":"s","question":null}')).toEqual({ outcome: 'done', summary: 's', question: null, hand_off: null });
    expect(parseFinal('{"outcome":"done","summary":"s","question":null,"hand_off":{"to":"TP-2","paths":["a.png"],"note":"n"}}')!.hand_off).toEqual({ to: 'TP-2', paths: ['a.png'], note: 'n' });
    expect(parseFinal('{"outcome":"done","summary":"s","question":null,"hand_off":{"to":"TP-2"}}')!.hand_off).toBeNull(); // malformed: ignored, never thrown
    expect(parseFinal('{"outcome":"maybe","summary":"s"}')).toBeUndefined();
    expect(parseFinal('not json')).toBeUndefined(); expect(parseFinal(undefined)).toBeUndefined();
    expect(classifyFailure('ERROR: 401 Unauthorized').subtype).toBe('auth_required');
    expect(classifyFailure('You have hit your usage limit').subtype).toBe('rate_limited');
    expect(classifyFailure('rmcp::transport noise\nsomething else broke').subtype).toBe('error_during_execution');
    expect(describeEvent({ type: 'item.completed', item: { type: 'file_change', path: 'a.png' } })).toBe('→ file_change a.png');
    expect(describeEvent({ type: 'something.new' })).toBeUndefined();
    expect(describeEvent({ type: 'item.completed', item: { type: 'command_execution', exit_code: 2, aggregated_output: 'a\nboom' } })).toBe('  exit 2: boom');
  });
});

describe('parts in the closing JSON (f4)', () => {
  it('parseFinal keeps a parts list and drops an empty or missing one', async () => {
    const { parseFinal } = await import('../src/engine/sessions/LiveCodexPort.ts');
    expect(parseFinal('{"outcome":"done","summary":"s","question":null,"hand_off":null,"parts":[{"name":"a","state":"accepted","reason":null}]}')?.parts).toEqual([{ name: 'a', state: 'accepted', reason: null }]);
    expect(parseFinal('{"outcome":"done","summary":"s","question":null,"hand_off":null,"parts":[]}')?.parts).toBeUndefined();
    expect(parseFinal('{"outcome":"done","summary":"s","question":null,"hand_off":null}')?.parts).toBeUndefined();
  });
});

