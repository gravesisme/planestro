import type { JournalEntry } from '@planestro/shared';
import { WORKTREE_SCOPE } from '@planestro/shared';
import { literal, readShell } from './shell.ts';
import type { PermissionRequest } from './ports.ts';
import { commandGrant, commandGrantGap } from './sessions/nativeApproval.ts';

/** Only an exact local command can be approved on its next request; never widen a turn's sandbox. */
export function permissionGrantRefusal(req: PermissionRequest, decision = 'allow'): string | undefined {
  if (req.tool !== 'CodexApproval') return;
  if (decision === 'always') return 'Codex commands can only be allowed once; permanent sandbox grants are not supported.';
  const gap = commandGrantGap(req);
  if (gap) return `These Codex sandbox permissions cannot be granted here: ${gap}. planestro allows only one complete local command, once, and never widens a turn's sandbox; there is no setting that grants more. Deny it and say what to do instead (a command that needs no more than the sandbox gives), or take the item over, do it yourself and hand it back.`;
}

/**
 * What waiting on a person costs (#108). A park ends the turn (invariant 2) and the answer resumes it;
 * once the prompt cache has expired that resume reloads the whole conversation (LM-24: about ten parks
 * at $15-18 each, half of a $250 budget). The journal holds each park (`permission.parked`), its answer
 * (`permission.answered`) and the turn that resumed from it (`op.begin` with `resumes_park`, whose
 * `op.end` has that turn's cost since #107), so what parks cost is read, not guessed.
 */

/** Commands whose second word says what they do (`npm run`, `git log`, `npx tsx`). */
const TWO_WORD = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'go', 'uv', 'poetry', 'make', 'docker']);
/**
 * Never offered as an allow rule, however often it parks: they reach outside the worktree or the machine, remove things, or
 * run whatever they are given (an interpreter on an ad-hoc script: workers are told to edit with Edit and Write instead, #109).
 */
const NEVER = /^(rm|sudo|su|chmod|chown|curl|wget|ssh|scp|rsync|dd|mkfs|kill|killall|pkill|open|osascript|eval|exec|sh|bash|zsh|python|python3|node|perl|ruby|deno|gh|git (push|reset|checkout|switch|clean|branch|worktree|rebase|merge|remote|config|tag))\b/;

/** The kind of command a Bash request is: its first command's name, and the subcommand for tools that have one. */
export function commandShape(command: string): string | undefined {
  const items = readShell(command);
  const first = items?.find((it) => it.kind === 'command' && it.words.length > 0);
  if (!first || first.kind !== 'command') return undefined;
  const words = first.words.map(literal);
  const head = words[0];
  if (!head || /[^\w./@+-]/.test(head)) return undefined;
  const sub = TWO_WORD.has(head) && words[1] && /^[a-z][\w:.-]*$/i.test(words[1]) ? words[1] : undefined;
  return sub ? `${head} ${sub}` : head;
}

/** The worktree-scoped rule that would allow this kind of command, or none when it is one never to allow on a count. */
export function suggestedRule(shape: string | undefined): string | undefined {
  if (!shape || NEVER.test(shape)) return undefined;
  return `Bash(${shape} *)${WORKTREE_SCOPE}`;
}

export interface ParkRow {
  park: string;
  at: string;
  kind: 'permission' | 'question' | 'audition';
  what: string;
  shape?: string;
  asked: 'user' | 'orchestrator';
  answered?: { by: string; decision: string; waited_ms: number };
  /** The cost of the turn that resumed from it: what the park cost. */
  resume_cost?: number;
}

/** Every park in these entries, with its answer and the cost of the turn that resumed from it. */
export function parksOf(entries: JournalEntry[]): ParkRow[] {
  const rows = new Map<string, ParkRow>();
  const turnOf = new Map<string, string>();   // op id → park it resumed
  for (const e of entries) {
    const d = e.data ?? {};
    if (e.type === 'permission.parked' && typeof d.park === 'string') {
      rows.set(d.park, { park: d.park, at: e.ts, kind: d.kind === 'question' || d.kind === 'audition' ? d.kind : 'permission', what: String(d.what ?? ''), ...(typeof d.shape === 'string' ? { shape: d.shape } : {}), asked: d.asked === 'orchestrator' ? 'orchestrator' : 'user' });
    } else if (e.type === 'permission.answered' && typeof d.park === 'string') {
      const r = rows.get(d.park);
      if (r) r.answered = { by: String(d.by ?? e.actor), decision: String(d.decision ?? ''), waited_ms: Number(d.waited_ms ?? 0) };
    } else if (e.type === 'op.begin' && typeof d.resumes_park === 'string' && typeof d.op_id === 'string') {
      turnOf.set(d.op_id, d.resumes_park);
    } else if (e.type === 'op.end' && typeof d.op_id === 'string' && turnOf.has(d.op_id)) {
      const r = rows.get(turnOf.get(d.op_id)!);
      if (r && typeof d.cost === 'number') r.resume_cost = (r.resume_cost ?? 0) + d.cost;
    }
  }
  return [...rows.values()];
}

export interface ParkSummary { item: string; parks: number; waited_ms: number; resume_cost: number; open: number; shapes: { shape: string; parks: number; rule?: string }[] }

/** Per item: how many parks, how long they waited, what their resumes cost, and the command kinds that park most. */
export function parkSummary(entries: JournalEntry[]): ParkSummary[] {
  const byItem = new Map<string, JournalEntry[]>();
  for (const e of entries) if (e.item) { const l = byItem.get(e.item) ?? []; l.push(e); byItem.set(e.item, l); }
  const out: ParkSummary[] = [];
  for (const [item, list] of byItem) {
    const rows = parksOf(list);
    if (!rows.length) continue;
    const shapes = new Map<string, number>();
    for (const r of rows) if (r.shape) shapes.set(r.shape, (shapes.get(r.shape) ?? 0) + 1);
    out.push({
      item, parks: rows.length, open: rows.filter((r) => !r.answered).length,
      waited_ms: rows.reduce((n, r) => n + (r.answered?.waited_ms ?? 0), 0),
      resume_cost: Math.round(rows.reduce((n, r) => n + (r.resume_cost ?? 0), 0) * 100) / 100,
      shapes: [...shapes].sort((a, b) => b[1] - a[1]).map(([shape, parks]) => ({ shape, parks, ...(suggestedRule(shape) ? { rule: suggestedRule(shape) } : {}) })),
    });
  }
  return out.sort((a, b) => b.resume_cost - a.resume_cost || b.parks - a.parks);
}

/**
 * For a request parked now: the rule to offer once this item has parked on the same kind of command before
 * (this is at least the second time), unless the project already has it.
 */
export function parkHint(entries: JournalEntry[], command: string, allow: string[], park?: string): { shape: string; parks: number; rule: string } | undefined {
  // The kind of command this park was journaled under (the one that parked, not the line's first), else the first.
  const journaled = park ? entries.find((e) => e.data?.park === park)?.data?.shape : undefined;
  const shape = typeof journaled === 'string' ? journaled : commandShape(command);
  const rule = suggestedRule(shape);
  if (!shape || !rule || allow.map((r) => r.trim()).includes(rule)) return undefined;
  const parks = parksOf(entries).filter((r) => r.shape === shape).length;
  return parks >= 2 ? { shape, parks, rule } : undefined;
}

/** A parked request as the worker should read it back: the command itself for Bash, else the tool and its input. */
export function parkedRequestText(req: { tool: string; input: Record<string, unknown> }): string {
  return req.tool === 'Bash' ? `\`${String(req.input.command)}\`` : `${req.tool} ${JSON.stringify(req.input).slice(0, 200)}`;
}

/**
 * The ruling a resumed session reads first (#168). Workers took a park for a denial and a denial for a hint to
 * rephrase, so the ruling is stated outright: an approved command runs now, as it was; a denied one is not tried
 * again in any other form, though what a denial's reason says to do instead is the worker's to do (#297).
 */
export function rulingText(req: { tool: string; input: Record<string, unknown> }, decision: 'allow' | 'always' | 'deny', who: string, note?: string): string {
  const native = commandGrant(req);
  if (decision === 'allow' && native) return `APPROVED ONCE: ${who} approved your original command in ${native.cwd}${note ? ` (${note})` : ''}. Reissue the original exec tool call with exactly the same command and working directory, requesting the same escalation. planestro will accept that matching request once. Do not add a nested shell wrapper or change the command. Any different command requires a new decision. The sandbox is otherwise unchanged.\n\nFull command as shown by Codex:\n${native.command}\n\nOriginal command actions:\n${JSON.stringify(req.input.commandActions ?? [])}\n\nThen continue.`;
  const what = req.tool === 'Bash' ? `your command ${parkedRequestText(req)}` : `your ${parkedRequestText(req)} call`;
  // #297: a ruling that says what to do instead ("submit a safer command") is not contradicted by a ban on every rewrite.
  if (decision === 'deny' && note?.trim()) return `DENIED: ${who} denied ${what}: ${note.trim()}. This exact command is denied: do not run it again, reworded or by another route (a script, another tool to the same effect). That does not forbid what the ruling asks for: where it says what to do instead, a safer or different command included, do that. You are authorized to propose it, and it is judged on its own. Continue, or call report_blocked if you cannot.`;
  if (decision === 'deny') return `DENIED: ${who} denied ${what}. Do not retry it in another form (a rewritten command, a script, another tool to the same effect). Continue without it, or call report_blocked if you cannot.`;
  return `APPROVED: ${who} approved ${what}${note ? ` (${note})` : ''}. Run it now, as it was; it is allowed. Then continue.`;
}

/** How a recorded audition is answered (#207), so a port can tell the park from a rejection. */
export const AUDITION_PARKED = 'Audition recorded by planestro';

/** How a refused report_blocked starts, so a port can tell the refusal from a recorded block. */
export const PARKED_REFUSAL = 'Not recorded:';

/**
 * report_blocked while the session waits on a ruling (#168) is refused in words, never thrown: a park is a wait,
 * not a block, and the turn should end with no report. Undefined when nothing is parked.
 */
export function parkedRefusal(fm: { awaiting?: string; awaiting_data?: Record<string, unknown> }): string | undefined {
  const permission = fm.awaiting === 'permission' || (fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission');
  if (!permission || typeof fm.awaiting_data?.tool !== 'string') return undefined;
  const req = { tool: fm.awaiting_data.tool, input: (fm.awaiting_data.input ?? {}) as Record<string, unknown> };
  return `${PARKED_REFUSAL} you are parked on ${parkedRequestText(req)}; wait. A park is not a denial and not a block: end your turn now with no report, and planestro resumes you with the ruling.`;
}

/** The command a ruling was on, as the journal keeps it (#169): whole up to 4000 characters, newlines and all, so the history can be replayed. */
export function answeredCommand(command: string): { command: string; truncated?: true } {
  return command.length > 4000 ? { command: command.slice(0, 4000), truncated: true } : { command };
}
