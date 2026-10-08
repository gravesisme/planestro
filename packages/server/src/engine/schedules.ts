import { dueSlot, renderPrompt, scheduleContext, scheduleDescription, isDone, type ScheduleFrontmatter } from '@planestro/shared';
import type { DataStore, StoredItem } from '../store/DataStore.ts';

/**
 * Schedules (#247), from the tick while automation runs: each enabled schedule whose cron slot has
 * come files one item from its template, keyed `<schedule>:<slot>` in the item's `scheduled_from`.
 * The schedule's `last_slot` and that key are the memory: an item already filed for the slot (a
 * restart between writing it and recording it) is recorded, never filed again. A sleep across several
 * slots files the latest once. `skip_if_open` skips the slot while the item filed last is open.
 * Submitting is the user's word (#73): only a schedule `created_by: user` says `submit`.
 */
export function driveSchedules(store: DataStore, now: Date, deps: { submit: (id: string, why: string) => void; note: (level: 'info' | 'warn' | 'error', message: string) => void }): void {
  for (const s of store.listSchedules()) {
    const fm = s.file.frontmatter;
    let slot: string | undefined;
    try { slot = dueSlot(fm, now); } catch (e) { deps.note('error', `schedule ${fm.name}: ${(e as Error).message}`); continue; }
    if (!slot) continue;
    try { fileSlot(store, fm, s.file, slot, deps); } catch (e) { deps.note('error', `schedule ${fm.name}: ${(e as Error).message}`); }
  }
}

function fileSlot(store: DataStore, fm: ScheduleFrontmatter, file: Parameters<typeof scheduleDescription>[0], slot: string, deps: Parameters<typeof driveSchedules>[2]): void {
  const key = `${fm.name}:${slot}`;
  const mine = store.listItems().filter((i) => i.file.frontmatter.scheduled_from?.startsWith(`${fm.name}:`));
  const already = mine.find((i) => i.file.frontmatter.scheduled_from === key);
  if (already) { store.recordScheduleSlot(fm.name, { slot, item: already.id }); return; }
  const last = lastFiled(mine);
  if (fm.skip_if_open && last && !isDone(last.file.frontmatter.status) && last.file.frontmatter.status !== 'ICEBOX') {
    store.recordScheduleSlot(fm.name, { slot, skipped: `${last.id} from the last run is still open (${last.file.frontmatter.status})` });
    deps.note('info', `schedule ${fm.name}: skipped ${slot}; ${last.id} is still open`);
    return;
  }
  const ctx = scheduleContext(fm, slot);
  let title: string; let description: string;
  try { title = renderPrompt(fm.title, ctx, undefined, `${fm.name} title`); description = renderPrompt(scheduleDescription(file), ctx, undefined, fm.name); } catch (e) {
    store.recordScheduleSlot(fm.name, { slot, skipped: `its template would not fill in: ${(e as Error).message}` });
    deps.note('warn', `schedule ${fm.name}: skipped ${slot}: ${(e as Error).message}`);
    return;
  }
  const category = fm.category && store.config.categories.includes(fm.category) ? fm.category : undefined;
  const item = store.createItem({ title, description, kind: fm.kind, ...(category ? { category } : {}), ...(fm.priority ? { priority: fm.priority } : {}), extra: { scheduled_from: key } }, 'engine');
  store.mutateItem(item.id, [{ activity: { actor: 'app', text: `filed by schedule ${fm.name} for ${slot}` } }], 'engine');
  store.recordScheduleSlot(fm.name, { slot, item: item.id });
  deps.note('info', `schedule ${fm.name}: filed ${item.id} for ${slot}`);
  if (!fm.submit) return;
  if (fm.created_by !== 'user') { store.mutateItem(item.id, [{ activity: { actor: 'app', text: `not submitted: schedule ${fm.name} says submit, but only a schedule you made submits what it files` } }], 'engine'); return; }
  try { deps.submit(item.id, `schedule ${fm.name} submits what it files, as you set it to`); } catch (e) {
    store.mutateItem(item.id, [{ activity: { actor: 'app', text: `not submitted: ${(e as Error).message}` } }], 'engine');
  }
}

function lastFiled(items: StoredItem[]): StoredItem | undefined {
  const slotOf = (i: StoredItem) => Date.parse(i.file.frontmatter.scheduled_from!.slice(i.file.frontmatter.scheduled_from!.indexOf(':') + 1));
  return items.reduce<StoredItem | undefined>((a, b) => (!a || slotOf(b) > slotOf(a) ? b : a), undefined);
}
