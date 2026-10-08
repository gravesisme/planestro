import { create } from 'zustand';
import type { JournalEntry } from '@planestro/shared';
import { api, type State, type ItemView, type QuestionView, type NoteView } from './api.ts';
import { showIfNotification } from './desktopNotify.ts';
import { watchInput } from './heartbeat.ts';

/** Journal entries the orchestrator chat shows (a wake's `done` only when it answered a message). */
export const isChatEntry = (j: JournalEntry) => ['orchestrator.user_message', 'orchestrator.reply', 'orchestrator.question'].includes(j.type) || (j.type === 'orchestrator.done' && ((j.data?.events as string[] | undefined) ?? []).includes('user_message'));

const NOTES_SEEN = 'planestro.notes.seen';
const readSeen = () => { try { return localStorage.getItem(NOTES_SEEN) ?? ''; } catch { return ''; } };

interface Store {
  state?: State; error?: string; connected: boolean; events: string[];
  /** A newer UI bundle is being served, but reloading now would lose what the user is typing. */
  updateReady: boolean;
  consoles: Record<string, string[]>;
  seedConsole(id: string, lines: string[]): void;
  refresh(): Promise<void>; connect(): void; item(id: string): ItemView | undefined; flash(msg: string): void;
  /** The orchestrator chat: its thread (loaded when first opened, then kept live from the journal stream) and what it opens with. */
  chat: { open: boolean; entries?: JournalEntry[]; enabled?: boolean; item?: string; draft?: string };
  openChat(opts?: { item?: string; draft?: string }): void; closeChat(): void; loadChat(): Promise<void>;
  /** The orchestrator's suggestions about planestro (f8), newest last, and the timestamp this viewer last marked read. */
  notes: NoteView[]; notesSeen: string;
  loadNotes(): Promise<void>; markNotesRead(): void;
  /** The orchestrator's questions (#75), newest first, kept live by `question.updated`; `questionRev` bumps per id so an open question page refetches. */
  questions?: QuestionView[]; questionRev: Record<string, number>;
  loadQuestions(): Promise<void>;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let questionsTimer: ReturnType<typeof setTimeout> | undefined;
let questionsSeq = 0;
/** The live connection, for the input heartbeat (#224). */
let socket: WebSocket | undefined;

// ---- self-reload: `planestro serve --watch` rebuilds the UI, and an open page should pick it up
const BUNDLE = /\/assets\/index-[\w-]+\.js/;
const ownBundle = () => document.querySelector('script[type=module][src]')?.getAttribute('src')?.match(BUNDLE)?.[0];
/** Typing somewhere, a dialog open, or an unsaved draft: a reload would throw work away. */
const midEdit = () => Boolean(document.querySelector('.dialog, [data-dirty="true"]')) || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
async function checkForNewBundle(): Promise<void> {
  const mine = ownBundle();
  if (!mine || document.hidden) return; // the dev server has no hashed bundle; a hidden tab checks when it comes back
  try {
    const served = (await (await fetch('/index.html', { cache: 'no-store' })).text()).match(BUNDLE)?.[0];
    if (!served || served === mine) return;
    if (midEdit()) useStore.setState({ updateReady: true }); else location.reload();
  } catch { /* server restarting, or mid-build: the next check sees it */ }
}
if (typeof window !== 'undefined') {
  setInterval(() => void checkForNewBundle(), 5000);
  document.addEventListener('visibilitychange', () => void checkForNewBundle());
}

export const useStore = create<Store>((set, get) => ({
  connected: false, events: [], consoles: {}, updateReady: false, chat: { open: false }, notes: [], notesSeen: readSeen(), questionRev: {},
  openChat(opts = {}) { set({ chat: { ...get().chat, open: true, item: opts.item, draft: opts.draft } }); void get().loadChat(); },
  closeChat() { set({ chat: { ...get().chat, open: false } }); },
  async loadChat() { try { const r = await api.orchestratorChat(); set({ chat: { ...get().chat, entries: r.entries, enabled: r.enabled } }); } catch { /* the panel says it could not load */ } },
  async loadNotes() { try { set({ notes: await api.orchestratorNotes() }); } catch { /* the Console says so when it loads */ } },
  markNotesRead() { const last = get().notes.at(-1)?.ts ?? ''; try { localStorage.setItem(NOTES_SEEN, last); } catch { /* private window: the badge comes back */ } set({ notesSeen: last }); },
  // Only the newest request's answer is kept: an older one that returns late would bring back a stale list.
  async loadQuestions() { const n = ++questionsSeq; try { const questions = await api.questions(); if (n === questionsSeq) set({ questions }); } catch { /* the Console keeps what it had */ } },
  seedConsole(id, lines) { set({ consoles: { ...get().consoles, [id]: lines } }); },
  async refresh() {
    try { set({ state: await api.state(), error: undefined }); } catch (e) { set({ error: (e as Error).message }); }
  },
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    if (!socket) watchInput(() => socket);
    socket = ws;
    ws.onopen = () => { set({ connected: true }); void get().refresh(); void get().loadNotes(); void get().loadQuestions(); void checkForNewBundle(); };
    ws.onclose = () => { set({ connected: false }); setTimeout(() => get().connect(), 2000); };
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      const appendConsole = (id: string, line: string) => { const cur = get().consoles[id] ?? []; set({ consoles: { ...get().consoles, [id]: [...cur.slice(-799), `${new Date().toTimeString().slice(0, 8)}  ${line}`] } }); };
      if (e.type === 'session.started') appendConsole(e.id, `── session ${e.session_id ? e.session_id.slice(0, 8) + ' ' : ''}turn started ──`);
      if (e.type === 'session.output') for (const l of String(e.text).split('\n')) if (l.trim()) appendConsole(e.id, l);
      if (e.type === 'session.ended') appendConsole(e.id, `── turn ended (${e.subtype ?? 'success'}) ──`);
      if (e.type === 'engine.log' && e.item) appendConsole(e.item, `[engine] ${e.message}`);
      if (e.type === 'engine.log') set({ events: [...get().events.slice(-199), `${e.level}: ${e.message}`] });
      if (e.type === 'question.updated') {
        set({ questionRev: { ...get().questionRev, [e.id]: (get().questionRev[e.id] ?? 0) + 1 } });
        clearTimeout(questionsTimer); questionsTimer = setTimeout(() => void get().loadQuestions(), 120);
        return;
      }
      if (e.type === 'journal.appended') {
        showIfNotification(e.entry);
        if (e.entry?.type === 'orchestrator.planestro_note') set({ notes: [...get().notes.slice(-199), e.entry] });
        if (e.entry?.type === 'orchestrator.planestro_note_link') void get().loadNotes();
        const c = get().chat; if (c.entries && isChatEntry(e.entry) && !c.entries.some((x) => x.ts === e.entry.ts && x.type === e.entry.type)) set({ chat: { ...c, entries: [...c.entries.slice(-199), e.entry] } });
        return;
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void get().refresh(), 120);
    };
  },
  item(id) { return get().state?.items.find((i) => i.id === id); },
  flash(msg) { set({ events: [...get().events.slice(-199), msg] }); },
}));

/** Run a mutation, surfacing errors in the header, then refresh. */
export async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { const r = await fn(); await useStore.getState().refresh(); return r; }
  catch (e) { useStore.setState({ error: (e as Error).message }); setTimeout(() => useStore.setState({ error: undefined }), 6000); return undefined; }
}
