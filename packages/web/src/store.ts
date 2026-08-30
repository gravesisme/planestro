import { create } from 'zustand';
import { api, type State, type ItemView } from './api.ts';

interface Store {
  state?: State; error?: string; connected: boolean; events: string[];
  consoles: Record<string, string[]>;
  seedConsole(id: string, lines: string[]): void;
  refresh(): Promise<void>; connect(): void; item(id: string): ItemView | undefined; flash(msg: string): void;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<Store>((set, get) => ({
  connected: false, events: [], consoles: {},
  seedConsole(id, lines) { set({ consoles: { ...get().consoles, [id]: lines } }); },
  async refresh() {
    try { set({ state: await api.state(), error: undefined }); } catch (e) { set({ error: (e as Error).message }); }
  },
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { set({ connected: true }); void get().refresh(); };
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
