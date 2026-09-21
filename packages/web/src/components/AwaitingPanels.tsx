import { useState } from 'react';
import { api, type ItemView } from '../api.ts';
import { act } from '../store.ts';

type Question = { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean };

/**
 * What a parked session is waiting for, answerable where it is seen: the item page and the board's
 * preview both show these, so a permission or a question does not cost a trip to the full page.
 */
export function AwaitingPanels({ item }: { item: ItemView }) {
  const fm = item.frontmatter;
  const data = fm.awaiting_data as { kind?: string; questions?: Question[]; tool?: string; input?: Record<string, unknown>; handed_back?: boolean } | undefined;
  const orchestrating = fm.awaiting === 'orchestrator' && data?.kind === 'permission';
  if (fm.awaiting === 'question' && data?.questions) return (
    <div className="approval">
      <h2 style={{ margin: '0 0 8px' }}>The agent asked</h2>
      <QuestionForm questions={data.questions} onSubmit={(answers) => act(() => api.respond(item.id, { kind: 'question', answers }))} />
    </div>
  );
  if ((fm.awaiting === 'permission' || orchestrating) && data) {
    const command = data.tool === 'Bash' && typeof data.input?.command === 'string' ? data.input.command : undefined;
    const why = typeof data.input?.description === 'string' ? data.input.description : undefined;
    return (
      <div className="approval">
        <h2 style={{ margin: '0 0 8px' }}>{orchestrating ? `The orchestrator is deciding a permission: ${data.tool}` : `Permission requested: ${data.tool}`}</h2>
        {orchestrating && <p className="small" style={{ marginTop: 0 }}>You asked it to decide these. It allows ordinary work in the worktree, denies what is wrong for the item, and leaves the rest to you. You can still decide yourself below.</p>}
        {why && <p className="small" style={{ margin: '0 0 6px' }}>{why}</p>}
        <pre className="events">{command ?? JSON.stringify(data.input, null, 2)}</pre>
        <div className="row">
          <button className="primary" onClick={() => act(() => api.respond(item.id, { kind: 'permission', decision: 'allow' }))}>Allow once</button>
          <button title="Adds this exact command to permissions.allow" onClick={() => act(() => api.respond(item.id, { kind: 'permission', decision: 'always' }))}>Always allow</button>
          <button className="danger" onClick={() => { const reason = prompt('Reason for denying?'); if (reason !== null) void act(() => api.respond(item.id, { kind: 'permission', decision: 'deny', reason })); }}>Deny</button>
        </div>
      </div>
    );
  }
  return null;
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
