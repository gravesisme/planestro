import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useStore, act } from '../store.ts';
import { api } from '../api.ts';
import { Markdown } from './Markdown.tsx';
import { ItemConsole } from './ItemConsole.tsx';
import { statusLabel } from './ItemCard.tsx';
import { QuickActions } from './QuickActions.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import { BlockedPanel } from './BlockedPanel.tsx';
import { WaitingPanel } from './ResumeAfter.tsx';
import { TakenOverPanel } from './TakeOver.tsx';
import { AwaitingPanels } from './AwaitingPanels.tsx';
import { DecisionCard } from './DecisionCard.tsx';
import { PartsStrip } from './PartsStrip.tsx';
import { ChildrenTable, epicChildren } from './EpicChildren.tsx';
import { decisionOf } from '@planestro/shared';

const LIVE_STATUSES = ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'];

/** Single-click preview of a board item, with a link to the full details view. */
export function PreviewDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useStore((s) => s.state);
  const item = state?.items.find((i) => i.id === id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!item) return null;
  const fm = item.frontmatter;
  const d = item.derived;
  const session = state?.engine.sessions.find((s) => s.item === id);
  // An epic says so, and shows its children as its page does (#290).
  const epic = fm.kind === 'epic' && state ? epicChildren(item, state.items) : undefined;
  const showConsole = session || fm.session_id || LIVE_STATUSES.includes(fm.status);
  // At a decision, a review or a block, what you need is the latest activity and the card, not the
  // brief you wrote weeks ago (dogfood f9): the description folds to one line and activity comes first.
  const deciding = Boolean(decisionOf(fm)) || fm.awaiting === 'review' || (fm.blocked && !fm.triage) || Boolean(fm.taken_over);
  const [descOpen, setDescOpen] = useState(false);
  const firstLine = (item.sections.Description || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '(no description)';
  const description = deciding && !descOpen
    ? <div className="drawer-desc drawer-desc-folded" onClick={() => setDescOpen(true)} role="button" title="Show the whole description"><span className="small muted">Description · </span>{firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine} <span className="small" style={{ color: 'var(--accent)' }}>more</span></div>
    : <div className="drawer-desc"><Markdown text={item.sections.Description || '_(no description)_'} /></div>;
  const activity = <><h3 className="drawer-h">Latest activity</h3><ul className="activity">{item.activity.slice(-4).map((a, i) => <li key={i}><span className="at">{a.at.slice(5, 16).replace('T', ' ')}</span><span className="muted">{a.actor}</span><span>{a.text}</span></li>)}</ul></>;
  return (
    <>
    <div className="drawer-backdrop" onClick={onClose} />
    <aside className="drawer" onClick={(e) => e.stopPropagation()}>
      <div className="row drawer-head">
        <span className="id">{id}</span>
        <b className="grow">{fm.title}</b>
        <Link to={`/items/${id}`} onClick={onClose}><button className="small">Full details</button></Link>
        <button className="small" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <div className="controls" style={{ margin: '8px 0' }}>
        {epic && <span className="pill epic">EPIC {epic.merged}/{epic.children.length}</span>}
        <span className="pill">{statusLabel(fm.status)}</span>
        {fm.blocked && <span className="pill blocked">BLOCKED · {fm.blocked_reason}</span>}
        {fm.awaiting && <span className={`pill ${d.needs_you ? 'await' : ''}`}>{decisionOf(fm) ? 'your decision' : `awaiting ${fm.awaiting.replace(/_/g, ' ')}`}</span>}
        {fm.triage && <span className="pill triage">orchestrator triaging</span>}
        {fm.taken_over && <span className="pill yours">yours · by hand</span>}
        {fm.op && <span className="pill">{fm.op.replace(/_/g, ' ')}</span>}
        {session && <span className="pill">session {session.busy ? 'running' : 'idle'}</span>}
      </div>
      <p className="small muted" style={{ margin: '4px 0' }}>
        {fm.category}{fm.priority ? ` · ${fm.priority} priority` : ''} · {fm.planner}{fm.implementer !== fm.planner ? ` → ${fm.implementer}` : ''}
        {fm.branch ? <> · <code>{fm.branch}</code></> : null}
        {fm.pr ? <> · <a href={`https://github.com/${state!.config.code_repo.github}/pull/${fm.pr}`} target="_blank" rel="noreferrer">PR #{fm.pr}</a>{fm.ci_result ? ` (CI ${fm.ci_result})` : ''}</> : null}
      </p>
      {fm.kind !== 'epic' && !d.external && state && (() => {
        // At the top, so a plan waiting on you says whether the orchestrator was allowed to review it at all.
        const orch = state.config.orchestrator;
        return (
          <label className="row small" style={{ margin: '0 0 8px' }} title={orch.may_approve_plans ? `The orchestrator reviews the plan and approves it, sends it back with fixes (up to ${orch.max_plan_revisions} round${orch.max_plan_revisions === 1 ? '' : 's'}), or leaves it to you` : 'Turn on "May approve plans" in Settings → Orchestrator first'}>
            <input type="checkbox" checked={!!fm.auto_approve_plan} disabled={!orch.may_approve_plans} onChange={(e) => void act(() => api.patchItem(id, { fields: { auto_approve_plan: e.target.checked } }))} />
            let the orchestrator approve the plan{orch.may_approve_plans ? ` (up to ${orch.max_plan_revisions} fix round${orch.max_plan_revisions === 1 ? '' : 's'}, then you)` : ' (off in Settings)'}
          </label>
        );
      })()}
      <DecisionCard item={item} />
      {fm.parts?.length ? <PartsStrip parts={fm.parts} compact /> : null}
      <TakenOverPanel item={item} />
      <BlockedPanel item={item} compact />
      <WaitingPanel item={item} />
      <AwaitingPanels item={item} />
      {fm.awaiting === 'review' ? <ReviewPanel item={item} compact /> : <QuickActions item={item} />}
      {deciding && activity}
      {epic && state && (<><h3 className="drawer-h">Children · {epic.merged}/{epic.children.length} merged</h3>{epic.children.length ? <div className="drawer-children"><ChildrenTable epic={item} items={state.items} /></div> : <p className="small muted">No children yet.</p>}</>)}
      {description}
      {fm.status === 'PLAN_READY' && item.sections.Plan && (<><h3 className="drawer-h">Plan awaiting your approval</h3><div className="drawer-desc"><Markdown text={item.sections.Plan} /></div></>)}
      {showConsole && (<><h3 className="drawer-h">Console</h3><ItemConsole id={id} tail={14} className="drawer-console" /></>)}
      {!deciding && activity}
      <div className="row drawer-foot">
        <Link className="grow" to={`/items/${id}`} onClick={onClose}><button className="primary" style={{ width: '100%' }}>Open full details →</button></Link>
      </div>
    </aside>
    </>
  );
}
