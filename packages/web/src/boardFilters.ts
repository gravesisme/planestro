export type FilterKey = 'needs' | 'running' | 'category' | 'priority' | 'release' | 'q';
/** The board's release filter (#375): a version, or NO_RELEASE for items planned for none. */
export const NO_RELEASE = '\u0000none';
export type ActiveFilter = { key: FilterKey; label: string };

/** The board's filters that hide items, in the order they are named: on a phone the chip strip scrolls them out of sight (#286). */
export function activeFilters(f: { q: string; category: string; priority: string; release?: string; needsOnly: boolean; runningOnly?: boolean }): ActiveFilter[] {
  const q = f.q.trim();
  return [
    ...(f.needsOnly ? [{ key: 'needs' as const, label: 'needs you' }] : []),
    ...(f.runningOnly ? [{ key: 'running' as const, label: 'running' }] : []),
    ...(f.category ? [{ key: 'category' as const, label: f.category }] : []),
    ...(f.priority ? [{ key: 'priority' as const, label: `${f.priority} priority` }] : []),
    ...(f.release ? [{ key: 'release' as const, label: f.release === NO_RELEASE ? 'no release' : `release ${f.release}` }] : []),
    ...(q ? [{ key: 'q' as const, label: `“${q}”` }] : []),
  ];
}

/** What an empty board says: the filters that emptied it, else how to start. */
export function emptyText(filters: ActiveFilter[]): string {
  if (!filters.length) return 'Nothing here yet. Add an item with + New item.';
  const rest = filters.filter((f) => f.key !== 'needs' && f.key !== 'running').map((f) => f.label).join(' · ');
  if (filters.some((f) => f.key === 'running')) return rest ? `No agent is running in ${rest}.` : 'No agent is running right now.';
  if (filters.some((f) => f.key === 'needs')) return rest ? `Nothing needs you in ${rest}.` : 'Nothing needs you right now.';
  return `No item matches ${rest}.`;
}
