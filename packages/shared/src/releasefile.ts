import { ReleaseFrontmatter, RELEASE_KEY_ORDER, type ReleaseSectionDef, type ItemFrontmatter } from './schema.ts';
import { splitFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { canonicalTimestamp } from './timestamps.ts';
import { splitSections, demoteH1, type Section } from './itemfile.ts';
import { trimLineEnds } from './textScan.ts';

export interface ReleaseFile { frontmatter: ReleaseFrontmatter; sections: Section[] }

/** Parse a release file. Sections are whatever `# Heading`s it has, in file order. */
export function parseReleaseFile(text: string): ReleaseFile {
  const { data, body } = splitFrontmatter(text);
  const parsed = ReleaseFrontmatter.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid release frontmatter: ${issues}`);
  }
  const frontmatter = parsed.data;
  frontmatter.created_at = canonicalTimestamp(frontmatter.created_at);
  frontmatter.updated_at = canonicalTimestamp(frontmatter.updated_at);
  return { frontmatter, sections: splitSections(body) };
}

/** Empty sections keep their heading, so a hand editor sees the project's template. */
export function serializeReleaseFile(file: ReleaseFile): string {
  const fm = serializeFrontmatter(file.frontmatter as Record<string, unknown>, RELEASE_KEY_ORDER);
  const body = file.sections.map((s) => {
    const text = trimLineEnds(s.body).trimEnd();
    if (s.title === '') return text ? `${text}\n` : '';
    return text ? `# ${s.title}\n\n${text}\n` : `# ${s.title}\n`;
  }).filter(Boolean).join('\n');
  return `${fm}\n${body}`;
}

export function getReleaseSection(file: ReleaseFile, title: string): string {
  return file.sections.find((s) => s.title === title)?.body ?? '';
}

/** Replace a section's text, or add it where the project's section order puts it. */
export function setReleaseSection(file: ReleaseFile, title: string, body: string, defs: readonly ReleaseSectionDef[]): void {
  const text = demoteH1(body).trim();
  const existing = file.sections.find((s) => s.title === title);
  if (existing) { existing.body = text; return; }
  const rank = (t: string) => { const i = defs.findIndex((d) => d.title === t); return i < 0 ? Infinity : i; };
  const at = file.sections.findIndex((s) => s.title !== '' && rank(s.title) > rank(title));
  file.sections.splice(at < 0 ? file.sections.length : at, 0, { title, body: text });
}

/** What a store counts: characters as a person sees them, not UTF-16 units. */
export function charCount(text: string): number { return [...text.trim()].length; }

/** `1.10.0` after `1.9.2`; a leading `v` is ignored; numeric parts compare as numbers, the rest as text. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v(?=\d)/i, '').split(/[.+_-]/);
  const pa = parts(a); const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN; const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const c = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/** Newest first. */
export function sortReleases<T extends { frontmatter: Pick<ReleaseFrontmatter, 'version'> }>(releases: readonly T[]): T[] {
  return [...releases].sort((a, b) => compareVersions(b.frontmatter.version, a.frontmatter.version));
}

/** Patch, minor and major bumps of the newest `x.y.z`; empty when versions are not of that shape. */
export function nextVersions(latest: string | undefined): string[] {
  const m = latest ? /^(v?)(\d+)\.(\d+)\.(\d+)$/.exec(latest) : null;
  if (!m) return latest ? [] : ['0.1.0', '1.0.0'];
  const [, v, maj, min, pat] = m; const n = (s: string) => Number(s);
  return [`${v}${maj}.${min}.${n(pat) + 1}`, `${v}${maj}.${n(min) + 1}.0`, `${v}${n(maj) + 1}.0.0`];
}

/** The day an item landed, if it has and the day is known (an imported item's dates are guesses). */
export function landedOn(fm: Pick<ItemFrontmatter, 'status' | 'merged_at' | 'finished_at' | 'dates_estimated'>): string | undefined {
  if ((fm.status !== 'MERGED' && fm.status !== 'FINISHED') || fm.dates_estimated) return undefined;
  return (fm.merged_at ?? fm.finished_at)?.slice(0, 10);
}

/**
 * Items that landed in this release's window and are not in any release yet. The window opens on
 * the day of the release below it and closes on this one's day once it has shipped; both ends are
 * inclusive, so work merged on a release day is offered to both until it is placed in one.
 */
export function releaseCandidates<I extends { id: string; fm: Pick<ItemFrontmatter, 'status' | 'merged_at' | 'finished_at' | 'dates_estimated'> & { release?: string } }>(
  version: string,
  releases: readonly { frontmatter: Pick<ReleaseFrontmatter, 'version' | 'status' | 'date' | 'items'> }[],
  items: readonly I[],
): I[] {
  const live = releases.filter((r) => r.frontmatter.status !== 'cancelled');
  const self = releases.find((r) => r.frontmatter.version === version)?.frontmatter;
  if (!self) return [];
  const placed = new Set(live.flatMap((r) => r.frontmatter.items));
  const below = sortReleases(live.filter((r) => compareVersions(r.frontmatter.version, version) < 0 && r.frontmatter.date))[0]?.frontmatter.date;
  const through = self.status === 'released' ? self.date : undefined;
  return items.filter((i) => {
    const day = landedOn(i.fm);
    // An item planned for a release (#375) is that release's, not a date hint for this one.
    return day !== undefined && !i.fm.release && !placed.has(i.id) && (!below || day >= below) && (!through || day <= through);
  });
}

/** Releases an item can be planned for (#375): planned or submitted, oldest version first. */
export function openReleases<R extends { frontmatter: Pick<ReleaseFrontmatter, 'version' | 'status'> }>(releases: readonly R[]): R[] {
  return sortReleases(releases.filter((r) => r.frontmatter.status === 'planned' || r.frontmatter.status === 'submitted')).reverse();
}

/**
 * The release a new item starts planned for (#375): `releases.default` as a version that is still open, or `next`, the
 * earliest planned one. Anything else (unset, shipped, cancelled, missing) is none: an item never targets a closed release by default.
 */
export function defaultRelease(setting: string | undefined, releases: readonly { frontmatter: Pick<ReleaseFrontmatter, 'version' | 'status'> }[]): string | undefined {
  if (!setting) return undefined;
  if (setting === 'next') return openReleases(releases).find((r) => r.frontmatter.status === 'planned')?.frontmatter.version;
  return openReleases(releases).find((r) => r.frontmatter.version === setting)?.frontmatter.version;
}

/**
 * What a release page lists from the items (#375): what is planned for it, and, of that, what has landed and is not in
 * its `items` yet, to offer when it is marked released (offered, never applied).
 */
export function plannedFor<I extends { id: string; fm: Pick<ItemFrontmatter, 'status'> & { release?: string } }>(
  version: string, items: readonly I[], shipped: readonly string[],
): { planned: I[]; landed: I[] } {
  const planned = items.filter((i) => i.fm.release === version);
  return { planned, landed: planned.filter((i) => (i.fm.status === 'MERGED' || i.fm.status === 'FINISHED') && !shipped.includes(i.id)) };
}

/** The whole release as one markdown document, for pasting somewhere else. */
export function releaseMarkdown(file: ReleaseFile): string {
  const fm = file.frontmatter;
  const head = `# ${fm.version}${fm.title ? ` — ${fm.title}` : ''}${fm.date ? ` (${fm.date})` : ''}`;
  const parts = file.sections.filter((s) => s.title && s.body.trim()).map((s) => `## ${s.title}\n\n${s.body.trim()}`);
  return [head, ...parts].join('\n\n') + '\n';
}
