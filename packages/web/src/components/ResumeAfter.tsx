import { useState } from 'react';
import { Link } from 'react-router';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { ActionButton } from './ActionButton.tsx';

/**
 * "Resume when HH-129 merges, and tell it this" (p14): a stopped item that is only waiting for another
 * item stops needing you, and its session resumes by itself once that item has merged.
 */
export function ResumeAfterButton({ item }: { item: ItemView }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)} title="Park it until other items merge; its session resumes then with your message">Resume when merged…</button>
    {open && <ResumeAfterDialog item={item} onClose={() => setOpen(false)} />}
  </>;
}

function ResumeAfterDialog({ item, onClose }: { item: ItemView; onClose: () => void }) {
  const items = useStore((s) => s.state?.items ?? []);
  const open = items.filter((i) => i.id !== item.id && !['MERGED', 'FINISHED'].includes(i.frontmatter.status) && i.derived.lane === 'board');
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  // Pull requests no item stands for (#136): typed as numbers, "468, 470" or "#468".
  const [prText, setPrText] = useState('');
  const prs = [...new Set((prText.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0))];
  const toggle = (id: string) => setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  return (
    <div className="dialog" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => e.preventDefault()}>
        <h2 style={{ margin: 0 }}>Resume {item.id} when…</h2>
        <p className="small muted" style={{ margin: 0 }}>It stops needing you. Once every item you tick and every pull request you name has merged, planestro rebases its branch onto the base and resumes its session with your message.</p>
        <div className="resume-pick">
          {open.map((i) => <label key={i.id} className="row small"><input type="checkbox" checked={picked.includes(i.id)} onChange={() => toggle(i.id)} /> <b>{i.id}</b> {i.frontmatter.title} <span className="muted">{i.frontmatter.status.replace(/_/g, ' ')}</span></label>)}
          {!open.length && <p className="muted small">No other open items to wait for.</p>}
        </div>
        <label className="small">Pull requests no item stands for <input placeholder="e.g. 468, 470" value={prText} onChange={(e) => setPrText(e.target.value)} /></label>
        <textarea placeholder="What should the session do once they have merged?" value={message} onChange={(e) => setMessage(e.target.value)} rows={4} />
        <div className="row"><span className="grow" /><button type="button" onClick={onClose}>Cancel</button><ActionButton className="primary" type="submit" working="Parking…" disabled={(!picked.length && !prs.length) || !message.trim()} onAct={async () => { if (await act(() => api.resumeAfter(item.id, picked, message, prs))) onClose(); }}>Park it</ActionButton></div>
      </form>
    </div>
  );
}

/** The item is parked on others: what it waits for, what it will be told, and a way out. */
export function WaitingPanel({ item }: { item: ItemView }) {
  const wait = item.frontmatter.resume_after;
  const items = useStore((s) => s.state?.items ?? []);
  if (!wait) return null;
  return (
    <div className="approval">
      <h2 style={{ margin: '0 0 8px' }}>Waiting to resume</h2>
      <p className="small" style={{ marginTop: 0 }}>Resumes when {wait.items.map((id, n) => { const s = items.find((i) => i.id === id)?.frontmatter.status; return <span key={id}>{n ? ', ' : ''}<Link to={`/items/${id}`}>{id}</Link>{s ? ` (${s.replace(/_/g, ' ')})` : ''}</span>; })} {(wait.prs ?? []).map((n, k) => <span key={n}>{wait.items.length || k ? ', ' : ''}PR #{n}</span>)} {wait.items.length + (wait.prs?.length ?? 0) === 1 ? 'has' : 'have'} merged, with:</p>
      <p className="blocked-said">{wait.message}</p>
      <div className="row"><ActionButton working="Stopping…" onAct={() => { if (confirm(`Stop waiting? ${item.id} becomes blocked for you again.`)) return act(() => api.cancelResumeAfter(item.id)); }}>Stop waiting</ActionButton><span className="small muted">since {wait.since.slice(0, 16).replace('T', ' ')}</span></div>
    </div>
  );
}
