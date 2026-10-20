import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { USAGE_STAGES, type EfficiencyRanking, type ItemEfficiency, type TestWaste, type UsageStage } from '@planestro/shared/view';
import { api } from '../api.ts';
import { formatValue } from '../usageChart.ts';

// ---- efficiency per item (#346): what an item cost, by stage, read from the journal's per-turn records ----

export const STAGE_LABELS: Record<UsageStage, string> = { planning: 'Planning', implementation: 'Implementation', fix: 'Fixes (CI, review)', conflict: 'Conflicts', orchestrator: 'Orchestrator' };
const money = (n: number) => formatValue(n, 'usd');
const toks = (n: number) => formatValue(n, 'tokens');
const pct = (r: number) => `${Math.round(r * 100)}%`;
const spend = (c: { usd: number; tokens: number }) => [c.usd > 0 ? money(c.usd) : '', c.tokens > 0 ? `${toks(c.tokens)} tokens` : ''].filter(Boolean).join(' · ') || '–';
/** `4 runs, 12 min` */
const runs = (n: number, ms: number) => `${n} run${n === 1 ? '' : 's'}${ms >= 60_000 ? `, ${waited(ms)}` : ms > 0 ? `, ${Math.round(ms / 1000)} s` : ''}`;
/** What the wasted test runs were (#347), in words. */
export function wasteText(w: TestWaste): string {
  const parts = [w.whole_suite.runs ? `${runs(w.whole_suite.runs, w.whole_suite.ms)} of the whole suite` : '', w.repeats.runs ? `${runs(w.repeats.runs, w.repeats.ms)} repeated on code unchanged since a green run` : '', w.load_repeats.runs ? `${runs(w.load_repeats.runs, w.load_repeats.ms)} of a load pass already green on that code` : ''].filter(Boolean);
  return parts.join('; ');
}
export function waited(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The item page's panel: refetched when the item changes (a turn ending updates it). */
export function EfficiencyPanel({ id, version }: { id: string; version?: string }) {
  const [e, setE] = useState<ItemEfficiency | undefined>();
  useEffect(() => { let live = true; api.itemEfficiency(id).then((r) => { if (live) setE(r); }).catch(() => {}); return () => { live = false; }; }, [id, version]);
  if (!e) return <p className="muted small">Loading…</p>;
  if (e.turns + e.wakes === 0) return <p className="muted small">No turns recorded for this item yet. Each turn and orchestrator wake is recorded as it ends.</p>;
  const stages = USAGE_STAGES.filter((s) => e.stages[s]);
  return <>
    <div className="usage-stats">
      <div><strong>{spend(e)}</strong><span>{e.turns} turn{e.turns === 1 ? '' : 's'}{e.wakes ? ` · ${e.wakes} wake${e.wakes === 1 ? '' : 's'}` : ''}</span></div>
      {e.cache_hit !== undefined && <div><strong>{pct(e.cache_hit)}</strong><span>cache hits</span></div>}
      {e.peak_context !== undefined && <div><strong>{toks(e.peak_context)}</strong><span>peak context</span></div>}
      {e.startup && <div title="What a new conversation carried before its first tool call: instructions, skills, tool definitions and the prompt"><strong>{toks(e.startup.max)}</strong><span>startup weight{e.startup.sessions > 1 ? ` (mean ${toks(e.startup.mean)})` : ''}</span></div>}
      <div><strong>{e.fresh_sessions}</strong><span>fresh sessions</span></div>
      <div><strong>{e.parks}</strong><span>parks{e.parked_ms ? ` · ${waited(e.parked_ms)} waiting` : ''}</span></div>
    </div>
    {e.test_runs && <p className="small">Test runs: {runs(e.test_runs.runs, e.test_runs.ms)}{e.test_runs.wasted.runs ? <> · <strong>{runs(e.test_runs.wasted.runs, e.test_runs.wasted.ms)} wasted</strong>: {wasteText(e.test_runs)}. The turns they fell in cost {spend({ usd: e.test_runs.turn_usd, tokens: e.test_runs.turn_tokens })}.</> : ' · none wasted'}</p>}
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead><tr><th scope="col">Stage</th><th scope="col">Cost</th><th scope="col">Turns</th><th scope="col">Cache hits</th></tr></thead>
        <tbody>{stages.map((s) => { const c = e.stages[s]!; return <tr key={s}><th scope="row">{STAGE_LABELS[s]}</th><td>{spend(c)}</td><td>{c.turns}</td><td>{c.cache_hit !== undefined ? pct(c.cache_hit) : '–'}</td></tr>; })}</tbody>
      </table>
    </div>
    <p className="small muted">Recorded per turn as it ends; an orchestrator wake about several items shares its cost among them. Spend from before per-turn recording is not counted.</p>
  </>;
}

/** The Usage page's ranking: the last days' most expensive items, per stage, and the heaviest starting context. */
export function EfficiencyRankingSection({ days }: { days: number }) {
  const [r, setR] = useState<EfficiencyRanking | undefined>();
  useEffect(() => { let live = true; api.usageItems(days).then((x) => { if (live) setR(x); }).catch(() => {}); return () => { live = false; }; }, [days]);
  if (!r) return null;
  const item = (id: string) => <Link to={`/items/${encodeURIComponent(id)}`}>{id}</Link>;
  return (
    <section className="usage-section">
      <h3>Items, last {r.days} days</h3>
      {!r.items.length ? <p className="muted small">No item turns in the last {r.days} days.</p> : <>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead><tr><th scope="col">Item</th><th scope="col">Cost</th><th scope="col">Turns</th><th scope="col">Fresh</th><th scope="col">Parks</th><th scope="col">Peak context</th><th scope="col">Cache hits</th></tr></thead>
            <tbody>{r.items.map((e) => <tr key={e.item}><th scope="row">{item(e.item)}</th><td>{spend(e)}</td><td>{e.turns}{e.wakes ? ` + ${e.wakes} wakes` : ''}</td><td>{e.fresh_sessions}</td><td>{e.parks}</td><td>{e.peak_context ? toks(e.peak_context) : '–'}</td><td>{e.cache_hit !== undefined ? pct(e.cache_hit) : '–'}</td></tr>)}</tbody>
          </table>
        </div>
        <h3>Most expensive per stage</h3>
        <ul className="usage-events">{USAGE_STAGES.filter((s) => r.by_stage[s]?.length).map((s) => <li key={s}><strong>{STAGE_LABELS[s]}</strong>: {r.by_stage[s]!.slice(0, 3).map((x, i) => <span key={x.item}>{i ? ', ' : ''}{item(x.item)} {spend(x)}</span>)}</li>)}</ul>
        {r.wasted_runs.length > 0 && <>
          <h3>Wasted test runs</h3>
          <ul className="usage-events">{r.wasted_runs.slice(0, 5).map((x) => <li key={x.item}>{item(x.item)} {runs(x.wasted.runs, x.wasted.ms)}: {wasteText(x)} <span className="muted">· turns cost {spend({ usd: x.turn_usd, tokens: x.turn_tokens })}</span></li>)}</ul>
        </>}
        {r.startup.length > 0 && <>
          <h3>Heaviest starting context</h3>
          <ul className="usage-events">{r.startup.slice(0, 5).map((x) => <li key={x.item}>{item(x.item)} {toks(x.max)}{x.sessions > 1 ? <span className="muted"> · mean {toks(x.mean)} over {x.sessions} sessions</span> : ''}</li>)}</ul>
        </>}
      </>}
    </section>
  );
}
