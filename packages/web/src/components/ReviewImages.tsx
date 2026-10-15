import { useState } from 'react';
import type { Attachment } from '@planestro/shared';
import type { ItemView } from '../api.ts';
import { useStore } from '../store.ts';

/** A changed-file list longer than this is folded until asked for (#355): a count, not a 1294-file scroll. */
export const FOLD_FILES_AFTER = 20;

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
/** An attachment the page can show as a picture: one planestro holds (a reference may point anywhere). */
export const isImageAttachment = (a: Pick<Attachment, 'kind' | 'path'>) => a.kind === 'managed' && IMAGE.test(a.path);

/** The item's pictures, the latest hand-off's first (newest added first). */
export function reviewImagesOf(item: Pick<ItemView, 'frontmatter'>): Attachment[] {
  return item.frontmatter.attachments.filter(isImageAttachment).sort((a, b) => b.added_at.localeCompare(a.added_at));
}

/** Whether the pictures go to the top of the page: the item is held or waits for review, or needs you, and has some. */
export function showsReviewImages(item: Pick<ItemView, 'frontmatter' | 'derived'>): boolean {
  const fm = item.frontmatter;
  const inReview = fm.status === 'IN_REVIEW' && (Boolean(fm.skip_merge) || fm.awaiting === 'review');
  return (inReview || item.derived.needs_you) && fm.attachments.some(isImageAttachment);
}

/**
 * One picture full size, on a checkerboard (#372): the same modal for a branch's changed images and the item's attached
 * ones. A picture small enough is drawn at the project's display scale (`review.image_scale`), pixel for pixel; a larger
 * one fits the window.
 */
export function ImageZoom({ src, onClose }: { src: string; onClose: () => void }) {
  const scale = useStore((s) => s.state?.config.review?.image_scale ?? 1);
  const [width, setWidth] = useState<number | undefined>();
  const fit = (img: HTMLImageElement) => { const w = img.naturalWidth * scale; setWidth(scale > 1 && w <= window.innerWidth * 0.92 && img.naturalHeight * scale <= window.innerHeight * 0.9 ? w : undefined); };
  return (
    <div className="dialog" onClick={onClose}>
      <div className="checker zoomed"><img src={src} alt="" onLoad={(e) => fit(e.currentTarget)} style={width ? { width, maxWidth: 'none', maxHeight: 'none', imageRendering: 'pixelated' } : undefined} /></div>
    </div>
  );
}

/**
 * What a hold or a review asks a person to look at, first (#355, #372): the item's attached pictures (a worker's
 * captures, contact sheets, before/after pairs) as large thumbnails above the changed-file list, newest first, each
 * opening full size. The Attachments section keeps the full list.
 */
export function ReviewGallery({ item }: { item: ItemView }) {
  const [zoom, setZoom] = useState<string | null>(null);
  if (!showsReviewImages(item)) return null;
  const images = reviewImagesOf(item);
  return (
    <div className="section" id="images" data-nav={`Images to review · ${images.length}`}>
      <h2><span>Images to review · {images.length}</span><span className="small muted" style={{ textTransform: 'none', letterSpacing: 0 }}>newest first · click to zoom</span></h2>
      <div className="review-gallery">
        {images.map((a) => {
          const url = `/${a.path}`;
          return (
            <figure key={a.path} className="review-side">
              <button type="button" className="checker" title="Click to zoom" onClick={() => setZoom(url)}><img src={url} alt={a.path} loading="lazy" /></button>
              <figcaption className="small"><code>{a.path.split('/').pop()}</code> <a href={url} target="_blank" rel="noreferrer">open in a new tab</a></figcaption>
            </figure>
          );
        })}
      </div>
      {zoom && <ImageZoom src={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
