import { partsSummary, type Part } from '@planestro/shared/view';

/** The worker's own progress on multi-part work (f4): one block per part, coloured by state, with the reasons under it. */
export function PartsStrip({ parts, compact = false }: { parts: Part[]; compact?: boolean }) {
  return (
    <div className={compact ? '' : 'section'}>
      {!compact && <h2>Parts · {partsSummary(parts).split(' · ')[0]}</h2>}
      <div className="parts-strip" title={partsSummary(parts)}>{parts.map((p) => <span key={p.name} className={`part ${p.state}`} title={`${p.name}: ${p.state}${p.reason ? ` — ${p.reason}` : ''}`}>{compact ? '' : p.name}</span>)}</div>
      {!compact && parts.some((p) => p.state !== 'accepted') && <ul className="small parts-list">{parts.filter((p) => p.state !== 'accepted').map((p) => <li key={p.name}><span className={`tag ${p.state === 'rejected' ? 'hot' : 'wait'}`}>{p.state}</span> <b>{p.name}</b>{p.reason ? <span className="muted"> — {p.reason}</span> : null}</li>)}</ul>}
    </div>
  );
}
