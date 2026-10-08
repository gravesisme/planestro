import { useEffect, useMemo, useState } from 'react';
import { api, type ItemView, type UndoTurnPreview } from '../api.ts';
import { act } from '../store.ts';
import { parsePatch, lineKey } from '../diff.ts';
import { ActionButton } from './ActionButton.tsx';

export const UNDO_HINT = 'Put the worktree back as it was before the last worker turn: you see what it discards first, and it is kept under a git ref';

/** A worker item whose turns run in its own worktree: the last of them may be undone (#234); the dialog says when it cannot. */
export function canUndoTurn(item: ItemView): boolean {
  const fm = item.frontmatter;
  return item.derived.flavor === 'worker' && Boolean(fm.worktree) && ['IN_PROGRESS', 'IN_REVIEW'].includes(fm.status);
}

export function UndoTurnButton({ item, open, onOpen }: { item: ItemView; open: boolean; onOpen: () => void }) {
  if (!canUndoTurn(item) || open) return null;
  return <button title={UNDO_HINT} onClick={onOpen}>Undo last turn…</button>;
}

/** The patch cut per file, each file's hunks parsed as the review panel parses them. */
function filesOf(patch: string) {
  return patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git ')).map((chunk) => ({
    path: /^diff --git a\/(.+?) b\//.exec(chunk)?.[1] ?? '?',
    binary: /^Binary files /m.test(chunk),
    hunks: parsePatch(chunk),
  }));
}

/**
 * The Undo last turn dialog (#234): what undoing discards (the turn's files, its patch and its commits) before the
 * button that does it, which is confirmed against exactly what was shown. A refusal says why instead.
 */
export function UndoTurnPanel({ item, onClose }: { item: ItemView; onClose: () => void }) {
  const [preview, setPreview] = useState<UndoTurnPreview | null>(null);
  useEffect(() => { let live = true; api.undoTurnPreview(item.id).then((p) => { if (live) setPreview(p); }).catch((e) => { if (live) setPreview({ refusal: (e as Error).message }); }); return () => { live = false; }; }, [item.id]);
  const files = useMemo(() => filesOf(preview?.patch ?? ''), [preview?.patch]);
  const rest = (preview?.files ?? []).filter((x) => !files.some((f) => f.path === x.path));
  const go = async () => { const r = await act(() => api.undoTurn(item.id, preview!.expect!)); if (r) onClose(); };
  return (
    <div className="discard-panel undo-panel">
      <b>Undo the last turn of {item.id}?</b>
      {!preview ? <p className="muted small row"><span className="spinner" aria-hidden="true" /> Checking the worktree and its remote…</p> : preview.refusal ? <p className="small">{preview.refusal}</p> : <>
        <p className="small">
          The worktree goes back to how it was before turn {preview.turn}{preview.head ? <> (HEAD <code>{preview.head.slice(0, 7)}</code>)</> : null}: its branch, index and files. This discards what the turn did, below. What it left is kept under a git ref first, named in the log.
        </p>
        {!preview.files?.length && !preview.commits ? <p className="small muted">The turn changed no files.</p> : null}
        {preview.commits ? <><span className="small muted">Commits it made, removed from the branch:</span><pre className="undo-commits small">{preview.commits}</pre></> : null}
        {files.map((f) => {
          const change = preview.files?.find((x) => x.path === f.path)?.change ?? 'modified';
          return (
            <div key={f.path} className="review-card diff-card">
              <div className="small"><code>{f.path}</code> <span className={`tag ${change === 'added' ? 'ok' : change === 'deleted' ? 'hot' : ''}`}>{change}</span></div>
              {f.binary ? <p className="small muted">A binary file: no text diff.</p> : f.hunks.length ? (
                <div className="diff-scroll"><table className="diff unified"><tbody>
                  {f.hunks.map((hk, i) => [
                    <tr key={`h${i}`} className="diff-hunk"><td colSpan={3}>{hk.header}</td></tr>,
                    ...hk.lines.map((l) => (
                      <tr key={`${i}-${lineKey(l)}`}>
                        <td className="diff-num">{l.old ?? ''}</td><td className="diff-num">{l.new ?? ''}</td>
                        <td className={`diff-code diff-${l.type}`} data-sign={l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}>{l.text || ' '}</td>
                      </tr>
                    )),
                  ])}
                </tbody></table></div>
              ) : <p className="small muted">No line changes.</p>}
            </div>
          );
        })}
        {preview.truncated && <p className="small muted">The diff is cut here: it is long.{rest.length ? <> It also changes {rest.map((x, i) => <span key={x.path}>{i ? ', ' : ''}<code>{x.path}</code> ({x.change})</span>)}.</> : null}</p>}
      </>}
      <div className="row">
        <ActionButton className="danger" disabled={!preview || !!preview.refusal || !preview.expect} working="Undoing…" onAct={go}>{preview?.turn ? `Undo turn ${preview.turn}` : 'Undo'}</ActionButton>
        <button onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
