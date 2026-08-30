import { describe, it, expect } from 'vitest';
import { rankForTop, rankForBottom, rankBefore, rankAfter, renormalize, sortByRank, GAP } from '../src/rank.ts';

const items = [{ id: 'A', rank: 1000 }, { id: 'B', rank: 2000 }, { id: 'C', rank: 3000 }, { id: 'D' }];

describe('rank', () => {
  it('sorts missing ranks last, ties by id', () => {
    expect(sortByRank([{ id: 'B', rank: 5 }, { id: 'A', rank: 5 }, { id: 'Z' }]).map((i) => i.id)).toEqual(['A', 'B', 'Z']);
  });
  it('top/bottom', () => {
    expect(rankForTop(items)).toBe(0);
    expect(rankForBottom(items)).toBe(4000);
    expect(rankForTop([])).toBe(GAP);
  });
  it('before/after use midpoints and touch only the mover', () => {
    expect(rankBefore(items, 'B', 'C')).toBe(1500);
    expect(rankAfter(items, 'B', 'A')).toBe(2500);
    expect(rankBefore(items, 'A', 'C')).toBe(0);
    expect(rankAfter(items, 'C', 'A')).toBe(4000);
  });
  it('returns null when no integer gap remains, and renormalize restores gaps', () => {
    const tight = [{ id: 'A', rank: 1 }, { id: 'B', rank: 2 }];
    expect(rankBefore(tight, 'B', 'C')).toBeNull();
    const map = renormalize(['A', 'B', 'C']);
    expect([...map.values()]).toEqual([1000, 2000, 3000]);
  });
});
