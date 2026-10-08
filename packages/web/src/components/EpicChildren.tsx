import { Link } from 'react-router';
import type { ItemView } from '../api.ts';
import { statusLabel } from './ItemCard.tsx';
import { ChildQueue, childQueueState } from './ChildQueue.tsx';

/** An epic's children as stored, and how many have merged: what its page and its quick view both show (#290). */
export function epicChildren(epic: ItemView, items: ItemView[]): { children: ItemView[]; merged: number } {
  const children = epic.derived.children.map((c) => items.find((i) => i.id === c)).filter(Boolean) as ItemView[];
  return { children, merged: children.filter((c) => ['MERGED', 'FINISHED'].includes(c.frontmatter.status)).length };
}

/** Each child's id, title and status, with its PR, or a Queue button / what it still waits on (#284). */
export function ChildrenTable({ epic, items }: { epic: ItemView; items: ItemView[] }) {
  const { children } = epicChildren(epic, items);
  const lookup = (id: string) => items.find((i) => i.id === id)?.frontmatter;
  return (
    <table><tbody>{children.map((c) => {
      const q = childQueueState(c.frontmatter, lookup, Boolean(epic.frontmatter.branch));
      return <tr key={c.id}><td><Link to={`/items/${c.id}`}>{c.id}</Link></td><td>{c.frontmatter.title}</td><td>{statusLabel(c.frontmatter.status)}</td><td>{q ? <ChildQueue id={c.id} state={q} /> : c.frontmatter.pr ? `PR #${c.frontmatter.pr}` : ''}</td></tr>;
    })}</tbody></table>
  );
}
