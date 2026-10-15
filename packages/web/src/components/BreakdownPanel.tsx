import { useEffect, useMemo, useState } from 'react';
import { validateBreakdown, canPlan, childrenFromList, type BreakdownChild, type ChildListFormat } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { ActionButton, ActionGroup } from './ActionButton.tsx';

const NONE: BreakdownChild[] = [];

/**
 * The planner proposed an epic's children; nothing exists yet. The user edits the list — retitle,
 * re-route to another implementer, drop one, add one, fix what waits on what — and approval creates
 * exactly what is on screen. The same validation the planner was held to runs here as you type.
 * `list` mode (#239) is the same review for children the user renders from a template and a list,
 * on an epic that is not being planned; they are created only by the button, queued only if ticked.
 */
export function BreakdownPanel({ item, mode = 'proposal', onClose }: { item: ItemView; mode?: 'proposal' | 'list'; onClose?: () => void }) {
  const state = useStore((s) => s.state)!;
  const listMode = mode === 'list';
  const proposed = listMode ? NONE : ((item.frontmatter.awaiting_data as { children?: BreakdownChild[] } | undefined)?.children ?? NONE);
  const [children, setChildren] = useState<BreakdownChild[]>(proposed);
  const [open, setOpen] = useState<number | null>(null);
  const [queue, setQueue] = useState(!listMode);
  const [reject, setReject] = useState('');
  const [fromList, setFromList] = useState(listMode);
  useEffect(() => { if (!listMode) setChildren(proposed); }, [item.frontmatter.plan_ready_at]); // a revised proposal replaces local edits
  // entries from a list wait on each other by their own numbers: shift them past what is already here
  const append = (more: BreakdownChild[]) => { setChildren((cs) => [...cs, ...more.map((c) => ({ ...c, depends_on: (c.depends_on ?? []).map((d) => d + cs.length) }))]); setFromList(false); };
  const models = state.config.models.filter((m) => !m.external);
  const problem = validateBreakdown(children, state.config.models, state.config.categories);
  const patch = (i: number, p: Partial<BreakdownChild>) => setChildren((cs) => cs.map((c, k) => k === i ? { ...c, ...p } : c));
  const remove = (i: number) => setChildren((cs) => cs.filter((_c, k) => k !== i).map((c) => ({ ...c, depends_on: (c.depends_on ?? []).filter((d) => d !== i).map((d) => d > i ? d - 1 : d) })));
  const runnerOf = (id: string) => models.find((m) => m.id === id)?.runner ?? 'claude';
  const planners = models.filter((m) => canPlan(m));
  return (
    <div className="approval" id="breakdown" data-nav="Breakdown under review" data-wait={item.frontmatter.awaiting === 'orchestrator' ? undefined : true}>
      <h2 style={{ margin: '0 0 8px' }}><span>{listMode ? 'Children from a list' : 'Proposed breakdown'} · {children.length} {children.length === 1 ? 'child' : 'children'}</span>{onClose && <button className="small" onClick={onClose}>cancel</button>}</h2>
      <p className="small" style={{ marginTop: 0 }}>Nothing exists yet. Edit the list; {listMode ? 'creating' : 'approving'} makes exactly these items under this epic. A child starts only after everything it waits on has merged into the epic branch. Children {item.frontmatter.allow_model_fallback ? <b>allow</b> : <b>do not allow</b>} their model's fallback, as this epic does.</p>
      {!listMode && item.activity.filter((a) => a.actor === 'orchestrator').slice(-2).map((a, i) => <p key={i} className="small"><b>orchestrator:</b> {a.text}</p>)}
      {fromList && <FromList item={item} onAdd={append} onCancel={children.length ? () => setFromList(false) : undefined} />}
      <ol className="breakdown">
        {children.map((c, i) => (
          <li key={i} className="review-card">
            <div className="row">
              <span className="muted small">#{i + 1}</span>
              <input className="grow" value={c.title} onChange={(e) => patch(i, { title: e.target.value })} />
              <select value={c.implementer} onChange={(e) => patch(i, { implementer: e.target.value })} title={models.find((m) => m.id === c.implementer)?.description}>{models.map((m) => <option key={m.id} value={m.id}>{m.label}{(m.runner ?? 'claude') !== 'claude' ? ` (${m.runner})` : ''}</option>)}</select>
              <select value={c.category ?? item.frontmatter.category} onChange={(e) => patch(i, { category: e.target.value })}>{state.config.categories.map((x) => <option key={x}>{x}</option>)}</select>
              <select value={c.planner ?? ''} title="Who plans this child" onChange={(e) => patch(i, { planner: e.target.value || undefined })}><option value="">planned by {planners.find((m) => m.id === item.frontmatter.planner)?.label ?? item.frontmatter.planner} (epic's)</option>{planners.map((m) => <option key={m.id} value={m.id}>planned by {m.label}</option>)}</select>
              <label className="small" title="Its pull request waits for your review before it merges"><input type="checkbox" checked={!!c.hold_for_review} onChange={(e) => patch(i, { hold_for_review: e.target.checked || undefined })} /> hold for review</label>
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
      {/* a list not yet rendered has nothing to review or create */}
      {(!listMode || children.length > 0) && <>
      <div className="row"><button className="small" onClick={() => { setChildren((cs) => [...cs, { title: 'New child', description: '', implementer: state.config.defaults.implementer, depends_on: [] }]); setOpen(children.length); }}>+ add a child</button>{!fromList && <button className="small" onClick={() => setFromList(true)}>+ from a list…</button>}{JSON.stringify(children) !== JSON.stringify(proposed) && <button className="small" onClick={() => setChildren(proposed)}>{listMode ? 'clear' : 'reset to the proposal'}</button>}</div>
      {problem && (children.length > 0 || !listMode) && <p className="small" style={{ color: 'var(--hot)' }}>Cannot create this yet: {problem}.</p>}
      <div className="row" style={{ marginTop: 8 }}><ActionGroup>
        {listMode
          ? <ActionButton className="primary" disabled={!!problem} working="Creating…" onAct={() => act(() => api.addChildren(item.id, children, queue)).then((r) => { if (r) onClose?.(); })}>Create {children.length} item{children.length === 1 ? '' : 's'}</ActionButton>
          : <ActionButton className="primary" disabled={!!problem} working="Approving…" onAct={() => act(() => api.approveBreakdown(item.id, children, queue))}>Approve &amp; create {children.length} item{children.length === 1 ? '' : 's'}</ActionButton>}
        <label className="small"><input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} /> queue them now</label>
        {!listMode && <>
          <span className="grow" />
          <input className="grow" placeholder="What should the planner change?" value={reject} onChange={(e) => setReject(e.target.value)} />
          <ActionButton className="danger" disabled={!reject.trim()} working="Sending…" onAct={() => act(() => api.rejectPlan(item.id, reject)).then((r) => { if (r) setReject(''); })}>Request changes</ActionButton>
        </>}
      </ActionGroup></div>
      </>}
    </div>
  );
}

const LIST_HINT: Record<ChildListFormat | 'auto', string> = {
  auto: 'One entry per line, or a JSON array',
  lines: 'One entry per line: {{item}} is the line',
  csv: 'A header row names the fields: {{name}}, {{path}}, …; a depends_on column lists entry numbers',
  json: 'An array of strings ({{item}}) or objects ({{field}}); "depends_on": [1, 2] lists entry numbers',
};

/**
 * A prompt template and a list (lines, CSV or JSON) rendered into children for the panel above (#239): one per entry,
 * independent unless the list says what waits on what. Rendering only fills the panel; nothing is created here.
 */
function FromList({ item, onAdd, onCancel }: { item: ItemView; onAdd: (children: BreakdownChild[]) => void; onCancel?: () => void }) {
  const state = useStore((s) => s.state)!;
  const models = state.config.models.filter((m) => !m.external);
  const [template, setTemplate] = useState('');
  const [title, setTitle] = useState('');
  const [list, setList] = useState('');
  const [format, setFormat] = useState<ChildListFormat | 'auto'>('auto');
  const [implementer, setImplementer] = useState(state.config.defaults.implementer);
  const rendered = useMemo(() => childrenFromList({ template, title, list, format, implementer }), [template, title, list, format, implementer]);
  const ready = !rendered.problem && rendered.children.length > 0;
  return (
    <div className="from-list review-card">
      <label className="small">Prompt template — each child's brief; {'{{item}}'}, {'{{n}}'} and the list's fields are filled in
        <textarea aria-label="Prompt template" placeholder={`e.g. Update the lint config in packages/{{item}} and fix what it flags there. Touch nothing outside packages/{{item}}.`} value={template} onChange={(e) => setTemplate(e.target.value)} style={{ minHeight: 80 }} />
      </label>
      <label className="small">Title template <input aria-label="Title template" placeholder="{{item}}" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="small">List — {LIST_HINT[format]}
        <textarea aria-label="List" className="mono" placeholder={format === 'csv' ? 'name,path,depends_on\nshared,packages/shared,\nweb,packages/web,1' : format === 'json' ? '[{"name": "shared"}, {"name": "web", "depends_on": [1]}]' : 'shared\nserver\nweb'} value={list} onChange={(e) => setList(e.target.value)} style={{ minHeight: 90 }} />
      </label>
      <div className="row">
        <select aria-label="List format" value={format} onChange={(e) => setFormat(e.target.value as ChildListFormat | 'auto')}><option value="auto">auto</option><option value="lines">lines</option><option value="csv">CSV</option><option value="json">JSON</option></select>
        <select aria-label="Implementer" value={implementer} onChange={(e) => setImplementer(e.target.value)}>{models.map((m) => <option key={m.id} value={m.id}>{m.label}{(m.runner ?? 'claude') !== 'claude' ? ` (${m.runner})` : ''}</option>)}</select>
        <span className="small muted">category {item.frontmatter.category}, as the epic</span>
      </div>
      {(template.trim() || list.trim()) && rendered.problem && <p className="small" style={{ color: 'var(--hot)', margin: '4px 0' }}>{rendered.problem[0].toUpperCase() + rendered.problem.slice(1)}.</p>}
      {ready && <p className="small muted" style={{ margin: '4px 0' }}>{rendered.children.length} {rendered.children.length === 1 ? 'child' : 'children'}: {rendered.children.slice(0, 6).map((c) => c.title).join(' · ')}{rendered.children.length > 6 ? ' · …' : ''}</p>}
      <div className="row">
        <button className="small primary" disabled={!ready} onClick={() => onAdd(rendered.children)}>Add {ready ? rendered.children.length : ''} to the list for review</button>
        {onCancel && <button className="small" onClick={onCancel}>cancel</button>}
      </div>
    </div>
  );
}
