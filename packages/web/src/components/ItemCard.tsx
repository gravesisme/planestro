import * as ContextMenu from '@radix-ui/react-context-menu';
import { useState, type MouseEventHandler, type TouchEventHandler } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { agentStateOf, itemsById } from '../agentState.ts';
import { confirmMove } from './QuickActions.tsx';
import { CategoryTag } from './CategoryTag.tsx';
import { CiCardTag } from './CiBreakdown.tsx';
import { afterChoices, columnOf, stepMove } from '../reorder.ts';
import { connectionDropOf, decisionOf, heldReasonOf, previewOf, waitsFor } from '@planestro/shared';

export function statusLabel(s: string): string { return s.replace(/_/g, ' '); }

export function ItemCard({ item, sortable = true, onSelect, selection }: {
  item: ItemView; sortable?: boolean; onSelect?: (id: string) => void;
  selection?: { checked: boolean; onChange: (checked: boolean) => void };
}) {
  const nav = useNavigate();
  // Move after… swaps the menu for its list of places in the same spot: a submenu beside it has no room on a phone.
  const [pickingAfter, setPickingAfter] = useState(false);
  // A running badge's last output is its title on a mouse; on glass, where nothing hovers, a tap shows it on the card (#299).
  const [showOutput, setShowOutput] = useState(false);
  const state = useStore((s) => s.state);
  const fm = item.frontmatter;
  const d = item.derived;
  const lastOutput = useStore((s) => s.lastOutput?.[item.id]);
  const agent = agentStateOf(item, state, lastOutput);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !sortable || !!selection, data: { status: fm.status } });
  const style = { transform: CSS.Transform.toString(transform), transition };
  // The mouse drags the whole card, touch only its handle: each takes its own sensor's activator.
  const drag = (listeners ?? {}) as { onMouseDown?: MouseEventHandler; onTouchStart?: TouchEventHandler };
  const lane = d.lane;
  const modelLabel = (id?: string) => state?.config.models.find((m) => m.id === id)?.label ?? id;
  const byId = state ? itemsById(state.items) : undefined;
  const children = d.children.map((c) => byId?.get(c)).filter(Boolean) as ItemView[];
  const merged = children.filter((c) => ['MERGED', 'FINISHED'].includes(c.frontmatter.status)).length;
  const heading = <><span className="id">{item.id}</span>{' '}<span className="title">{fm.title}</span></>;
  const content = <>
          {selection ? <label className="provider-card-check"><input type="checkbox" checked={selection.checked} onChange={(e) => selection.onChange(e.target.checked)} /><span>{heading}</span></label> : <div>{heading}</div>}
          {fm.awaiting === 'review' && <div className="checker card-thumb"><img src={`/api/items/${item.id}/thumb?v=${encodeURIComponent(fm.updated_at)}`} alt="" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).hidden = true; }} /></div>}
          <div className="meta">
            <CategoryTag name={fm.category} />
            {fm.priority && <span className={`tag prio-${fm.priority}`} title={`${fm.priority} priority`}>{fm.priority}</span>}
            {fm.release && <span className="tag release" title={`Planned for release ${fm.release}`}>for {fm.release}</span>}
            {fm.kind === 'epic' && <span className="tag epic">EPIC {children.length ? `${merged}/${children.length}` : ''}</span>}
            {fm.parent && <span className="tag">↳ {fm.parent}</span>}
            {d.external ? <span className="tag">{modelLabel(fm.implementer)} (external)</span> : <span className="tag">{modelLabel(fm.planner)} → {modelLabel(fm.implementer)}</span>}
            {fm.pr && <span className="tag ok">PR #{fm.pr}</span>}
            {fm.status === 'IN_REVIEW' && <CiCardTag fm={fm} />}
            {previewOf(fm) && <span className="tag" title={`Preview deployment: ${previewOf(fm)!.url}`}>preview</span>}
            {fm.status === 'IN_REVIEW' && fm.skip_merge && <span className={`tag ${fm.ci_result === 'red' ? 'hot' : ''}`} title={`Held out of the merge queue${heldReasonOf(fm) ? ` (${heldReasonOf(fm)})` : ''}: it waits for you to release the hold. Its commits are pushed and its CI is watched${fm.ci_result === 'red' ? '; the red run is being fixed meanwhile (its session, or the orchestrator for an epic)' : ''}, but it does not merge`}>{fm.op_data?.pr_draft ? 'held for you · draft PR' : `${fm.hold_waits_on === 'person' || fm.review_hold ? 'held for you' : 'held'} · CI ${fm.ci_result ?? 'pending'}`}</span>}
            {fm.status === 'IN_PROGRESS' && fm.skip_merge && <span className="tag" title={`Its pull request will be held out of the merge queue${heldReasonOf(fm) ? `: ${heldReasonOf(fm)}` : ''}`}>PR will be held</span>}
            {connectionDropOf(fm) && <span className="tag hot" title={`The session lost its connection to planestro at ${connectionDropOf(fm)!.at.slice(0, 16).replace('T', ' ')}${connectionDropOf(fm)!.tool ? ` (on ${connectionDropOf(fm)!.tool})` : ''}: ${connectionDropOf(fm)!.error}`}>lost connection</span>}
            {fm.triage && <span className="tag triage" title={`It stopped (${fm.triage.reason}); the orchestrator fixes it or asks you one question`}>orchestrator triaging</span>}
            {fm.blocked && !fm.triage && !decisionOf(fm) && <span className="tag hot">BLOCKED{fm.blocked_reason ? `: ${fm.blocked_reason}` : ''}</span>}
            {decisionOf(fm) ? <span className="tag hot">decision needed</span> : fm.awaiting && !(fm.triage && fm.awaiting === 'user') && <span className={`tag ${d.needs_you ? 'wait' : ''}`}>awaiting {fm.awaiting.replace(/_/g, ' ')}</span>}
            {fm.op && <span className="tag">{fm.op.replace(/_/g, ' ')}</span>}
            {agent?.kind === 'running' && <button type="button" className="tag running" aria-expanded={showOutput} title={agent.output ? `Last output: ${agent.output}` : 'An agent is working on this now'} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setShowOutput(!showOutput); }}><span className="pulse" aria-hidden />{agent.label}</button>}
            {agent?.kind === 'slot' && <span className="tag wait" title={agent.reason}>waiting for a slot</span>}
            {agent?.kind === 'wait' && <span className="tag wait" title={agent.reason}>waiting: saved instruction</span>}
            {fm.parts?.length ? <span className={`tag ${fm.parts.some((p) => p.state === 'rejected') ? 'hot' : fm.parts.every((p) => p.state === 'accepted') ? 'ok' : 'wait'}`} title={fm.parts.map((p) => `${p.name}: ${p.state}`).join(', ')}>parts {fm.parts.filter((p) => p.state === 'accepted').length}/{fm.parts.length}</span> : null}
            {(() => { const cfg = state?.config; if (!cfg || d.lane !== 'board') return null; const usd = (fm.cost_usd ?? 0) / (fm.budget_usd ?? cfg.budget_usd_per_item); const tok = (fm.tokens ?? 0) / (fm.budget_tokens ?? cfg.budget_tokens_per_item); const share = Math.max(usd, tok); return share >= 0.8 ? <span className={`tag ${share >= 1 ? 'hot' : 'wait'}`} title="Of this item's budget; raise it on the item page">budget {Math.round(share * 100)}%</span> : null; })()}
            {!d.deps_satisfied && <span className="tag">waits on {fm.depends_on.join(', ')}</span>}
            {fm.taken_over && <span className="tag yours" title={`You took it over${fm.taken_over.note ? `: ${fm.taken_over.note}` : ''}. Nothing automatic touches it until you hand it back.`}>yours · by hand</span>}
            {fm.resume_after && <span className="tag" title={`Resumes when these have merged, with: ${fm.resume_after.message}`}>resumes after {waitsFor(fm.resume_after)}</span>}
            {lane === 'done' && fm.finished_at && <span>{fm.finished_at.slice(0, 16).replace('T', ' ')}</span>}
          </div>
          {agent?.kind === 'running' && showOutput && <div className="run-output small muted">{agent.output ?? 'No output yet.'}</div>}
  </>;
  const cardClass = `card ${d.needs_you ? 'needs' : ''} ${fm.blocked && !fm.triage ? 'blocked' : ''} ${agent?.kind === 'running' ? 'running' : ''}`;
  // Selection cards have no navigation, drag/drop, or lifecycle context menu.
  if (selection) return <div className={`${cardClass} provider-select-card ${selection.checked ? 'selected' : ''}`}>{content}</div>;
  return (
    <ContextMenu.Root onOpenChange={(open) => { if (!open) setPickingAfter(false); }}>
      <ContextMenu.Trigger asChild>
        <div ref={setNodeRef} style={style} {...attributes} onMouseDown={drag.onMouseDown} className={`${cardClass} ${isDragging ? 'dragging' : ''}`} onClick={() => onSelect?.(item.id)} onDoubleClick={() => nav(`/items/${item.id}`)}>
          {content}
          {/* On glass a drag starts only from the handle, so the rest of the card scrolls and its long-press opens this menu (#215). */}
          {sortable && <span className="drag-handle" aria-label={`Drag ${item.id} to reorder`} onTouchStart={drag.onTouchStart} onPointerDown={(e) => { if (e.pointerType !== 'mouse') e.stopPropagation(); }} onClick={(e) => e.stopPropagation()}>⠿</span>}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu menu-scroll" collisionPadding={8}>
          {pickingAfter && state ? <MoveAfterItems item={item} items={state.items} onBack={() => setPickingAfter(false)} /> : <>
          <ContextMenu.Item className="menu-item" onSelect={() => nav(`/items/${item.id}`)}>Open</ContextMenu.Item>
          {fm.status === 'NOT_YET_SUBMITTED' && !d.external && fm.kind === 'item' && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.transition(item.id, 'QUEUED'))}>Queue for planning</ContextMenu.Item>}
          {fm.status === 'NOT_YET_SUBMITTED' && (d.external || fm.kind === 'epic') && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.transition(item.id, 'IN_PROGRESS'))}>{fm.kind === 'epic' ? 'Open epic' : 'Mark started'}</ContextMenu.Item>}
          {fm.status === 'QUEUED' && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.transition(item.id, 'NOT_YET_SUBMITTED'))}>Cancel queue</ContextMenu.Item>}
          <ContextMenu.Separator className="menu-sep" />
          {lane !== 'done' && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.move(item.id, 'top'))}>Move to top</ContextMenu.Item>}
          {lane !== 'done' && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.move(item.id, 'bottom'))}>Move to bottom</ContextMenu.Item>}
          {lane !== 'done' && state && <ReorderItems item={item} items={state.items} onPickAfter={() => setPickingAfter(true)} />}
          {lane === 'board' && ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'].includes(fm.status) && <ContextMenu.Item className="menu-item" onSelect={() => { if (confirmMove(item, 'ICEBOX', 'Move to ICEBOX')) void act(() => api.move(item.id, 'icebox')); }}>Move to ICEBOX</ContextMenu.Item>}
          {lane === 'icebox' && <ContextMenu.Item className="menu-item" onSelect={() => { if (confirmMove(item, 'NOT_YET_SUBMITTED', 'Move to BACKLOG')) void act(() => api.move(item.id, 'backlog')); }}>Move to BACKLOG</ContextMenu.Item>}
          {lane === 'done' && <ContextMenu.Item className="menu-item" onSelect={() => { if (confirmMove(item, 'NOT_YET_SUBMITTED', 'Reopen')) void act(() => api.transition(item.id, 'NOT_YET_SUBMITTED')); }}>Reopen</ContextMenu.Item>}
          <ContextMenu.Separator className="menu-sep" />
          <ContextMenu.Item className="menu-item" onSelect={() => void navigator.clipboard.writeText(item.id)}>Copy id</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => void navigator.clipboard.writeText(item.path)}>Copy file path</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => { if (confirm(`Delete ${item.id} "${fm.title}"?`)) void act(() => api.deleteItem(item.id)); }}>Delete…</ContextMenu.Item>
          </>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** Move up one, down one, or after a chosen item: places within the item's column and priority band (#194, #215). */
function ReorderItems({ item, items, onPickAfter }: { item: ItemView; items: ItemView[]; onPickAfter: () => void }) {
  const column = columnOf(items, item);
  const up = stepMove(column, item.id, 'up');
  const down = stepMove(column, item.id, 'down');
  return <>
    <ContextMenu.Item className="menu-item" disabled={!up} onSelect={() => { if (up) void act(() => api.move(item.id, up.op, up.ref)); }}>Move up one</ContextMenu.Item>
    <ContextMenu.Item className="menu-item" disabled={!down} onSelect={() => { if (down) void act(() => api.move(item.id, down.op, down.ref)); }}>Move down one</ContextMenu.Item>
    <ContextMenu.Item className="menu-item menu-sub" disabled={!afterChoices(column, item.id).length} onSelect={(e) => { e.preventDefault(); onPickAfter(); }}>Move after…</ContextMenu.Item>
  </>;
}

function MoveAfterItems({ item, items, onBack }: { item: ItemView; items: ItemView[]; onBack: () => void }) {
  return <>
    <ContextMenu.Item className="menu-item" onSelect={(e) => { e.preventDefault(); onBack(); }}>‹ Move {item.id} after…</ContextMenu.Item>
    <ContextMenu.Separator className="menu-sep" />
    {afterChoices(columnOf(items, item), item.id).map((c) => <ContextMenu.Item key={c.id} className="menu-item menu-pick" title={`${c.id} ${c.frontmatter.title}`} onSelect={() => act(() => api.move(item.id, 'after', c.id))}><span className="id">{c.id}</span> {c.frontmatter.title}</ContextMenu.Item>)}
  </>;
}
