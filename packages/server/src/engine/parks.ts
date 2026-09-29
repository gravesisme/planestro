import type { JournalEntry } from '@planestro/shared';
import { WORKTREE_SCOPE } from '@planestro/shared';
import { literal, readShell } from './shell.ts';

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
  kind: 'permission' | 'question';
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
      rows.set(d.park, { park: d.park, at: e.ts, kind: d.kind === 'question' ? 'question' : 'permission', what: String(d.what ?? ''), ...(typeof d.shape === 'string' ? { shape: d.shape } : {}), asked: d.asked === 'orchestrator' ? 'orchestrator' : 'user' });
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
export function parkHint(entries: JournalEntry[], command: string, allow: string[]): { shape: string; parks: number; rule: string } | undefined {
  const shape = commandShape(command);
  const rule = suggestedRule(shape);
  if (!shape || !rule || allow.map((r) => r.trim()).includes(rule)) return undefined;
  const parks = parksOf(entries).filter((r) => r.shape === shape).length;
  return parks >= 2 ? { shape, parks, rule } : undefined;
}
