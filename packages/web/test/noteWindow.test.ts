import { describe, expect, it } from 'vitest';
import { NOTE_PAGE, noteWindow } from '../src/noteWindow.ts';

/** The Console's planestro feedback list (#220): every unread note is shown, older read ones a page at a time. */
const at = (i: number) => `2026-09-${String(1 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
const notes = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: at(i) }));

describe('the planestro feedback list (#220)', () => {
  it('shows all 63 unread notes, newest first, even past a page', () => {
    const all = notes(100); const seen = all[36].ts; // 63 newer than the marker
    const w = noteWindow(all, seen, 1);
    expect(w.unread).toBe(63);
    expect(w.shown.filter((n) => n.ts > seen)).toHaveLength(63);
    expect(w.shown[0].ts).toBe(all[99].ts);
    expect(w.newestShown).toBe(all[99].ts);
  });

  it('names how many older read notes are left out, and shows them a page at a time', () => {
    const all = notes(100); const seen = all[36].ts;
    expect(noteWindow(all, seen, 1).older).toBe(37);
    const two = noteWindow(all, seen, 2);
    expect(two.shown).toHaveLength(63 + (2 * NOTE_PAGE - 63));
    expect(two.older).toBe(100 - two.shown.length);
    const all3 = noteWindow(all, seen, 4);
    expect(all3.shown).toHaveLength(100);
    expect(all3.older).toBe(0);
  });

  it('shows a page of read notes when nothing is unread', () => {
    const all = notes(100);
    const w = noteWindow(all, all[99].ts, 1);
    expect(w.unread).toBe(0);
    expect(w.shown).toHaveLength(NOTE_PAGE);
    expect(w.older).toBe(100 - NOTE_PAGE);
  });
});
