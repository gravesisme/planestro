import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UsageGroup, UsageReport } from '@planestro/shared';
import { api } from '../api.ts';
import { setTitle } from '../tabBadge.ts';
import { usageSeries, dayValues, niceTicks, formatValue, type UsageMeasure, type Series } from '../usageChart.ts';

// ---- usage over time (#236): what every turn and wake spent, per day, by provider, model or role ----
// Facts the engine journals as each turn ends (`usage.turn`); nothing before them is rebuilt. #182's CI timing will share this page.

const RANGES = [7, 30, 90];
const GROUPS: { key: UsageGroup; label: string }[] = [{ key: 'provider', label: 'Provider' }, { key: 'model', label: 'Model' }, { key: 'role', label: 'Role' }];
const REFRESH_MS = 60_000;
const pref = (k: string, fallback: string) => { try { return localStorage.getItem(`planestro.usage.${k}`) ?? fallback; } catch { return fallback; } };
const keep = (k: string, v: string) => { try { localStorage.setItem(`planestro.usage.${k}`, v); } catch { /* a private window */ } };
const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const longDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function Chips<T extends string | number>({ label, options, value, onPick }: { label: string; options: { key: T; label: string }[]; value: T; onPick: (v: T) => void }) {
  return <div className="usage-chips" role="group" aria-label={label}>{options.map((o) => <button key={String(o.key)} className={`chip ${o.key === value ? 'on' : ''}`} aria-pressed={o.key === value} onClick={() => onPick(o.key)}>{o.label}</button>)}</div>;
}

/** Stacked daily bars, drawn at the width they are given; a day is picked by hover or tap and read out below. */
function DailyBars({ report, series, group, measure, picked, onPick }: { report: UsageReport; series: Series[]; group: UsageGroup; measure: UsageMeasure; picked: number; onPick: (i: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, Math.floor(el.clientWidth))));
    ro.observe(el); setWidth(Math.max(240, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);
  const days = report.days;
  const values = days.map((d) => dayValues(d, series, group, measure));
  const totals = values.map((v) => v.reduce((a, b) => a + b, 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks.at(-1) || 1;
  const H = 200, padT = 14, padB = 22, padL = 44, padR = 4;
  const plotW = width - padL - padR, plotH = H - padT - padB;
  const slot = plotW / days.length;
  const gap = slot > 8 ? 2 : 1;
  const barW = Math.max(1, slot - gap);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const marks = new Set(report.events.filter((e) => e.kind === 'crossing' || e.kind === 'disk_pause' || e.kind === 'unavailable').map((e) => e.day));
  const every = Math.ceil(days.length / Math.max(2, Math.floor(plotW / 64)));
  return (
    <div ref={box} className="usage-chart">
      <svg width={width} height={H} role="img" aria-label={`${measure === 'usd' ? 'Dollars' : 'Tokens'} per day, last ${days.length} days`} onPointerLeave={() => onPick(days.length - 1)}>
        {ticks.map((t) => <g key={t}><line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} className="usage-grid" /><text x={padL - 6} y={y(t)} dy="0.32em" textAnchor="end" className="usage-axis">{formatValue(t, measure)}</text></g>)}
        {days.map((d, i) => {
          const x = padL + i * slot + gap / 2;
          let acc = 0;
          return (
            <g key={d.day} className={i === picked ? 'usage-day picked' : 'usage-day'}>
              <rect x={padL + i * slot} y={padT} width={slot} height={plotH} className="usage-hit" onPointerEnter={() => onPick(i)} onClick={() => onPick(i)} />
              {values[i].map((v, s) => {
                if (v <= 0) return null;
                const y0 = y(acc); acc += v; const y1 = y(acc);
                // A 1px seam between stacked segments, so neighbours read apart.
                const h = Math.max(1, y0 - y1 - (s > 0 ? 1 : 0));
                return <rect key={series[s].key} x={x} y={y1} width={barW} height={h} rx={Math.min(2, barW / 2)} fill={series[s].color} pointerEvents="none" />;
              })}
              {marks.has(d.day) && <path d={`M${x + barW / 2 - 4},${padT - 10} h8 l-4,6 z`} className="usage-mark" pointerEvents="none" />}
              {(i % every === (days.length - 1) % every) && <text x={i === days.length - 1 ? width - padR : x + barW / 2} y={H - 6} textAnchor={i === days.length - 1 ? 'end' : 'middle'} className="usage-axis">{shortDay(d.day)}</text>}
            </g>
          );
        })}
        <line x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} className="usage-base" />
      </svg>
    </div>
  );
}

export function UsagePage() {
  const [days, setDays] = useState(() => Number(pref('days', '30')) || 30);
  const [group, setGroup] = useState<UsageGroup>(() => pref('group', 'provider') as UsageGroup);
  const [measure, setMeasure] = useState<UsageMeasure>(() => (pref('measure', 'usd') === 'tokens' ? 'tokens' : 'usd'));
  const [table, setTable] = useState(() => pref('table', '') === '1');
  const [report, setReport] = useState<UsageReport | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [picked, setPicked] = useState(-1);
  const load = useCallback(async () => { try { setReport(await api.usage(days)); setError(undefined); } catch (e) { setError((e as Error).message); } }, [days]);
  useEffect(() => { setTitle('Usage'); }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), REFRESH_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => { setPicked(-1); }, [days]);
  const series = report ? usageSeries(report, group, measure) : [];
  const day = report ? report.days[picked < 0 ? report.days.length - 1 : picked] : undefined;
  const dayVals = report && day ? dayValues(day, series, group, measure) : [];
  const since = report?.recorded_since && report.recorded_since.slice(0, 10) > report.days[0].day ? report.recorded_since.slice(0, 10) : undefined;
  const pick = <T,>(k: string, set: (v: T) => void) => (v: T) => { keep(k, String(v)); set(v); };
  return (
    <div className="usage-page">
      <div className="toolbar usage-toolbar">
        <h2 className="projects-title">Usage</h2>
        <Chips label="Range" options={RANGES.map((n) => ({ key: n, label: `${n} days` }))} value={days} onPick={pick('days', setDays)} />
        <Chips label="Group by" options={GROUPS} value={group} onPick={pick('group', setGroup)} />
        <Chips label="Measure" options={[{ key: 'usd' as UsageMeasure, label: 'Dollars' }, { key: 'tokens' as UsageMeasure, label: 'Tokens' }]} value={measure} onPick={pick('measure', setMeasure)} />
        <button className={`chip ${table ? 'on' : ''}`} aria-pressed={table} onClick={() => { keep('table', table ? '' : '1'); setTable(!table); }}>Table</button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {!report ? <p className="muted">Loading…</p> : <>
        <section className="usage-section">
          <div className="usage-stats">
            <div><strong>${report.totals.usd.toFixed(2)}</strong><span>reported dollars</span></div>
            <div><strong>{formatValue(report.totals.tokens, 'tokens')}</strong><span>reported tokens</span></div>
            <div><strong>{report.totals.turns}</strong><span>turns and wakes</span></div>
          </div>
          {report.totals.turns === 0 ? <p className="muted">No turns in the last {days} days. Each worker turn and orchestrator wake is recorded here as it ends.</p> : <>
            <ul className="usage-legend">
              {series.map((s) => <li key={s.key}><span className="swatch" style={{ background: s.color }} />{s.label} <span className="muted">{formatValue(s.total, measure)}</span></li>)}
              {report.events.some((e) => e.kind !== 'resumed' && e.kind !== 'disk_resumed') && <li><span className="usage-mark-key" />window crossed or paused</li>}
            </ul>
            {table ? <UsageTable report={report} series={series} group={group} measure={measure} /> : <>
              <DailyBars report={report} series={series} group={group} measure={measure} picked={picked < 0 ? report.days.length - 1 : picked} onPick={setPicked} />
              {day && <div className="usage-readout" aria-live="polite">
                <strong>{longDay(day.day)}</strong> · {formatValue(measure === 'usd' ? day.usd : day.tokens, measure)} over {day.turns} turn{day.turns === 1 ? '' : 's'}
                {series.map((s, i) => dayVals[i] > 0 && <span key={s.key} className="usage-readout-item"><span className="swatch" style={{ background: s.color }} />{s.label} {formatValue(dayVals[i], measure)}</span>)}
                {report.events.filter((e) => e.day === day.day).map((e) => <div key={e.at + e.kind} className="small status-notice-inline">{e.text}</div>)}
              </div>}
            </>}
          </>}
          <p className="small muted">{measure === 'usd' ? 'Dollars are what Claude reports for each turn; Codex reports tokens only.' : 'Tokens are what Codex reports (uncached input and output); Claude reports dollars.'} {since ? `Recorded from ${longDay(since)}: earlier turns are not counted.` : 'Spend from before per-turn recording is not counted.'}</p>
        </section>
        <section className="usage-section">
          <h3>Usage windows and pauses</h3>
          {report.events.length === 0 ? <p className="muted small">No usage-window crossings, outages or pauses in the last {days} days.</p> :
            <ul className="usage-events">{report.events.map((e) => <li key={e.at + e.kind} className={e.kind === 'resumed' || e.kind === 'disk_resumed' ? 'ok' : 'warn'}><time dateTime={e.at}>{longDay(e.day)} {new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()}</time> {e.text}</li>)}</ul>}
        </section>
      </>}
    </div>
  );
}

function UsageTable({ report, series, group, measure }: { report: UsageReport; series: Series[]; group: UsageGroup; measure: UsageMeasure }) {
  const rows = [...report.days].reverse().filter((d) => d.turns > 0);
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead><tr><th scope="col">Day</th>{series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}<th scope="col">Total</th><th scope="col">Turns</th></tr></thead>
        <tbody>{rows.map((d) => { const v = dayValues(d, series, group, measure); return <tr key={d.day}><th scope="row">{shortDay(d.day)}</th>{v.map((n, i) => <td key={series[i].key}>{n > 0 ? formatValue(n, measure) : '–'}</td>)}<td>{formatValue(measure === 'usd' ? d.usd : d.tokens, measure)}</td><td>{d.turns}</td></tr>; })}</tbody>
      </table>
    </div>
  );
}
