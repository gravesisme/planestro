import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { JournalEntry } from '@planestro/shared';
import { DndContext, MouseSensor, TouchSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, type QuestionView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { usePhone } from '../usePhone.ts';

export function ConsolePage() {
  const state = useStore((s) => s.state);
  const events = useStore((s) => s.events);
  const phone = usePhone();
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [itemFilter, setItemFilter] = useState('');
  const [reconcileOut, setReconcileOut] = useState<string[] | null>(null);
  const refresh = () => { void api.journal({ item: itemFilter || undefined, limit: 120 }).then((j) => setJournal(j.reverse())); };
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
        <p className="muted small">The judgment layer: woken on plan submissions, merges, repeated CI failures and blocks. Talk to it from any page with the <b>Orchestrator</b> button in the corner; it answers there, and records its decisions on the items.</p>
        <div className="row"><button className="primary" onClick={() => useStore.getState().openChat()}>Open the chat</button></div>
        <Questions />
      </div>
      <PlanestroNotes />
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

/**
 * The orchestrator's questions (#75): the open ones, each with a way into its discussion and a way
 * to ask whether it still stands; the answered ones folded away, so the list is only what is live.
 */
function Questions() {
  const questions = useStore((s) => s.questions);
  const paused = useStore((s) => s.state?.engine.paused ?? false);
  const orchestrated = useStore((s) => s.chat.enabled !== false); // not the mock engine
  if (!questions?.length) return null;
  const open = questions.filter((q) => q.frontmatter.status === 'open');
  const answered = questions.filter((q) => q.frontmatter.status !== 'open');
  const checking = open.filter((q) => q.pending).length;
  return <>
    <h3 className="drawer-h q-head"><span>Its questions for you{open.length > 0 && <span className="badge-n">{open.length}</span>}</span>
      {open.length > 1 && orchestrated && <button className="small" disabled={checking === open.length} title="The orchestrator looks at every open question against the backlog as it is now, and withdraws or refreshes the ones that moved on" onClick={() => act(() => api.reviewAllQuestions())}>Check all</button>}
    </h3>
    {paused && checking > 0 && <p className="muted small">Automation is paused: the orchestrator looks at these when you resume.</p>}
    {!open.length && <p className="muted small">None open.</p>}
    <div className="q-list">{open.map((q) => <QuestionRow key={q.id} q={q} canAsk={orchestrated} />)}</div>
    {answered.length > 0 && <details className="small q-answered"><summary className="muted">Answered ({answered.length})</summary>
      <ul className="q-done">{answered.map((q) => <li key={q.id}><Link to={`/questions/${q.id}`}>{q.frontmatter.headline}</Link> <span className="muted">{q.frontmatter.status === 'withdrawn' ? 'withdrawn' : 'resolved'}{q.frontmatter.resolution ? `: ${q.frontmatter.resolution}` : ''} · {ago(q.frontmatter.resolved_at ?? q.frontmatter.updated_at)}</span></li>)}</ul>
    </details>}
  </>;
}

function QuestionRow({ q, canAsk }: { q: QuestionView; canAsk: boolean }) {
  const fm = q.frontmatter;
  return (
    <div className="q-row">
      <Link className="q-headline" to={`/questions/${q.id}`}>{fm.headline}</Link>
      <div className="q-meta small muted">
        {fm.item && <Link to={`/items/${fm.item}`}>{fm.item}</Link>}
        <span>asked {ago(fm.asked_at)}</span>
        {q.messages > 0 && <span>{q.messages} message{q.messages === 1 ? '' : 's'}</span>}
        {q.pending && <span className="tag triage">orchestrator looking</span>}
      </div>
      <div className="q-actions">
        <Link className="button small" to={`/questions/${q.id}`}>Discuss</Link>
        {canAsk && <button className="small" disabled={q.pending} title="Have the orchestrator check it against the current state: it withdraws a moot question or refreshes one that moved on" onClick={() => act(() => api.reviewQuestion(q.id))}>{q.pending ? 'Checking…' : 'Still relevant?'}</button>}
      </div>
    </div>
  );
}

/** "3 h ago", "2 d ago": how stale a question is matters more than its clock time. */
export function ago(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
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


/** What the orchestrator would change about planestro (f8): a list of its own, with a badge until read. */
function PlanestroNotes() {
  const notes = useStore((s) => s.notes); const seen = useStore((s) => s.notesSeen);
  const items = useStore((s) => s.state?.items ?? []);
  const unread = notes.filter((n) => n.ts > seen).length;
  return (
    <div className="section"><h2>planestro feedback{unread > 0 && <span className="badge-n">{unread}</span>}</h2>
      <p className="muted small">The orchestrator's suggestions about planestro itself: a tool it lacked, a rule that misfired, a card that could not do what it asked. They are for you, not for the items.</p>
      {!notes.length && <p className="muted small">None yet.</p>}
      <ul className="activity">{[...notes].reverse().slice(0, 30).map((n, i) => <li key={`${n.ts}-${i}`} className={n.ts > seen ? 'unread' : ''}><span className="at">{n.ts.slice(5, 16).replace('T', ' ')}</span><span className="muted">{n.item && items.some((x) => x.id === n.item) ? <Link to={`/items/${n.item}`}>{n.item}</Link> : (n.item ?? 'planestro')}</span><span>{String(n.data?.text ?? '')}</span></li>)}</ul>
      {unread > 0 && <div className="row"><button className="small" onClick={() => useStore.getState().markNotesRead()}>Mark all read</button></div>}
    </div>
  );
}

