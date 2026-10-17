import type { JournalEntry } from '@planestro/shared';
import type { DataStore } from '../store/DataStore.ts';
import type { GhPort, IssueInfo } from './ports.ts';

/**
 * The orchestrator's notes about planestro, filed as issues (#231, milestone 1). A note is a journal entry
 * (`note_planestro`); what became of it is a link entry of its own beside it (the journal is append-only), keyed by
 * the note's timestamp: the issues it became, one or several, or "handled, no issue". Filing goes to
 * `feedback.issue_repo` through the gh port, never to the project's own repo by default (invariant 5), and never
 * twice: each issue carries a hidden marker with the note's timestamp, searched for first, and a likely match (the
 * note's item and words) is offered to the user before anything new is filed.
 */
export const NOTE_TYPE = 'orchestrator.planestro_note';
export const NOTE_LINK_TYPE = 'orchestrator.planestro_note_link';
/**
 * The Console's read marker (#305): every note up to `up_to` has been read, on every device. Kept in the journal beside
 * the notes and their links (committed with the quiet checkpoint, never per click), heard by every open page as
 * `journal.appended`, and only ever moved forward.
 */
export const NOTES_SEEN_TYPE = 'orchestrator.planestro_notes_seen';
/** How many of the feedback repo's issues are searched for a marker or a likely match. */
const SEARCH_LIMIT = 1000;

export interface NoteIssue { number: number; url?: string }
export interface NoteLinks { issues: NoteIssue[]; handled: boolean; comments: string[] }
export type NoteView = JournalEntry & { links: NoteLinks };
export type FileOutcome =
  | { outcome: 'filed' | 'linked'; issue: NoteIssue }
  | { outcome: 'candidates'; candidates: { number: number; title: string; url: string; state: string }[] };

export const noteMarker = (ts: string): string => `<!-- planestro-note: ${ts} -->`;
const issueUrl = (repo: string | undefined, n: number): string | undefined => (repo ? `https://github.com/${repo}/issues/${n}` : undefined);

/** Every note with what became of it, oldest first: all of them, so the Console can reach every one it counts (#220). */
export function notesWithLinks(store: DataStore): NoteView[] {
  const all = store.journal.read({ types: [NOTE_TYPE, NOTE_LINK_TYPE] });
  const links = new Map<string, NoteLinks>();
  for (const e of all) {
    if (e.type !== NOTE_LINK_TYPE) continue;
    const key = String(e.data?.note ?? '');
    const cur = links.get(key) ?? { issues: [], handled: false, comments: [] };
    for (const i of (e.data?.issues as NoteIssue[] | undefined) ?? []) if (!cur.issues.some((x) => x.number === i.number)) cur.issues.push(i);
    if (e.data?.handled) cur.handled = true;
    if (typeof e.data?.comment === 'string' && e.data.comment) cur.comments.push(e.data.comment);
    links.set(key, cur);
  }
  const notes = all.filter((e) => e.type === NOTE_TYPE).map((e) => ({ ...e, links: links.get(e.ts) ?? { issues: [], handled: false, comments: [] } }));
  return notes;
}

/** The read marker: the latest `up_to` recorded, '' while nothing has been marked read. */
export function notesSeen(store: DataStore): string {
  let seen = '';
  for (const e of store.journal.read({ type: NOTES_SEEN_TYPE })) { const t = String(e.data?.up_to ?? ''); if (t > seen) seen = t; }
  return seen;
}

/**
 * Mark read every note up to `upTo`, held to the newest note there is so it never covers one nobody has seen. An older
 * marker than the one kept (a stale page) changes nothing and writes nothing. Returns the marker as it now stands.
 */
export function markNotesSeen(store: DataStore, upTo: string): string {
  const seen = notesSeen(store);
  const newest = store.journal.read({ type: NOTE_TYPE }).reduce((m, e) => (e.ts > m ? e.ts : m), '');
  const next = upTo > newest ? newest : upTo;
  if (next <= seen) return seen;
  store.journal.append({ type: NOTES_SEEN_TYPE, actor: 'user', data: { up_to: next } });
  return next;
}

const isDone = (l: NoteLinks): boolean => l.handled || l.issues.length > 0;
function noteAt(store: DataStore, ts: string): NoteView {
  const n = notesWithLinks(store).find((x) => x.ts === ts);
  if (!n) throw new Error(`no note at ${ts}`);
  return n;
}

const STOP = new Set('that this with from when while then than have been were into onto still would should could there their they what which after before about because only also just does doesn item items planestro note issue said says same each every other some more most such them will your here'.split(' '));
const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 4 && !STOP.has(w)));

/**
 * Issues that look like this note filed by hand: they name its item and share at least three of its words, or share
 * half of them whatever the item. Best first, at most three. Pure, for tests.
 */
export function likelyMatches(note: { ts: string; item?: string; text: string }, issues: IssueInfo[]): IssueInfo[] {
  const mine = words(note.text);
  if (!mine.size) return [];
  const itemRe = note.item ? new RegExp(`(^|[^A-Za-z0-9-])${note.item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i') : null;
  return issues
    .map((i) => {
      const hay = `${i.title}\n${i.body}`;
      const theirs = words(hay);
      const shared = [...mine].filter((w) => theirs.has(w)).length;
      const named = Boolean(itemRe?.test(hay));
      return { i, shared, likely: (named && shared >= 3) || (mine.size >= 4 && shared / mine.size >= 0.5) };
    })
    .filter((x) => x.likely)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3)
    .map((x) => x.i);
}

function titleOf(item: string | undefined, text: string): string {
  const first = text.trim().split(/\n|(?<=[.!?])\s/)[0].trim();
  const short = first.length > 90 ? `${first.slice(0, 89).trimEnd()}…` : first;
  return item && !short.includes(item) ? `${item}: ${short}` : short;
}

const filing = new Set<string>();

/**
 * File as issue. A note already linked or handled is refused. An issue carrying the note's marker is linked, not
 * filed; a likely match is offered (`candidates`) unless `force`. Otherwise the issue is created and linked.
 */
export async function fileNote(store: DataStore, gh: GhPort, ts: string, opts: { force?: boolean } = {}): Promise<FileOutcome> {
  const repo = store.config.feedback.issue_repo;
  if (!repo) throw Object.assign(new Error('feedback.issue_repo is not set: name the repo notes are filed in (Settings → Orchestrator)'), { status: 400 });
  if (!gh.issueList || !gh.issueCreate) throw Object.assign(new Error('this engine cannot file issues'), { status: 400 });
  const note = noteAt(store, ts);
  if (isDone(note.links)) throw Object.assign(new Error(note.links.issues.length ? `already filed as ${note.links.issues.map((i) => `#${i.number}`).join(', ')}` : 'already marked handled'), { status: 409 });
  const key = `${store.dataDir}\n${ts}`;
  if (filing.has(key)) throw Object.assign(new Error('already being filed'), { status: 409 });
  filing.add(key);
  try {
    const issues = await gh.issueList(repo, { limit: SEARCH_LIMIT });
    const marked = issues.find((i) => i.body.includes(noteMarker(ts)));
    if (marked) return { outcome: 'linked', issue: record(store, ts, [{ number: marked.number, url: marked.url }], 'marker')[0] };
    const text = String(note.data?.text ?? '');
    if (!opts.force) {
      const candidates = likelyMatches({ ts, item: note.item, text }, issues);
      if (candidates.length) return { outcome: 'candidates', candidates: candidates.map(({ number, title, url, state }) => ({ number, title, url, state })) };
    }
    const body = `${text.trim()}\n\n---\nFiled by planestro from an orchestrator note${note.item ? ` on ${note.item}` : ''} in ${store.config.project.name}, ${ts}.\n\n${noteMarker(ts)}\n`;
    const made = await gh.issueCreate(repo, { title: titleOf(note.item, text), body });
    return { outcome: 'filed', issue: record(store, ts, [{ number: made.number, url: made.url }], 'filed')[0] };
  } finally { filing.delete(key); }
}

function record(store: DataStore, ts: string, issues: NoteIssue[], via: string, extra: { handled?: boolean; comment?: string } = {}): NoteIssue[] {
  const note = noteAt(store, ts);
  store.journal.append({ type: NOTE_LINK_TYPE, item: note.item, actor: 'user', data: { note: ts, issues, via, ...(extra.handled ? { handled: true } : {}), ...(extra.comment ? { comment: extra.comment } : {}) } });
  return issues;
}

export interface MarkLink { note: string; issues?: number[]; handled?: boolean; comment?: string }

/**
 * Mark as handled: records issues filed by hand, or "handled, no issue", for each note named; creates nothing. One
 * call can carry many (a backfill). Every note is checked before any is recorded.
 */
export function markNotes(store: DataStore, links: MarkLink[]): void {
  const repo = store.config.feedback.issue_repo;
  const known = new Set(notesWithLinks(store).map((n) => n.ts));
  for (const l of links) {
    if (!known.has(l.note)) throw new Error(`no note at ${l.note}`);
    if (!l.issues?.length && !l.handled) throw new Error(`${l.note}: name the issues it became, or mark it handled`);
  }
  for (const l of links) record(store, l.note, (l.issues ?? []).map((number) => ({ number, url: issueUrl(repo, number) })), 'marked', { handled: l.handled, comment: l.comment?.trim() });
}
