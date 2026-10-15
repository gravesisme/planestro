/** How many notes the Console's planestro feedback list shows per page of older, read ones (#220). */
export const NOTE_PAGE = 30;

/** Unread: newer than the read marker, and not yet filed as an issue or marked handled (#305), which count as read. */
export function isUnread(note: { ts: string; links?: { issues: unknown[]; handled: boolean } }, seen: string): boolean {
  return note.ts > seen && !(note.links && (note.links.issues.length > 0 || note.links.handled));
}

/** The header's unread count: nothing (0) for anything but a list, so one bad response costs the badge, never the page (#350). */
export function unreadNoteCount(notes: unknown, seen: string): number {
  return Array.isArray(notes) ? notes.filter((n) => isUnread(n, seen)).length : 0;
}

/**
 * What the planestro feedback list shows (#220), from notes oldest first, newest first: every unread note (`isUnread`),
 * at least a page in all, and a page more of read ones for each of `pages` past the first. `older` is how many read
 * notes are left out, for **Show older (N)**; `newestShown` is what **Mark all read** may mark, so it never covers
 * a note nobody was shown.
 */
export function noteWindow<T extends { ts: string; links?: { issues: unknown[]; handled: boolean } }>(notes: T[], seen: string, pages: number): { shown: T[]; unread: number; older: number; newestShown?: string } {
  const newest = [...notes].reverse();
  const unread = newest.filter((n) => isUnread(n, seen)).length;
  const count = Math.min(newest.length, Math.max(unread, NOTE_PAGE) + (pages - 1) * NOTE_PAGE);
  const shown = newest.slice(0, count);
  return { shown, unread, older: newest.length - count, newestShown: shown[0]?.ts };
}
