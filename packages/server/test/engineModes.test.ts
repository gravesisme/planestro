import { describe, it, expect, afterEach } from 'vitest';
import { DataStore } from '../src/store/DataStore.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { stateView } from '../src/routes/views.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

type Mode = 'live' | 'dry-run';
/** A running engine of the given mode: the ports are built once, so it keeps that mode whatever is saved later. */
const engineIn = (s: DataStore, mode: Mode) => Object.assign(new MockEngine(s, () => {}), { mode });

describe('/api/state reports the saved and the running engine mode (#335)', () => {
  const cases: [Mode, Mode | undefined, Mode, { saved: Mode; restart_to_apply: boolean }][] = [
    ['dry-run', undefined, 'dry-run', { saved: 'dry-run', restart_to_apply: false }],
    ['live', undefined, 'dry-run', { saved: 'live', restart_to_apply: true }],      // saved live, not restarted yet
    ['live', undefined, 'live', { saved: 'live', restart_to_apply: false }],
    ['dry-run', undefined, 'live', { saved: 'dry-run', restart_to_apply: true }],
    ['live', 'dry-run', 'dry-run', { saved: 'dry-run', restart_to_apply: false }],  // this machine overrides the project
    ['live', 'dry-run', 'live', { saved: 'dry-run', restart_to_apply: true }],
    ['dry-run', 'live', 'dry-run', { saved: 'live', restart_to_apply: true }],
    ['dry-run', 'live', 'live', { saved: 'live', restart_to_apply: false }],
  ];
  it.each(cases)('configured %s, local override %s, running %s', async (configured, local, running, expected) => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    store.updateConfig((doc) => { doc.setIn(['engine', 'mode'], configured); }, 'config');
    if (local) store.updateLocal({ engine: { ...store.local.engine, mode: local } });
    const engine = engineIn(store, running);
    const want = { configured, local: local ?? null, running, ...expected };
    expect(stateView(store, engine, {}).engine).toMatchObject({ mode: running, modes: want });
    expect((await (await apiRoutes(store, engine).request('/engine')).json()).modes).toEqual(want);
  });
});
