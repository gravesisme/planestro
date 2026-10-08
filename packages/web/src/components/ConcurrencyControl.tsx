import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { limitsLabel, raiseNeedsConfirm, localClock, type ConcurrencyChange } from '@planestro/shared';
import { api, type ConcurrencyView, type SlotsView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { ActionButton, ActionGroup } from './ActionButton.tsx';

/**
 * Raise or lower agents from the status popover (#330): steppers for max_sessions and each runner limit, applied
 * live through the Settings path, with this machine's load, its CI runner and recent timeout-killed checks beside,
 * a confirm above the recommended max, and one click back to the values before the last change.
 */
export function ConcurrencyControl({ slots, open }: { slots?: SlotsView; open: boolean }) {
  const [view, setView] = useState<ConcurrencyView>();
  const [sessions, setSessions] = useState<number>();
  const [runners, setRunners] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const maxNow = useStore((s) => s.state?.config.concurrency.max_sessions);
  const load = useCallback(() => { api.concurrency().then((v) => { setView(v); setSessions(v.limits.max_sessions); setRunners(v.limits.runner_limits); }).catch(() => undefined); }, []);
  // Read when the popover opens, and again when the limits change (here, in Settings or by the engine).
  useEffect(() => { if (open) load(); }, [open, load, maxNow]);
  if (!view || sessions === undefined) return <div className="concurrency"><div className="concurrency-head"><span>Agents</span><span>{slots ? `${slots.running} of ${slots.max}` : '…'}</span></div></div>;

  const { limits, advice } = view;
  const changedRunners = Object.keys(runners).filter((k) => runners[k] !== limits.runner_limits[k]);
  const dirty = sessions !== limits.max_sessions || changedRunners.length > 0;
  const confirmRaise = raiseNeedsConfirm(limits.max_sessions, sessions, advice);
  const apply = async () => {
    if (confirmRaise && !confirm(`${sessions} sessions is above the recommended ${advice.recommended_max}${advice.reasons.length ? `:\n\n${advice.reasons.join('\n')}` : ''}\n\nApply it anyway?`)) return;
    const v = await act(() => api.putConcurrency({ ...(sessions !== limits.max_sessions ? { max_sessions: sessions } : {}), ...(changedRunners.length ? { runner_limits: Object.fromEntries(changedRunners.map((k) => [k, runners[k]])) } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}), ...(confirmRaise ? { confirm: true } : {}) }));
    if (v) { setView(v); setSessions(v.limits.max_sessions); setRunners(v.limits.runner_limits); setReason(''); }
  };
  const back = view.rollback;
  const rollBack = async () => {
    if (!back) return;
    const raise = raiseNeedsConfirm(limits.max_sessions, back.max_sessions, advice);
    if (raise && !confirm(`Rolling back raises sessions to ${back.max_sessions}, above the recommended ${advice.recommended_max}. Roll back anyway?`)) return;
    const v = await act(() => api.rollbackConcurrency({ ...(reason.trim() ? { reason: reason.trim() } : {}), ...(raise ? { confirm: true } : {}) }));
    if (v) { setView(v); setSessions(v.limits.max_sessions); setRunners(v.limits.runner_limits); setReason(''); }
  };
  const host = view.host;
  const runnerState = view.ci_runner.state === 'unknown' ? 'unknown' : view.ci_runner.state === 'busy' ? `busy (${view.ci_runner.labels.join(', ')})` : `idle (${view.ci_runner.labels.join(', ')})`;
  const waiting = slots?.waiting ?? view.slots.waiting;

  return (
    <div className="concurrency">
      <div className="concurrency-head"><span>Agents</span><span><strong>{slots?.running ?? view.slots.running} of {limits.max_sessions}</strong>{waiting > 0 && <span className="muted"> · {waiting} waiting for a slot</span>}</span></div>
      <ActionGroup>
        <Stepper label="Sessions at once" value={sessions} onChange={setSessions} hint={sessions > advice.recommended_max ? `above the recommended ${advice.recommended_max}` : `recommended up to ${advice.recommended_max}`} warn={sessions > advice.recommended_max} />
        {Object.keys(runners).map((r) => <Stepper key={r} label={`${r} turns at once`} value={runners[r]} onChange={(n) => setRunners({ ...runners, [r]: n })} hint={`${view.slots.runners[r]?.running ?? 0} running${view.slots.runners[r]?.waiting ? ` · ${view.slots.runners[r].waiting} waiting` : ''}`} />)}
        <p className="small muted concurrency-note">Runner limits share the session slots: they change the mix, never the number of agents. Local jobs at once: {limits.max_local_jobs} (<Link to="/settings">Settings</Link>).</p>
        {dirty && <div className="concurrency-apply">
          <input aria-label="Why (optional)" placeholder="Why (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <ActionButton className={confirmRaise ? 'danger' : 'primary'} working="Applying…" onAct={apply}>{confirmRaise ? 'Apply anyway…' : 'Apply'}</ActionButton>
          <button type="button" onClick={() => { setSessions(limits.max_sessions); setRunners(limits.runner_limits); }}>Reset</button>
        </div>}
        <dl className="concurrency-signals">
          <dt>Load 1 / 5 / 15 min</dt><dd>{host ? `${host.load.map((n) => n.toFixed(1)).join(' / ')} on ${host.cpus} cores` : 'unknown'}</dd>
          <dt>CI runner on this machine</dt><dd title={view.ci_runner.detail.join('\n')}>{runnerState}</dd>
          <dt>Timeout-killed checks</dt><dd>{advice.seen ? `${advice.kills} of the last ${advice.seen} CI results` : 'no CI results seen yet'}</dd>
        </dl>
        {advice.reasons.length > 0 && <ul className={`concurrency-reasons ${advice.healthy ? 'muted' : 'warn'}`}>{advice.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        {view.ci_runner.state === 'unknown' && <p className="small muted">{view.ci_runner.detail[0]}</p>}
        {view.last_change && <div className="concurrency-last">
          <p className="small">{changeLine(view.last_change)}</p>
          {back && limitsLabel(back) !== limitsLabel(limits) && <ActionButton working="Rolling back…" onAct={rollBack}>Roll back to {limitsLabel(back)}</ActionButton>}
        </div>}
      </ActionGroup>
    </div>
  );
}

function Stepper({ label, value, onChange, hint, warn }: { label: string; value: number; onChange: (n: number) => void; hint?: string; warn?: boolean }) {
  return (
    <div className="stepper-row">
      <span className="stepper-label">{label}{hint && <span className={`small ${warn ? 'warn-text' : 'muted'}`}>{hint}</span>}</span>
      <span className="stepper">
        <button type="button" aria-label={`Fewer: ${label}`} disabled={value <= 1} onClick={() => onChange(value - 1)}>−</button>
        <output aria-live="polite">{value}</output>
        <button type="button" aria-label={`More: ${label}`} onClick={() => onChange(value + 1)}>+</button>
      </span>
    </div>
  );
}

/** "You, 4:12 pm: 2 / codex 1 → 3 / codex 2 · 29 items queued". */
function changeLine(c: ConcurrencyChange): string {
  const who = c.auto ? 'Stepped down by planestro' : c.rollback ? `Rolled back by ${c.by === 'user' ? 'you' : c.by}` : c.by === 'user' ? 'You' : c.by;
  return `${who}, ${localClock(c.at)}: ${limitsLabel(c.from)} → ${limitsLabel(c.to)}${c.reason ? ` · ${c.reason}` : ''}`;
}
