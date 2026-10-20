import { ReleasePicker } from './ReleasePicker.tsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useStore, act } from '../store.ts';
import { api, type ItemView, type State } from '../api.ts';
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
import { ActivityList } from './ActivityList.tsx';
import { decisionOf, findModel, modelCapabilities } from '@planestro/shared';
import { isActiveItem, nowOf, phaseTrack } from '../drawerNow.ts';
import { useFullItem } from '../fullItem.ts';
import { CategoryTag } from './CategoryTag.tsx';

const LIVE_STATUSES = ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'];
const shortStamp = (at: string) => at.slice(5, 16).replace('T', ' ');

/** Single-click preview of a board item, with a link to the full details view. */
export function PreviewDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useStore((s) => s.state);
  const item = useFullItem(id);
  const [descOpen, setDescOpen] = useState(false);
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
  const firstLine = (item.sections.Description || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '(no description)';
  const clipped = firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
  const autoApprove = fm.kind !== 'epic' && !d.external && state && (() => {
    // At the top, so a plan waiting on you says whether the orchestrator was allowed to review it at all.
    const orch = state.config.orchestrator;
    return (
      <label className="row small" style={{ margin: '0 0 8px' }} title={orch.may_approve_plans ? `The orchestrator reviews the plan and approves it, sends it back with fixes (up to ${orch.max_plan_revisions} round${orch.max_plan_revisions === 1 ? '' : 's'}), or leaves it to you` : 'Turn on "May approve plans" in Settings → Orchestrator first'}>
        <input type="checkbox" checked={!!fm.auto_approve_plan} disabled={!orch.may_approve_plans} onChange={(e) => void act(() => api.patchItem(id, { fields: { auto_approve_plan: e.target.checked } }))} />
        let the orchestrator approve the plan{orch.may_approve_plans ? ` (up to ${orch.max_plan_revisions} fix round${orch.max_plan_revisions === 1 ? '' : 's'}, then you)` : ' (off in Settings)'}
      </label>
    );
  })();
  const panels = <>
    <DecisionCard item={item} />
    {fm.parts?.length ? <PartsStrip parts={fm.parts} compact /> : null}
    <TakenOverPanel item={item} />
    <BlockedPanel item={item} compact />
    <WaitingPanel item={item} />
    <AwaitingPanels item={item} />
  </>;
  const children = epic && state && (<><h3 className="drawer-h">Children · {epic.merged}/{epic.children.length} merged</h3>{epic.children.length ? <div className="drawer-children"><ChildrenTable epic={item} items={state.items} /></div> : <p className="small muted">No children yet.</p>}</>);
  const plan = fm.status === 'PLAN_READY' && item.sections.Plan && (<><h3 className="drawer-h">Plan awaiting your approval</h3><div className="drawer-desc"><Markdown text={item.sections.Plan} /></div></>);
  const consoleOf = (tail: number) => showConsole && (<><h3 className="drawer-h">Console</h3><ItemConsole id={id} tail={tail} className="drawer-console" /></>);

  let body: ReactNode;
  if (state && isActiveItem(item, state)) {
    // An active item opens on what is happening now (#314): the Now strip, where it is, the console and the newest
    // activity. The step the state calls for stays in the row and the rest go behind ⋯; the brief folds to the bottom.
    const now = nowOf(item, state);
    const extra = [fm.status !== 'PLAN_READY' && item.sections.Plan?.trim() && 'plan', item.sections.Notes?.trim() && 'notes'].filter(Boolean) as string[];
    body = <>
      <div className={`drawer-now tone-${now.tone}`} title={now.title}>
        <div className="drawer-now-line">{now.tone === 'running' && <span className="pulse" aria-hidden />}<span className="grow">{now.text}</span>{epic && <span className="pill epic">EPIC {epic.merged}/{epic.children.length}</span>}</div>
        {now.tone === 'running' && <div className="drawer-now-out" title={now.output}>{now.output ?? 'No output yet.'}</div>}
      </div>
      <ol className="phase-track" aria-label="Lifecycle">
        {phaseTrack(fm).map((p) => <li key={p.label} className={p.state} aria-current={p.state === 'current' ? 'step' : undefined}>{p.state === 'done' && <span aria-hidden>✓ </span>}{p.label}{p.spent && <span className="spent"> {p.spent}</span>}</li>)}
      </ol>
      {fm.awaiting === 'review' ? <><Facts item={item} state={state} /><ReviewPanel item={item} compact /></> : <QuickActions item={item} overflow lead={<Facts item={item} state={state} />} />}
      {['QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY'].includes(fm.status) && autoApprove}
      {panels}
      {plan}
      {consoleOf(10)}
      <h3 className="drawer-h">Latest activity</h3>
      <ActivityList entries={item.activity} limit={6} stamp={shortStamp} />
      {children}
      <h3 className="drawer-h">Brief</h3>
      {descOpen
        ? <>
          <div className="drawer-desc"><Markdown text={item.sections.Description || '_(no description)_'} /></div>
          {extra.includes('plan') && <><h3 className="drawer-h">Plan</h3><div className="drawer-desc"><Markdown text={item.sections.Plan} /></div></>}
          {extra.includes('notes') && <><h3 className="drawer-h">Notes</h3><div className="drawer-desc"><Markdown text={item.sections.Notes} /></div></>}
        </>
        : <button type="button" className="drawer-desc drawer-desc-folded drawer-brief" aria-expanded={false} title="Show the description, plan and notes" onClick={() => setDescOpen(true)}>
          {clipped}{extra.length ? <span className="small muted"> · with its {extra.join(' and ')}</span> : null} <span className="small" style={{ color: 'var(--accent)' }}>more</span>
        </button>}
    </>;
  } else {
    // At a decision, a review or a block, what you need is the latest activity and the card, not the
    // brief you wrote weeks ago (dogfood f9): the description folds to one line and activity comes first.
    const deciding = Boolean(decisionOf(fm)) || fm.awaiting === 'review' || (fm.blocked && !fm.triage) || Boolean(fm.taken_over);
    const description = deciding && !descOpen
      ? <div className="drawer-desc drawer-desc-folded" onClick={() => setDescOpen(true)} role="button" title="Show the whole description"><span className="small muted">Description · </span>{clipped} <span className="small" style={{ color: 'var(--accent)' }}>more</span></div>
      : <div className="drawer-desc"><Markdown text={item.sections.Description || '_(no description)_'} /></div>;
    const activity = <><h3 className="drawer-h">Latest activity</h3><ActivityList entries={item.activity} limit={4} stamp={shortStamp} /></>;
    body = <>
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
        <CategoryTag name={fm.category} />{fm.priority ? ` · ${fm.priority} priority` : ''}{(state?.releases?.length ?? 0) > 0 && <> · for <ReleasePicker value={fm.release} onChange={(release) => void act(() => api.patchItem(id, { fields: { release } }))} /></>} · {fm.planner}{fm.implementer !== fm.planner ? ` → ${fm.implementer}` : ''}
        {fm.branch ? <> · <code>{fm.branch}</code></> : null}
        {fm.pr ? <> · <a href={`https://github.com/${state!.config.code_repo.github}/pull/${fm.pr}`} target="_blank" rel="noreferrer">PR #{fm.pr}</a>{fm.ci_result ? ` (CI ${fm.ci_result})` : ''}</> : null}
      </p>
      {autoApprove}
      {panels}
      {fm.awaiting === 'review' ? <ReviewPanel item={item} compact /> : <QuickActions item={item} />}
      {deciding && activity}
      {children}
      {description}
      {plan}
      {consoleOf(14)}
      {!deciding && activity}
    </>;
  }
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
      {body}
      <div className="row drawer-foot">
        <Link className="grow" to={`/items/${id}`} onClick={onClose}><button className="primary" style={{ width: '100%' }}>Open full details →</button></Link>
      </div>
    </aside>
    </>
  );
}

const CI_CHIP: Record<string, [string, string]> = { pending: ['CI running', 'wait'], green: ['CI green', 'ok'], red: ['CI red', 'hot'], blocked: ['CI blocked', 'hot'], unknown: ['CI unknown', ''] };

/** One line of facts (#314): the PR with a CI chip that links to its run (or its checks), the branch, and what it has used. */
function Facts({ item, state }: { item: ItemView; state: State }) {
  const fm = item.frontmatter;
  const repo = state.config.code_repo.github;
  const rerun = fm.op_data?.ci_rerun as { sha?: string; runId?: number } | undefined;
  const runUrl = rerun?.runId && rerun.sha === fm.ci_head_sha ? `https://github.com/${repo}/actions/runs/${rerun.runId}` : `https://github.com/${repo}/pull/${fm.pr}/checks`;
  const def = findModel(state.config, ['PLAN_IN_PROGRESS', 'PLAN_READY'].includes(fm.status) ? fm.planner : fm.implementer);
  const turns = def && modelCapabilities(def).accounting === 'tokens';
  const used = turns
    ? `${fm.agent_turns ?? 0}/${fm.budget_turns ?? state.config.budget_turns_per_item} turns`
    : fm.cost_usd ? `$${fm.cost_usd.toFixed(2)} of $${fm.budget_usd ?? state.config.budget_usd_per_item}` : undefined;
  const chip = fm.ci_result ? CI_CHIP[fm.ci_result] : undefined;
  const parts: ReactNode[] = [
    fm.pr && <span key="pr"><a href={`https://github.com/${repo}/pull/${fm.pr}`} target="_blank" rel="noreferrer">PR #{fm.pr}</a>{chip && <> <a className={`tag ${chip[1]}`} href={runUrl} target="_blank" rel="noreferrer">{chip[0]}</a></>}</span>,
    fm.branch && <code key="branch">{fm.branch}</code>,
    used && <span key="used">{used}</span>,
  ].filter(Boolean);
  return parts.length ? <p className="drawer-facts small muted">{parts.flatMap((p, i) => i ? [' · ', p] : [p])}</p> : null;
}
