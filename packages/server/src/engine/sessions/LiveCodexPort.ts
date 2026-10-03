import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { AgentPort, AgentTurnOptions, TurnResult } from '../ports.ts';

/**
 * Worker turns on the Codex CLI (`codex exec`). Codex has no plan mode and no planestro tools, so it
 * only implements, and it reports through its final message instead of calling tools: the turn must
 * end with JSON matching FINAL_SCHEMA, which this port turns into report_done / report_blocked / a
 * parked question. Everything here was established by spikes/codex-spike.ts (docs/notes/codex-spike.md).
 *
 * Trust model: there is no per-command permission callback. The turn runs under Codex's
 * `workspace-write` sandbox — writes confined to the worktree and the git dirs its commits need
 * (gitWritableRoots), no network for its commands — and
 * planestro verifies the result afterwards like any other turn (clean tree, commits ahead).
 */
export const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'question'] },
    summary: { type: 'string' },
    question: { type: ['string', 'null'] },
    hold: { type: ['string', 'null'] },
    parts: { type: ['array', 'null'], items: { type: 'object', properties: { name: { type: 'string' }, state: { type: 'string', enum: ['accepted', 'pending', 'rejected'] }, reason: { type: ['string', 'null'] } }, required: ['name', 'state', 'reason'], additionalProperties: false } },
    hand_off: {
      type: ['object', 'null'],
      properties: { to: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
      required: ['to', 'paths', 'note'],
      additionalProperties: false,
    },
  },
  required: ['outcome', 'summary', 'question', 'hold', 'parts', 'hand_off'],
  additionalProperties: false,
} as const;

export interface CodexFinal { outcome: 'done' | 'blocked' | 'question'; summary: string; question: string | null; /** Done, but the pull request must not merge yet: what it waits for (#97). */ hold?: string | null; hand_off?: { to: string; paths: string[]; note: string } | null; parts?: unknown[] | null }

/** A lenient read of the final message: the schema is enforced by Codex, but a crash can leave anything. */
export function parseFinal(text: string | undefined): CodexFinal | undefined {
  if (!text?.trim()) return undefined;
  try {
    const v = JSON.parse(text) as Partial<CodexFinal>;
    if (v && (v.outcome === 'done' || v.outcome === 'blocked' || v.outcome === 'question') && typeof v.summary === 'string') {
      const h = v.hand_off;
      const hand_off = h && typeof h === 'object' && typeof h.to === 'string' && Array.isArray(h.paths) && h.paths.every((p) => typeof p === 'string') ? { to: h.to, paths: h.paths, note: typeof h.note === 'string' ? h.note : '' } : null;
      return { outcome: v.outcome, summary: v.summary, question: typeof v.question === 'string' ? v.question : null, ...(typeof v.hold === 'string' && v.hold.trim() ? { hold: v.hold.trim() } : {}), hand_off, ...(Array.isArray(v.parts) && v.parts.length ? { parts: v.parts } : {}) };
    }
  } catch { /* not JSON */ }
  return undefined;
}

/** One console line per event a person would care about; unknown events are skipped, never fatal. */
export function describeEvent(e: any): string | undefined {
  const item = e?.item;
  if (e?.type === 'item.completed' && item?.type === 'agent_message' && item.text) return String(item.text).trim();
  if (e?.type === 'item.started' && item?.type === 'command_execution') return `→ ${String(item.command ?? '').replace(/^\/bin\/(ba|z)?sh -lc /, '').split('\n')[0].slice(0, 180)}`;
  if (e?.type === 'item.completed' && item?.type === 'command_execution' && item.exit_code) return `  exit ${item.exit_code}: ${String(item.aggregated_output ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''}`;
  if (e?.type === 'item.completed' && item?.type && !['agent_message', 'command_execution', 'reasoning'].includes(item.type)) return `→ ${item.type}${item.path ? ` ${item.path}` : ''}`;
  if (e?.type === 'error' || e?.type === 'turn.failed') return `error: ${String(e.message ?? e.error?.message ?? JSON.stringify(e)).slice(0, 300)}`;
  return undefined;
}

/** stderr → a reason a person can act on. Patterns come from real failures; unknown text falls through. */
export function classifyFailure(stderr: string): { subtype: string; error: string } {
  const tail = stderr.split('\n').filter((l) => l.trim() && !/rmcp::transport|Reading additional input from stdin/.test(l)).slice(-4).join(' ').slice(0, 400);
  if (/no rollout found for thread id|thread\/resume failed/i.test(stderr)) return { subtype: 'session_lost', error: `the Codex thread could not be resumed: ${tail}` };
  if (/not logged in|login required|401|unauthorized|invalid_token|token (has )?expired/i.test(stderr)) return { subtype: 'auth_required', error: `Codex is not logged in (run \`codex login\`): ${tail}` };
  if (/rate limit|429|usage limit|quota/i.test(stderr)) return { subtype: 'rate_limited', error: `Codex hit a usage or rate limit: ${tail}` };
  return { subtype: 'error_during_execution', error: tail || 'codex exited with an error and no message' };
}

/**
 * The image tool's own staging, said by the runner that has it (HH-274): workers read "write nothing outside the
 * worktree" as covering the folder the built-in generator saves into, and blocked on their first generation. A
 * data dir's copy of worker-system-codex predates this, so it rides with every turn here rather than in the prompt library.
 */
export const IMAGE_TOOL_NOTE = [
  '## Your image tool',
  '',
  '- The built-in image generator saves what it makes in its own folder ($CODEX_HOME/generated_images). That is the tool working as it always does, not a write of yours: it is allowed, and it never needs anyone\'s approval.',
  '- Copy each image you keep into the worktree: the final file at the path the plan names, raw generations under tmp/ when the plan asks for them. "Nothing outside the worktree" is about what your commands write.',
].join('\n');

/**
 * What a commit writes outside a linked worktree, as sandbox roots (HH-273, HH-281, HH-286): its own git dir
 * (index, HEAD, rebase state) and, in the shared one, objects/, refs/heads/ and logs/refs/heads/. Never the
 * shared dir itself: config and hooks/ stay read-only to the worker. Without them every commit failed on
 * index.lock ("Operation not permitted"); the spike missed it because it ran under the temp dir, which the
 * sandbox always lets a turn write. A worktree that holds its own .git needs nothing. packed-refs stays out:
 * git only warns when it cannot tidy it.
 */
export function gitWritableRoots(cwd: string): string[] {
  let gitDir: string, common: string;
  try { [gitDir, common] = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n'); }
  catch { return []; }
  const here = (() => { try { return realpathSync(cwd); } catch { return cwd; } })();
  const inside = (p: string) => { const r = relative(here, p); return !r.startsWith('..') && !isAbsolute(r); };
  if (!gitDir || !common || inside(gitDir)) return [];
  const shared = ['objects', 'refs/heads', 'logs/refs/heads'].map((d) => join(common, d));
  for (const d of shared) { try { mkdirSync(d, { recursive: true }); } catch { /* git makes it on first use; the root is then simply missing */ } }
  return [gitDir, ...shared];
}

export class LiveCodexPort implements AgentPort<AgentTurnOptions> {
  private lastError?: string;
  constructor(private readonly codexBin = 'codex', private readonly extraArgs: string[] = []) {}

  async runTurn(o: AgentTurnOptions): Promise<TurnResult> {
    const result: TurnResult = { sessionId: o.resume, subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
    const scratch = mkdtempSync(join(tmpdir(), 'planestro-codex-'));
    const schemaFile = join(scratch, 'final.schema.json');
    const lastFile = join(scratch, 'last.json');
    writeFileSync(schemaFile, JSON.stringify(FINAL_SCHEMA));
    // A resumed thread does NOT keep its sandbox: without the user's config it comes back read-only, and
    // `resume` has no `-s`. The config override works for both, so both get it. No `--add-dir`: that
    // grants WRITE access, and a worker must never be able to write the data dir (reads are unrestricted).
    // The git dirs a commit writes, by config rather than --add-dir, which `resume` does not take.
    const roots = gitWritableRoots(o.cwd);
    const shared = ['--json', '--ignore-user-config', '-c', 'sandbox_mode="workspace-write"', ...(roots.length ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`] : []), '--output-schema', schemaFile, '-o', lastFile, ...this.extraArgs, ...(o.model ? ['-m', o.model] : []), ...(o.images ?? []).flatMap((p) => ['-i', p])];
    const args = o.resume
      ? ['exec', 'resume', o.resume, ...shared]
      : ['exec', '-s', 'workspace-write', '-C', o.cwd, ...shared];
    // There is no system-prompt flag: the worker rules ride at the top of the prompt, every turn.
    const prompt = `${o.systemAppend.trim()}\n\n${IMAGE_TOOL_NOTE}\n\n---\n\n${o.prompt.trim()}\n\nEnd your turn with ONLY the JSON object described above: {"outcome": "done" | "blocked" | "question", "summary": "...", "parts": [...] or null, "question": "..." or null, "hold": null or "<what the pull request waits for>", "hand_off": null or {"to": "<item id that waits on this one>", "paths": ["<files in your worktree, relative>"], "note": "<what they are and how to use them>"}}. Use hand_off only when another backlog item needs files you made before your branch merges. Use hold only with "done", and only when the pull request must not merge yet because the plan or the request says it waits for something ("until TD-12 has merged"): planestro then keeps it out of the merge queue until the user releases it.`;

    let killed = false;
    this.lastError = undefined;
    let stderr = '';
    const exit = await new Promise<{ code: number | null; spawnError?: string }>((resolve) => {
      // stdin MUST be ignored: given a pipe, `codex exec` waits on it forever. And `--` MUST end the
      // options: `-i` takes one or more files, so a prompt right after an image is read as another
      // image, and codex, finding no prompt, reads stdin — and gets nothing ("No prompt provided via stdin").
      const child = spawn(this.codexBin, [...args, '--', prompt], { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const onAbort = () => { killed = true; child.kill('SIGTERM'); };
      if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) { this.onLine(buf.slice(0, nl), result, o); buf = buf.slice(nl + 1); }
      });
      child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000); });
      child.once('error', (e) => resolve({ code: null, spawnError: e.message }));
      child.once('close', (code) => { if (buf.trim()) this.onLine(buf, result, o); o.signal?.removeEventListener('abort', onAbort); resolve({ code }); });
    });

    let finalText: string | undefined;
    try { finalText = readFileSync(lastFile, 'utf8'); } catch { /* no final message */ }
    rmSync(scratch, { recursive: true, force: true });

    if (exit.spawnError) return { ...result, subtype: 'spawn_error', isError: true, error: `could not start ${this.codexBin}: ${exit.spawnError}` };
    // SIGTERM makes Codex exit 0 with no final message, so "killed" is what we remember, not what it reports.
    if (killed) return { ...result, subtype: 'killed', isError: false };
    // Codex reports most failures as an `error` / `turn.failed` event on stdout and only then exits non-zero.
    if (exit.code !== 0) return { ...result, ...classifyFailure(`${stderr}\n${this.lastError ?? ''}`), isError: true };

    const final = parseFinal(finalText) ?? parseFinal(result.text.trim().split('\n').slice(-1)[0]);
    if (!final) return { ...result, subtype: 'no_final_message', isError: true, error: 'the turn ended without the closing JSON (interrupted, or the agent ignored the schema); it can be resumed' };
    result.text = final.summary;
    if (final.hand_off && final.hand_off.to && final.hand_off.paths?.length) {
      const answer = await o.tools.hand_off(final.hand_off.to, final.hand_off.paths, final.hand_off.note ?? '');
      o.onOutput(`hand_off → ${final.hand_off.to}: ${answer}`);
    }
    if (final.outcome === 'done') { const answer = await o.tools.report_done(final.summary, final.parts ?? undefined, final.hold ?? undefined); if (!answer.startsWith('Rejected')) result.done = final.summary; }
    else if (final.outcome === 'blocked') { await o.tools.report_blocked(final.summary, final.parts ?? undefined); result.blocked = final.summary; }
    else if (final.parts) await o.tools.report_progress(final.parts);
    else { await o.onQuestion([{ question: final.question ?? final.summary, header: 'Codex asks', options: [] }]); result.parked = 'question'; }
    return result;
  }

  private onLine(line: string, result: TurnResult, o: AgentTurnOptions): void {
    if (!line.trim()) return;
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'thread.started' && e.thread_id) result.sessionId = e.thread_id;
    if (e.type === 'turn.completed' && e.usage) {
      const u = e.usage;
      result.tokens = (result.tokens ?? 0) + Math.max(0, Number(u.input_tokens ?? 0) - Number(u.cached_input_tokens ?? 0)) + Number(u.output_tokens ?? 0);
    }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) result.text += `${e.item.text}\n`;
    if (e.type === 'error' || e.type === 'turn.failed') this.lastError = String(e.message ?? e.error?.message ?? JSON.stringify(e)).slice(0, 400);
    const said = describeEvent(e);
    if (said) o.onOutput(said);
  }
}
