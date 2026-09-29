import * as ContextMenu from '@radix-ui/react-context-menu';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { confirmMove } from './QuickActions.tsx';
import { decisionOf, heldReasonOf } from '@planestro/shared';

export function statusLabel(s: string): string { return s.replace(/_/g, ' '); }

export function ItemCard({ item, sortable = true, onSelect }: { item: ItemView; sortable?: boolean; onSelect?: (id: string) => void }) {
  const nav = useNavigate();
  const state = useStore((s) => s.state);
  const fm = item.frontmatter;
  const d = item.derived;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !sortable, data: { status: fm.status } });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const lane = d.lane;
  const modelLabel = (id?: string) => state?.config.models.find((m) => m.id === id)?.label ?? id;
  const children = d.children.map((c) => state?.items.find((i) => i.id === c)).filter(Boolean) as ItemView[];
  const merged = children.filter((c) => ['MERGED', 'FINISHED'].includes(c.frontmatter.status)).length;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={`card ${d.needs_you ? 'needs' : ''} ${fm.blocked && !fm.triage ? 'blocked' : ''} ${isDragging ? 'dragging' : ''}`} onClick={() => onSelect?.(item.id)} onDoubleClick={() => nav(`/items/${item.id}`)}>
          <div><span className="id">{item.id}</span><span className="title">{fm.title}</span></div>
          {fm.awaiting === 'review' && <div className="checker card-thumb"><img src={`/api/items/${item.id}/thumb?v=${encodeURIComponent(fm.updated_at)}`} alt="" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).hidden = true; }} /></div>}
          <div className="meta">
            <span className="tag">{fm.category}</span>
            {fm.kind === 'epic' && <span className="tag epic">EPIC {children.length ? `${merged}/${children.length}` : ''}</span>}
            {fm.parent && <span className="tag">↳ {fm.parent}</span>}
            {d.external ? <span className="tag">{modelLabel(fm.implementer)} (external)</span> : <span className="tag">{modelLabel(fm.planner)} → {modelLabel(fm.implementer)}</span>}
            {fm.pr && <span className="tag ok">PR #{fm.pr}</span>}
            {fm.status === 'IN_REVIEW' && fm.skip_merge && <span className={`tag ${fm.ci_result === 'red' ? 'hot' : ''}`} title={`Held out of the merge queue${heldReasonOf(fm) ? ` (${heldReasonOf(fm)})` : ''}: it waits for you to release the hold. Its commits are pushed and its CI is watched${fm.ci_result === 'red' ? '; the red run is being fixed meanwhile (its session, or the orchestrator for an epic)' : ''}, but it does not merge`}>{fm.op_data?.pr_draft ? 'held for you · draft PR' : `held for you · CI ${fm.ci_result ?? 'pending'}`}</span>}
            {fm.status === 'IN_PROGRESS' && fm.skip_merge && <span className="tag" title={`Its pull request will be held out of the merge queue${heldReasonOf(fm) ? `: ${heldReasonOf(fm)}` : ''}`}>PR will be held</span>}
            {fm.triage && <span className="tag triage" title={`It stopped (${fm.triage.reason}); the orchestrator fixes it or asks you one question`}>orchestrator triaging</span>}
            {fm.blocked && !fm.triage && !decisionOf(fm) && <span className="tag hot">BLOCKED{fm.blocked_reason ? `: ${fm.blocked_reason}` : ''}</span>}
            {decisionOf(fm) ? <span className="tag hot">decision needed</span> : fm.awaiting && !(fm.triage && fm.awaiting === 'user') && <span className={`tag ${d.needs_you ? 'wait' : ''}`}>awaiting {fm.awaiting.replace(/_/g, ' ')}</span>}
            {fm.op && <span className="tag">{fm.op.replace(/_/g, ' ')}</span>}
            {fm.parts?.length ? <span className={`tag ${fm.parts.some((p) => p.state === 'rejected') ? 'hot' : fm.parts.every((p) => p.state === 'accepted') ? 'ok' : 'wait'}`} title={fm.parts.map((p) => `${p.name}: ${p.state}`).join(', ')}>parts {fm.parts.filter((p) => p.state === 'accepted').length}/{fm.parts.length}</span> : null}
            {(() => { const cfg = state?.config; if (!cfg || d.lane !== 'board') return null; const usd = (fm.cost_usd ?? 0) / (fm.budget_usd ?? cfg.budget_usd_per_item); const tok = (fm.tokens ?? 0) / (fm.budget_tokens ?? cfg.budget_tokens_per_item); const share = Math.max(usd, tok); return share >= 0.8 ? <span className={`tag ${share >= 1 ? 'hot' : 'wait'}`} title="Of this item's budget; raise it on the item page">budget {Math.round(share * 100)}%</span> : null; })()}
            {!d.deps_satisfied && <span className="tag">waits on {fm.depends_on.join(', ')}</span>}
            {fm.taken_over && <span className="tag yours" title={`You took it over${fm.taken_over.note ? `: ${fm.taken_over.note}` : ''}. Nothing automatic touches it until you hand it back.`}>yours · by hand</span>}
            {fm.resume_after && <span className="tag" title={`Resumes when these have merged, with: ${fm.resume_after.message}`}>resumes after {fm.resume_after.items.join(', ')}</span>}
            {lane === 'done' && fm.finished_at && <span>{fm.finished_at.slice(0, 16).replace('T', ' ')}</span>}
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu">
          <ContextMenu.Item className="menu-item" onSelect={() => nav(`/items/${item.id}`)}>Open</ContextMenu.Item>
          {fm.status === 'NOT_YET_SUBMITTED' && !d.external && fm.kind === 'item' && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.transition(item.id, 'QUEUED'))}>Queue for planning</ContextMenu.Item>}
          {fm.status === 'NOT_YET_SUBMITTED' && (d.external || fm.kind === 'epic') && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.transition(item.id, 'IN_PROGRESS'))}>{fm.kind === 'epic' ? 'Open epic' : 'Mark started'}</ContextMenu.Item>}
          {fm.status === 'QUEUED' && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.transition(item.id, 'NOT_YET_SUBMITTED'))}>Cancel queue</ContextMenu.Item>}
          <ContextMenu.Separator className="menu-sep" />
          {lane !== 'done' && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.move(item.id, 'top'))}>Move to top</ContextMenu.Item>}
          {lane !== 'done' && <ContextMenu.Item className="menu-item" onSelect={() => act(() => api.move(item.id, 'bottom'))}>Move to bottom</ContextMenu.Item>}
          {lane === 'board' && ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'].includes(fm.status) && <ContextMenu.Item className="menu-item" onSelect={() => { if (confirmMove(item, 'ICEBOX', 'Move to ICEBOX')) void act(() => api.move(item.id, 'icebox')); }}>Move to ICEBOX</ContextMenu.Item>}
          {lane === 'icebox' && <ContextMenu.Item className="menu-item" onSelect={() => { if (confirmMove(item, 'NOT_YET_SUBMITTED', 'Move to BACKLOG')) void act(() => api.move(item.id, 'backlog')); }}>Move to BACKLOG</ContextMenu.Item>}
          {lane === 'done' && <ContextMenu.Item className="menu-item" onSelect={() => { if (confirmMove(item, 'NOT_YET_SUBMITTED', 'Reopen')) void act(() => api.transition(item.id, 'NOT_YET_SUBMITTED')); }}>Reopen</ContextMenu.Item>}
          <ContextMenu.Separator className="menu-sep" />
          <ContextMenu.Item className="menu-item" onSelect={() => void navigator.clipboard.writeText(item.id)}>Copy id</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => void navigator.clipboard.writeText(item.path)}>Copy file path</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => { if (confirm(`Delete ${item.id} "${fm.title}"?`)) void act(() => api.deleteItem(item.id)); }}>Delete…</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
