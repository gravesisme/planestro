import { useState } from 'react';
import type { Attachment, ReviewFlag } from '@planestro/shared';
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

/** The worker's advisory flags on its last hand-off (#372). */
export const reviewFlagsOf = (item: Pick<ItemView, 'frontmatter'>): ReviewFlag[] => item.frontmatter.review_handoff?.flags ?? [];

/**
 * The pictures the gallery shows (#372): the latest hand-off's, when it attached any that are still on the item;
 * otherwise every picture, newest first. `latest` says which.
 */
export function galleryImagesOf(item: Pick<ItemView, 'frontmatter'>): { images: Attachment[]; latest: boolean } {
  const all = reviewImagesOf(item);
  const handed = new Set(item.frontmatter.review_handoff?.attached ?? []);
  const latest = all.filter((a) => handed.has(a.path));
  return latest.length ? { images: latest, latest: true } : { images: all, latest: false };
}

/** Whether the pictures go to the top of the page: the item is held or waits for review, or needs you, and has some (or flags). */
export function showsReviewImages(item: Pick<ItemView, 'frontmatter' | 'derived'>): boolean {
  const fm = item.frontmatter;
  const inReview = fm.status === 'IN_REVIEW' && (Boolean(fm.skip_merge) || fm.awaiting === 'review');
  return (inReview || item.derived.needs_you) && (fm.attachments.some(isImageAttachment) || reviewFlagsOf(item).length > 0);
}

/** An attachment's own name: the store prefixes `YYYYMMDD-HHMMSS-` (and `n-` for a second in one second). */
export const attachmentName = (path: string) => (path.split('/').pop() ?? path).replace(/^\d{8}-\d{6}-(?:\d+-)?/, '');
const safe = (s: string) => s.replace(/[\/\\]/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-');

/**
 * The flags on one file: a branch path matches as is; an attachment matches the worktree path it was copied from
 * (`tmp/shots/a.png` is attached as `tmp-shots-a.png`) or that path's file name.
 */
export function flagsFor(flags: ReviewFlag[], file: { path: string; attachment?: boolean }): ReviewFlag[] {
  if (!flags.length) return [];
  if (!file.attachment) return flags.filter((f) => f.path === file.path);
  const name = attachmentName(file.path);
  return flags.filter((f) => safe(f.path) === name || safe(f.path.split('/').pop() ?? f.path) === name);
}

const SEVERITY_RANK = { problem: 0, warn: 1, info: 2 } as const;
/** The worst severity among flags, for the border (unset reads as warn). */
export const worstSeverity = (flags: ReviewFlag[]) => flags.map((f) => f.severity ?? 'warn').sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0];

const PAIR_WORD = /(^|[-_.\s])(before|after|compare|comparison|diff|old|new)(?=$|[-_.\s])/gi;
const PAIR_ORDER = ['before', 'old', 'after', 'new', 'compare', 'comparison', 'diff'];
/** What a picture is in its pair: `before`, `after`, `compare`… from its name, or '' for none. */
export const pairRole = (name: string) => (name.replace(IMAGE, '').match(PAIR_WORD)?.at(-1)?.replace(/^[-_.\s]/, '').toLowerCase() ?? '');

/**
 * Compare pairs grouped by name (#355): `lamp_4x_before.png` and `lamp_4x_after.png` are one group (the scale stays in
 * the key, so a 4× pair and a 6× pair are two), ordered before, after, compare. Groups keep the input's order.
 */
export function groupPairs(images: Attachment[]): Attachment[][] {
  const groups = new Map<string, Attachment[]>();
  for (const a of images) {
    const name = attachmentName(a.path);
    const key = name.replace(IMAGE, '').replace(PAIR_WORD, '$1').replace(/[-_.\s]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || name;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const rank = (a: Attachment) => { const i = PAIR_ORDER.indexOf(pairRole(attachmentName(a.path))); return i < 0 ? PAIR_ORDER.length : i; };
  return [...groups.values()].map((g) => [...g].sort((a, b) => rank(a) - rank(b)));
}

/** A flag's reason under its picture: `cell: reason`, worst first. */
export function FlagReasons({ flags }: { flags: ReviewFlag[] }) {
  if (!flags.length) return null;
  return <ul className="flag-reasons small">{flags.map((f, i) => <li key={i} className={`sev-${f.severity ?? 'warn'}`}>{f.cell ? <b>{f.cell}: </b> : null}{f.reason}</li>)}</ul>;
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
 * What a hold or a review asks a person to look at, first (#355, #372): the latest hand-off's attached pictures (a
 * worker's captures, contact sheets, before/after pairs side by side) as large thumbnails above the changed-file list,
 * each opening full size. Pictures the worker flagged come first under "Needs a look", boxed, with the reason; flags
 * are advisory and change nothing about approval or the merge. The Attachments section keeps the full list.
 */
export function ReviewGallery({ item }: { item: ItemView }) {
  const [zoom, setZoom] = useState<string | null>(null);
  if (!showsReviewImages(item)) return null;
  const { images, latest } = galleryImagesOf(item);
  const flags = reviewFlagsOf(item);
  const own = (a: Attachment) => flagsFor(flags, { path: a.path, attachment: true });
  // A flagged picture brings its whole compare group up with it: the before beside the after it is judged against.
  const groups = groupPairs(images);
  const flagged = groups.filter((g) => g.some((a) => own(a).length));
  const rest = groups.filter((g) => !flagged.includes(g));
  // A flag on no picture shown here (a branch file, a picture not attached) is still listed, by its path.
  const shown = new Set(images.flatMap(own));
  const loose = flags.filter((f) => !shown.has(f));
  const group = (g: Attachment[]) => g.length > 1 ? <div key={g[0].path} className="review-group">{g.map((a) => figure(a, own(a)))}</div> : figure(g[0], own(g[0]));
  const figure = (a: Attachment, own: ReviewFlag[]) => {
    const url = `/${a.path}`;
    const role = pairRole(attachmentName(a.path));
    return (
      <figure key={a.path} className={`review-side${own.length ? ` flagged sev-${worstSeverity(own)}` : ''}`}>
        <button type="button" className="checker" title="Click to zoom" onClick={() => setZoom(url)}><img src={url} alt={a.path} loading="lazy" /></button>
        <figcaption className="small">{role && <span className="tag">{role}</span>} <code>{attachmentName(a.path)}</code> <a href={url} target="_blank" rel="noreferrer">open in a new tab</a></figcaption>
        <FlagReasons flags={own} />
      </figure>
    );
  };
  const n = images.length;
  return (
    <div className="section" id="images" data-nav={`${latest ? 'Latest hand-off' : 'Images to review'} · ${n}${flags.length ? ` · ${flags.length} flagged` : ''}`}>
      <h2>
        <span>{latest ? 'Latest hand-off' : 'Images to review'} · {n}{flags.length > 0 && <span className="flag-count"> · {flags.length} flagged</span>}</span>
        <span className="small muted" style={{ textTransform: 'none', letterSpacing: 0 }}>{latest ? 'earlier pictures are under Attachments · ' : 'newest first · '}click to zoom</span>
      </h2>
      {(flagged.length > 0 || loose.length > 0) && (
        <div className="needs-look">
          <h3 className="small">Needs a look <span className="muted">· the worker's flags, advisory: they never hold the merge</span></h3>
          {flagged.length > 0 && <div className="review-gallery">{flagged.map(group)}</div>}
          {loose.length > 0 && <ul className="flag-reasons small">{loose.map((f, i) => <li key={i} className={`sev-${f.severity ?? 'warn'}`}><code>{f.path}</code>{f.cell ? ` (${f.cell})` : ''}: {f.reason}</li>)}</ul>}
        </div>
      )}
      {rest.length > 0 && <div className="review-gallery">{rest.map(group)}</div>}
      {zoom && <ImageZoom src={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
