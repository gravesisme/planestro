import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DISCARD, epicFlagOf, holdShapeOf, type Status } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { canTakeOver, TakeOverButton } from './TakeOver.tsx';
import { ActionButton, ActionGroup } from './ActionButton.tsx';

export const CLOSE_HINT = 'The work already landed some other way: finish this item without a pull request';
export const FINISH_HINT = 'The work is committed on the branch but never reached a pull request (over budget, a size gate, a commit made by hand): open the pull request from the worktree, as planestro would have';

/** Finish from here (f2): it refuses a dirty tree or a branch with nothing ahead of its base, and says which. */
export function promptFinishFromWorktree(id: string): Promise<unknown> | undefined {
  if (confirm(`Open a pull request for ${id} from its worktree?\n\nIts committed work goes through the same sync and CI as any item; any block is cleared. The tree must be clean and ahead of its base.`)) return act(() => api.finishFromWorktree(id));
}

export const SYNC_HINT = 'Bring the branch up to date with its base between turns (rebased; pushed with a lease only if already pushed), e.g. after something it needs has merged. A conflict goes to the session.';

/**
 * Sync with base (p29) is offered for a worker item with a worktree that nothing is driving right now:
 * no live turn, no step in flight, not waiting on an answer. The engine re-checks all of it.
 */
export function canSyncWithBase(item: ItemView, live: boolean): boolean {
  const fm = item.frontmatter;
  return fm.kind !== 'epic' && !item.derived.external && ['PLAN_IN_PROGRESS', 'IN_PROGRESS'].includes(fm.status) && !!fm.worktree && !fm.op && !live && (!fm.awaiting || fm.awaiting === 'user');
}

export function promptSyncWithBase(item: ItemView): Promise<unknown> | undefined {
  if (confirm(`Sync ${item.id} with ${item.derived.base_branch ?? 'its base'}?\n\nIts branch is rebased onto origin/${item.derived.base_branch ?? '<base>'} (nothing happens if it is already there). A conflict is aborted and goes to its session. The tree must be clean.`)) return act(() => api.syncWithBase(item.id));
}

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

/** What a move button says while it goes (#304). */
export function movingLabel(to: string): string {
  return to === 'QUEUED' ? 'Queuing…' : to === 'ICEBOX' ? 'Moving to the icebox…' : to === 'NOT_YET_SUBMITTED' ? 'Moving to the backlog…' : to === 'PLAN_IN_PROGRESS' ? 'Starting the plan…' : to === 'IN_PROGRESS' ? 'Starting…' : 'Moving…';
}

/** Closing skips the PR, so it always asks first; the optional reason lands in the Activity log. */
export function promptCloseAsDone(id: string): Promise<unknown> | undefined {
  const r = prompt(`Close ${id} as done without a pull request?\n\nIts worktree and branch are removed only if they hold no changes. Optional reason for the log:`);
  if (r !== null) return act(() => api.transition(id, 'FINISHED', r.trim() || undefined));
}

/**
 * The user's next steps for an item as one row of buttons, so the board's preview can act without
 * opening the full page. Plan approval is included because it is the most common "needs you".
 */
export function QuickActions({ item, onActed }: { item: ItemView; onActed?: () => void }) {
  const fm = item.frontmatter; const d = item.derived;
  const [transitions, setTransitions] = useState<{ to: Status; label: string }[]>([]);
  useEffect(() => { let live = true; api.transitions(item.id).then((t) => { if (live) setTransitions(t); }).catch(() => {}); return () => { live = false; }; }, [item.id, fm.status]);
  const run = (fn: () => Promise<unknown>) => act(fn).then(() => onActed?.());
  const live = useStore((s) => !!s.state?.engine.sessions.some((x) => x.item === item.id));
  const sync = canSyncWithBase(item, live);
  const planReady = fm.status === 'PLAN_READY' && fm.kind !== 'epic'; // an epic's breakdown is edited on its page, not approved blind
  // A plan that says its pull request must wait is approved on its page, where the hold is offered (#97).
  const statedHold = planReady ? holdShapeOf(item.sections.Plan ?? '') : null;
  // Approve / request-changes have their own endpoints (they start a session turn); the bare transition would not.
  const plain = transitions.filter((t) => t.label !== DISCARD && !(fm.status === 'PLAN_READY' && (t.to === 'IN_PROGRESS' || t.to === 'PLAN_IN_PROGRESS')));
  if (!plain.length && !planReady && !fm.blocked && !sync && fm.status !== 'IN_PROGRESS' && !canTakeOver(item) && !(fm.status === 'IN_REVIEW' && (fm.awaiting === 'review' || fm.skip_merge))) return null;
  return (
    <div className="row quick-actions"><ActionGroup>
      {planReady && !epicFlagOf(fm) && !statedHold && <ActionButton className="primary" working="Approving…" onAct={() => run(() => api.approvePlan(item.id))}>Approve &amp; implement</ActionButton>}
      {planReady && !epicFlagOf(fm) && statedHold && <Link className="button primary" to={`/items/${item.id}`} title={`Its plan says: "${statedHold.quote}"`}>States a merge hold: decide…</Link>}
      {planReady && epicFlagOf(fm) && <Link className="button primary" to={`/items/${item.id}`} title={epicFlagOf(fm)!.reason}>An epic: convert it…</Link>}
      {fm.status === 'IN_REVIEW' && (fm.awaiting === 'review' || fm.skip_merge) && <ActionButton className="primary" working="Releasing…" onAct={() => { const n = prompt(`Let ${item.id} merge? Optional note for the log:`); if (n !== null) return run(() => api.releaseHold(item.id, n || undefined)); }}>{fm.awaiting === 'review' ? 'Approve & merge' : 'Release hold'}</ActionButton>}
      {planReady && <ActionButton working="Sending…" onAct={() => { const m = prompt(`What should change in the plan for ${item.id}?`); if (m?.trim()) return run(() => api.rejectPlan(item.id, m.trim())); }}>Request changes…</ActionButton>}
      {plain.map((t) => t.to === 'FINISHED'
        ? <ActionButton key={t.to} title={CLOSE_HINT} working="Closing…" onAct={() => promptCloseAsDone(item.id)}>{t.label}…</ActionButton>
        : <ActionButton key={t.to} className={t.to === 'QUEUED' ? 'primary' : ''} disabled={t.to === 'QUEUED' && (!d.deps_satisfied || !!d.base_branch_error)} title={d.base_branch_error ?? (t.to === 'QUEUED' && !d.deps_satisfied ? 'dependencies not merged' : '')} working={movingLabel(t.to)} onAct={() => { if (confirmMove(item, t.to, t.label)) return run(() => api.transition(item.id, t.to)); }}>{t.label}</ActionButton>)}
      {fm.blocked && <ActionButton className="danger" working="Unblocking…" onAct={() => { const m = prompt(`Unblock ${item.id} (${fm.blocked_reason}). Optional message for the session:`); if (m !== null) return run(() => api.unblock(item.id, m || undefined)); }}>unblock…</ActionButton>}
      {fm.status === 'IN_PROGRESS' && !d.external && fm.kind !== 'epic' && fm.worktree && !fm.taken_over && <ActionButton title={FINISH_HINT} working="Opening the PR…" onAct={() => promptFinishFromWorktree(item.id)?.then(() => onActed?.())}>finish from here…</ActionButton>}
      <TakeOverButton item={item} onActed={onActed} />
      {sync && <ActionButton title={SYNC_HINT} working="Syncing…" onAct={() => promptSyncWithBase(item)?.then(() => onActed?.())}>sync with base…</ActionButton>}
    </ActionGroup></div>
  );
}
