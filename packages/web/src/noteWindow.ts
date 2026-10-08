/** How many notes the Console's planestro feedback list shows per page of older, read ones (#220). */
export const NOTE_PAGE = 30;

/**
 * What the planestro feedback list shows (#220), from notes oldest first, newest first: every unread note (newer than
 * `seen`), at least a page in all, and a page more of read ones for each of `pages` past the first. `older` is how many
 * read notes are left out, for **Show older (N)**; `newestShown` is what **Mark all read** may mark, so it never covers
 * a note nobody was shown.
 */
export function noteWindow<T extends { ts: string }>(notes: T[], seen: string, pages: number): { shown: T[]; unread: number; older: number; newestShown?: string } {
  const newest = [...notes].reverse();
  const unread = newest.filter((n) => n.ts > seen).length;
  const count = Math.min(newest.length, Math.max(unread, NOTE_PAGE) + (pages - 1) * NOTE_PAGE);
  const shown = newest.slice(0, count);
  return { shown, unread, older: newest.length - count, newestShown: shown[0]?.ts };
}
