import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, boardColumns } from '../src/boardColumns.ts';

describe('the board leaves out Merged while nothing is merged (#291)', () => {
  it('shows every column but Merged when no board item is MERGED', () => {
    expect(boardColumns([])).toEqual(BOARD_COLUMNS.filter((s) => s !== 'MERGED'));
    expect(boardColumns(['QUEUED', 'IN_REVIEW'])).not.toContain('MERGED');
  });

  it('shows Merged, last, as soon as any board item is MERGED: something is stuck in cleanup', () => {
    expect(boardColumns(['IN_PROGRESS', 'MERGED'])).toEqual(BOARD_COLUMNS);
    expect(boardColumns(['IN_PROGRESS', 'MERGED']).at(-1)).toBe('MERGED');
  });
});
