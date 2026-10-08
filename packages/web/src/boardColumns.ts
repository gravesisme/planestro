export const BOARD_COLUMNS = ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'];

/**
 * The board's columns, given the status of every item on the board, filtered or not (#291). An item
 * is MERGED only until cleanup moves it to FINISHED, so Merged is left out while it is empty; one that
 * stays there is stuck, and no filter may hide that the column exists.
 */
export function boardColumns(statuses: readonly string[]): string[] {
  return statuses.includes('MERGED') ? BOARD_COLUMNS : BOARD_COLUMNS.filter((s) => s !== 'MERGED');
}
