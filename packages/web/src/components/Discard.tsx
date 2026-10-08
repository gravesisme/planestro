import { useEffect, useState } from 'react';
import { api, type ItemView } from '../api.ts';
import { act } from '../store.ts';
import { useAction } from '../sending.ts';
import { Sending } from './Sending.tsx';

const DISCARDABLE = ['QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'];
export const DISCARD_HINT = 'You no longer want this work: its session stops, its pull request is closed, it leaves its epic and goes to the icebox';

/** Work planestro is doing on a worker item, or an iceboxed epic child that still holds its epic open (#135). */
export function canDiscard(item: ItemView): boolean {
  const fm = item.frontmatter;
  return item.derived.flavor === 'worker' && (DISCARDABLE.includes(fm.status) || (fm.status === 'ICEBOX' && Boolean(fm.parent)));
}

export function DiscardButton({ item, open, onOpen }: { item: ItemView; open: boolean; onOpen: () => void }) {
  if (!canDiscard(item) || open) return null;
  return <button className="danger" title={DISCARD_HINT} onClick={onOpen}>Discard…</button>;
}

/**
 * The Discard dialog (#135): why, and whether its branch on GitHub goes too (ticked by default; shown only
 * when the branch is there). The delete is leased to the tip shown here, so a commit made since keeps it.
 */
export function DiscardPanel({ item, onClose }: { item: ItemView; onClose: () => void }) {
  const fm = item.frontmatter;
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.discardPreview>> | null>(null);
  const [reason, setReason] = useState('');
  const [deleteBranch, setDeleteBranch] = useState(true);
  useEffect(() => { let live = true; api.discardPreview(item.id).then((p) => { if (live) setPreview(p); }).catch((e) => { if (live) setPreview({ refusal: (e as Error).message, remote_sha: null }); }); return () => { live = false; }; }, [item.id]);
  const remote = preview?.remote_sha;
  // Enter and the button share one guard (#304): marked at once, a second press sends nothing.
  const { busy: going, run } = useAction();
  const busy = going !== undefined;
  const go = () => run('discard', async () => { const r = await act(() => api.discard(item.id, reason.trim(), remote ? deleteBranch : false, remote ?? undefined)); if (r) onClose(); return r; });
  return (
    <div className="discard-panel">
      <b>Discard {item.id}?</b>
      {!preview ? <p className="muted small">Checking its branch…</p> : preview.refusal ? <p className="small">{preview.refusal}</p> : <>
        <p className="small">
          {fm.status === 'ICEBOX' ? 'It is taken off its epic, so the epic no longer waits on it.' : <>Its session stops{preview.pr ? <>, pull request #{preview.pr} is closed with your reason</> : null}, it is taken off {fm.parent ? `epic ${fm.parent}` : 'any epic'} and goes to the icebox.</>}
        </p>
        <input className="grow" autoFocus placeholder="Why? (it goes on the closed pull request and in the log)" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim() && !busy) { e.preventDefault(); void go(); } if (e.key === 'Escape') onClose(); }} />
        {remote && preview.branch && <label className="small"><input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /><span>Delete the branch <code>{preview.branch}</code> on GitHub (tip {remote.slice(0, 7)}), and its worktree here. Uncommitted files are set aside in <code>.displaced/</code>; the tip is written to the log so the branch can be restored.</span></label>}
        {!remote && preview.branch && <p className="muted small">Its branch is not on GitHub, so its worktree and branch here are kept: they are the only copy.</p>}
      </>}
      <div className="row">
        <button className="danger" disabled={!preview || !!preview.refusal || !reason.trim() || busy} aria-busy={busy || undefined} onClick={() => void go()}>{busy ? <Sending label="Discarding…" /> : remote && deleteBranch ? 'Discard and delete the branch' : 'Discard'}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
