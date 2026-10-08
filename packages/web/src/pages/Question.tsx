import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, type QuestionView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { Markdown } from '../components/Markdown.tsx';
import { setTitle } from '../tabBadge.ts';
import { useAction } from '../sending.ts';
import { Sending } from '../components/Sending.tsx';
import { ago } from './Console.tsx';

const WHO = { user: 'You', orchestrator: 'Orchestrator', app: 'planestro' } as const;

/**
 * One orchestrator question (#75): what it is in plain terms, then the details for whoever wants
 * them, then what it would do, then the discussion. The thread is the question file's, so it is
 * still there days later; a message wakes the orchestrator with the whole file.
 */
export function QuestionPage() {
  const { id = '' } = useParams();
  const rev = useStore((s) => s.questionRev[id] ?? 0);
  const paused = useStore((s) => s.state?.engine.paused ?? false);
  const orchestrated = useStore((s) => s.chat.enabled !== false);
  const [q, setQ] = useState<QuestionView | null | undefined>();
  // Re-read after our own change rather than trusting its response: `act` resolves only after the state refresh, by which time the wake it started may already have answered, and an older view would hide that.
  const [mine, setMine] = useState(0);
  const [msg, setMsg] = useState('');
  // One action at a time, shown at once (#304): a post, a review, a close or a reopen.
  const { busy, run } = useAction();
  const sending = busy !== undefined;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { let live = true; api.question(id).then((v) => live && setQ(v)).catch(() => live && setQ(null)); return () => { live = false; }; }, [id, rev, mine]);
  useEffect(() => { if (q) setTitle(`${q.id} · ${q.frontmatter.headline}`); return () => setTitle('planestro'); }, [q?.id, q?.frontmatter.headline]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [q?.thread?.length, q?.pending]);
  if (q === undefined) return <p className="muted">Loading…</p>;
  if (q === null) return <p>Unknown question {id}. <Link to="/console">Back to the Console</Link></p>;

  const fm = q.frontmatter;
  const open = fm.status === 'open';
  const send = (key: string, text: string) => { const body = text.trim(); if (body) void run(key, async () => { const r = await act(() => api.postToQuestion(q.id, body)); if (r) { setMine((n) => n + 1); setMsg(''); } return r; }); };
  const update = (key: string, fn: () => Promise<QuestionView>) => void run(key, async () => { const r = await act(fn); if (r) setMine((n) => n + 1); return r; });
  const label = (key: string, idle: string, working: string) => busy === key ? <Sending label={working} /> : idle;

  return (
    <div className="question-page">
      <p className="small muted"><Link to="/console">← Console</Link></p>
      <div className="section">
        <div className="q-kicker small">
          <span className={`tag ${open ? 'wait' : 'ok'}`}>{open ? 'open' : fm.status}</span>
          <span className="muted">{q.id} · asked {ago(fm.asked_at)}</span>
          {fm.item && <span>about <Link to={`/items/${fm.item}`}>{fm.item}</Link>{q.item_title ? <span className="muted"> — {q.item_title}{q.item_status ? ` (${q.item_status.toLowerCase().replace(/_/g, ' ')})` : ''}</span> : null}</span>}
        </div>
        <h1 className="q-title">{fm.headline}</h1>
        {!open && fm.resolution && <p className="q-resolution small">{fm.status === 'withdrawn' ? 'Withdrawn' : 'Resolved'} {fm.resolved_at ? ago(fm.resolved_at) : ''}: {fm.resolution}</p>}
        <h3 className="drawer-h">In plain terms</h3>
        <div className="q-summary"><Markdown text={q.summary} /></div>
        {q.details?.trim() && <details className="q-details"><summary>Details</summary><Markdown text={q.details} /></details>}
        {q.recommendation.trim() && <div className="q-recommendation">
          <div className="decision-kicker">Recommendation</div>
          <Markdown text={q.recommendation} />
          {open && orchestrated && <button className="primary" disabled={sending || q.pending} aria-busy={busy === 'accept' || undefined} title="Tells the orchestrator in the thread below that you accept it; it carries it out and closes the question"
            onClick={() => send('accept', `I accept your recommendation:\n\n${q.recommendation.trim()}`)}>{label('accept', 'Accept recommendation', 'Sending…')}</button>}
        </div>}
        <div className="row q-controls">
          {open && orchestrated && <button disabled={q.pending || sending} aria-busy={busy === 'review' || undefined} title="Have the orchestrator check it against the current state: it withdraws a moot question or refreshes one that moved on" onClick={() => update('review', () => api.reviewQuestion(q.id))}>{label('review', 'Still relevant?', 'Asking…')}</button>}
          {open ? <button disabled={sending} aria-busy={busy === 'resolve' || undefined} title="Close it yourself: it leaves your list, and its discussion stays here" onClick={() => { const why = prompt('How was it answered? (optional)'); if (why !== null) update('resolve', () => api.resolveQuestion(q.id, 'resolved', why)); }}>{label('resolve', 'Mark answered', 'Closing…')}</button>
            : <button disabled={sending} aria-busy={busy === 'reopen' || undefined} onClick={() => update('reopen', () => api.reopenQuestion(q.id))}>{label('reopen', 'Reopen', 'Reopening…')}</button>}
        </div>
      </div>

      <div className="section">
        <h2>Discussion</h2>
        {!q.thread?.length && <p className="muted small">Nothing yet. Answer it, ask what it means, or push back: the orchestrator reads the whole question and replies here.</p>}
        <div className="q-thread">
          {(q.thread ?? []).map((m, i) => m.actor === 'app'
            ? <div key={`${m.at}-${i}`} className="q-note small muted">{m.text} · {ago(m.at)}</div>
            : <div key={`${m.at}-${i}`} className={`chat-msg ${m.actor === 'user' ? 'user_message' : 'reply'}`}>
                <span className="small chat-label">{WHO[m.actor]}</span>
                <div className="q-text"><Markdown text={m.text} /></div>
                <span className="chat-at">{m.at.slice(5, 16).replace('T', ' ')}</span>
              </div>)}
          {q.pending && <div className="chat-msg reply pending" aria-live="polite"><span className="muted small">{paused ? 'Automation is paused: the orchestrator answers when you resume.' : 'The orchestrator is looking at it…'}</span></div>}
          <div ref={end} />
        </div>
        {orchestrated
          ? <form className="q-input" onSubmit={(e) => { e.preventDefault(); send('post', msg); }}>
              <textarea rows={3} value={msg} data-dirty={msg.trim() ? 'true' : undefined} placeholder={open ? 'Your answer or question… (Enter to send, Shift+Enter for a new line)' : 'Write here to take it up again (it stays closed unless you reopen it)'}
                onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send('post', msg); } }} />
              <button className="primary" type="submit" disabled={!msg.trim() || sending} aria-busy={busy === 'post' || undefined}>{label('post', 'Send', 'Sending…')}</button>
            </form>
          : <p className="muted small">The orchestrator is not available with this engine, so nobody would answer here.</p>}
      </div>
    </div>
  );
}
