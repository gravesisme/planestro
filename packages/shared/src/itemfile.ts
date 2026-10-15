import { ItemFrontmatter, ITEM_KEY_ORDER, SECTION_TITLES, type SectionTitle } from './schema.ts';
import { splitFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { canonicalTimestamp, isoLocal } from './timestamps.ts';

export interface Section { title: string; body: string }
export interface ItemFile { frontmatter: ItemFrontmatter; sections: Section[] }

const H1 = /^# (.+?)\s*$/;

/** Parse an item file. Throws with a readable message on schema violations. */
export function parseItemFile(text: string): ItemFile {
  const { data, body } = splitFrontmatter(text);
  const parsed = ItemFrontmatter.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid frontmatter: ${issues}`);
  }
  const frontmatter = parsed.data;
  for (const k of Object.keys(frontmatter)) if (k.endsWith('_at') && typeof (frontmatter as any)[k] === 'string') (frontmatter as any)[k] = canonicalTimestamp((frontmatter as any)[k]);
  for (const a of frontmatter.attachments) a.added_at = canonicalTimestamp(a.added_at);
  return { frontmatter, sections: parseSections(body) };
}

export function parseSections(body: string): Section[] {
  return ensureKnownSections(splitSections(body));
}

/** `# Heading` blocks in file order; text before the first heading is an untitled section. */
export function splitSections(body: string): Section[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;
  let preamble: string[] = [];
  for (const line of lines) {
    const m = H1.exec(line);
    if (m) { current = { title: m[1], body: '' }; sections.push(current); continue; }
    if (current) current.body += (current.body ? '\n' : '') + line; else preamble.push(line);
  }
  if (preamble.join('\n').trim()) sections.unshift({ title: '', body: preamble.join('\n') });
  for (const s of sections) s.body = s.body.replace(/\s+$/, '').replace(/^\n+/, '');
  return sections;
}

/** Missing canonical sections are inserted in canonical order; unknown sections keep their place. */
export function ensureKnownSections(sections: Section[]): Section[] {
  const out = [...sections];
  let insertAt = out.findIndex((s) => s.title !== '');
  if (insertAt < 0) insertAt = out.length;
  for (const title of SECTION_TITLES) {
    const idx = out.findIndex((s) => s.title === title);
    if (idx >= 0) { insertAt = idx + 1; continue; }
    out.splice(insertAt, 0, { title, body: '' });
    insertAt += 1;
  }
  return out;
}

export function serializeItemFile(file: ItemFile): string {
  const fm = serializeFrontmatter(file.frontmatter as Record<string, unknown>, ITEM_KEY_ORDER);
  const sections = ensureKnownSections(file.sections);
  const body = sections.map((s) => {
    const text = s.body.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
    if (s.title === '') return text ? `${text}\n` : '';
    return text ? `# ${s.title}\n\n${text}\n` : `# ${s.title}\n`;
  }).filter(Boolean).join('\n');
  return `${fm}\n${body}`;
}

export function getSection(file: ItemFile, title: SectionTitle | string): string {
  return file.sections.find((s) => s.title === title)?.body ?? '';
}

/** H1 is the section delimiter, so any `# heading` inside a body is demoted to `##`. */
export function demoteH1(body: string): string {
  return body.replace(/^# (?=\S)/gm, '## ');
}

export function setSection(file: ItemFile, title: SectionTitle | string, body: string): void {
  const text = demoteH1(body).trim();
  const s = file.sections.find((x) => x.title === title);
  if (s) s.body = text; else file.sections.push({ title, body: text });
}

/** `operator`: the user's own supervising session, through the operator MCP (#365). */
export type ActivityActor = 'user' | 'app' | 'orchestrator' | 'worker' | 'operator';

/** Append one bullet to `# Activity`: `- <ts> [actor] text` (single line; newlines become spaces). */
export function appendActivity(file: ItemFile, actor: ActivityActor, text: string, when: string = isoLocal()): void {
  const line = `- ${when} [${actor}] ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
  const current = getSection(file, 'Activity');
  setSection(file, 'Activity', current ? `${current}\n${line}` : line);
}

export interface ActivityEntry { at: string; actor: string; text: string }
export function parseActivity(file: ItemFile): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const line of getSection(file, 'Activity').split('\n')) {
    const m = /^- (\S+) \[([a-z]+)\] (.*)$/.exec(line);
    if (m) out.push({ at: m[1], actor: m[2], text: m[3] });
  }
  return out;
}

/** Numeric part of an id (`HH-143` → 143). */
export function idNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf('-') + 1));
}

export function slugify(title: string, max = 40): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s.slice(0, max).replace(/-+$/, '') || 'item');
}
