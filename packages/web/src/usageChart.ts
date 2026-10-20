import type { UsageCell, UsageGroup, UsageReport } from '@planestro/shared/view';

// ---- the Usage page's chart, as data (#236): which series, in which colour, and how tall each day stands ----

export type UsageMeasure = 'usd' | 'tokens';
/** Categorical slots in a fixed order (dark-surface steps of the dataviz reference palette); the eighth is "Other". */
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767'];
export const OTHER_COLOR = '#7a828c';
export const OTHER = 'Other';
/** A role and a provider keep their colour whatever else is on the chart. */
const FIXED: Partial<Record<UsageGroup, string[]>> = { role: ['worker', 'planner', 'orchestrator'], provider: ['claude', 'codex'] };

export interface Series { key: string; label: string; color: string; total: number }

const value = (c: UsageCell | undefined, m: UsageMeasure) => (c ? (m === 'usd' ? c.usd : c.tokens) : 0);

/**
 * The series to stack, biggest first in the legend. A colour follows its entity, never its rank: fixed for roles and
 * providers, by name for models, so a range or measure change does not repaint the survivors. Past seven, the rest fold into Other.
 */
export function usageSeries(r: UsageReport, group: UsageGroup, m: UsageMeasure): Series[] {
  const keys = Object.keys(r.totals.by[group]).filter((k) => value(r.totals.by[group][k], m) > 0);
  const fixed = FIXED[group] ?? [];
  const ordered = [...fixed.filter((k) => keys.includes(k)), ...keys.filter((k) => !fixed.includes(k)).sort()];
  const byTotal = [...ordered].sort((a, b) => value(r.totals.by[group][b], m) - value(r.totals.by[group][a], m));
  const kept = new Set(byTotal.slice(0, byTotal.length > SERIES_COLORS.length ? SERIES_COLORS.length - 1 : SERIES_COLORS.length));
  // A fixed key keeps its slot; the others take the slots after the fixed ones, in name order.
  let next = fixed.length;
  const out: Series[] = ordered.filter((k) => kept.has(k)).map((k) => ({ key: k, label: labelOf(group, k), color: (fixed.includes(k) ? SERIES_COLORS[fixed.indexOf(k)] : SERIES_COLORS[next++]) ?? OTHER_COLOR, total: value(r.totals.by[group][k], m) }));
  const rest = byTotal.filter((k) => !kept.has(k));
  if (rest.length) out.push({ key: OTHER, label: `${OTHER} (${rest.length})`, color: OTHER_COLOR, total: rest.reduce((n, k) => n + value(r.totals.by[group][k], m), 0) });
  return out.sort((a, b) => (a.key === OTHER ? 1 : b.key === OTHER ? -1 : b.total - a.total));
}

/** One day's value per series (Other summed), in the series' order. */
export function dayValues(day: UsageReport['days'][number], series: Series[], group: UsageGroup, m: UsageMeasure): number[] {
  const named = new Set(series.map((s) => s.key));
  return series.map((s) => (s.key === OTHER ? Object.entries(day.by[group]).filter(([k]) => !named.has(k)).reduce((n, [, c]) => n + value(c, m), 0) : value(day.by[group][s.key], m)));
}

/** A round top for the y axis and its ticks (0 included): 1, 2 or 5 times a power of ten per step. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * pow).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
}

export function formatValue(n: number, m: UsageMeasure): string {
  if (m === 'usd') return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

const ROLE_LABELS: Record<string, string> = { worker: 'Worker', planner: 'Planner', orchestrator: 'Orchestrator' };
export function labelOf(group: UsageGroup, key: string): string {
  if (group === 'role') return ROLE_LABELS[key] ?? key;
  if (group === 'provider') return key === 'claude' ? 'Claude' : key === 'codex' ? 'Codex' : key;
  return key;
}
