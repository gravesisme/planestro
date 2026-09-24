import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { JournalEntry } from '@planestro/shared';
import { DndContext, MouseSensor, TouchSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../api.ts';
import { act, useStore } from '../store.ts';
import { usePhone } from '../usePhone.ts';

export function ConsolePage() {
  const state = useStore((s) => s.state);
  const events = useStore((s) => s.events);
  const phone = usePhone();
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [questions, setQuestions] = useState<JournalEntry[]>([]);
  const [itemFilter, setItemFilter] = useState('');
  const [msg, setMsg] = useState('');
  const [reconcileOut, setReconcileOut] = useState<string[] | null>(null);
  const refresh = () => { void api.journal({ item: itemFilter || undefined, limit: 120 }).then((j) => setJournal(j.reverse())); void api.orchestratorQuestions().then((q) => setQuestions(q.reverse())); };
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [itemFilter]);
  const queue = (state?.items ?? []).filter((i) => i.frontmatter.status === 'IN_REVIEW').sort((a, b) => (a.frontmatter.merge_order ?? 1e9) - (b.frontmatter.merge_order ?? 1e9) || (a.frontmatter.rank ?? 0) - (b.frontmatter.rank ?? 0));
  // A finger that moves is scrolling the page; one that rests on a row first is picking it up.
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }));
  const onQueueDrag = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = queue.map((i) => i.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    void act(() => api.queueOrder(next));
  };
  if (!state) return <p className="muted">Loading…</p>;
  return (
    <div>
      <div className="section"><h2>Orchestrator</h2>
        <p className="muted small">The judgment layer: woken on plan submissions, merges, repeated CI failures and blocks. Message it with context or answers; it records decisions on the items.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (!msg.trim()) return; void act(() => api.orchestratorMessage(msg)); setMsg(''); }}><input className="grow" placeholder="Message the orchestrator (it wakes with your text + current state)" value={msg} onChange={(e) => setMsg(e.target.value)} /><button type="submit" disabled={!msg.trim()}>Send</button></form>
        {questions.length > 0 && <>
          <h3 className="drawer-h">Its questions for you</h3>
          {questions.slice(0, 3).map((q, i) => <Question key={i} q={q} />)}
          {questions.length > 3 && <details className="small"><summary className="muted">{questions.length - 3} older</summary>{questions.slice(3).map((q, i) => <Question key={i} q={q} />)}</details>}
        </>}
      </div>
      <div className="section"><h2>Merge queue ({phone ? 'hold, then drag' : 'drag'} to reorder)</h2>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onQueueDrag}>
          <SortableContext items={queue.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            {queue.map((i, n) => <QueueRow key={i.id} n={n + 1} id={i.id} title={i.frontmatter.title} base={i.derived.base_branch} ci={i.frontmatter.ci_result} skip={i.frontmatter.skip_merge} />)}
          </SortableContext>
        </DndContext>
        {!queue.length && <p className="muted small">Nothing in review.</p>}
      </div>
      <div className="section"><h2>Maintenance</h2>
        <RestartPrep />
        <div className="row"><button onClick={async () => { const r = await act(() => api.reconcile()); if (r) setReconcileOut(r.corrections); }}>Reconcile now</button><span className="muted small">Cross-checks items against git, worktrees, GitHub and CI.</span></div>
        {reconcileOut && <pre className="events">{reconcileOut.length ? reconcileOut.join('\n') : 'everything matches'}</pre>}
      </div>
      <div className="section"><h2>Journal <input placeholder="filter by item id" value={itemFilter} onChange={(e) => setItemFilter(e.target.value)} style={{ marginLeft: 10, fontWeight: 400 }} /></h2>
        <div className="events">{journal.map((e, i) => `${e.ts.slice(5, 19).replace('T', ' ')}  ${e.type.padEnd(22)} ${e.item ?? ''} ${e.data ? JSON.stringify(e.data).slice(0, 140) : ''}`).join('\n') || 'quiet'}</div>
      </div>
      <div className="section"><h2>Engine log</h2><div className="events">{events.slice(-80).join('\n') || 'quiet'}</div></div>
    </div>
  );
}

function QueueRow({ n, id, title, base, ci, skip }: { n: number; id: string; title: string; base?: string; ci?: string; skip?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners} className={`card queue-row ${isDragging ? 'dragging' : ''}`}>
      <span className="id">#{n}</span> <Link to={`/items/${id}`}>{id}</Link> {title} <span className="muted small">→ {base}</span> {ci && <span className="tag">{ci}</span>} {skip && <span className="tag hot">held</span>}
    </div>
  );
}

function Question({ q }: { q: JournalEntry }) {
  return <p>🟠 <b>{String((q.data as any)?.question)}</b> {q.item && <Link to={`/items/${q.item}`}>{q.item}</Link>} <span className="muted small">{q.ts.slice(0, 16).replace('T', ' ')}</span></p>;
}

/** Getting ready to restart planestro: nothing new starts, what runs finishes, and this says when nothing is left. */
function RestartPrep() {
  const restart = useStore((s) => s.state?.engine.restart);
  if (!restart) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row">
        {restart.draining
          ? <button onClick={() => act(() => api.undrain())}>Cancel restart preparation</button>
          : <button onClick={() => act(() => api.drain())}>Prepare to restart</button>}
        <span className="muted small">{restart.draining
          ? (restart.idle ? <b style={{ color: 'var(--ok)' }}>Nothing is running: restart now and nothing is lost. planestro comes back running.</b> : `Waiting for ${restart.running.length} to finish; nothing new starts.`)
          : 'Lets running turns and steps finish while nothing new starts, then says when a restart loses nothing. Unlike PAUSE, planestro comes back running after the restart.'}</span>
      </div>
      {restart.draining && !restart.idle && <ul className="small muted" style={{ margin: '6px 0 0' }}>{restart.running.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}

