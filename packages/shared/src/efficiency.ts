import type { JournalEntry } from './events.ts';
import { cacheHitRate } from './tokens.ts';
import { TEST_RUN, testWaste, type TestWaste } from './testRuns.ts';
import { USAGE_TURN, USAGE_STAGES, usageStage, dayBefore, type UsageCell, type UsageStage, type UsageTurn } from './usageLog.ts';

/**
 * Cost and tokens per item (#346), read from the journal only: its `usage.turn` entries (worker and planner turns carry
 * the item, an orchestrator wake its `items`, sharing its cost), `session.replaced` (fresh sessions) and the parks
 * (`permission.parked` / `permission.answered`). Never the item's own totals: before #107 they summed running totals.
 */
export interface ItemEfficiency {
  item: string;
  /** Totals over every stage; an orchestrator wake counts its share. */
  usd: number;
  tokens: number;
  /** Worker and planner turns (orchestrator wakes are counted in `wakes`). */
  turns: number;
  wakes: number;
  stages: Partial<Record<UsageStage, UsageCell>>;
  fresh_sessions: number;
  parks: number;
  parked_ms: number;
  /** The largest window any of its turns ended with. */
  peak_context?: number;
  cache_hit?: number;
  /** What its new conversations carried before their first tool call: the largest, and their mean (#346). */
  startup?: { sessions: number; max: number; mean: number };
  /** Its recorded test runs and the wasted ones among them (#347), when it made any. */
  test_runs?: TestWaste;
  first_at?: string;
  last_at?: string;
}

const zero = (): UsageCell => ({ usd: 0, tokens: 0, turns: 0, input: 0, cache_read: 0, cache_write: 0, output: 0 });
/** A share of a turn (an orchestrator wake split among its items) added to a cell. */
const addShare = (c: UsageCell, u: UsageTurn, share: number) => {
  c.usd += (u.usd ?? 0) * share; c.tokens += (u.tokens ?? 0) * share; c.turns += 1;
  c.input += (u.input ?? 0) * share; c.cache_read += (u.cache_read ?? 0) * share; c.cache_write += (u.cache_write ?? 0) * share; c.output += (u.output ?? 0) * share;
};
const settleCell = (c: UsageCell) => {
  c.usd = Math.round(c.usd * 100) / 100;
  for (const k of ['tokens', 'input', 'cache_read', 'cache_write', 'output'] as const) c[k] = Math.round(c[k]);
  const hit = cacheHitRate(c);
  if (hit !== undefined) c.cache_hit = Math.round(hit * 1000) / 1000;
};

interface Acc { e: ItemEfficiency; all: UsageCell; starts: number[] }

/** Every item's efficiency over the entries given (filter them by date first for a window). */
export function itemEfficiencies(entries: JournalEntry[]): ItemEfficiency[] {
  const by = new Map<string, Acc>();
  const acc = (item: string, ts: string): Acc => {
    let a = by.get(item);
    if (!a) by.set(item, a = { e: { item, usd: 0, tokens: 0, turns: 0, wakes: 0, stages: {}, fresh_sessions: 0, parks: 0, parked_ms: 0 }, all: zero(), starts: [] });
    a.e.first_at ??= ts; a.e.last_at = ts;
    return a;
  };
  for (const e of entries) {
    const d = e.data ?? {};
    if (e.type === USAGE_TURN) {
      const u = d as unknown as UsageTurn;
      const stage = usageStage(u);
      const items = e.item ? [e.item] : Array.isArray(u.items) ? u.items.filter((i): i is string => typeof i === 'string') : [];
      for (const item of items) {
        const a = acc(item, e.ts);
        const share = 1 / items.length;
        addShare(a.e.stages[stage] ??= zero(), u, share);
        addShare(a.all, u, share);
        if (stage === 'orchestrator') a.e.wakes += 1; else a.e.turns += 1;
        if (stage !== 'orchestrator' && u.context) a.e.peak_context = Math.max(a.e.peak_context ?? 0, u.context);
        // A new conversation's first window is its startup weight; a resume's is a reload, not counted here.
        if (stage !== 'orchestrator' && u.resumed === false && u.start_context) a.starts.push(u.start_context);
      }
    } else if (e.item && e.type === 'session.replaced') acc(e.item, e.ts).e.fresh_sessions += 1;
    else if (e.item && e.type === 'permission.parked') acc(e.item, e.ts).e.parks += 1;
    else if (e.item && e.type === 'permission.answered' && typeof d.park === 'string') acc(e.item, e.ts).e.parked_ms += Math.max(0, Number(d.waited_ms) || 0);
    else if (e.item && e.type === TEST_RUN) acc(e.item, e.ts);
  }
  const waste = testWaste(entries);
  for (const [item, w] of waste) { const a = by.get(item); if (a) a.e.test_runs = w; }
  return [...by.values()].map(({ e, all, starts }) => {
    settleCell(all);
    for (const c of Object.values(e.stages)) settleCell(c!);
    e.usd = all.usd; e.tokens = all.tokens;
    if (all.cache_hit !== undefined) e.cache_hit = all.cache_hit;
    if (starts.length) e.startup = { sessions: starts.length, max: Math.max(...starts), mean: Math.round(starts.reduce((x, y) => x + y, 0) / starts.length) };
    return e;
  });
}

/** One item's efficiency, queue to merge: every entry the journal holds for it. */
export function itemEfficiency(entries: JournalEntry[], item: string): ItemEfficiency {
  return itemEfficiencies(entries).find((e) => e.item === item) ?? { item, usd: 0, tokens: 0, turns: 0, wakes: 0, stages: {}, fresh_sessions: 0, parks: 0, parked_ms: 0 };
}

/** Dollars first (what Claude reports), then tokens (what Codex does): the order every ranking uses. */
const costlier = (a: { usd: number; tokens: number }, b: { usd: number; tokens: number }) => b.usd - a.usd || b.tokens - a.tokens;

export interface EfficiencyRanking {
  days: number;
  /** Most expensive first. */
  items: ItemEfficiency[];
  /** Per stage, its most expensive items. */
  by_stage: Partial<Record<UsageStage, { item: string; usd: number; tokens: number; turns: number }[]>>;
  /** Heaviest starting context first. */
  startup: { item: string; max: number; mean: number; sessions: number }[];
  /** Most time in wasted test runs first (#347). */
  wasted_runs: ({ item: string } & TestWaste)[];
}

/** The last `days` local days up to `today`, ranked (#346): the Usage page's list and the daily audit's input. */
export function efficiencyRanking(entries: JournalEntry[], opts: { days: number; today: string; top?: number }): EfficiencyRanking {
  const first = dayBefore(opts.today, opts.days - 1);
  const top = opts.top ?? 10;
  const all = itemEfficiencies(entries.filter((e) => { const day = e.ts.slice(0, 10); return day >= first && day <= opts.today; }))
    .filter((e) => e.turns + e.wakes > 0);
  const by_stage: EfficiencyRanking['by_stage'] = {};
  for (const s of USAGE_STAGES) {
    const rows = all.flatMap((e) => { const c = e.stages[s]; return c ? [{ item: e.item, usd: c.usd, tokens: c.tokens, turns: c.turns }] : []; }).sort(costlier).slice(0, top);
    if (rows.length) by_stage[s] = rows;
  }
  return {
    days: opts.days,
    items: [...all].sort(costlier).slice(0, top),
    by_stage,
    startup: all.flatMap((e) => (e.startup ? [{ item: e.item, ...e.startup }] : [])).sort((a, b) => b.max - a.max).slice(0, top),
    wasted_runs: all.flatMap((e) => (e.test_runs?.wasted.runs ? [{ item: e.item, ...e.test_runs }] : [])).sort((a, b) => b.wasted.ms - a.wasted.ms || b.wasted.runs - a.wasted.runs || b.turn_usd - a.turn_usd).slice(0, top),
  };
}

/** The journal types the efficiency report reads. */
export const EFFICIENCY_TYPES = [USAGE_TURN, 'session.replaced', 'permission.parked', 'permission.answered', TEST_RUN];
