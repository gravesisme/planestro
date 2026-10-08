import { describe, expect, it } from 'vitest';
import { activeFilters, emptyText } from '../src/boardFilters.ts';

const none = { q: '', category: '', priority: '', needsOnly: false } as const;

describe('the board names the filters that hide items (#286)', () => {
  it('lists each active filter in a fixed order: needs you, category, priority, search', () => {
    expect(activeFilters(none)).toEqual([]);
    expect(activeFilters({ ...none, q: '  ' })).toEqual([]);
    expect(activeFilters({ q: ' lamp ', category: 'Game', priority: 'high', needsOnly: true }).map((f) => [f.key, f.label]))
      .toEqual([['needs', 'needs you'], ['category', 'Game'], ['priority', 'high priority'], ['q', '“lamp”']]);
  });

  it('names the running filter after needs you (#299)', () => {
    expect(activeFilters({ ...none, runningOnly: true, category: 'Game' }).map((f) => [f.key, f.label])).toEqual([['running', 'running'], ['category', 'Game']]);
    expect(emptyText(activeFilters({ ...none, runningOnly: true }))).toBe('No agent is running right now.');
    expect(emptyText(activeFilters({ ...none, runningOnly: true, category: 'Game' }))).toBe('No agent is running in Game.');
  });

  it('an empty board says what hides it', () => {
    expect(emptyText([])).toBe('Nothing here yet. Add an item with + New item.');
    expect(emptyText(activeFilters({ ...none, needsOnly: true }))).toBe('Nothing needs you right now.');
    expect(emptyText(activeFilters({ ...none, category: 'Game' }))).toBe('No item matches Game.');
    expect(emptyText(activeFilters({ ...none, needsOnly: true, category: 'Game', q: 'lamp' }))).toBe('Nothing needs you in Game · “lamp”.');
  });
});
