import { useEffect, useState } from 'react';
import { validateBreakdown, type BreakdownChild } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';

/**
 * The planner proposed an epic's children; nothing exists yet. The user edits the list — retitle,
 * re-route to another implementer, drop one, add one, fix what waits on what — and approval creates
 * exactly what is on screen. The same validation the planner was held to runs here as you type.
 */
export function BreakdownPanel({ item }: { item: ItemView }) {
  const state = useStore((s) => s.state)!;
  const proposed = ((item.frontmatter.awaiting_data as { children?: BreakdownChild[] } | undefined)?.children ?? []);
  const [children, setChildren] = useState<BreakdownChild[]>(proposed);
  const [open, setOpen] = useState<number | null>(null);
  const [queue, setQueue] = useState(true);
  const [reject, setReject] = useState('');
  useEffect(() => { setChildren(proposed); }, [item.frontmatter.plan_ready_at]); // a revised proposal replaces local edits
  const models = state.config.models.filter((m) => !m.external);
  const problem = validateBreakdown(children, state.config.models, state.config.categories);
  const patch = (i: number, p: Partial<BreakdownChild>) => setChildren((cs) => cs.map((c, k) => k === i ? { ...c, ...p } : c));
  const remove = (i: number) => setChildren((cs) => cs.filter((_c, k) => k !== i).map((c) => ({ ...c, depends_on: (c.depends_on ?? []).filter((d) => d !== i).map((d) => d > i ? d - 1 : d) })));
  const runnerOf = (id: string) => models.find((m) => m.id === id)?.runner ?? 'claude';
  return (
    <div className="approval">
      <h2 style={{ margin: '0 0 8px' }}><span>Proposed breakdown · {children.length} {children.length === 1 ? 'child' : 'children'}</span></h2>
      <p className="small" style={{ marginTop: 0 }}>Nothing exists yet. Edit the list; approving creates exactly these items under this epic. A child starts only after everything it waits on has merged into the epic branch. Children {item.frontmatter.allow_model_fallback ? <b>allow</b> : <b>do not allow</b>} their model's fallback, as this epic does.</p>
      {item.activity.filter((a) => a.actor === 'orchestrator').slice(-2).map((a, i) => <p key={i} className="small"><b>orchestrator:</b> {a.text}</p>)}
      <ol className="breakdown">
        {children.map((c, i) => (
          <li key={i} className="review-card">
            <div className="row">
              <span className="muted small">#{i + 1}</span>
              <input className="grow" value={c.title} onChange={(e) => patch(i, { title: e.target.value })} />
              <select value={c.implementer} onChange={(e) => patch(i, { implementer: e.target.value })} title={models.find((m) => m.id === c.implementer)?.description}>{models.map((m) => <option key={m.id} value={m.id}>{m.label}{(m.runner ?? 'claude') !== 'claude' ? ` (${m.runner})` : ''}</option>)}</select>
              <select value={c.category ?? item.frontmatter.category} onChange={(e) => patch(i, { category: e.target.value })}>{state.config.categories.map((x) => <option key={x}>{x}</option>)}</select>
              <button className="small" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'hide brief' : 'brief'}</button>
              <button className="small danger" title="Drop this child" onClick={() => remove(i)}>×</button>
            </div>
            <div className="deps" style={{ marginTop: 4 }}>
              <span className={`tag ${runnerOf(c.implementer) === 'claude' ? '' : 'epic'}`}>{runnerOf(c.implementer)}</span> waits on
              {(c.depends_on ?? []).length === 0 && <span className="muted"> nothing — starts right away</span>}
              {(c.depends_on ?? []).map((d) => <span key={d} className="tag">#{d + 1} {children[d]?.title.slice(0, 28)} <button className="chip-x" onClick={() => patch(i, { depends_on: (c.depends_on ?? []).filter((x) => x !== d) })}>×</button></span>)}
              <select value="" onChange={(e) => e.target.value !== '' && patch(i, { depends_on: [...(c.depends_on ?? []), Number(e.target.value)] })}><option value="">add…</option>{children.map((o, k) => k !== i && !(c.depends_on ?? []).includes(k) ? <option key={k} value={k}>#{k + 1} {o.title.slice(0, 50)}</option> : null)}</select>
            </div>
            {open === i && <textarea style={{ marginTop: 6, minHeight: 110 }} value={c.description} onChange={(e) => patch(i, { description: e.target.value })} />}
            {open !== i && <p className="small muted" style={{ margin: '4px 0 0' }}>{c.description.slice(0, 220)}{c.description.length > 220 ? '…' : ''}</p>}
          </li>
        ))}
      </ol>
      <div className="row"><button className="small" onClick={() => { setChildren((cs) => [...cs, { title: 'New child', description: '', implementer: state.config.defaults.implementer, depends_on: [] }]); setOpen(children.length); }}>+ add a child</button>{JSON.stringify(children) !== JSON.stringify(proposed) && <button className="small" onClick={() => setChildren(proposed)}>reset to the proposal</button>}</div>
      {problem && <p className="small" style={{ color: 'var(--hot)' }}>Cannot create this yet: {problem}.</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={!!problem} onClick={() => act(() => api.approveBreakdown(item.id, children, queue))}>Approve &amp; create {children.length} item{children.length === 1 ? '' : 's'}</button>
        <label className="small"><input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} /> queue them now</label>
        <span className="grow" />
        <input className="grow" placeholder="What should the planner change?" value={reject} onChange={(e) => setReject(e.target.value)} />
        <button className="danger" disabled={!reject.trim()} onClick={() => act(() => api.rejectPlan(item.id, reject)).then((r) => { if (r) setReject(''); })}>Request changes</button>
      </div>
    </div>
  );
}
