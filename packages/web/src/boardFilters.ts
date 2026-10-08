export type FilterKey = 'needs' | 'category' | 'priority' | 'q';
export type ActiveFilter = { key: FilterKey; label: string };

/** The board's filters that hide items, in the order they are named: on a phone the chip strip scrolls them out of sight (#286). */
export function activeFilters(f: { q: string; category: string; priority: string; needsOnly: boolean }): ActiveFilter[] {
  const q = f.q.trim();
  return [
    ...(f.needsOnly ? [{ key: 'needs' as const, label: 'needs you' }] : []),
    ...(f.category ? [{ key: 'category' as const, label: f.category }] : []),
    ...(f.priority ? [{ key: 'priority' as const, label: `${f.priority} priority` }] : []),
    ...(q ? [{ key: 'q' as const, label: `“${q}”` }] : []),
  ];
}

/** What an empty board says: the filters that emptied it, else how to start. */
export function emptyText(filters: ActiveFilter[]): string {
  if (!filters.length) return 'Nothing here yet. Add an item with + New item.';
  const rest = filters.filter((f) => f.key !== 'needs').map((f) => f.label).join(' · ');
  if (filters.some((f) => f.key === 'needs')) return rest ? `Nothing needs you in ${rest}.` : 'Nothing needs you right now.';
  return `No item matches ${rest}.`;
}
