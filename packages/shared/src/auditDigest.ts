import type { JournalEntry } from './events.ts';
import { itemEfficiencies, type ItemEfficiency } from './efficiency.ts';
import { usageReport, dayBefore, USAGE_TURN, USAGE_STAGES, type UsageCell } from './usageLog.ts';

/**
 * The daily efficiency audit's input (#348): a digest of the last days' usage, built in code from the journal at no model
 * cost (#345's token split, #346's per-item report, #347's wasted test runs, the parks) for the one wake that names the
 * single biggest waste. The wake judges; everything it reads is counted here.
 */
export const EFFICIENCY_AUDIT = 'efficiency.audit';
/**
 * One audit slot, as it ended: a note filed, an unacted note still standing, nothing new (its biggest waste was already
 * filed as an issue or handled), skipped, or failed. The slot is its memory.
 */
export interface AuditRecord {
  slot: string;
  outcome: 'noted' | 'repeat' | 'nothing_new' | 'skipped' | 'failed';
  /** The recommendation's short key (what it is about), to tell a repeat from a new one. */
  key?: string;
  what?: string;
  /** The note it filed (its journal timestamp), or the one it repeats or found already acted on. */
  note?: string;
  /** For `nothing_new`: the issues that note was filed as (none when it was marked handled). */
  issues?: number[];
  reason?: string;
  usd?: number;
  tokens?: number;
}
/** The last recommendation, and whether anything was done with it (the note was filed as an issue or marked handled). */
export interface PreviousRecommendation { at: string; key: string; what: string; acted: boolean }

const money = (n: number) => `$${n.toFixed(2)}`;
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const pct = (r: number | undefined) => (r === undefined ? '–' : `${Math.round(r * 100)}%`);
const cost = (c: { usd: number; tokens: number }) => [c.usd ? money(c.usd) : '', c.tokens ? `${k(c.tokens)} tok` : ''].filter(Boolean).join(' + ') || '0';
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** Turns that ended on `day` (local): an audit skips a day nothing ran on. */
export function turnsOn(entries: JournalEntry[], day: string): number {
  return entries.filter((e) => e.type === USAGE_TURN && e.ts.slice(0, 10) === day).length;
}

/**
 * The digest, as markdown, of the `days` local days up to `today` (yesterday's audit runs overnight, so `today` is the
 * day before the run): totals, by role and model, by stage, the costliest items, startup weight, cache hits, wasted test
 * runs and permission parks, and the last recommendation with whether it was acted on. `top` bounds every list.
 */
export function auditDigest(entries: JournalEntry[], opts: { today: string; days: number; top?: number; previous?: PreviousRecommendation }): string {
  const top = opts.top ?? 10;
  const first = dayBefore(opts.today, opts.days - 1);
  const inRange = entries.filter((e) => { const d = e.ts.slice(0, 10); return d >= first && d <= opts.today; });
  const report = usageReport(inRange, { days: opts.days, today: opts.today });
  const items = itemEfficiencies(inRange).filter((e) => e.turns + e.wakes > 0);
  const out: string[] = [];
  const t = report.totals;
  out.push(`## Totals, ${first} to ${opts.today}`, `${cost(t)} over ${t.turns} turns and wakes; cache hits ${pct(t.cache_hit)}; input ${k(t.input)}, cache read ${k(t.cache_read)}, cache write ${k(t.cache_write)}, output ${k(t.output)}.`);
  out.push('', '## Per day', ...report.days.map((d) => `- ${d.day}: ${cost(d)}, ${d.turns} turns`));
  const groups = (title: string, m: Record<string, UsageCell>) => {
    const rows = Object.entries(m).sort((a, b) => b[1].usd - a[1].usd || b[1].tokens - a[1].tokens).slice(0, top);
    if (rows.length) out.push('', `## By ${title}`, ...rows.map(([name, c]) => `- ${name}: ${cost(c)}, ${c.turns} turns, cache hits ${pct(c.cache_hit)}, cache write ${k(c.cache_write)}`));
  };
  groups('role', t.by.role);
  groups('model', t.by.model);
  const stages = USAGE_STAGES.map((s) => {
    const c = items.reduce((a, e) => { const x = e.stages[s]; return x ? { usd: a.usd + x.usd, tokens: a.tokens + x.tokens, turns: a.turns + x.turns } : a; }, { usd: 0, tokens: 0, turns: 0 });
    return [s, c] as const;
  }).filter(([, c]) => c.turns);
  if (stages.length) out.push('', '## By stage (item turns, and wakes about items)', ...stages.map(([s, c]) => `- ${s}: ${cost(c)}, ${c.turns} turns`));
  out.push(...unattributedLines(inRange));
  const costliest = [...items].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens).slice(0, top);
  if (costliest.length) out.push('', '## Costliest items', ...costliest.map(itemLine));
  const heavy = items.filter((e) => e.startup).sort((a, b) => b.startup!.max - a.startup!.max).slice(0, 5);
  if (heavy.length) out.push('', '## Heaviest starting context (a new conversation\'s first window)', ...heavy.map((e) => `- ${e.item}: max ${k(e.startup!.max)}, mean ${k(e.startup!.mean)} over ${e.startup!.sessions} sessions`));
  const lowCache = items.filter((e) => e.cache_hit !== undefined && e.turns >= 3).sort((a, b) => a.cache_hit! - b.cache_hit!).slice(0, 5);
  if (lowCache.length) out.push('', '## Lowest cache hits (items with 3+ turns)', ...lowCache.map((e) => `- ${e.item}: ${pct(e.cache_hit)} over ${e.turns} turns, ${e.fresh_sessions} fresh sessions`));
  const wasted = items.filter((e) => e.test_runs?.wasted.runs).sort((a, b) => b.test_runs!.wasted.ms - a.test_runs!.wasted.ms).slice(0, 5);
  if (wasted.length) out.push('', '## Wasted test runs', ...wasted.map((e) => { const w = e.test_runs!; return `- ${e.item}: ${w.wasted.runs} of ${w.runs} runs wasted (${mins(w.wasted.ms)}): whole suite ${w.whole_suite.runs}, repeats on unchanged code ${w.repeats.runs}, load repeats ${w.load_repeats.runs}; the turns they fell in cost ${cost({ usd: w.turn_usd, tokens: w.turn_tokens })}`; }));
  out.push(...parkLines(inRange, top));
  out.push('', '## Last recommendation', opts.previous ? `${opts.previous.at.slice(0, 10)} [${opts.previous.key}] ${opts.previous.what} — ${opts.previous.acted ? 'acted on (filed as an issue or marked handled)' : 'not acted on yet'}` : 'none');
  return out.join('\n');
}

/**
 * The orchestrator's spend that no item carries, read entry by entry (#416). A wake journaled before #346 recorded no
 * `items` (nor `stage`): it is not "about no item", and the old subtraction put a week of item wakes ($75 of HH's $80) there.
 */
function unattributedLines(entries: JournalEntry[]): string[] {
  const sum = () => ({ usd: 0, tokens: 0, turns: 0 });
  const none = sum(), unknown = sum(), audits = sum();
  for (const e of entries) {
    if (e.type !== USAGE_TURN) continue;
    const u = e.data as { role?: string; op?: string; stage?: string; items?: unknown; usd?: number; tokens?: number };
    if (u.role !== 'orchestrator' || e.item || (Array.isArray(u.items) && u.items.length)) continue;
    const c = u.op === 'efficiency_audit' ? audits : u.stage ? none : unknown;
    c.usd += u.usd ?? 0; c.tokens += u.tokens ?? 0; c.turns += 1;
  }
  return [
    ...(none.turns ? [`- orchestrator wakes about no item: ${cost(none)}, ${none.turns} wakes`] : []),
    ...(unknown.turns ? [`- orchestrator wakes journaled before their items were recorded (#346; not "no item"): ${cost(unknown)}, ${unknown.turns} wakes`] : []),
    ...(audits.turns ? [`- the efficiency audit itself: ${cost(audits)}, ${audits.turns} runs`] : []),
  ];
}

function itemLine(e: ItemEfficiency): string {
  const st = USAGE_STAGES.filter((s) => e.stages[s]).map((s) => `${s} ${cost(e.stages[s]!)}`).join(', ');
  return `- ${e.item}: ${cost(e)} (${st}); ${e.turns} turns, ${e.wakes} wakes, ${e.fresh_sessions} fresh, ${e.parks} parks${e.parked_ms ? ` (${mins(e.parked_ms)})` : ''}, peak context ${e.peak_context ? k(e.peak_context) : '–'}, cache hits ${pct(e.cache_hit)}`;
}

/** Permission parks by the shape of what parked (`npm test …`), most first. */
function parkLines(entries: JournalEntry[], top: number): string[] {
  const shapes = new Map<string, { n: number; items: Set<string> }>();
  for (const e of entries) {
    if (e.type !== 'permission.parked' || !e.item) continue;
    const shape = String(e.data?.shape ?? e.data?.what ?? '?').slice(0, 80);
    const s = shapes.get(shape) ?? { n: 0, items: new Set<string>() };
    s.n += 1; s.items.add(e.item); shapes.set(shape, s);
  }
  const rows = [...shapes].sort((a, b) => b[1].n - a[1].n).slice(0, top);
  return rows.length ? ['', '## Permission parks by the command that parked', ...rows.map(([shape, s]) => `- \`${shape}\`: ${s.n} parks on ${s.items.size} items`)] : [];
}

/** The journal types the digest reads. */
export const AUDIT_DIGEST_TYPES = [USAGE_TURN, 'session.replaced', 'permission.parked', 'permission.answered', 'test.run'];
