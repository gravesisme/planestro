import { Link } from 'react-router';
import { useStore } from '../store.ts';
import { statusLabel } from '../components/ItemCard.tsx';

export function SessionsPage() {
  const state = useStore((s) => s.state);
  const events = useStore((s) => s.events);
  if (!state) return <p className="muted">Loading…</p>;
  const awaiting = state.items.filter((i) => i.derived.needs_you && i.derived.lane === 'board');
  const active = state.items.filter((i) => ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'].includes(i.frontmatter.status));
  const queue = state.items.filter((i) => i.frontmatter.status === 'IN_REVIEW').sort((a, b) => (a.frontmatter.merge_order ?? 1e9) - (b.frontmatter.merge_order ?? 1e9) || (a.frontmatter.rank ?? 0) - (b.frontmatter.rank ?? 0));
  return (
    <div>
      <div className="section"><h2>Live sessions ({state.engine.sessions.length}) · engine {state.engine.mode}{state.engine.paused ? ' · PAUSED' : ''}</h2>
        <table><thead><tr><th>item</th><th>model</th><th>state</th><th>op</th><th>last output</th></tr></thead><tbody>
          {state.engine.sessions.map((s) => <tr key={s.item}><td><Link to={`/items/${s.item}`}>{s.item}</Link></td><td>{s.model}</td><td>{s.busy ? 'busy' : 'queued'}</td><td>{s.op}</td><td className="small muted">{s.last_output}</td></tr>)}
          {!state.engine.sessions.length && <tr><td colSpan={5} className="muted">No process is running. Parked sessions resume on demand.</td></tr>}
        </tbody></table>
      </div>
      <div className="section"><h2>Needs you ({awaiting.length})</h2>
        <table><tbody>{awaiting.map((i) => <tr key={i.id}><td><Link to={`/items/${i.id}`}>{i.id}</Link></td><td>{i.frontmatter.title}</td><td>{statusLabel(i.frontmatter.status)}</td><td>{i.frontmatter.blocked ? `blocked: ${i.frontmatter.blocked_reason}` : `awaiting ${i.frontmatter.awaiting}`}</td></tr>)}</tbody></table>
      </div>
      <div className="section"><h2>Active items ({active.length})</h2>
        <table><tbody>{active.map((i) => <tr key={i.id}><td><Link to={`/items/${i.id}`}>{i.id}</Link></td><td>{i.frontmatter.title}</td><td>{statusLabel(i.frontmatter.status)}</td><td>{i.frontmatter.op ?? ''}</td><td>{i.frontmatter.pr ? `PR #${i.frontmatter.pr}` : ''}</td></tr>)}</tbody></table>
      </div>
      <div className="section"><h2>Merge queue order</h2>
        <ol>{queue.map((i) => <li key={i.id}><Link to={`/items/${i.id}`}>{i.id}</Link> {i.frontmatter.title} → {i.derived.base_branch} {i.frontmatter.ci_result ? `· CI ${i.frontmatter.ci_result}` : ''}</li>)}</ol>
        {!queue.length && <p className="muted small">Nothing in review.</p>}
      </div>
      <div className="section"><h2>Engine log</h2><div className="events">{events.join('\n') || 'quiet'}</div></div>
    </div>
  );
}
