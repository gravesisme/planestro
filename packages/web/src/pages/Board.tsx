import { useMemo, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router';
import { DndContext, PointerSensor, useSensor, useSensors, useDroppable, closestCenter, pointerWithin, type CollisionDetection, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { findTransition, PRIORITIES, type Priority, type Status } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { ItemCard, statusLabel } from '../components/ItemCard.tsx';
import { NewItemDialog } from '../components/NewItemDialog.tsx';
import { PreviewDrawer } from '../components/PreviewDrawer.tsx';
import { usePhone } from '../usePhone.ts';

const BOARD_COLUMNS = ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'];
const COL = 'col:';
/** The phone's stage strip has seven cells across one screen: names that fit, in the order of the columns. */
const STAGE_SHORT: Record<string, string> = { NOT_YET_SUBMITTED: 'Backlog', QUEUED: 'Queued', PLAN_IN_PROGRESS: 'Planning', PLAN_READY: 'Plan ready', IN_PROGRESS: 'Working', IN_REVIEW: 'Review', MERGED: 'Merged' };
const LANES = [{ to: '/', lane: 'board', label: 'Board' }, { to: '/icebox', lane: 'icebox', label: 'Icebox' }, { to: '/done', lane: 'done', label: 'Done' }] as const;

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
  const [priority, setPriority] = useState<Priority | ''>('');
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<{ status: string; ok: boolean } | null>(null);
  const needsOnly = params.get('needs') === '1';
  const phone = usePhone();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const items = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (state?.items ?? []).filter((i) => i.derived.lane === lane)
      .filter((i) => !category || i.frontmatter.category === category)
      .filter((i) => !priority || i.frontmatter.priority === priority)
      .filter((i) => !needsOnly || i.derived.needs_you)
      .filter((i) => terms.every((t) => `${i.id} ${i.frontmatter.title} ${i.sections.Description} ${i.sections.Notes}`.toLowerCase().includes(t)));
  }, [state, lane, q, category, priority, needsOnly]);

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
    // A rank orders an item within its priority (#194): dropped among another priority's items, it takes that
    // priority if you say so; otherwise the server keeps it at its own priority's edge.
    const to_ = o.frontmatter.priority;
    if (to_ !== a.frontmatter.priority && confirm(`Change ${a.id}'s priority from ${a.frontmatter.priority ?? 'none'} to ${to_ ?? 'none'}?`)) {
      void act(async () => { await api.patchItem(a.id, { fields: { priority: to_ ?? null } }); return api.move(a.id, before ? 'before' : 'after', o.id); });
      return;
    }
    void act(() => api.move(a.id, before ? 'before' : 'after', o.id));
  };

  if (!state) return <p className="muted">Loading…</p>;
  const columns = lane === 'board' ? BOARD_COLUMNS : [lane === 'icebox' ? 'ICEBOX' : 'FINISHED'];
  const done = lane === 'done' ? [...items].sort((a, b) => (b.frontmatter.finished_at ?? '').localeCompare(a.frontmatter.finished_at ?? '')) : items;
  return (
    <div className="board-page">
      <nav className="lanes phone-only">{LANES.map((l) => <NavLink key={l.to} to={l.to} end>{l.label}<span className="n">{state.items.filter((i) => i.derived.lane === l.lane).length}</span></NavLink>)}</nav>
      <div className="toolbar">
        <input type="search" placeholder={phone ? 'Search…' : 'Search id, title, description…'} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips">
          <button className={`chip ${!category ? 'on' : ''}`} onClick={() => setCategory('')}>All</button>
          {state.config.categories.map((c) => <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(category === c ? '' : c)}>{c}</button>)}
          <span className="chip-sep" aria-hidden />
          {PRIORITIES.map((p) => <button key={p} className={`chip prio-${p} ${priority === p ? 'on' : ''}`} title={`Only ${p}-priority items`} onClick={() => setPriority(priority === p ? '' : p)}>{p}</button>)}
          {needsOnly && <button className="chip on" onClick={() => setParams({})}>needs you ×</button>}
        </div>
        <span className="grow desk-only" />
        <span className="muted small desk-only">{items.length} item{items.length === 1 ? '' : 's'}</span>
        <button className="primary fab" onClick={() => setCreating(true)}>+ New item</button>
      </div>
      {creating && <NewItemDialog onClose={() => setCreating(false)} icebox={lane === 'icebox'} />}
      {preview && <PreviewDrawer id={preview} onClose={() => setPreview(null)} />}
      {phone && lane !== 'done' ? (
        <PhoneBoard columns={columns} items={items} filtered={!!q || !!category || !!priority || needsOnly} onSelect={setPreview} />
      ) : lane === 'done' ? (
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

/**
 * The board on a phone: every stage in one scroll, stages with nothing in them left out, and the
 * strip above it showing all seven at once. Nothing drags here (a drag and a scroll are the same
 * gesture on glass): moves are the preview's buttons and the long-press menu.
 */
function PhoneBoard({ columns, items, filtered, onSelect }: { columns: string[]; items: ItemView[]; filtered: boolean; onSelect: (id: string) => void }) {
  const stages = columns.map((status) => ({ status, items: items.filter((i) => i.frontmatter.status === status) }));
  return (
    <div className="list">
      {columns.length > 1 && (
        <div className="pipeline">
          {stages.map((s) => (
            <button key={s.status} disabled={!s.items.length} className={s.items.some((i) => i.frontmatter.blocked && !i.frontmatter.triage) ? 'has hot' : s.items.some((i) => i.derived.needs_you) ? 'has wait' : s.items.length ? 'has' : ''} title={statusLabel(s.status)}
              onClick={() => document.getElementById(`stage-${s.status}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })}><b>{s.items.length}</b><span>{STAGE_SHORT[s.status] ?? statusLabel(s.status)}</span></button>
          ))}
        </div>
      )}
      {stages.filter((s) => s.items.length).map((s) => (
        <section key={s.status} id={`stage-${s.status}`} className="stage">
          <h3><span>{statusLabel(s.status)}</span><span>{s.items.length}</span></h3>
          {s.items.map((i) => <ItemCard key={i.id} item={i} sortable={false} onSelect={onSelect} />)}
        </section>
      ))}
      {!items.length && <p className="muted">{filtered ? 'No item matches.' : 'Nothing here yet. Add an item with + New item.'}</p>}
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
