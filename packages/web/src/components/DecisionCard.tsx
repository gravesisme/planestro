import { UsageProviderSwitch } from './UsageProviderSwitch.tsx';
import { useState } from 'react';
import { decisionOf, describeAction, DOLLAR_HINT } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { reloadText, useResumeEstimate } from '../resumeCost.ts';
import { useSending } from '../sending.ts';
import { Sending } from './Sending.tsx';

/**
 * The orchestrator's question for you, when a stopped item needs a call that is yours: the
 * question in plain words, why it is asked, its options with the recommended one first, and a
 * box for an answer of your own. The raw block reason stays under "details" — the card is the
 * whole story on a phone. An option that does something says what, in planestro's words rather
 * than the orchestrator's: it wrote the label, and the tap is yours (#73).
 */
export function DecisionCard({ item }: { item: ItemView }) {
  const fm = item.frontmatter;
  const decision = decisionOf(fm);
  const projectBudget = useStore((s) => s.state?.config.budget_usd_per_item);
  const projectTurns = useStore((s) => s.state?.config.budget_turns_per_item);
  const projectTokens = useStore((s) => s.state?.config.budget_tokens_per_item);
  const items = useStore((s) => s.state?.items);
  const [text, setText] = useState('');
  // One answer at a time, shown at once (#282); the card stays locked until it goes.
  const { sending, send: once } = useSending(`${item.id}:${decision?.requested_at ?? ''}`);
  const estimate = useResumeEstimate(item);
  if (!decision) return null;
  const send = (key: string, body: { choice?: string; text?: string }) => once(key, () => act(() => api.decide(item.id, body)));
  const lookup = (id: string) => { const it = items?.find((i) => i.id === id)?.frontmatter; return it && { title: it.title, kind: it.kind }; };
  const reason = fm.blocked_reason ?? decision.reason;
  const said = reason ? [...item.activity].reverse().find((a) => a.text.startsWith(`BLOCKED (${reason}): `))?.text.replace(/^BLOCKED \([a-z_]+\): /, '') : undefined;
  const questions = (fm.awaiting_data?.questions as { question: string }[] | undefined) ?? [];
  return (
    <div className="decision-card" id="decision" data-wait>
      <div className="decision-kicker">Your decision · {item.id}</div>
      <h2 className="decision-question">{decision.question}</h2>
      <p className="decision-why">{decision.why}</p>
      <UsageProviderSwitch item={item} />
      <div className="decision-options">
        {decision.options.map((o, i) => (
          <button key={o.label} className={`decision-option ${o.recommended ? 'recommended' : ''} ${sending === `option-${i}` ? 'chosen' : ''}`} disabled={sending !== undefined} aria-busy={sending === `option-${i}`} onClick={() => void send(`option-${i}`, { choice: o.label, ...(text.trim() ? { text: text.trim() } : {}) })}>
            <span className="decision-label">{o.label}{o.recommended && <span className="decision-badge">Recommended</span>}{sending === `option-${i}` && <Sending />}</span>
            {o.description && <span className="decision-desc">{o.description}</span>}
            {o.raise_budget_usd !== undefined && <span className="decision-desc">Tapping this sets the item's budget to ${(Math.max(fm.budget_usd ?? projectBudget ?? 0, fm.cost_usd ?? 0) + o.raise_budget_usd).toFixed(0)} (+${o.raise_budget_usd}) and {o.fresh ? 'finishes it in a fresh session' : 'resumes it'}. <span className="muted">Dollars here: {DOLLAR_HINT}.</span></span>}
            {o.raise_budget_turns !== undefined && <span className="decision-desc">Adds {o.raise_budget_turns} turns, setting this item's limit to {Math.max(fm.budget_turns ?? projectTurns ?? 0, fm.agent_turns ?? 0) + o.raise_budget_turns} turns.</span>}
            {o.raise_budget_tokens !== undefined && <span className="decision-desc">Adds {o.raise_budget_tokens.toLocaleString()} tokens, setting this item's limit to {(Math.max(fm.budget_tokens ?? projectTokens ?? 0, fm.tokens ?? 0) + o.raise_budget_tokens).toLocaleString()} tokens.</span>}
            {o.set_mcp_budget !== undefined && <span className="decision-desc">Tapping this sets this item's MCP budget to {o.set_mcp_budget} call{o.set_mcp_budget === 1 ? '' : 's'}{fm.mcp_budget !== undefined ? ` (now ${fm.mcp_budget})` : ''} per MCP server. Each call there can cost money.</span>}
            {o.fresh ? <span className="decision-desc">A fresh session gets a brief instead of the old conversation, so nothing is spent reloading it.</span>
              : o.raise_budget_usd !== undefined && estimate && <span className="decision-desc">Resuming costs {reloadText(estimate)}, before any work; this raise covers it.</span>}
            {o.action && <span className="decision-desc decision-does">Tapping this {describeAction(o.action, lookup)}. planestro does it as you, at once.</span>}
          </button>
        ))}
      </div>
      {decision.options.filter((o) => o.action?.tool === 'create_item').map((o) => o.action?.tool === 'create_item' && (
        <details key={o.label} className="decision-details">
          <summary>what "{o.label}" creates</summary>
          <p className="small"><b>{o.action.args.title}</b>{o.action.args.category ? ` · ${o.action.args.category}` : ''}{o.action.args.planner ? ` · planned by ${o.action.args.planner}` : ''}</p>
          <p className="small decision-brief">{o.action.args.description}</p>
        </details>
      ))}
      {decision.allow_free_text && (
        <div className="decision-free">
          <textarea disabled={sending !== undefined} data-dirty={text.trim() ? 'true' : undefined} placeholder="Or answer in your own words (sent with an option, or on its own)" value={text} onChange={(e) => setText(e.target.value)} />
          <button disabled={sending !== undefined || !text.trim()} aria-busy={sending === ':text'} onClick={() => void send(':text', { text: text.trim() })}>{sending === ':text' ? <Sending /> : 'Send'}</button>
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
