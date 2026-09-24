import { useEffect } from 'react';
import { Link } from 'react-router';
import { useStore } from '../store.ts';
import { Markdown } from './Markdown.tsx';
import { ItemConsole } from './ItemConsole.tsx';
import { statusLabel } from './ItemCard.tsx';
import { QuickActions } from './QuickActions.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import { BlockedPanel } from './BlockedPanel.tsx';
import { WaitingPanel } from './ResumeAfter.tsx';
import { AwaitingPanels } from './AwaitingPanels.tsx';
import { DecisionCard } from './DecisionCard.tsx';
import { PartsStrip } from './PartsStrip.tsx';
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
  const showConsole = session || fm.session_id || LIVE_STATUSES.includes(fm.status);
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
        <span className="pill">{statusLabel(fm.status)}</span>
        {fm.blocked && <span className="pill blocked">BLOCKED · {fm.blocked_reason}</span>}
        {fm.awaiting && <span className={`pill ${d.needs_you ? 'await' : ''}`}>{decisionOf(fm) ? 'your decision' : `awaiting ${fm.awaiting.replace(/_/g, ' ')}`}</span>}
        {fm.triage && <span className="pill triage">orchestrator triaging</span>}
        {fm.op && <span className="pill">{fm.op.replace(/_/g, ' ')}</span>}
        {session && <span className="pill">session {session.busy ? 'running' : 'idle'}</span>}
      </div>
      <p className="small muted" style={{ margin: '4px 0' }}>
        {fm.category} · {fm.planner}{fm.implementer !== fm.planner ? ` → ${fm.implementer}` : ''}
        {fm.branch ? <> · <code>{fm.branch}</code></> : null}
        {fm.pr ? <> · <a href={`https://github.com/${state!.config.code_repo.github}/pull/${fm.pr}`} target="_blank" rel="noreferrer">PR #{fm.pr}</a>{fm.ci_result ? ` (CI ${fm.ci_result})` : ''}</> : null}
      </p>
      <DecisionCard item={item} />
      {fm.parts?.length ? <PartsStrip parts={fm.parts} compact /> : null}
      <BlockedPanel item={item} compact />
      <WaitingPanel item={item} />
      <AwaitingPanels item={item} />
      {fm.awaiting === 'review' ? <ReviewPanel item={item} compact /> : <QuickActions item={item} />}
      <div className="drawer-desc"><Markdown text={item.sections.Description || '_(no description)_'} /></div>
      {fm.status === 'PLAN_READY' && item.sections.Plan && (<><h3 className="drawer-h">Plan awaiting your approval</h3><div className="drawer-desc"><Markdown text={item.sections.Plan} /></div></>)}
      {showConsole && (<><h3 className="drawer-h">Console</h3><ItemConsole id={id} tail={14} className="drawer-console" /></>)}
      <h3 className="drawer-h">Latest activity</h3>
      <ul className="activity">{item.activity.slice(-4).map((a, i) => <li key={i}><span className="at">{a.at.slice(5, 16).replace('T', ' ')}</span><span className="muted">{a.actor}</span><span>{a.text}</span></li>)}</ul>
      <div className="row drawer-foot">
        <Link className="grow" to={`/items/${id}`} onClick={onClose}><button className="primary" style={{ width: '100%' }}>Open full details →</button></Link>
      </div>
    </aside>
    </>
  );
}
