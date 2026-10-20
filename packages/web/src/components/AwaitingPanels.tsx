import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { api, type ItemView } from '../api.ts';
import { act } from '../store.ts';
import { decisionOf, auditionPicksProblem, auditionNeed, type Audition, type AuditionPick } from '@planestro/shared/view';
import { TriageNote } from './DecisionCard.tsx';
import { useSending } from '../sending.ts';
import { Sending } from './Sending.tsx';

type Question = { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean };

/**
 * What a parked session is waiting for, answerable where it is seen: the item page and the board's
 * preview both show these, so a permission or a question does not cost a trip to the full page.
 */
export function AwaitingPanels({ item }: { item: ItemView }) {
  const fm = item.frontmatter;
  const data = fm.awaiting_data as { kind?: string; questions?: Question[]; tool?: string; input?: Record<string, unknown>; grantable?: boolean; grant_refusal?: string; handed_back?: boolean; escalated?: string } | undefined;
  const orchestrating = fm.awaiting === 'orchestrator' && data?.kind === 'permission';
  // One answer at a time, shown at once (#282): keyed by the request, so the next one starts unlocked.
  const { sending, send } = useSending(`${item.id}:${String(fm.awaiting_data?.requested_at ?? '')}`);
  const respond = (key: string, payload: Record<string, unknown>) => send(key, () => act(() => api.respond(item.id, payload)));
  // The orchestrator's plain-words card replaces whatever it was made from (a block, the worker's questions).
  if (decisionOf(fm)) return null; // shown by DecisionCard, at the top of the page and the preview
  if (fm.awaiting === 'question' && data?.questions) return (
    <div className="approval" id="question" data-wait>
      {fm.triage && <TriageNote item={item} />}
      <h2 style={{ margin: '0 0 8px' }}>The agent asked</h2>
      <QuestionForm questions={data.questions} sending={sending !== undefined} onSubmit={(answers) => void respond('answers', { kind: 'question', answers })} />
    </div>
  );
  if (fm.awaiting === 'audition' && (fm.awaiting_data as { audition?: Audition } | undefined)?.audition) return <AuditionPanel item={item} audition={(fm.awaiting_data as { audition: Audition }).audition} sending={sending} respond={respond} />;
  if ((fm.awaiting === 'permission' || orchestrating) && data) {
    const nativeCodex = data.tool === 'CodexApproval';
    const cannotGrant = data.grantable === false || (nativeCodex && data.grantable !== true);
    const command = (data.tool === 'Bash' || nativeCodex) && typeof data.input?.command === 'string' ? data.input.command : undefined;
    const why = typeof data.input?.description === 'string' ? data.input.description : nativeCodex && typeof data.input?.reason === 'string' ? data.input.reason : undefined;
    return (
      <div className="approval" id="permission" data-nav="Permission: the orchestrator is deciding" data-wait={orchestrating ? undefined : true}>
        <h2 style={{ margin: '0 0 8px' }}>{orchestrating ? `The orchestrator is deciding a permission: ${data.tool}` : `Permission requested: ${data.tool}`}</h2>
        {orchestrating && <p className="small" style={{ marginTop: 0 }}>You asked it to decide these. It allows ordinary work in the worktree, denies what is wrong for the item, and leaves the rest to you. You can still decide yourself below.</p>}
        {!orchestrating && data.escalated === 'orchestrator_denials' && <p className="small" style={{ marginTop: 0 }}>This comes to you because the orchestrator denied this item's last three requests. Allowing it hands the item's next requests back to the orchestrator.</p>}
        {why && <p className="small" style={{ margin: '0 0 6px' }}>{why}</p>}
        <pre className="events">{!cannotGrant && command ? command : JSON.stringify(data.input, null, 2)}</pre>
        {nativeCodex && !cannotGrant && <p>Allow once resumes the agent and approves this exact command in this working directory once. Other commands still need their own permission.</p>}
        {nativeCodex && typeof data.input?.cwd === 'string' && <p className="small">Working directory: <code>{data.input.cwd}</code></p>}
        {cannotGrant && <p>{data.grant_refusal ?? 'This permission cannot be carried into a new turn. Take over to perform the action yourself, then hand back, or deny it and ask for another approach.'}</p>}
        {item.park_hint && <ParkHint hint={item.park_hint} />}
        <div className="row">
          {!cannotGrant && <button className="primary" disabled={sending !== undefined} aria-busy={sending === 'allow'} onClick={() => void respond('allow', { kind: 'permission', decision: 'allow' })}>{sending === 'allow' ? <Sending /> : 'Allow once'}</button>}
          {!cannotGrant && !nativeCodex && <button title="Adds this exact command to permissions.allow" disabled={sending !== undefined} aria-busy={sending === 'always'} onClick={() => void respond('always', { kind: 'permission', decision: 'always' })}>{sending === 'always' ? <Sending /> : 'Always allow'}</button>}
          <button className="danger" disabled={sending !== undefined} aria-busy={sending === 'deny'} onClick={() => { const reason = prompt('Reason for denying, and what to do instead?'); if (reason !== null) void respond('deny', { kind: 'permission', decision: 'deny', reason }); }}>{sending === 'deny' ? <Sending /> : 'Deny'}</button>
        </div>
      </div>
    );
  }
  return null;
}

const takeUrl = (id: string, path: string, v: string) => `/api/items/${id}/audition?path=${encodeURIComponent(path)}&v=${encodeURIComponent(v)}`;
const takeName = (path: string) => path.split('/').pop() ?? path;

/**
 * A mid-build audition (#207, #318): every take the worker made, playable here (a phone included). Each role keeps up to
 * as many takes as it needs, and short of that asks for the rest again, with an optional note; takes kept in an earlier
 * round are shown locked. The picks resume the worker.
 */
function AuditionPanel({ item, audition, sending, respond }: { item: ItemView; audition: Audition; sending?: string; respond: (key: string, payload: Record<string, unknown>) => Promise<boolean> }) {
  const v = String(item.frontmatter.awaiting_data?.requested_at ?? item.frontmatter.updated_at);
  const [picks, setPicks] = useState<Record<string, AuditionPick>>({});
  const missing = auditionPicksProblem(audition, picks);
  const takes = audition.roles.reduce((n, r) => n + (r.takes?.length ?? 0), 0);
  const kept = audition.roles.some((r) => r.kept?.length);
  const set = (id: string, f: (p: AuditionPick) => AuditionPick) => setPicks((x) => ({ ...x, [id]: f(x[id] ?? { takes: [] }) }));
  return (
    <div className="approval audition" id="audition" data-wait>
      <h2 style={{ margin: '0 0 4px' }}>Audition: {audition.title}</h2>
      <p className="small" style={{ marginTop: 0 }}>The worker made {takes} {kept ? 'new ' : ''}take{takes === 1 ? '' : 's'}. Keep what each role needs; if too few are right, regenerate the rest and say what to change.</p>
      {audition.roles.map((r) => {
        const need = auditionNeed(r); const want = r.pick ?? 1; const p = picks[r.id] ?? { takes: [] };
        const short = need - p.takes.length;
        return (
          <fieldset key={r.id} className="audition-role">
            <legend><b>{r.name}</b> <span className="muted small">{r.id}</span></legend>
            <div className={`audition-count small${short <= 0 ? ' done' : ''}`} aria-live="polite">{need === 0 ? `Filled: ${want} of ${want} kept` : `${(r.kept?.length ?? 0) + p.takes.length} of ${want} picked`}</div>
            {r.where && <div className="small muted">Plays: {r.where}</div>}
            {r.prompt && <div className="small muted">From: {r.prompt}</div>}
            {(r.kept ?? []).map((t) => (
              <div key={t} className="audition-take kept">
                <span className="tag ok" title="Kept in an earlier round">Kept</span>
                <span className="audition-name">{takeName(t)}</span>
                <Take url={takeUrl(item.id, t, v)} path={t} />
              </div>
            ))}
            {need > 0 && (r.takes ?? []).map((t) => {
              const on = p.takes.includes(t);
              return (
                <label key={t} className={`audition-take${on ? ' on' : ''}`}>
                  <input type="checkbox" checked={on} disabled={!on && short <= 0} onChange={() => set(r.id, (q) => ({ ...q, takes: on ? q.takes.filter((x) => x !== t) : [...q.takes, t] }))} />
                  <span className="audition-name">{takeName(t)}</span>
                  <Take url={takeUrl(item.id, t, v)} path={t} />
                </label>
              );
            })}
            {short > 0 && (
              <div className="audition-regen">
                <label><input type="checkbox" checked={p.regenerate !== undefined} onChange={(e) => set(r.id, (q) => (e.target.checked ? { ...q, regenerate: q.regenerate ?? '' } : { takes: q.takes }))} /> Regenerate the rest ({short} more)</label>
                {p.regenerate !== undefined && <input placeholder="Notes for the new takes (optional)" value={p.regenerate} onChange={(e) => set(r.id, (q) => ({ ...q, regenerate: e.target.value }))} />}
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="primary" disabled={!!missing || sending !== undefined} aria-busy={sending === 'picks'} title={missing} onClick={() => void respond('picks', { kind: 'audition', picks })}>{sending === 'picks' ? <Sending /> : 'Send picks'}</button>
        {missing && <span className="small muted">{missing}</span>}
      </div>
    </div>
  );
}

/** One take at a time plays: starting another stops the last. */
let playing: HTMLAudioElement | null = null;

function Take({ url, path }: { url: string; path: string }) {
  if (/\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(path)) return <PlayButton url={url} name={takeName(path)} />;
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(path)) return <a href={url} target="_blank" rel="noreferrer" className="audition-thumb" onClick={(e) => e.stopPropagation()}><img src={url} alt={takeName(path)} className="checker" /></a>;
  return <a href={url} download={takeName(path)} className="small" onClick={(e) => e.stopPropagation()}>Download</a>;
}

function PlayButton({ url, name }: { url: string; name: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => () => { if (playing === ref.current) playing = null; }, []);
  const toggle = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const a = ref.current; if (!a) return;
    if (!a.paused) { a.pause(); return; }
    if (playing && playing !== a) playing.pause();
    playing = a; a.currentTime = 0; void a.play().catch(() => setOn(false));
  };
  return (
    <>
      <button type="button" className="audition-play" aria-label={`${on ? 'Stop' : 'Play'} ${name}`} aria-pressed={on} onClick={toggle}>{on ? '■' : '▶'}</button>
      <audio ref={ref} preload="none" src={url} onPlay={() => setOn(true)} onPause={() => setOn(false)} onEnded={() => setOn(false)} />
    </>
  );
}

function QuestionForm({ questions, onSubmit, sending }: { questions: Question[]; onSubmit: (answers: Record<string, string>) => void; sending: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <div>
      {questions.map((q) => (
        <div key={q.question} style={{ marginBottom: 10 }}>
          <div><b>{q.header ? `${q.header}: ` : ''}{q.question}</b></div>
          {q.options.map((o) => <label key={o.label} className="row"><input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.question} onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: q.multiSelect ? [...(a[q.question]?.split(', ').filter(Boolean) ?? []).filter((x) => x !== o.label), ...(e.target.checked ? [o.label] : [])].join(', ') : o.label }))} /> {o.label} <span className="muted small">{o.description}</span></label>)}
          <input className="grow" style={{ width: '100%' }} placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'} onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: e.target.value }))} />
        </div>
      ))}
      <button className="primary" disabled={sending || questions.some((q) => !answers[q.question])} aria-busy={sending} onClick={() => onSubmit(answers)}>{sending ? <Sending /> : 'Send answers'}</button>
    </div>
  );
}

/** The second park on one kind of command (#108): each costs a resume, and one worktree-scoped rule would have spared them. */
function ParkHint({ hint }: { hint: { shape: string; parks: number; rule: string } }) {
  return (
    <div className="small" style={{ margin: '6px 0 10px' }}>
      <p style={{ margin: '0 0 6px' }}>This item has waited on <code>{hint.shape} …</code> {hint.parks} times, and each wait costs a resume. <code>{hint.rule}</code> lets such commands run without asking, as long as they stay inside the worktree.</p>
      <button className="small" title="Adds the rule to permissions.allow for this project (Settings → Workers & permissions). This request still needs your answer below." onClick={() => void act(async () => { const s = (await api.state()).config.permissions.allow; if (!s.includes(hint.rule)) await api.putConfig({ permissions: { allow: [...s, hint.rule] } }); })}>Allow from now on</button>
    </div>
  );
}
