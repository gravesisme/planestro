import { create } from 'zustand';
import { api, type State, type ItemView } from './api.ts';

interface Store {
  state?: State; error?: string; connected: boolean; events: string[];
  refresh(): Promise<void>; connect(): void; item(id: string): ItemView | undefined; flash(msg: string): void;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<Store>((set, get) => ({
  connected: false, events: [],
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
