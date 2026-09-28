import { useState } from 'react';
import { decisionOf, dollarHint } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';

/**
 * The orchestrator's question for you, when a stopped item needs a call that is yours: the
 * question in plain words, why it is asked, its options with the recommended one first, and a
 * box for an answer of your own. The raw block reason stays under "details" — the card is the
 * whole story on a phone.
 */
export function DecisionCard({ item }: { item: ItemView }) {
  const fm = item.frontmatter;
  const decision = decisionOf(fm);
  const projectBudget = useStore((s) => s.state?.config.budget_usd_per_item);
  const billing = useStore((s) => s.state?.billing);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  if (!decision) return null;
  const send = async (body: { choice?: string; text?: string }) => {
    setSending(true);
    const ok = await act(() => api.decide(item.id, body));
    setSending(false);
    if (ok) setText('');
  };
  const reason = fm.blocked_reason ?? decision.reason;
  const said = reason ? [...item.activity].reverse().find((a) => a.text.startsWith(`BLOCKED (${reason}): `))?.text.replace(/^BLOCKED \([a-z_]+\): /, '') : undefined;
  const questions = (fm.awaiting_data?.questions as { question: string }[] | undefined) ?? [];
  return (
    <div className="decision-card">
      <div className="decision-kicker">Your decision · {item.id}</div>
      <h2 className="decision-question">{decision.question}</h2>
      <p className="decision-why">{decision.why}</p>
      <div className="decision-options">
        {decision.options.map((o) => (
          <button key={o.label} className={`decision-option ${o.recommended ? 'recommended' : ''}`} disabled={sending} onClick={() => void send({ choice: o.label, ...(text.trim() ? { text: text.trim() } : {}) })}>
            <span className="decision-label">{o.label}{o.recommended && <span className="decision-badge">Recommended</span>}</span>
            {o.description && <span className="decision-desc">{o.description}</span>}
            {o.raise_budget_usd !== undefined && <span className="decision-desc">Tapping this sets the item's budget to ${(Math.max(fm.budget_usd ?? projectBudget ?? 0, fm.cost_usd ?? 0) + o.raise_budget_usd).toFixed(0)} (+${o.raise_budget_usd}) and resumes it. <span className="muted">Dollars here: {dollarHint(billing)}.</span></span>}
          </button>
        ))}
      </div>
      {decision.allow_free_text && (
        <div className="decision-free">
          <textarea data-dirty={text.trim() ? 'true' : undefined} placeholder="Or answer in your own words (sent with an option, or on its own)" value={text} onChange={(e) => setText(e.target.value)} />
          <button disabled={sending || !text.trim()} onClick={() => void send({ text: text.trim() })}>Send</button>
        </div>
      )}
      <details className="decision-details">
        <summary>details</summary>
        <p className="small"><b>{fm.blocked ? `Blocked: ${reason}` : reason === 'question' ? 'The worker asked' : `Waiting: ${fm.awaiting}`}</b> · asked {decision.requested_at.slice(0, 16).replace('T', ' ')}</p>
        {said && <p className="small blocked-said">{said}</p>}
        {questions.map((q) => <p key={q.question} className="small">Q: {q.question}</p>)}
      </details>
    </div>
  );
}

/** A small note on a stop the orchestrator is still looking at, in place of the full block panel. */
export function TriageNote({ item }: { item: ItemView }) {
  const t = item.frontmatter.triage;
  if (!t) return null;
  const answering = t.reason === 'decision';
  return (
    <div className="triage-note">
      <b>{answering ? 'The orchestrator is carrying out your decision' : 'The orchestrator is triaging this'}</b>
      <span className="small muted"> since {t.started_at.slice(11, 16)}</span>
      <p className="small" style={{ margin: '4px 0 0' }}>{answering ? 'It acts on your answer with its tools; if it cannot, the item comes back to you.' : `It stopped (${t.reason.replace(/_/g, ' ')}). The orchestrator fixes it if it can, or brings you one plain question. You can still step in below.`}</p>
    </div>
  );
}
