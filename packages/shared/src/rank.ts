/**
 * Integer ranks spaced by GAP. Every move touches only the moved item; when no
 * integer gap remains the caller renormalizes the whole lane and retries.
 */
export const GAP = 1000;

export interface Ranked { id: string; rank?: number }

export function sortByRank<T extends Ranked>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ra = a.rank ?? Number.POSITIVE_INFINITY, rb = b.rank ?? Number.POSITIVE_INFINITY;
    return ra === rb ? a.id.localeCompare(b.id, undefined, { numeric: true }) : ra - rb;
  });
}

export function rankForTop(items: Ranked[]): number {
  const ranks = items.map((i) => i.rank).filter((r): r is number => r !== undefined);
  return ranks.length ? Math.min(...ranks) - GAP : GAP;
}

export function rankForBottom(items: Ranked[]): number {
  const ranks = items.map((i) => i.rank).filter((r): r is number => r !== undefined);
  return ranks.length ? Math.max(...ranks) + GAP : GAP;
}

/** Rank that places the moved item just before `refId`; null when there is no integer gap. */
export function rankBefore(items: Ranked[], refId: string, movingId: string): number | null {
  const sorted = sortByRank(items.filter((i) => i.id !== movingId));
  const idx = sorted.findIndex((i) => i.id === refId);
  if (idx < 0) throw new Error(`unknown reference item ${refId}`);
  const ref = sorted[idx].rank;
  if (ref === undefined) return null;
  if (idx === 0) return ref - GAP;
  const prev = sorted[idx - 1].rank;
  if (prev === undefined) return null;
  return midpoint(prev, ref);
}

/** Rank that places the moved item just after `refId`; null when there is no integer gap. */
export function rankAfter(items: Ranked[], refId: string, movingId: string): number | null {
  const sorted = sortByRank(items.filter((i) => i.id !== movingId));
  const idx = sorted.findIndex((i) => i.id === refId);
  if (idx < 0) throw new Error(`unknown reference item ${refId}`);
  const ref = sorted[idx].rank;
  if (ref === undefined) return null;
  if (idx === sorted.length - 1) return ref + GAP;
  const next = sorted[idx + 1].rank;
  if (next === undefined) return ref + GAP; // unranked items sort last: after `ref` is still the end of the ranked run
  return midpoint(ref, next);
}

function midpoint(a: number, b: number): number | null {
  if (b - a < 2) return null;
  return a + Math.floor((b - a) / 2);
}

/** New ranks for the given ordered ids: 1000, 2000, … */
export function renormalize(orderedIds: string[]): Map<string, number> {
  return new Map(orderedIds.map((id, i) => [id, GAP * (i + 1)]));
}
