import { ScheduleFrontmatter, SCHEDULE_KEY_ORDER, SCHEDULE_HISTORY_MAX, type ScheduleHistoryEntry } from './schema.ts';
import { splitFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { canonicalTimestamp } from './timestamps.ts';
import { splitSections, demoteH1, type Section } from './itemfile.ts';
import { parseCron, prevSlot, nextSlot, isoInZone } from './cron.ts';
import { trimLineEnds } from './textScan.ts';

export interface ScheduleFile { frontmatter: ScheduleFrontmatter; sections: Section[] }

export function parseScheduleFile(text: string): ScheduleFile {
  const { data, body } = splitFrontmatter(text);
  const parsed = ScheduleFrontmatter.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid schedule frontmatter: ${issues}`);
  }
  const fm = parsed.data;
  for (const k of ['created_at', 'updated_at', 'armed_at', 'last_slot'] as const) if (fm[k]) fm[k] = canonicalTimestamp(fm[k]!);
  return { frontmatter: fm, sections: splitSections(body) };
}

export function serializeScheduleFile(file: ScheduleFile): string {
  const fm = serializeFrontmatter(file.frontmatter as Record<string, unknown>, SCHEDULE_KEY_ORDER);
  const body = file.sections.map((s) => {
    const text = trimLineEnds(s.body).trimEnd();
    if (s.title === '') return text ? `${text}\n` : '';
    return text ? `# ${s.title}\n\n${text}\n` : `# ${s.title}\n`;
  }).filter(Boolean).join('\n');
  return `${fm}\n${body}`;
}

/** The filed item's description template. */
export function scheduleDescription(file: ScheduleFile): string { return file.sections.find((s) => s.title === 'Description')?.body ?? ''; }
export function setScheduleDescription(file: ScheduleFile, body: string): void {
  const text = demoteH1(body).trim();
  const s = file.sections.find((x) => x.title === 'Description');
  if (s) s.body = text; else file.sections.push({ title: 'Description', body: text });
}

/** What a template is filled with: the slot on the schedule's clock, its date, the schedule's name. */
export function scheduleContext(fm: Pick<ScheduleFrontmatter, 'name'>, slot: string): Record<string, string> {
  return { schedule: fm.name, slot, date: slot.slice(0, 10) };
}

/** The slot to handle now, on the schedule's clock: the latest at or before `now` after both `armed_at` and `last_slot`. */
export function dueSlot(fm: ScheduleFrontmatter, now: Date): string | undefined {
  if (!fm.enabled) return undefined;
  const slot = prevSlot(parseCron(fm.cron), fm.tz, now);
  if (!slot) return undefined;
  const floor = Math.max(Date.parse(fm.armed_at), fm.last_slot ? Date.parse(fm.last_slot) : -Infinity);
  return slot.getTime() > floor ? isoInZone(slot, fm.tz) : undefined;
}

/** The next slot after `now` (and after the last one handled), for the Schedules page. */
export function nextRun(fm: ScheduleFrontmatter, now: Date): string | undefined {
  if (!fm.enabled) return undefined;
  const floor = Math.max(now.getTime(), Date.parse(fm.armed_at), fm.last_slot ? Date.parse(fm.last_slot) : -Infinity);
  const t = nextSlot(parseCron(fm.cron), fm.tz, new Date(floor));
  return t ? isoInZone(t, fm.tz) : undefined;
}

export function withHistory(history: ScheduleHistoryEntry[], entry: ScheduleHistoryEntry): ScheduleHistoryEntry[] {
  return [...history, entry].slice(-SCHEDULE_HISTORY_MAX);
}
