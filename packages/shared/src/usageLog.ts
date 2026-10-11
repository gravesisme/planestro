import type { JournalEntry } from './events.ts';
import { usagePercent, usageWindowLabel } from './usage.ts';
import { cacheHitRate, splitBudgetTokens, type TokenSplit } from './tokens.ts';

/**
 * Usage over time (#236): one `usage.turn` journal entry per model session, written where the turn or wake
 * ends (a fact recorded at op end, never rebuilt later), and the per-day report the Usage page charts from them.
 * Nothing is backfilled: item spend before #107 summed running totals, so older numbers are not to be trusted.
 */
export const USAGE_TURN = 'usage.turn';
export type UsageRole = 'planner' | 'worker' | 'orchestrator';
export const USAGE_ROLES: UsageRole[] = ['planner', 'worker', 'orchestrator'];

export interface UsageTurn {
  provider: string;
  /** The model the runner was asked for (its own id, e.g. `claude-opus-4-5`), else the row's label. */
  model: string;
  role: UsageRole;
  /** What ran: `planning_turn`, `implement_turn`, `conflict_session`, `orchestrator_wake`. */
  op: string;
  /** Dollars, only from a runner that reports them (the turn's own share, #64). */
  usd?: number;
  /** The tokens the turn paid for in full: uncached input, cache writes and output (what `TokenSplit` sums as budget tokens). */
  tokens?: number;
  /** The split behind `tokens` (#345), from every runner that streams it; cache writes and their TTL from Claude only. */
  input?: number;
  cache_read?: number;
  cache_write?: number;
  cache_ttl_s?: number;
  output?: number;
  /** The conversation's window at the turn's end: what a resume reloads. */
  context?: number;
  subtype: string;
}

/** The entry's data for one finished turn, or undefined when nothing ran (a deferred or declined turn). */
export function usageTurnData(t: { provider: string; model: string; role: UsageRole; op: string; accounting: 'dollars' | 'tokens'; result: { subtype: string; costUsd: number; tokens?: number; numTurns: number; usage?: TokenSplit; contextTokens?: number } }): UsageTurn | undefined {
  const r = t.result;
  if (r.subtype === 'deferred' || r.subtype === 'resume_declined') return undefined;
  const u = r.usage;
  const tokens = r.tokens || (u ? splitBudgetTokens(u) : 0);
  if (!r.numTurns && !r.costUsd && !tokens) return undefined;
  return {
    provider: t.provider, model: t.model, role: t.role, op: t.op,
    ...(t.accounting === 'dollars' ? { usd: Math.round(r.costUsd * 1e6) / 1e6 } : {}),
    ...(tokens ? { tokens } : {}),
    ...(u ? { input: u.input, cache_read: u.cache_read, cache_write: u.cache_write, ...(u.cache_ttl_s ? { cache_ttl_s: u.cache_ttl_s } : {}), output: u.output } : {}),
    ...(r.contextTokens ? { context: r.contextTokens } : {}),
    subtype: r.subtype,
  };
}

export type UsageGroup = 'provider' | 'model' | 'role';
/** Totals over a set of turns. The split counts only turns that recorded one (#345); `cache_hit` is over those. */
export interface UsageCell { usd: number; tokens: number; turns: number; input: number; cache_read: number; cache_write: number; output: number; cache_hit?: number }
export interface UsageDay extends UsageCell { day: string; by: Record<UsageGroup, Record<string, UsageCell>> }
/** A usage-window crossing (the provider guard tripped), a resume, a model out of usage, or a disk pause. */
export interface UsageEvent { at: string; day: string; kind: 'crossing' | 'resumed' | 'unavailable' | 'disk_pause' | 'disk_resumed'; provider?: string; text: string }
export interface UsageReport {
  /** Oldest first, one per local day, empty days included. */
  days: UsageDay[];
  totals: UsageCell & { by: Record<UsageGroup, Record<string, UsageCell>> };
  /** Newest first. */
  events: UsageEvent[];
  /** The first `usage.turn` among the entries read: when it falls inside the range, nothing before it was recorded. */
  recorded_since?: string;
}

const emptyBy = (): Record<UsageGroup, Record<string, UsageCell>> => ({ provider: {}, model: {}, role: {} });
const zero = (): UsageCell => ({ usd: 0, tokens: 0, turns: 0, input: 0, cache_read: 0, cache_write: 0, output: 0 });
const add = (c: UsageCell, u: UsageTurn) => {
  c.usd += u.usd ?? 0; c.tokens += u.tokens ?? 0; c.turns += 1;
  c.input += u.input ?? 0; c.cache_read += u.cache_read ?? 0; c.cache_write += u.cache_write ?? 0; c.output += u.output ?? 0;
};
const cell = (m: Record<string, UsageCell>, k: string) => (m[k] ??= zero());
const settle = (c: UsageCell) => {
  c.usd = Math.round(c.usd * 100) / 100;
  const hit = cacheHitRate(c);
  if (hit !== undefined) c.cache_hit = Math.round(hit * 1000) / 1000;
};

/** `2026-10-08` → the day `n` before it (calendar arithmetic, no time zone involved). */
export function dayBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * The last `days` local days up to `today` (`YYYY-MM-DD`). A journal timestamp is local time
 * (`isoLocal`), so its first ten characters are the day it happened on where planestro runs.
 */
export function usageReport(entries: JournalEntry[], opts: { days: number; today: string }): UsageReport {
  const first = dayBefore(opts.today, opts.days - 1);
  const days: UsageDay[] = Array.from({ length: opts.days }, (_, i) => ({ day: dayBefore(opts.today, opts.days - 1 - i), ...zero(), by: emptyBy() }));
  const byDay = new Map(days.map((d) => [d.day, d]));
  const totals: UsageReport['totals'] = { ...zero(), by: emptyBy() };
  const events: UsageEvent[] = [];
  let since: string | undefined;
  for (const e of entries) {
    const day = e.ts.slice(0, 10);
    if (e.type === USAGE_TURN) since ??= e.ts;
    if (day < first || day > opts.today) continue;
    const d = e.data ?? {};
    if (e.type === USAGE_TURN) {
      const u = d as unknown as UsageTurn;
      const slot = byDay.get(day)!;
      add(slot, u); add(totals, u);
      for (const g of ['provider', 'model', 'role'] as const) { const k = String(u[g] ?? 'unknown'); add(cell(slot.by[g], k), u); add(cell(totals.by[g], k), u); }
      continue;
    }
    const ev = usageEvent(e, day);
    if (ev) events.push(ev);
  }
  for (const c of [totals, ...days]) { settle(c); for (const m of Object.values(c.by)) Object.values(m).forEach(settle); }
  return { days, totals, events: events.reverse(), ...(since ? { recorded_since: since } : {}) };
}

const providerName = (p: unknown) => (p === 'codex' ? 'Codex' : p === 'claude' ? 'Claude' : String(p ?? 'a provider'));
function usageEvent(e: JournalEntry, day: string): UsageEvent | undefined {
  const d = e.data ?? {};
  switch (e.type) {
    case 'usage.guard_tripped': {
      const pct = usagePercent(typeof d.utilization === 'number' ? d.utilization : undefined);
      const win = usageWindowLabel(String(d.window ?? ''));
      return { at: e.ts, day, kind: 'crossing', provider: String(d.provider ?? 'claude'), text: `${providerName(d.provider)} paused: the ${win} window ${pct ? `reached ${pct}` : d.status === 'rejected' ? 'was exhausted' : 'sent a usage warning'}` };
    }
    case 'usage.guard_resumed': return { at: e.ts, day, kind: 'resumed', provider: String(d.provider ?? 'claude'), text: `${providerName(d.provider)} resumed` };
    case 'model.unavailable': return { at: e.ts, day, kind: 'unavailable', text: `${String(d.model ?? 'a model')} out of usage${d.until ? ` until ${String(d.until)}` : ''}${e.actor === 'user' ? ' (marked by hand)' : ''}` };
    case 'disk.guard_tripped': return { at: e.ts, day, kind: 'disk_pause', text: `Automation paused: ${String(d.free_gib)} GiB free on ${String(d.path ?? 'disk')}` };
    case 'disk.guard_resumed': return { at: e.ts, day, kind: 'disk_resumed', text: `Automation resumed: ${String(d.free_gib)} GiB free` };
    default: return undefined;
  }
}
/** The journal types the report reads, so the server can read only those. */
export const USAGE_REPORT_TYPES = [USAGE_TURN, 'usage.guard_tripped', 'usage.guard_resumed', 'model.unavailable', 'disk.guard_tripped', 'disk.guard_resumed'];
