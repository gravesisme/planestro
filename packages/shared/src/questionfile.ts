import { QuestionFrontmatter, QUESTION_KEY_ORDER, QUESTION_SECTIONS, QUESTION_ID_RE, type QuestionSection } from './schema.ts';
import { splitFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { canonicalTimestamp, isoLocal } from './timestamps.ts';
import { splitSections, demoteH1, idNumber, type Section } from './itemfile.ts';

export interface QuestionFile { frontmatter: QuestionFrontmatter; sections: Section[] }
/** `user` and `orchestrator` talk; `app` lines are planestro saying what happened (resolved when its item finished, a review that changed nothing). */
export type ThreadActor = 'user' | 'orchestrator' | 'app';
export interface ThreadEntry { at: string; actor: ThreadActor; text: string }

/** Parse a question file. Sections are the four known ones, in canonical order, plus whatever else a hand editor added. */
export function parseQuestionFile(text: string): QuestionFile {
  const { data, body } = splitFrontmatter(text);
  const parsed = QuestionFrontmatter.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid question frontmatter: ${issues}`);
  }
  const frontmatter = parsed.data;
  for (const k of ['asked_at', 'updated_at', 'resolved_at'] as const) if (frontmatter[k]) frontmatter[k] = canonicalTimestamp(frontmatter[k]!);
  const sections = splitSections(body);
  for (const title of QUESTION_SECTIONS) if (!sections.some((s) => s.title === title)) sections.push({ title, body: '' });
  const rank = (t: string) => { const i = (QUESTION_SECTIONS as readonly string[]).indexOf(t); return i < 0 ? QUESTION_SECTIONS.length : i; };
  return { frontmatter, sections: sections.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s.title) - rank(b.s.title) || a.i - b.i).map((x) => x.s) };
}

/** Empty sections keep their heading, so a hand editor sees where things go. */
export function serializeQuestionFile(file: QuestionFile): string {
  const fm = serializeFrontmatter(file.frontmatter as Record<string, unknown>, QUESTION_KEY_ORDER);
  const body = file.sections.map((s) => {
    const text = s.body.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
    if (s.title === '') return text ? `${text}\n` : '';
    return text ? `# ${s.title}\n\n${text}\n` : `# ${s.title}\n`;
  }).filter(Boolean).join('\n');
  return `${fm}\n${body}`;
}

export function getQuestionSection(file: QuestionFile, title: QuestionSection | string): string {
  return file.sections.find((s) => s.title === title)?.body ?? '';
}

export function setQuestionSection(file: QuestionFile, title: QuestionSection, body: string): void {
  const text = demoteH1(body).trim();
  const s = file.sections.find((x) => x.title === title);
  if (s) s.body = text; else file.sections.push({ title, body: text });
}

const ENTRY = /^- (\S+) \[(user|orchestrator|app)\] ?(.*)$/;

/**
 * One bullet per message: `- <ts> [actor] first line`, further lines indented two spaces, so a
 * message keeps its paragraphs and a `# heading` in it cannot end the section.
 */
export function appendThread(file: QuestionFile, actor: ThreadActor, text: string, when: string = isoLocal()): void {
  const [first, ...rest] = demoteH1(text).trim().split('\n');
  const entry = [`- ${when} [${actor}] ${first}`, ...rest.map((l) => (l.trim() ? `  ${l}` : ''))].join('\n');
  const current = getQuestionSection(file, 'Thread');
  setQuestionSection(file, 'Thread', current ? `${current}\n${entry}` : entry);
}

export function parseThread(file: QuestionFile): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  for (const line of getQuestionSection(file, 'Thread').split('\n')) {
    const m = ENTRY.exec(line);
    if (m) { out.push({ at: m[1], actor: m[2] as ThreadActor, text: m[3] }); continue; }
    const last = out.at(-1);
    if (last) last.text += `\n${line.replace(/^ {2}/, '')}`;
  }
  for (const e of out) e.text = e.text.replace(/\s+$/, '');
  return out;
}

export function isQuestionId(id: string): boolean { return QUESTION_ID_RE.test(id); }
/** `Q-7` → 7. */
export function questionNumber(id: string): number { return idNumber(id); }
