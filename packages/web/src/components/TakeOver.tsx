import { api, type ItemView } from '../api.ts';
import { act } from '../store.ts';

const TAKEABLE = ['QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'];
export const TAKE_OVER_HINT = 'You finish this item by hand: its running turn stops, what was queued for it is dropped, and nothing automatic touches it until you hand it back';

/** A worker item planestro is driving, and nobody has taken it over yet. */
export function canTakeOver(item: ItemView): boolean {
  return item.derived.flavor === 'worker' && !item.frontmatter.taken_over && TAKEABLE.includes(item.frontmatter.status);
}

/** Taking over stops a session mid-turn, so it always asks first; the optional note lands in the Activity log. */
export function promptTakeOver(item: ItemView, onActed?: () => void): void {
  const n = prompt(`Take ${item.id} over and finish it by hand?\n\nIts running turn is stopped and anything queued for it (messages, a fix, a resume) is dropped. No turn, orchestrator, fix or merge touches it until you hand it back; its CI is still read. Optional note for the log:`);
  if (n !== null) void act(() => api.takeOver(item.id, n.trim() || undefined)).then(() => onActed?.());
}

export function TakeOverButton({ item, onActed }: { item: ItemView; onActed?: () => void }) {
  if (!canTakeOver(item)) return null;
  return <button title={TAKE_OVER_HINT} onClick={() => promptTakeOver(item, onActed)}>Take over…</button>;
}

/** What handing it back will do, from where the item stands now. */
function handBackSays(item: ItemView): string {
  const fm = item.frontmatter;
  if (fm.status === 'IN_REVIEW' && fm.pr) return 'Handing it back sends the pull request through sync and CI, and it merges.';
  if (fm.status === 'IN_PROGRESS') return 'Handing it back runs the done check: committed work on a clean worktree goes to a pull request; otherwise its session resumes, told you had the worktree.';
  if (fm.status === 'PLAN_IN_PROGRESS') return 'Handing it back resumes its planning session, told you had the worktree.';
  if (fm.status === 'PLAN_READY') return 'Its plan still waits for approval: approving it while you have the item starts no session; handing it back does.';
  if (fm.status === 'QUEUED') return 'Handing it back lets it start when a slot is free.';
  return 'Handing it back lets planestro drive it again from where it stands.';
}

/** The banner while you have the item: since when, your note, what still runs, and the way back. */
export function TakenOverPanel({ item }: { item: ItemView }) {
  const fm = item.frontmatter;
  if (!fm.taken_over) return null;
  const handBack = () => { const n = prompt(`Hand ${item.id} back to planestro? ${handBackSays(item)}\n\nOptional note (for the log, and for its session if it resumes):`); if (n !== null) void act(() => api.handBack(item.id, n.trim() || undefined)); };
  return (
    <div className="yours-panel">
      <h2>You have this item <span className="small muted">since {fm.taken_over.since.slice(0, 16).replace('T', ' ')}</span></h2>
      {fm.taken_over.note && <p className="blocked-said">{fm.taken_over.note}</p>}
      <p className="small" style={{ marginTop: 0 }}>Nothing automatic touches it: no turns, no orchestrator, no fix on red CI, no merge.{fm.pr ? <> CI on PR #{fm.pr}: <b>{fm.ci_result ?? 'pending'}</b>{fm.ci_head_sha ? ` (${fm.ci_head_sha.slice(0, 7)})` : ''}.</> : null} {handBackSays(item)}</p>
      <div className="row"><button className="primary" onClick={handBack}>Hand back…</button></div>
    </div>
  );
}
