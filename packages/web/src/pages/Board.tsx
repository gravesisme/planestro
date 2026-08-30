import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { ItemCard, statusLabel } from '../components/ItemCard.tsx';
import { NewItemDialog } from '../components/NewItemDialog.tsx';

const BOARD_COLUMNS = ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'];

export function BoardPage({ lane }: { lane: 'board' | 'icebox' | 'done' }) {
  const state = useStore((s) => s.state);
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const needsOnly = params.get('needs') === '1';
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const items = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (state?.items ?? []).filter((i) => i.derived.lane === lane)
      .filter((i) => !category || i.frontmatter.category === category)
      .filter((i) => !needsOnly || i.derived.needs_you)
      .filter((i) => terms.every((t) => `${i.id} ${i.frontmatter.title} ${i.sections.Description} ${i.sections.Notes}`.toLowerCase().includes(t)));
  }, [state, lane, q, category, needsOnly]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const a = items.find((i) => i.id === active.id)!; const o = items.find((i) => i.id === over.id)!;
    if (a.frontmatter.status !== o.frontmatter.status) return; // cross-column drops are transitions, done via the menu
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
      {lane === 'done' ? (
        <div className="list card-list">{done.map((i) => <ItemCard key={i.id} item={i} sortable={false} />)}{!done.length && <p className="muted">Nothing finished yet.</p>}</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <div className="board" style={lane === 'icebox' ? { gridAutoColumns: 'minmax(420px, 640px)' } : undefined}>
            {columns.map((status) => { const col = items.filter((i) => i.frontmatter.status === status); return <Column key={status} status={status} items={col} />; })}
          </div>
        </DndContext>
      )}
    </div>
  );
}

function Column({ status, items }: { status: string; items: ItemView[] }) {
  return (
    <div className="column">
      <h3><span>{statusLabel(status)}</span><span>{items.length}</span></h3>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((i) => <ItemCard key={i.id} item={i} />)}
      </SortableContext>
    </div>
  );
}
