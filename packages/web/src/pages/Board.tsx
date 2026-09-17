import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { DndContext, PointerSensor, useSensor, useSensors, useDroppable, closestCenter, pointerWithin, type CollisionDetection, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { findTransition, type Status } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { ItemCard, statusLabel } from '../components/ItemCard.tsx';
import { NewItemDialog } from '../components/NewItemDialog.tsx';
import { PreviewDrawer } from '../components/PreviewDrawer.tsx';

const BOARD_COLUMNS = ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'];
const COL = 'col:';

/**
 * What dropping `item` on another column does, or why it does nothing. Only moves the user owns
 * outright are drags: queue and cancel. Approving a plan is a decision made while reading it, and
 * every other column is the engine's to enter.
 */
function dropAction(item: ItemView, to: string): { run?: () => Promise<unknown>; why?: string } {
  const from = item.frontmatter.status;
  if (to === from) return {};
  if (!findTransition(from, to as Status, 'user', item.derived.flavor)) return { why: `${item.id} cannot be dragged from ${statusLabel(from)} to ${statusLabel(to)}` };
  if (from === 'PLAN_READY') return { why: `open ${item.id} to approve its plan or request changes` };
  if (to === 'QUEUED' && item.derived.base_branch_error) return { why: item.derived.base_branch_error };
  if (to === 'QUEUED' && !item.derived.deps_satisfied) return { why: `${item.id} waits on ${item.frontmatter.depends_on.join(', ')}` };
  return { run: () => api.transition(item.id, to as Status) };
}

/** Columns catch the pointer; inside the column under it the nearest card wins, so reordering still works. */
const columnFirst: CollisionDetection = (args) => {
  const isCol = (c: { id: string | number }) => String(c.id).startsWith(COL);
  const col = pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter(isCol) })[0];
  if (!col) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => !isCol(c)) });
  const cards = args.droppableContainers.filter((c) => !isCol(c) && c.data.current?.status === String(col.id).slice(COL.length));
  const near = cards.length ? closestCenter({ ...args, droppableContainers: cards }) : [];
  return near.length ? near : [col];
};

export function BoardPage({ lane }: { lane: 'board' | 'icebox' | 'done' }) {
  const state = useStore((s) => s.state);
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<{ status: string; ok: boolean } | null>(null);
  const needsOnly = params.get('needs') === '1';
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const items = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (state?.items ?? []).filter((i) => i.derived.lane === lane)
      .filter((i) => !category || i.frontmatter.category === category)
      .filter((i) => !needsOnly || i.derived.needs_you)
      .filter((i) => terms.every((t) => `${i.id} ${i.frontmatter.title} ${i.sections.Description} ${i.sections.Notes}`.toLowerCase().includes(t)));
  }, [state, lane, q, category, needsOnly]);

  const statusAt = (overId: string | number): string | undefined => String(overId).startsWith(COL) ? String(overId).slice(COL.length) : items.find((i) => i.id === overId)?.frontmatter.status;
  const onDragOver = (e: DragOverEvent) => {
    const a = items.find((i) => i.id === e.active.id); const to = e.over ? statusAt(e.over.id) : undefined;
    setDragTarget(a && to && to !== a.frontmatter.status ? { status: to, ok: !!dropAction(a, to).run } : null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragTarget(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const a = items.find((i) => i.id === active.id); const to = statusAt(over.id);
    if (!a || !to) return;
    if (to !== a.frontmatter.status) {
      const { run, why } = dropAction(a, to);
      if (run) void act(run); else if (why) void act(() => Promise.reject(new Error(why)));
      return;
    }
    const o = items.find((i) => i.id === over.id);
    if (!o) return; // dropped on its own column's empty space
    const col = items.filter((i) => i.frontmatter.status === a.frontmatter.status);
    const before = col.indexOf(a) > col.indexOf(o);
    void act(() => api.move(a.id, before ? 'before' : 'after', o.id));
  };

  if (!state) return <p className="muted">Loading…</p>;
  const columns = lane === 'board' ? BOARD_COLUMNS : [lane === 'icebox' ? 'ICEBOX' : 'FINISHED'];
  const done = lane === 'done' ? [...items].sort((a, b) => (b.frontmatter.finished_at ?? '').localeCompare(a.frontmatter.finished_at ?? '')) : items;
  return (
    <div>
      <div className="toolbar">
        <input type="search" placeholder="Search id, title, description…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`chip ${!category ? 'on' : ''}`} onClick={() => setCategory('')}>All</button>
        {state.config.categories.map((c) => <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(category === c ? '' : c)}>{c}</button>)}
        {needsOnly && <button className="chip on" onClick={() => setParams({})}>🔴 needs you ×</button>}
        <span className="grow" />
        <span className="muted small">{items.length} item{items.length === 1 ? '' : 's'}</span>
        <button className="primary" onClick={() => setCreating(true)}>+ New item</button>
      </div>
      {creating && <NewItemDialog onClose={() => setCreating(false)} icebox={lane === 'icebox'} />}
      {preview && <PreviewDrawer id={preview} onClose={() => setPreview(null)} />}
      {lane === 'done' ? (
        <div className="list card-list">{done.map((i) => <ItemCard key={i.id} item={i} sortable={false} onSelect={setPreview} />)}{!done.length && <p className="muted">Nothing finished yet.</p>}</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={columnFirst} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDragTarget(null)}>
          <div className="board" style={lane === 'icebox' ? { gridAutoColumns: 'minmax(420px, 640px)' } : undefined}>
            {columns.map((status) => { const col = items.filter((i) => i.frontmatter.status === status); return <Column key={status} status={status} items={col} onSelect={setPreview} drop={dragTarget?.status === status ? (dragTarget.ok ? 'ok' : 'no') : undefined} />; })}
          </div>
        </DndContext>
      )}
    </div>
  );
}

function Column({ status, items, onSelect, drop }: { status: string; items: ItemView[]; onSelect: (id: string) => void; drop?: 'ok' | 'no' }) {
  const { setNodeRef } = useDroppable({ id: `${COL}${status}` });
  return (
    <div ref={setNodeRef} className={`column ${drop ? `drop-${drop}` : ''}`}>
      <h3><span>{statusLabel(status)}</span><span>{items.length}</span></h3>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((i) => <ItemCard key={i.id} item={i} onSelect={onSelect} />)}
      </SortableContext>
    </div>
  );
}
