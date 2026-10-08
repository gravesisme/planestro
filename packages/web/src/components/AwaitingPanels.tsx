import { useState } from 'react';
import { api, type ItemView } from '../api.ts';
import { act } from '../store.ts';
import { decisionOf, auditionPicksProblem, type Audition, type AuditionPick } from '@planestro/shared';
import { TriageNote } from './DecisionCard.tsx';

type Question = { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean };

/**
 * What a parked session is waiting for, answerable where it is seen: the item page and the board's
 * preview both show these, so a permission or a question does not cost a trip to the full page.
 */
export function AwaitingPanels({ item }: { item: ItemView }) {
  const fm = item.frontmatter;
  const data = fm.awaiting_data as { kind?: string; questions?: Question[]; tool?: string; input?: Record<string, unknown>; grantable?: boolean; handed_back?: boolean; escalated?: string } | undefined;
  const orchestrating = fm.awaiting === 'orchestrator' && data?.kind === 'permission';
  // The orchestrator's plain-words card replaces whatever it was made from (a block, the worker's questions).
  if (decisionOf(fm)) return null; // shown by DecisionCard, at the top of the page and the preview
  if (fm.awaiting === 'question' && data?.questions) return (
    <div className="approval">
      {fm.triage && <TriageNote item={item} />}
      <h2 style={{ margin: '0 0 8px' }}>The agent asked</h2>
      <QuestionForm questions={data.questions} onSubmit={(answers) => act(() => api.respond(item.id, { kind: 'question', answers }))} />
    </div>
  );
  if (fm.awaiting === 'audition' && (fm.awaiting_data as { audition?: Audition } | undefined)?.audition) return <AuditionPanel item={item} audition={(fm.awaiting_data as { audition: Audition }).audition} />;
  if ((fm.awaiting === 'permission' || orchestrating) && data) {
    const nativeCodex = data.tool === 'CodexApproval';
    const cannotGrant = data.grantable === false || (nativeCodex && data.grantable !== true);
    const command = (data.tool === 'Bash' || nativeCodex) && typeof data.input?.command === 'string' ? data.input.command : undefined;
    const why = typeof data.input?.description === 'string' ? data.input.description : nativeCodex && typeof data.input?.reason === 'string' ? data.input.reason : undefined;
    return (
      <div className="approval">
        <h2 style={{ margin: '0 0 8px' }}>{orchestrating ? `The orchestrator is deciding a permission: ${data.tool}` : `Permission requested: ${data.tool}`}</h2>
        {orchestrating && <p className="small" style={{ marginTop: 0 }}>You asked it to decide these. It allows ordinary work in the worktree, denies what is wrong for the item, and leaves the rest to you. You can still decide yourself below.</p>}
        {!orchestrating && data.escalated === 'orchestrator_denials' && <p className="small" style={{ marginTop: 0 }}>This comes to you because the orchestrator denied this item's last three requests. Allowing it hands the item's next requests back to the orchestrator.</p>}
        {why && <p className="small" style={{ margin: '0 0 6px' }}>{why}</p>}
        <pre className="events">{!cannotGrant && command ? command : JSON.stringify(data.input, null, 2)}</pre>
        {nativeCodex && !cannotGrant && <p>Allow once resumes the agent and approves this exact command in this working directory once. Other commands still need their own permission.</p>}
        {nativeCodex && typeof data.input?.cwd === 'string' && <p className="small">Working directory: <code>{data.input.cwd}</code></p>}
        {cannotGrant && <p>This permission cannot be carried into a new turn. Take over to perform the action yourself, then hand back, or deny it and ask for another approach.</p>}
        {item.park_hint && <ParkHint hint={item.park_hint} />}
        <div className="row">
          {!cannotGrant && <button className="primary" onClick={() => act(() => api.respond(item.id, { kind: 'permission', decision: 'allow' }))}>Allow once</button>}
          {!cannotGrant && !nativeCodex && <button title="Adds this exact command to permissions.allow" onClick={() => act(() => api.respond(item.id, { kind: 'permission', decision: 'always' }))}>Always allow</button>}
          <button className="danger" onClick={() => { const reason = prompt('Reason for denying?'); if (reason !== null) void act(() => api.respond(item.id, { kind: 'permission', decision: 'deny', reason })); }}>Deny</button>
        </div>
      </div>
    );
  }
  return null;
}

const takeUrl = (id: string, path: string, v: string) => `/api/items/${id}/audition?path=${encodeURIComponent(path)}&v=${encodeURIComponent(v)}`;
const takeName = (path: string) => path.split('/').pop() ?? path;

/**
 * A mid-build audition (#207): every take the worker made, playable here (a phone included), one pick per role or,
 * when the worker offered it, none of them with what to change. The picks resume the worker.
 */
function AuditionPanel({ item, audition }: { item: ItemView; audition: Audition }) {
  const v = String(item.frontmatter.awaiting_data?.requested_at ?? item.frontmatter.updated_at);
  const [picks, setPicks] = useState<Record<string, AuditionPick>>({});
  const missing = auditionPicksProblem(audition, picks);
  const takes = audition.roles.reduce((n, r) => n + r.takes.length, 0);
  return (
    <div className="approval audition" id="audition">
      <h2 style={{ margin: '0 0 4px' }}>Audition: {audition.title}</h2>
      <p className="small" style={{ marginTop: 0 }}>The worker made {takes} take{takes === 1 ? '' : 's'} and waits for your pick{audition.roles.length === 1 ? '' : ' for each role'} before it builds on {audition.roles.length === 1 ? 'one' : 'them'}.</p>
      {audition.roles.map((r) => {
        const p = picks[r.id];
        return (
          <fieldset key={r.id} className="audition-role">
            <legend><b>{r.name}</b> <span className="muted small">{r.id}</span></legend>
            {r.where && <div className="small muted">Plays: {r.where}</div>}
            {r.prompt && <div className="small muted">From: {r.prompt}</div>}
            {r.takes.map((t) => (
              <label key={t} className="audition-take">
                <span className="audition-pick"><input type="radio" name={`audition-${r.id}`} checked={!!p && 'take' in p && p.take === t} onChange={() => setPicks((x) => ({ ...x, [r.id]: { take: t } }))} /> {takeName(t)}</span>
                <Take url={takeUrl(item.id, t, v)} path={t} />
              </label>
            ))}
            {audition.allow_regenerate && (
              <label className="audition-take">
                <span className="audition-pick"><input type="radio" name={`audition-${r.id}`} checked={!!p && 'regenerate' in p} onChange={() => setPicks((x) => ({ ...x, [r.id]: { regenerate: '' } }))} /> None of these: regenerate</span>
                {p && 'regenerate' in p && <input style={{ width: '100%' }} placeholder="What should change?" value={p.regenerate} onChange={(e) => setPicks((x) => ({ ...x, [r.id]: { regenerate: e.target.value } }))} />}
              </label>
            )}
          </fieldset>
        );
      })}
      <div className="row">
        <button className="primary" disabled={!!missing} title={missing} onClick={() => act(() => api.respond(item.id, { kind: 'audition', picks }))}>Send picks</button>
      </div>
    </div>
  );
}

function Take({ url, path }: { url: string; path: string }) {
  if (/\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(path)) return <audio controls preload="none" src={url} style={{ width: '100%' }} />;
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(path)) return <img src={url} alt={takeName(path)} className="checker" style={{ maxWidth: '100%', maxHeight: 240 }} />;
  return <a href={url} download={takeName(path)} className="small">Download {takeName(path)}</a>;
}

function QuestionForm({ questions, onSubmit }: { questions: Question[]; onSubmit: (answers: Record<string, string>) => void }) {
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
      <button className="primary" disabled={questions.some((q) => !answers[q.question])} onClick={() => onSubmit(answers)}>Send answers</button>
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
