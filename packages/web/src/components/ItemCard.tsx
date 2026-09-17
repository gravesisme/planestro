import * as ContextMenu from '@radix-ui/react-context-menu';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { confirmMove } from './QuickActions.tsx';

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
        <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={`card ${d.needs_you ? 'needs' : ''} ${fm.blocked ? 'blocked' : ''} ${isDragging ? 'dragging' : ''}`} onClick={() => onSelect?.(item.id)} onDoubleClick={() => nav(`/items/${item.id}`)}>
          <div><span className="id">{item.id}</span><span className="title">{fm.title}</span></div>
          {fm.awaiting === 'review' && <div className="checker card-thumb"><img src={`/api/items/${item.id}/thumb?v=${encodeURIComponent(fm.updated_at)}`} alt="" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).hidden = true; }} /></div>}
          <div className="meta">
            <span className="tag">{fm.category}</span>
            {fm.kind === 'epic' && <span className="tag epic">EPIC {children.length ? `${merged}/${children.length}` : ''}</span>}
            {fm.parent && <span className="tag">↳ {fm.parent}</span>}
            {d.external ? <span className="tag">{modelLabel(fm.implementer)} (external)</span> : <span className="tag">{modelLabel(fm.planner)} → {modelLabel(fm.implementer)}</span>}
            {fm.pr && <span className="tag ok">PR #{fm.pr}</span>}
            {fm.blocked && <span className="tag hot">BLOCKED{fm.blocked_reason ? `: ${fm.blocked_reason}` : ''}</span>}
            {fm.awaiting && <span className={`tag ${d.needs_you ? 'hot' : ''}`}>awaiting {fm.awaiting.replace(/_/g, ' ')}</span>}
            {fm.op && <span className="tag">{fm.op.replace(/_/g, ' ')}</span>}
            {!d.deps_satisfied && <span className="tag">waits on {fm.depends_on.join(', ')}</span>}
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
