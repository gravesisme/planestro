import { priorityBand } from '@planestro/shared/view';
import type { ItemView } from './api.ts';

/** The items in `item`'s column (same lane and status), in the order the server lists them: priority band, then rank. */
export function columnOf(items: ItemView[], item: ItemView): ItemView[] {
  return items.filter((i) => i.derived.lane === item.derived.lane && i.frontmatter.status === item.frontmatter.status);
}

const sameBand = (a: ItemView, b: ItemView) => priorityBand(a.frontmatter.priority) === priorityBand(b.frontmatter.priority);

/**
 * The move that puts `id` one place up or down its column, or undefined when it is already at the end
 * of its priority band: a rank orders an item within its band (#194), so the step never crosses one.
 */
export function stepMove(column: ItemView[], id: string, dir: 'up' | 'down'): { op: 'before' | 'after'; ref: string } | undefined {
  const at = column.findIndex((i) => i.id === id);
  const next = column[dir === 'up' ? at - 1 : at + 1];
  if (at < 0 || !next || !sameBand(column[at]!, next)) return undefined;
  return { op: dir === 'up' ? 'before' : 'after', ref: next.id };
}

/** What **Move after…** offers for `id`: the other items of its band, less the one it already follows. */
export function afterChoices(column: ItemView[], id: string): ItemView[] {
  const at = column.findIndex((i) => i.id === id);
  if (at < 0) return [];
  return column.filter((i, n) => n !== at && n !== at - 1 && sameBand(i, column[at]!));
}
