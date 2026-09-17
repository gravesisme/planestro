import { useEffect, useState } from 'react';
import type { Status } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act } from '../store.ts';

export const CLOSE_HINT = 'The work already landed some other way: finish this item without a pull request';

const IN_FLIGHT = ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'];
const laneOfStatus = (s: string) => s === 'ICEBOX' ? 'icebox' : s === 'FINISHED' ? 'done' : 'board';

/**
 * One misplaced click should not pull an item out from under its session, so a move asks first
 * when it changes the item's lane (board / icebox / done) or the item is in flight. Queueing and
 * cancelling inside the backlog stay one click.
 */
export function confirmMove(item: ItemView, to: string, label: string): boolean {
  const from = item.frontmatter.status;
  const inFlight = IN_FLIGHT.includes(from);
  if (!inFlight && laneOfStatus(from) === laneOfStatus(to)) return true;
  const where = to.replace(/_/g, ' ');
  return confirm(inFlight
    ? `${item.id} is ${from.replace(/_/g, ' ')} — planestro is working on it.\n\n"${label}" moves it to ${where} and stops that work (its worktree and session are kept). Continue?`
    : `Move ${item.id} "${item.frontmatter.title}" to ${where}?`);
}

/** Closing skips the PR, so it always asks first; the optional reason lands in the Activity log. */
export function promptCloseAsDone(id: string): void {
  const r = prompt(`Close ${id} as done without a pull request?\n\nIts worktree and branch are removed only if they hold no changes. Optional reason for the log:`);
  if (r !== null) void act(() => api.transition(id, 'FINISHED', r.trim() || undefined));
}

/**
 * The user's next steps for an item as one row of buttons, so the board's preview can act without
 * opening the full page. Plan approval is included because it is the most common "needs you".
 */
export function QuickActions({ item, onActed }: { item: ItemView; onActed?: () => void }) {
  const fm = item.frontmatter; const d = item.derived;
  const [transitions, setTransitions] = useState<{ to: Status; label: string }[]>([]);
  useEffect(() => { let live = true; api.transitions(item.id).then((t) => { if (live) setTransitions(t); }).catch(() => {}); return () => { live = false; }; }, [item.id, fm.status]);
  const run = (fn: () => Promise<unknown>) => { void act(fn).then(() => onActed?.()); };
  const planReady = fm.status === 'PLAN_READY' && fm.kind !== 'epic'; // an epic's breakdown is edited on its page, not approved blind
  // Approve / request-changes have their own endpoints (they start a session turn); the bare transition would not.
  const plain = transitions.filter((t) => !(fm.status === 'PLAN_READY' && (t.to === 'IN_PROGRESS' || t.to === 'PLAN_IN_PROGRESS')));
  if (!plain.length && !planReady && !fm.blocked && !(fm.status === 'IN_REVIEW' && (fm.awaiting === 'review' || fm.skip_merge))) return null;
  return (
    <div className="row quick-actions">
      {planReady && <button className="primary" onClick={() => run(() => api.approvePlan(item.id))}>Approve &amp; implement</button>}
      {fm.status === 'IN_REVIEW' && (fm.awaiting === 'review' || fm.skip_merge) && <button className="primary" onClick={() => { const n = prompt(`Let ${item.id} merge? Optional note for the log:`); if (n !== null) run(() => api.releaseHold(item.id, n || undefined)); }}>{fm.awaiting === 'review' ? 'Approve & merge' : 'Release hold'}</button>}
      {planReady && <button onClick={() => { const m = prompt(`What should change in the plan for ${item.id}?`); if (m?.trim()) run(() => api.rejectPlan(item.id, m.trim())); }}>Request changes…</button>}
      {plain.map((t) => t.to === 'FINISHED'
        ? <button key={t.to} title={CLOSE_HINT} onClick={() => promptCloseAsDone(item.id)}>{t.label}…</button>
        : <button key={t.to} className={t.to === 'QUEUED' ? 'primary' : ''} disabled={t.to === 'QUEUED' && (!d.deps_satisfied || !!d.base_branch_error)} title={d.base_branch_error ?? (t.to === 'QUEUED' && !d.deps_satisfied ? 'dependencies not merged' : '')} onClick={() => { if (confirmMove(item, t.to, t.label)) run(() => api.transition(item.id, t.to)); }}>{t.label}</button>)}
      {fm.blocked && <button className="danger" onClick={() => { const m = prompt(`Unblock ${item.id} (${fm.blocked_reason}). Optional message for the session:`); if (m !== null) run(() => api.unblock(item.id, m || undefined)); }}>unblock…</button>}
    </div>
  );
}
