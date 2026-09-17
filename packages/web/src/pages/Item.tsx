import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Status } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { Markdown } from '../components/Markdown.tsx';
import { statusLabel } from '../components/ItemCard.tsx';
import { ItemConsole } from '../components/ItemConsole.tsx';
import { CLOSE_HINT, confirmMove, promptCloseAsDone } from '../components/QuickActions.tsx';

function useAutosave(id: string, section: 'Description' | 'Notes' | 'Plan', initial: string) {
  const [text, setText] = useState(initial);
  const saved = useRef(initial);
  useEffect(() => { if (initial !== saved.current) { setText(initial); saved.current = initial; } }, [initial]);
  const save = () => { if (text === saved.current) return; saved.current = text; void act(() => api.patchItem(id, { sections: { [section]: text } })); };
  return { text, setText, save, dirty: text !== saved.current };
}

export function ItemPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const state = useStore((s) => s.state);
  const item = state?.items.find((i) => i.id === id);
  const [transitions, setTransitions] = useState<{ to: Status; label: string }[]>([]);
  useEffect(() => { if (item) void api.transitions(id).then(setTransitions).catch(() => setTransitions([])); }, [id, item?.frontmatter.status]);
  if (!state) return <p className="muted">Loading…</p>;
  if (!item) return <p>Unknown item {id}. <Link to="/">Back to board</Link></p>;
  return <ItemBody key={id} item={item} transitions={transitions} onDeleted={() => nav('/')} />;
}

function ItemBody({ item, transitions, onDeleted }: { item: ItemView; transitions: { to: Status; label: string }[]; onDeleted: () => void }) {
  const state = useStore((s) => s.state)!;
  const fm = item.frontmatter; const d = item.derived;
  const desc = useAutosave(item.id, 'Description', item.sections.Description);
  const notes = useAutosave(item.id, 'Notes', item.sections.Notes);
  const [editPlan, setEditPlan] = useState(false);
  const plan = useAutosave(item.id, 'Plan', item.sections.Plan);
  const [title, setTitle] = useState(fm.title);
  const [approval, setApproval] = useState('');
  const [reject, setReject] = useState('');
  const [msg, setMsg] = useState('');
  const [refPath, setRefPath] = useState('');
  const session = state.engine.sessions.find((s) => s.item === item.id);
  const children = d.children.map((c) => state.items.find((i) => i.id === c)).filter(Boolean) as ItemView[];
  const epics = state.items.filter((i) => i.frontmatter.kind === 'epic' && i.id !== item.id);
  const others = state.items.filter((i) => i.id !== item.id && i.derived.lane !== 'done');
  const field = (fields: Record<string, unknown>) => act(() => api.patchItem(item.id, { fields }));
  const canClose = transitions.some((t) => t.to === 'FINISHED');
  const closeAsDone = () => promptCloseAsDone(item.id);
  const onPaste = (e: React.ClipboardEvent) => { const f = [...e.clipboardData.files][0]; if (f) { e.preventDefault(); void act(() => api.uploadAttachment(item.id, f)); } };
  const awaitingData = fm.awaiting_data as { questions?: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[]; tool?: string; input?: Record<string, unknown> } | undefined;

  return (
    <div className="item-page" onPaste={onPaste}>
      <div>
        <h1><input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== fm.title && field({ title: title.trim() })} /></h1>
        <div className="controls">
          <span className="pill">{statusLabel(fm.status)}</span>
          {fm.blocked && <span className="pill blocked">BLOCKED{fm.blocked_reason ? ` · ${fm.blocked_reason}` : ''}</span>}
          {fm.awaiting && <span className={`pill ${d.needs_you ? 'await' : ''}`}>awaiting {fm.awaiting.replace(/_/g, ' ')}</span>}
          {fm.op && <span className="pill">{fm.op.replace(/_/g, ' ')}</span>}
          {transitions.filter((t) => !(t.to === 'IN_PROGRESS' && fm.status === 'PLAN_READY') && !(t.to === 'PLAN_IN_PROGRESS' && fm.status === 'PLAN_READY')).map((t) => (
            t.to === 'FINISHED'
              ? <button key={t.to} title={CLOSE_HINT} onClick={closeAsDone}>{t.label}…</button>
              : <button key={t.to} disabled={t.to === 'QUEUED' && (!d.deps_satisfied || !!d.base_branch_error)} title={d.base_branch_error ?? (!d.deps_satisfied ? 'dependencies not merged' : '')} onClick={() => { if (confirmMove(item, t.to, t.label)) void act(() => api.transition(item.id, t.to)); }}>{t.label}</button>
          ))}
          {fm.blocked && <button className="danger" onClick={() => { const m = prompt(`Unblock ${item.id} (${fm.blocked_reason}). Optional message for the session:`) ; if (m !== null) void act(() => api.unblock(item.id, m || undefined)); }}>unblock…</button>}
        </div>
        <div className="controls">
          <label>category <select value={fm.category} onChange={(e) => field({ category: e.target.value })}>{state.config.categories.map((c) => <option key={c}>{c}</option>)}</select></label>
          {fm.kind !== 'epic' && <label>planner <select value={fm.planner ?? ''} onChange={(e) => field({ planner: e.target.value })}>{state.config.models.filter((m) => !m.external).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>}
          {fm.kind !== 'epic' && <label>implementer <select value={fm.implementer ?? ''} onChange={(e) => field({ implementer: e.target.value })}>{state.config.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.external ? ' (external)' : ''}</option>)}</select></label>}
          {fm.kind !== 'epic' && <label>parent epic <select value={fm.parent ?? ''} onChange={(e) => field({ parent: e.target.value || null })}><option value="">none</option>{epics.map((e) => <option key={e.id} value={e.id}>{e.id} {e.frontmatter.title}</option>)}</select></label>}
          {fm.kind !== 'epic' && !d.external && <label><input type="checkbox" checked={!!fm.auto_approve_plan} onChange={(e) => field({ auto_approve_plan: e.target.checked })} disabled title="Available once the orchestrator exists (Phase 4)" /> auto-approve plan</label>}
          {d.external && <label>merge policy <select value={fm.merge_policy ?? 'watch'} onChange={(e) => field({ merge_policy: e.target.value })}><option value="watch">watch (someone else merges)</option><option value="app">app (planestro merges)</option></select></label>}
          <label>depends on <select multiple size={Math.min(4, Math.max(2, others.length))} value={fm.depends_on} onChange={(e) => field({ depends_on: [...e.target.selectedOptions].map((o) => o.value) })}>{others.map((o) => <option key={o.id} value={o.id}>{o.id} {o.frontmatter.title}</option>)}</select></label>
        </div>
        {(d.external || fm.kind === 'epic') && (
          <div className="controls">
            <label>branch <input value={fm.branch ?? ''} placeholder={fm.kind === 'epic' ? 'feature/<slug>' : 'external branch name'} onBlur={(e) => e.target.value !== (fm.branch ?? '') && field({ branch: e.target.value || null })} onChange={() => {}} readOnly={false} key={fm.branch} defaultValue={fm.branch ?? ''} /></label>
            <label>PR # <input type="number" key={fm.pr} defaultValue={fm.pr ?? ''} onBlur={(e) => Number(e.target.value) !== (fm.pr ?? 0) && field({ pr: e.target.value ? Number(e.target.value) : null })} /></label>
          </div>
        )}

        {fm.status === 'PLAN_READY' && (
          <div className="approval">
            <h2 style={{ margin: '0 0 8px' }}>Plan needs your approval</h2>
            {item.activity.filter((a) => a.actor === 'orchestrator').slice(-3).map((a, i) => <p key={i} className="small"><b>orchestrator:</b> {a.text}</p>)}
            <textarea placeholder="Optional notes to pass to the implementer" value={approval} onChange={(e) => setApproval(e.target.value)} style={{ minHeight: 60 }} />
            <div className="row"><button className="primary" onClick={() => act(() => api.approvePlan(item.id, approval || undefined))}>Approve &amp; implement</button>{canClose && <button title={CLOSE_HINT} onClick={closeAsDone}>Already done — close…</button>}<span className="grow" /><input className="grow" placeholder="What should change?" value={reject} onChange={(e) => setReject(e.target.value)} /><button className="danger" disabled={!reject.trim()} onClick={() => act(() => api.rejectPlan(item.id, reject))}>Request changes</button></div>
          </div>
        )}
        {fm.awaiting === 'question' && awaitingData?.questions && (
          <div className="approval">
            <h2 style={{ margin: '0 0 8px' }}>The agent asked</h2>
            <QuestionForm questions={awaitingData.questions} onSubmit={(answers) => act(() => api.respond(item.id, { kind: 'question', answers }))} />
          </div>
        )}
        {fm.awaiting === 'permission' && awaitingData && (
          <div className="approval">
            <h2 style={{ margin: '0 0 8px' }}>Permission requested: {awaitingData.tool}</h2>
            <pre className="events">{JSON.stringify(awaitingData.input, null, 2)}</pre>
            <div className="row">
              <button className="primary" onClick={() => act(() => api.respond(item.id, { kind: 'permission', decision: 'allow' }))}>Allow once</button>
              <button onClick={() => act(() => api.respond(item.id, { kind: 'permission', decision: 'always' }))}>Always allow</button>
              <button className="danger" onClick={() => { const reason = prompt('Reason for denying?') ?? ''; void act(() => api.respond(item.id, { kind: 'permission', decision: 'deny', reason })); }}>Deny</button>
            </div>
          </div>
        )}

        <div className="section"><h2>Description</h2><textarea value={desc.text} onChange={(e) => desc.setText(e.target.value)} onBlur={desc.save} /><div className="small muted">{desc.dirty ? 'unsaved — saves on blur' : ' '}</div></div>
        <div className="section"><h2>Notes</h2><textarea value={notes.text} onChange={(e) => notes.setText(e.target.value)} onBlur={notes.save} style={{ minHeight: 80 }} /></div>
        <div className="section"><h2>Plan <button className="small" onClick={() => { if (editPlan) plan.save(); setEditPlan(!editPlan); }}>{editPlan ? 'done' : 'edit'}</button></h2>{editPlan ? <textarea value={plan.text} onChange={(e) => plan.setText(e.target.value)} onBlur={plan.save} style={{ minHeight: 200 }} /> : <Markdown text={item.sections.Plan} />}</div>
        {fm.kind === 'epic' && (
          <div className="section"><h2>Children · {children.filter((c) => ['MERGED', 'FINISHED'].includes(c.frontmatter.status)).length}/{children.length} merged
            <span>
              {fm.status === 'NOT_YET_SUBMITTED' && <button className="small" onClick={() => act(() => api.epicAction(item.id, 'open'))}>Open epic branch</button>}{' '}
              {fm.status === 'IN_PROGRESS' && <button className="small" onClick={() => act(() => api.epicAction(item.id, 'sync'))}>Sync with {d.base_branch}</button>}{' '}
              {fm.status === 'IN_PROGRESS' && children.length > 0 && children.every((c) => ['MERGED', 'FINISHED'].includes(c.frontmatter.status)) && <button className="small primary" onClick={() => act(() => api.epicAction(item.id, 'submit'))}>Submit epic PR</button>}
            </span></h2>
            <table><tbody>{children.map((c) => <tr key={c.id}><td><Link to={`/items/${c.id}`}>{c.id}</Link></td><td>{c.frontmatter.title}</td><td>{statusLabel(c.frontmatter.status)}</td><td>{c.frontmatter.pr ? `PR #${c.frontmatter.pr}` : ''}</td></tr>)}</tbody></table>
            {!children.length && <p className="muted small">No children yet — create items with this epic as their parent.</p>}
          </div>
        )}
        <div className="section"><h2>Session</h2>
          {session ? <p>{session.busy ? 'running' : 'idle'} · {session.model} · {session.op ?? ''}<br /><span className="small muted">{session.last_output}</span></p> : <p className="muted small">No live session. {fm.session_id ? `Parked session ${fm.session_id.slice(0, 8)}… resumes when needed.` : 'Nothing has run for this item yet.'}</p>}
          {fm.session_id && !session && <p className="small muted">Open in a terminal (pauses planestro's use of it while attached): <code>claude --resume {fm.session_id}</code> <button className="small" onClick={() => void navigator.clipboard.writeText(`claude --resume ${fm.session_id}`)}>copy</button></p>}
          <div className="row"><input className="grow" placeholder="Message to the session (queued for its next turn)" value={msg} onChange={(e) => setMsg(e.target.value)} /><button disabled={!msg.trim()} onClick={() => { void act(() => api.message(item.id, msg)); setMsg(''); }}>Send</button></div>
          <h2 style={{ marginTop: 12 }}>Console</h2>
          <ItemConsole id={item.id} />
        </div>
        <div className="section"><h2>Attachments</h2>
          <ul className="attachments">{fm.attachments.map((a) => <li key={a.path}>{a.kind === 'managed' && /\.(png|jpe?g|gif|webp)$/i.test(a.path) && <img src={`/${a.path}`} alt="" />}<code>{a.path}</code><span className="tag">{a.kind}</span>{a.kind === 'managed' && <a href={`/${a.path}`} target="_blank" rel="noreferrer">open</a>}<button className="small" onClick={() => act(() => api.removeAttachment(item.id, a.path))}>remove</button></li>)}</ul>
          <div className="row"><span className="small muted">Paste an image anywhere on this page to attach it (≤ {Math.round(state.config.attachments.managed_max_bytes / 1e6)} MB, committed).</span></div>
          <div className="row"><input className="grow" placeholder="Reference a path (absolute, or relative to the code repo) — never copied" value={refPath} onChange={(e) => setRefPath(e.target.value)} /><button disabled={!refPath.trim()} onClick={() => { void act(() => api.referenceAttachment(item.id, refPath.trim())); setRefPath(''); }}>Add reference</button></div>
        </div>
        <div className="section"><h2>Activity</h2><ul className="activity">{item.activity.map((a, i) => <li key={i}><span className="at">{a.at.slice(0, 19).replace('T', ' ')}</span><span className="muted">{a.actor}</span><span>{a.text}</span></li>)}</ul></div>
      </div>
      <aside className="sidebar section">
        <dl>
          <dt>id</dt><dd>{item.id} · {fm.kind}{d.external ? ' · external' : ''}</dd>
          <dt>file</dt><dd><code className="small">{item.path}</code></dd>
          <dt>base branch</dt><dd>{d.base_branch ?? <span className="tag hot">{d.base_branch_error}</span>}</dd>
          <dt>branch</dt><dd>{fm.branch ?? '—'}</dd>
          <dt>worktree</dt><dd>{fm.worktree ?? '—'}</dd>
          <dt>PR</dt><dd>{fm.pr ? <a href={`https://github.com/${state.config.code_repo.github}/pull/${fm.pr}`} target="_blank" rel="noreferrer">#{fm.pr}</a> : '—'}</dd>
          <dt>session</dt><dd>{fm.session_id ?? '—'}</dd>
          <dt>CI</dt><dd>{fm.ci_result ?? '—'}{fm.ci_failed_count ? ` (${fm.ci_failed_count} red)` : ''}</dd>
          <dt>cost</dt><dd>{fm.cost_usd !== undefined ? `$${fm.cost_usd.toFixed(2)} · ${fm.turns ?? 0} turns` : '—'}</dd>
          <dt>rank</dt><dd>{fm.rank ?? '—'}</dd>
          {(['created_at', 'updated_at', 'queued_at', 'started_at', 'plan_ready_at', 'plan_approved_at', 'pr_created_at', 'merged_at', 'finished_at', 'iceboxed_at'] as const).map((k) => fm[k] ? <Fragment key={k}><dt>{k.replace('_at', '')}</dt><dd>{fm[k]!.slice(0, 19).replace('T', ' ')}</dd></Fragment> : null)}
        </dl>
        <div className="row" style={{ marginTop: 12 }}><button className="danger small" onClick={() => { if (confirm(`Delete ${item.id}?`)) void act(() => api.deleteItem(item.id)).then(onDeleted); }}>Delete item</button></div>
      </aside>
    </div>
  );
}

import { Fragment } from 'react';

function QuestionForm({ questions, onSubmit }: { questions: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[]; onSubmit: (answers: Record<string, string>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <div>
      {questions.map((q) => (
        <div key={q.question} style={{ marginBottom: 10 }}>
          <div><b>{q.header ? `${q.header}: ` : ''}{q.question}</b></div>
          {q.options.map((o) => <label key={o.label} className="row"><input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.question} onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: q.multiSelect ? [...(a[q.question]?.split(', ').filter(Boolean) ?? []).filter((x) => x !== o.label), ...(e.target.checked ? [o.label] : [])].join(', ') : o.label }))} /> {o.label} <span className="muted small">{o.description}</span></label>)}
          <input placeholder="Or type your own answer" onBlur={(e) => e.target.value && setAnswers((a) => ({ ...a, [q.question]: e.target.value }))} />
        </div>
      ))}
      <button className="primary" disabled={questions.some((q) => !answers[q.question])} onClick={() => onSubmit(answers)}>Send answers</button>
    </div>
  );
}
