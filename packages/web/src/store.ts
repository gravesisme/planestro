import { create } from 'zustand';
import { api, type State, type ItemView } from './api.ts';

interface Store {
  state?: State; error?: string; connected: boolean; events: string[];
  /** A newer UI bundle is being served, but reloading now would lose what the user is typing. */
  updateReady: boolean;
  consoles: Record<string, string[]>;
  seedConsole(id: string, lines: string[]): void;
  refresh(): Promise<void>; connect(): void; item(id: string): ItemView | undefined; flash(msg: string): void;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

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
  connected: false, events: [], consoles: {}, updateReady: false,
  seedConsole(id, lines) { set({ consoles: { ...get().consoles, [id]: lines } }); },
  async refresh() {
    try { set({ state: await api.state(), error: undefined }); } catch (e) { set({ error: (e as Error).message }); }
  },
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { set({ connected: true }); void get().refresh(); void checkForNewBundle(); };
    ws.onclose = () => { set({ connected: false }); setTimeout(() => get().connect(), 2000); };
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      const appendConsole = (id: string, line: string) => { const cur = get().consoles[id] ?? []; set({ consoles: { ...get().consoles, [id]: [...cur.slice(-799), `${new Date().toTimeString().slice(0, 8)}  ${line}`] } }); };
      if (e.type === 'session.started') appendConsole(e.id, `── session ${e.session_id ? e.session_id.slice(0, 8) + ' ' : ''}turn started ──`);
      if (e.type === 'session.output') for (const l of String(e.text).split('\n')) if (l.trim()) appendConsole(e.id, l);
      if (e.type === 'session.ended') appendConsole(e.id, `── turn ended (${e.subtype ?? 'success'}) ──`);
      if (e.type === 'engine.log' && e.item) appendConsole(e.item, `[engine] ${e.message}`);
      if (e.type === 'engine.log') set({ events: [...get().events.slice(-199), `${e.level}: ${e.message}`] });
      if (e.type === 'journal.appended') return;
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
