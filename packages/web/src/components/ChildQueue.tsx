import { Fragment } from 'react';
import { Link } from 'react-router';
import { isDone, type ItemFrontmatter, type Status } from '@planestro/shared/view';
import { api } from '../api.ts';
import { act } from '../store.ts';
import { ActionButton } from './ActionButton.tsx';

/** What an epic's not-yet-submitted child can do from the Children list (#284): be queued, or wait on these. */
export type ChildQueueState = { kind: 'queue' } | { kind: 'waits'; on: { id: string; status?: Status }[] } | { kind: 'epic_closed' };

/** `epicOpen`: the epic has its integration branch; until it does, the server refuses to queue its children. */
export function childQueueState(fm: Pick<ItemFrontmatter, 'status' | 'depends_on'>, lookup: (id: string) => Pick<ItemFrontmatter, 'status'> | undefined, epicOpen = true): ChildQueueState | undefined {
  if (fm.status !== 'NOT_YET_SUBMITTED') return undefined;
  if (!epicOpen) return { kind: 'epic_closed' };
  const on = fm.depends_on.map((id) => ({ id, status: lookup(id)?.status })).filter((d) => !d.status || !isDone(d.status));
  return on.length ? { kind: 'waits', on } : { kind: 'queue' };
}

export function ChildQueue({ id, state }: { id: string; state: ChildQueueState }) {
  if (state.kind === 'epic_closed') return <span className="small muted">waits on the epic branch (Open epic branch above)</span>;
  if (state.kind === 'queue') return <ActionButton className="small" working="Queuing…" onAct={() => act(() => api.transition(id, 'QUEUED'))}>Queue</ActionButton>;
  return (
    <span className="small muted">waits on {state.on.map((d, i) => (
      <Fragment key={d.id}>{i > 0 && ', '}{d.status ? <Link to={`/items/${d.id}`}>{d.id}</Link> : d.id} ({d.status ? d.status.replace(/_/g, ' ').toLowerCase() : 'not found'})</Fragment>
    ))}</span>
  );
}
