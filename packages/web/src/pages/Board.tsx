import { useMemo, useRef, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router';
import { DndContext, MouseSensor, TouchSensor, useSensor, useSensors, useDroppable, closestCenter, pointerWithin, type CollisionDetection, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { findTransition, PRIORITIES, type Priority, type Status } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { ItemCard, statusLabel } from '../components/ItemCard.tsx';
import { NewItemDialog } from '../components/NewItemDialog.tsx';
import { ImportIssuesDialog } from '../components/ImportIssuesDialog.tsx';
import { PreviewDrawer } from '../components/PreviewDrawer.tsx';
import { usePhone } from '../usePhone.ts';
import { activeFilters, emptyText, type ActiveFilter, type FilterKey } from '../boardFilters.ts';
import { boardColumns } from '../boardColumns.ts';
import { agentStateOf } from '../agentState.ts';

const COL = 'col:';
/** A drop target's column: `col:<status>` is a column (or a phone stage), `col:<status>@strip` a cell of the phone's stage strip. */
const colStatus = (id: string | number): string => String(id).slice(COL.length).split('@')[0]!;
/** The phone's stage strip has a cell per column across one screen: names that fit, in the order of the columns. */
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
  // The phone's stage strip sits over the stages it scrolls past: a cell under the pointer is the target. It is
  // sticky, so it is hit-tested where it is now; dnd-kit's measured rects move with the page as it scrolls.
  const p = args.pointerCoordinates;
  const strip = p && args.droppableContainers.find((c) => {
    const r = String(c.id).includes('@') ? c.node.current?.getBoundingClientRect() : undefined;
    return r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  });
  if (strip) return [{ id: strip.id, data: { droppableContainer: strip, value: 0 } }];
  const col = pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter((c) => isCol(c) && !String(c.id).includes('@')) })[0];
  if (!col) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => !isCol(c)) });
  const cards = args.droppableContainers.filter((c) => !isCol(c) && c.data.current?.status === colStatus(col.id));
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
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<{ status: string; ok: boolean } | null>(null);
  const needsOnly = params.get('needs') === '1';
  const runningOnly = params.get('running') === '1';
  const phone = usePhone();
  // A mouse drags the whole card; touch drags only from the card's handle, which has `touch-action: none` (#215).
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { distance: 4 } }));

  const items = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (state?.items ?? []).filter((i) => i.derived.lane === lane)
      .filter((i) => !category || i.frontmatter.category === category)
      .filter((i) => !priority || i.frontmatter.priority === priority)
      .filter((i) => !needsOnly || i.derived.needs_you)
      .filter((i) => !runningOnly || agentStateOf(i, state)?.kind === 'running')
      .filter((i) => terms.every((t) => `${i.id} ${i.frontmatter.title} ${i.sections.Description} ${i.sections.Notes}`.toLowerCase().includes(t)));
  }, [state, lane, q, category, priority, needsOnly, runningOnly]);

  const statusAt = (overId: string | number): string | undefined => String(overId).startsWith(COL) ? colStatus(overId) : items.find((i) => i.id === overId)?.frontmatter.status;
  // Over a cell of the phone's strip the page must hold still: scrolled to the top, the strip is no longer stuck and moves away.
  const overStrip = useRef(false);
  const onDragOver = (e: DragOverEvent) => {
    overStrip.current = String(e.over?.id ?? '').includes('@');
    const a = items.find((i) => i.id === e.active.id); const to = e.over ? statusAt(e.over.id) : undefined;
    setDragTarget(a && to && to !== a.frontmatter.status ? { status: to, ok: !!dropAction(a, to).run } : null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragTarget(null); overStrip.current = false;
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

  const filters = activeFilters({ q, category, priority, needsOnly, runningOnly });
  const setRunning = (on: boolean) => setParams((p) => { if (on) p.set('running', '1'); else p.delete('running'); return p; });
  const clear = (key: FilterKey) => {
    if (key === 'needs') setParams((p) => { p.delete('needs'); return p; });
    else if (key === 'running') setRunning(false);
    else if (key === 'category') setCategory(''); else if (key === 'priority') setPriority(''); else setQ('');
  };
  const clearAll = () => filters.forEach((f) => clear(f.key));

  const dropAt = (status: string): 'ok' | 'no' | undefined => dragTarget?.status === status ? (dragTarget.ok ? 'ok' : 'no') : undefined;

  if (!state) return <p className="muted">Loading…</p>;
  const columns = lane === 'board' ? boardColumns(state.items.filter((i) => i.derived.lane === 'board').map((i) => i.frontmatter.status)) : [lane === 'icebox' ? 'ICEBOX' : 'FINISHED'];
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
          <span className="chip-sep" aria-hidden />
          <button className={`chip running ${runningOnly ? 'on' : ''}`} aria-pressed={runningOnly} title="Only items with an agent working on them now" onClick={() => setRunning(!runningOnly)}>running</button>
          {needsOnly && <button className="chip on" onClick={() => clear('needs')}>needs you ×</button>}
        </div>
        <span className="grow desk-only" />
        <span className="muted small desk-only">{items.length} item{items.length === 1 ? '' : 's'}</span>
        {state.config.code_repo.github && lane === 'board' && <button className="desk-only" title={`File open issues of ${state.config.code_repo.github} as items`} onClick={() => setImporting(true)}>Import issues</button>}
        <button className="primary fab" onClick={() => setCreating(true)}>+ New item</button>
      </div>
      {phone && filters.length > 0 && (
        <div className="filter-bar" aria-label="Active filters">
          <span className="muted">Showing</span>
          {filters.map((f) => <button key={f.key} className="chip on" aria-label={`Stop filtering by ${f.label}`} onClick={() => clear(f.key)}>{f.label} ×</button>)}
          <span className="grow" />
          <button className="link" onClick={clearAll}>Show all</button>
        </div>
      )}
      {importing && <ImportIssuesDialog onClose={() => setImporting(false)} />}
      {creating && <NewItemDialog onClose={() => setCreating(false)} icebox={lane === 'icebox'} />}
      {preview && <PreviewDrawer id={preview} onClose={() => setPreview(null)} />}
      {lane === 'done' ? (
        <div className="list card-list">{done.map((i) => <ItemCard key={i.id} item={i} sortable={false} onSelect={setPreview} />)}{!done.length && <p className="muted">Nothing finished yet.</p>}</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={columnFirst} autoScroll={{ canScroll: () => !overStrip.current }} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setDragTarget(null); overStrip.current = false; }}>
          {phone ? (
            <PhoneBoard columns={columns} items={items} filters={filters} onClear={clearAll} onSelect={setPreview} dropAt={dropAt} />
          ) : (<>
            {!items.length && filters.length > 0 && <Empty filters={filters} onClear={clearAll} />}
            <div className="board" style={lane === 'icebox' ? { gridAutoColumns: 'minmax(420px, 640px)' } : undefined}>
              {columns.map((status) => { const col = items.filter((i) => i.frontmatter.status === status); return <Column key={status} status={status} items={col} onSelect={setPreview} drop={dropAt(status)} />; })}
            </div>
          </>)}
        </DndContext>
      )}
    </div>
  );
}

/** An empty board names the filters that emptied it and offers to drop them (#286). */
function Empty({ filters, onClear }: { filters: ActiveFilter[]; onClear: () => void }) {
  return <p className="muted board-empty">{emptyText(filters)}{filters.length > 0 && <> <button className="link" onClick={onClear}>Show all items</button></>}</p>;
}

/**
 * The board on a phone: every stage in one scroll, stages with nothing in them left out, and the
 * strip above it showing every column at once (Merged only while something is in it, #291). A card drags by its handle (#215): within its stage to
 * reorder, or onto another stage, or onto that stage's cell in the strip when it is empty or off screen.
 */
function PhoneBoard({ columns, items, filters, onClear, onSelect, dropAt }: { columns: string[]; items: ItemView[]; filters: ActiveFilter[]; onClear: () => void; onSelect: (id: string) => void; dropAt: (status: string) => 'ok' | 'no' | undefined }) {
  const stages = columns.map((status) => ({ status, items: items.filter((i) => i.frontmatter.status === status) }));
  return (
    <div className="list">
      {columns.length > 1 && (
        <div className="pipeline">
          {stages.map((s) => <StripCell key={s.status} status={s.status} items={s.items} drop={dropAt(s.status)} />)}
        </div>
      )}
      {stages.filter((s) => s.items.length).map((s) => <Stage key={s.status} status={s.status} items={s.items} onSelect={onSelect} drop={dropAt(s.status)} />)}
      {!items.length && <Empty filters={filters} onClear={onClear} />}
    </div>
  );
}

function StripCell({ status, items, drop }: { status: string; items: ItemView[]; drop?: 'ok' | 'no' }) {
  const { setNodeRef } = useDroppable({ id: `${COL}${status}@strip` });
  const tone = items.some((i) => i.frontmatter.blocked && !i.frontmatter.triage) ? 'has hot' : items.some((i) => i.derived.needs_you) ? 'has wait' : items.length ? 'has' : '';
  return (
    <button ref={setNodeRef} disabled={!items.length} className={`${tone} ${drop ? `drop-${drop}` : ''}`} title={statusLabel(status)}
      onClick={() => document.getElementById(`stage-${status}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })}><b>{items.length}</b><span>{STAGE_SHORT[status] ?? statusLabel(status)}</span></button>
  );
}

function Stage({ status, items, onSelect, drop }: { status: string; items: ItemView[]; onSelect: (id: string) => void; drop?: 'ok' | 'no' }) {
  const { setNodeRef } = useDroppable({ id: `${COL}${status}` });
  return (
    <section ref={setNodeRef} id={`stage-${status}`} className={`stage ${drop ? `drop-${drop}` : ''}`}>
      <h3><span>{statusLabel(status)}</span><span>{items.length}</span></h3>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((i) => <ItemCard key={i.id} item={i} onSelect={onSelect} />)}
      </SortableContext>
    </section>
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
