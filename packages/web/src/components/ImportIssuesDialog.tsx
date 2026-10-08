import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type ImportableIssues, type ImportIssuesResult } from '../api.ts';
import { act } from '../store.ts';

/**
 * Import issues (#231): the project's open GitHub issues, to file as items. Pick some, or import every one with the
 * configured label; one already imported links to its item and cannot be picked. Nothing is submitted.
 */
export function ImportIssuesDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ImportableIssues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [closes, setCloses] = useState(false);
  const [done, setDone] = useState<ImportIssuesResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.importableIssues().then(setList, (e: Error) => setError(e.message)); }, []);

  const run = async (body: { issues?: number[]; label?: string }) => {
    setBusy(true);
    const r = await act(() => api.importIssues({ ...body, ...(closes ? { closes: true } : {}) }));
    setBusy(false);
    if (r) setDone(r);
  };
  const toggle = (n: number) => setPicked((p) => { const s = new Set(p); if (s.has(n)) s.delete(n); else s.add(n); return s; });
  const fresh = list?.issues.filter((i) => !i.item) ?? [];
  const labelled = list?.label ? fresh.filter((i) => i.labels.includes(list.label!)) : [];

  return (
    <div className="dialog" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (picked.size) void run({ issues: [...picked] }); }}>
        <h2 style={{ margin: 0 }}>Import issues{list ? <span className="muted small"> · {list.repo}</span> : null}</h2>
        {error && <p className="small">{error}</p>}
        {!list && !error && <p className="muted small">Reading open issues…</p>}
        {done ? (<>
          <p className="small">{done.imported.length} imported{done.skipped.length ? `, ${done.skipped.length} skipped` : ''}. Nothing was submitted: queue an item when you want it worked on.</p>
          <ul className="small issue-result">
            {done.imported.map((x) => <li key={x.issue}>#{x.issue} → <Link to={`/items/${x.item}`} onClick={onClose}>{x.item}</Link> {x.title}</li>)}
            {done.skipped.map((x) => <li key={x.issue} className="muted">#{x.issue}: {x.reason}</li>)}
          </ul>
          <div className="row"><span className="grow" /><button className="primary" type="button" onClick={onClose}>Done</button></div>
        </>) : list && (<>
          {list.issues.length === 0 ? <p className="muted small">No open issues.</p> : (
            <div className="issue-pick">
              {list.issues.map((i) => (
                <label key={i.number} className={`row small ${i.item ? 'muted' : ''}`}>
                  <input type="checkbox" disabled={!!i.item} checked={picked.has(i.number)} onChange={() => toggle(i.number)} />
                  <span className="grow"><a href={i.url} target="_blank" rel="noreferrer">#{i.number}</a> {i.title}{i.labels.length ? <span className="muted"> · {i.labels.join(', ')}</span> : null}</span>
                  {i.item && <Link to={`/items/${i.item}`} onClick={onClose}>{i.item}</Link>}
                </label>
              ))}
            </div>
          )}
          <label className="row small" title='Its pull request says "Closes #N", so GitHub closes the issue when it merges into the default branch. You can change it on the item until its PR opens.'><input type="checkbox" checked={closes} onChange={(e) => setCloses(e.target.checked)} /> close each issue when its PR merges</label>
          <p className="muted small" style={{ margin: 0 }}>Each issue becomes an item that is not submitted; one already imported is never imported again.</p>
          <div className="row">
            {list.label && <button type="button" disabled={busy || !labelled.length} title={`Every open issue labelled ${list.label} that is not imported yet`} onClick={() => void run({ label: list.label })}>Import all labelled {list.label} ({labelled.length})</button>}
            <span className="grow" />
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="primary" type="submit" disabled={busy || !picked.size}>Import {picked.size || ''}</button>
          </div>
        </>)}
      </form>
    </div>
  );
}
