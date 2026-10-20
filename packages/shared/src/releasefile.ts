import { ReleaseFrontmatter, RELEASE_KEY_ORDER, type ReleaseSectionDef, type ItemFrontmatter } from './schema.ts';
import { splitFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { canonicalTimestamp } from './timestamps.ts';
import { splitSections, demoteH1, type Section } from './itemfile.ts';
import { trimLineEnds } from './textScan.ts';

export * from './releaseView.ts';

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
