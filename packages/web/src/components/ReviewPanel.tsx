import { useEffect, useState } from 'react';
import { api, type ItemView, type ReviewImage } from '../api.ts';
import { act, useStore } from '../store.ts';
import { prepareUpload } from '../uploadImage.ts';
import { usePhone } from '../usePhone.ts';
import { FileDiff } from './FileDiff.tsx';
import { ActionButton, ActionGroup } from './ActionButton.tsx';
import { FOLD_FILES_AFTER, ImageZoom } from './ReviewImages.tsx';

const src = (id: string, path: string, side: 'before' | 'after', v: string) => `/api/items/${id}/image?path=${encodeURIComponent(path)}&side=${side}&v=${encodeURIComponent(v)}`;
const kb = (n?: number) => n === undefined ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * What a branch made, as a person reviews it: every image it added or changed, before beside after
 * on a checkerboard (transparency is part of the art), at 1× and at the project's display scale;
 * every other file opens to its diff against the base (#233), before a pull request and after the merge.
 * The list comes from git through the engine; nothing here asks a model what it made.
 */
export function ReviewPanel({ item, compact = false }: { item: ItemView; compact?: boolean }) {
  const fm = item.frontmatter;
  const scaleN = useStore((s) => s.state?.config.review?.image_scale ?? 1);
  const [images, setImages] = useState<ReviewImage[] | null>(null);
  const [scaled, setScaled] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  // A long list (an art branch's raw frames, an import's churn) is folded to its count until asked for (#355).
  const [unfolded, setUnfolded] = useState(false);
  const phone = usePhone();
  const [split, setSplit] = useState<boolean | null>(null); // side by side where there is room, unless chosen
  const sideBySide = split ?? !phone;
  const [note, setNote] = useState('');
  // An audition (f5): the candidates a sound or 3D worker made; the ones ticked go back to it as the note's first line.
  const [picks, setPicks] = useState<string[]>([]);
  const togglePick = (path: string) => setPicks((p) => p.includes(path) ? p.filter((x) => x !== path) : [...p, path]);
  const [pasted, setPasted] = useState<string[]>([]);
  const maxBytes = useStore((s) => s.state?.config.attachments.managed_max_bytes) ?? 8_000_000;
  // Paste on desktop, the picker on a phone (which can't paste from Photos); both convert HEIC and shrink to the limit.
  const attach = (files: File[]) => { for (const f of files) void act(async () => api.uploadAttachment(item.id, await prepareUpload(f, maxBytes))).then((r) => { if (r) setPasted((p) => [...p, r.path.split('/').pop() || f.name || 'screenshot']); }); };
  const awaiting = fm.status === 'IN_REVIEW' && fm.awaiting === 'review';
  const v = fm.updated_at; // a revised picture keeps its path: the version busts the cache
  useEffect(() => { let live = true; api.reviewImages(item.id).then((r) => { if (live) setImages(r); }).catch(() => { if (live) setImages([]); }); return () => { live = false; }; }, [item.id, fm.updated_at, fm.status]);
  // Still reading the branch (#159): say so where the files will be, so nobody leaves before they show up.
  if (!awaiting && images === null && fm.branch && ['IN_PROGRESS', 'IN_REVIEW'].includes(fm.status)) return (
    <div className="section review-loading" id="files" data-nav="Files to review" aria-busy="true">
      <h2 style={{ margin: '0 0 8px' }}><span>Files to review on this branch</span></h2>
      <p className="small muted row"><span className="spinner" aria-hidden="true" /> Reading the branch for the files it changed…</p>
    </div>
  );
  if (!awaiting && !images?.length) return null;
  const px = scaled ? scaleN : 1;
  const merged = fm.status === 'MERGED' || fm.status === 'FINISHED';
  const folded = !unfolded && (images?.length ?? 0) > FOLD_FILES_AFTER;
  const texts = images?.filter((f) => f.kind === 'text') ?? [];
  const media = images?.filter((f) => f.kind !== 'text') ?? [];
  // Picked lines join the note the Request changes button sends.
  const quote = awaiting ? (q: string) => setNote((n) => `${n.trimEnd()}${n.trim() ? '\n\n' : ''}${q}\n`) : undefined;
  const candidate = (f: ReviewImage) => {
    const url = src(item.id, f.path, 'after', v);
    return (
      <div key={f.path} className="review-card">
        <div className="small"><code>{f.path}</code> <span className={`tag ${f.change === 'added' ? 'ok' : f.change === 'deleted' ? 'hot' : ''}`}>{f.change}</span> <span className="muted">{kb(f.bytes)}</span>{awaiting && f.change !== 'deleted' && <label className="small" style={{ marginLeft: 8 }}><input type="checkbox" checked={picks.includes(f.path)} onChange={() => togglePick(f.path)} /> pick</label>}</div>
        {f.change === 'deleted' ? <div className="review-none small muted">removed</div>
          : f.kind === 'audio' ? <audio controls preload="none" src={url} style={{ width: '100%', marginTop: 6 }} />
          : <a className="small" href={url} download>download to look at it (a 3D model)</a>}
      </div>
    );
  };
  const picture = (img: ReviewImage, side: 'before' | 'after') => {
    const missing = (side === 'before' && img.change === 'added') || (side === 'after' && img.change === 'deleted');
    const url = src(item.id, img.path, side, v);
    return (
      <figure className="review-side">
        <figcaption className="small muted">{side}</figcaption>
        {missing ? <div className="review-none small muted">{side === 'before' ? 'new file' : 'removed'}</div>
          : <button type="button" className="checker" title="Click to zoom" onClick={() => setZoom(url)}><img src={url} alt={`${img.path} (${side})`} style={px > 1 && img.width ? { width: img.width * px, imageRendering: 'pixelated', maxWidth: 'none' } : undefined} /></button>}
      </figure>
    );
  };
  return (
    <div className={awaiting ? 'approval' : 'section'} id={awaiting ? 'review' : 'files'} data-nav={`${merged ? 'Files changed' : 'Files to review'} · ${images?.length ?? 0}`} data-wait={awaiting || undefined}>
      <h2 style={{ margin: '0 0 8px' }}>
        <span>{awaiting ? 'Waiting for your review before it merges' : merged ? `Files changed${fm.pr ? ` by PR #${fm.pr}` : ''} · ${images?.length ?? 0}` : `Files to review on this branch · ${images?.length ?? 0}`}</span>
        {texts.length > 0 && <button className="small" onClick={() => setSplit(!sideBySide)}>{sideBySide ? 'side by side — show unified' : 'unified — show side by side'}</button>}
        {scaleN > 1 && media.length > 0 && <button className="small" onClick={() => setScaled(!scaled)}>{scaled ? `showing ${scaleN}× — show 1×` : `showing 1× — show ${scaleN}×`}</button>}
      </h2>
      {awaiting && <p className="small" style={{ marginTop: 0 }}>Synced and CI is green{fm.pr ? ` (PR #${fm.pr})` : ''}. Everything a machine can check has passed; this part is yours.</p>}
      {folded && <p className="small row" style={{ flexWrap: 'wrap' }}><button className="small" onClick={() => setUnfolded(true)}>Show all {images!.length} files</button><span className="muted">{media.length} image or media file{media.length === 1 ? '' : 's'}, {texts.length} other{texts.length === 1 ? '' : 's'}: folded because the list is long.</span></p>}
      {folded ? null : images === null ? <p className="small muted">Reading the branch…</p> : !images.length ? <p className="small muted">This branch changes no files{awaiting ? ' — review the pull request itself.' : '.'}</p> : media.length > 0 && (
        <div className={`review-grid ${compact ? 'compact' : ''}`}>
          {media.filter((f) => f.kind && f.kind !== 'image').map(candidate)}
          {media.filter((f) => !f.kind || f.kind === 'image').map((img) => (
            <div key={img.path} className="review-card">
              <div className="small"><code>{img.path}</code> <span className={`tag ${img.change === 'added' ? 'ok' : img.change === 'deleted' ? 'hot' : ''}`}>{img.change}</span> <span className="muted">{img.width ? `${img.width}×${img.height} · ` : ''}{kb(img.bytes)}</span></div>
              <div className="review-pair">{img.change !== 'added' && picture(img, 'before')}{picture(img, 'after')}</div>
            </div>
          ))}
        </div>
      )}
      {!folded && texts.length > 0 && (
        <div className="diff-list">
          {awaiting && <p className="small muted" style={{ margin: 0 }}>Open a file for its diff; pick line numbers (shift for a range) to quote them in your note.</p>}
          {texts.map((f) => <FileDiff key={f.path} itemId={item.id} file={f} v={v} split={sideBySide} onQuote={quote} />)}
        </div>
      )}
      {awaiting && (
        <>
          {picks.length > 0 && <p className="small" style={{ margin: '8px 0 0' }}>Picked: <b>{picks.join(', ')}</b> — sent to the worker as the first line of your note (say what to do with the rest).</p>}
          <textarea style={{ minHeight: 56, marginTop: 8 }} placeholder="What should change? Paste a screenshot to send it along." value={note} onChange={(e) => setNote(e.target.value)}
            onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/')); if (!f) return; e.preventDefault(); e.stopPropagation(); attach([f]); }} />
          <label className="small" style={{ display: 'inline-block', margin: '4px 0', cursor: 'pointer' }}>
            <input type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; attach(fs); }} />
            <span className="tag">attach a photo…</span>
          </label>
          {pasted.length > 0 && <p className="small muted" style={{ margin: '4px 0' }}>attached for the agent: {pasted.join(', ')}</p>}
          <div className="row"><ActionGroup>
            <ActionButton className="primary" working="Approving…" onAct={() => { const n = prompt(`Approve ${item.id} and let it merge? Optional note for the log:`); if (n !== null) return act(() => api.releaseHold(item.id, n || undefined)); }}>Approve &amp; merge</ActionButton>
            <span className="grow" />
            <ActionButton className="danger" disabled={!note.trim() && !picks.length} working="Sending…" onAct={() => act(() => api.requestReviewChanges(item.id, `${picks.length ? `Picked: ${picks.join(', ')}.` : ''}${picks.length && note.trim() ? ' ' : ''}${note.trim()}`)).then((r) => { if (r) { setNote(''); setPasted([]); setPicks([]); } })}>{picks.length ? 'Send picks & changes' : 'Request changes'}</ActionButton>
          </ActionGroup></div>
        </>
      )}
      {zoom && <ImageZoom src={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
