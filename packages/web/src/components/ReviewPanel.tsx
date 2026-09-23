import { useEffect, useState } from 'react';
import { api, type ItemView, type ReviewImage } from '../api.ts';
import { act, useStore } from '../store.ts';
import { prepareUpload } from '../uploadImage.ts';

const src = (id: string, path: string, side: 'before' | 'after', v: string) => `/api/items/${id}/image?path=${encodeURIComponent(path)}&side=${side}&v=${encodeURIComponent(v)}`;
const kb = (n?: number) => n === undefined ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * What a branch drew, as a person reviews it: every image it added or changed, before beside after
 * on a checkerboard (transparency is part of the art), at 1× and at the project's display scale.
 * The list comes from git through the engine; nothing here asks a model what it made.
 */
export function ReviewPanel({ item, compact = false }: { item: ItemView; compact?: boolean }) {
  const fm = item.frontmatter;
  const scaleN = useStore((s) => s.state?.config.review?.image_scale ?? 1);
  const [images, setImages] = useState<ReviewImage[] | null>(null);
  const [scaled, setScaled] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pasted, setPasted] = useState<string[]>([]);
  const maxBytes = useStore((s) => s.state?.config.attachments.managed_max_bytes) ?? 8_000_000;
  // Paste on desktop, the picker on a phone (which can't paste from Photos); both convert HEIC and shrink to the limit.
  const attach = (files: File[]) => { for (const f of files) void act(async () => api.uploadAttachment(item.id, await prepareUpload(f, maxBytes))).then((r) => { if (r) setPasted((p) => [...p, r.path.split('/').pop() || f.name || 'screenshot']); }); };
  const awaiting = fm.status === 'IN_REVIEW' && fm.awaiting === 'review';
  const v = fm.updated_at; // a revised picture keeps its path: the version busts the cache
  useEffect(() => { let live = true; api.reviewImages(item.id).then((r) => { if (live) setImages(r); }).catch(() => { if (live) setImages([]); }); return () => { live = false; }; }, [item.id, fm.updated_at, fm.status]);
  if (!awaiting && !images?.length) return null;
  const px = scaled ? scaleN : 1;
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
    <div className={awaiting ? 'approval' : 'section'}>
      <h2 style={{ margin: '0 0 8px' }}>
        <span>{awaiting ? 'Waiting for your review before it merges' : `Images on this branch · ${images?.length ?? 0}`}</span>
        {scaleN > 1 && <button className="small" onClick={() => setScaled(!scaled)}>{scaled ? `showing ${scaleN}× — show 1×` : `showing 1× — show ${scaleN}×`}</button>}
      </h2>
      {awaiting && <p className="small" style={{ marginTop: 0 }}>Synced and CI is green{fm.pr ? ` (PR #${fm.pr})` : ''}. Everything a machine can check has passed; this part is yours.</p>}
      {images === null ? <p className="small muted">Reading the branch…</p> : !images.length ? <p className="small muted">This branch changes no image files{awaiting ? ' — review the pull request itself.' : '.'}</p> : (
        <div className={`review-grid ${compact ? 'compact' : ''}`}>
          {images.map((img) => (
            <div key={img.path} className="review-card">
              <div className="small"><code>{img.path}</code> <span className={`tag ${img.change === 'added' ? 'ok' : img.change === 'deleted' ? 'hot' : ''}`}>{img.change}</span> <span className="muted">{img.width ? `${img.width}×${img.height} · ` : ''}{kb(img.bytes)}</span></div>
              <div className="review-pair">{img.change !== 'added' && picture(img, 'before')}{picture(img, 'after')}</div>
            </div>
          ))}
        </div>
      )}
      {awaiting && (
        <>
          <textarea style={{ minHeight: 56, marginTop: 8 }} placeholder="What should change? Paste a screenshot to send it along." value={note} onChange={(e) => setNote(e.target.value)}
            onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/')); if (!f) return; e.preventDefault(); e.stopPropagation(); attach([f]); }} />
          <label className="small" style={{ display: 'inline-block', margin: '4px 0', cursor: 'pointer' }}>
            <input type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; attach(fs); }} />
            <span className="tag">attach a photo…</span>
          </label>
          {pasted.length > 0 && <p className="small muted" style={{ margin: '4px 0' }}>attached for the agent: {pasted.join(', ')}</p>}
          <div className="row">
            <button className="primary" onClick={() => { const n = prompt(`Approve ${item.id} and let it merge? Optional note for the log:`); if (n !== null) void act(() => api.releaseHold(item.id, n || undefined)); }}>Approve &amp; merge</button>
            <span className="grow" />
            <button className="danger" disabled={!note.trim()} onClick={() => void act(() => api.requestReviewChanges(item.id, note.trim())).then((r) => { if (r) { setNote(''); setPasted([]); } })}>Request changes</button>
          </div>
        </>
      )}
      {zoom && <div className="dialog" onClick={() => setZoom(null)}><div className="checker zoomed"><img src={zoom} alt="" /></div></div>}
    </div>
  );
}
