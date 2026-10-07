import { it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ModelDef } from '@planestro/shared';
const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector?: (s: any) => any) => selector ? selector(fixture.current) : fixture.current, act: () => {} }));
vi.mock('../src/components/OrchestratorChat.tsx', () => ({ OrchestratorChat: () => null }));
import { SwitchProviderPage, PROVIDER_GUIDE } from '../src/pages/SwitchProvider.tsx';
import { App } from '../src/App.tsx';
function state(provider: 'claude' | 'codex') {
  const other = provider === 'claude' ? 'codex' : 'claude';
  fixture.current = {
    notes: [], notesSeen: '', connected: true, connect: () => {},
    state: { config: { project: { name: 'Synthetic project' }, orchestrator: { model: provider }, models: [
      ModelDef.parse({ id: 'claude', label: 'Claude', runner: 'claude', claude_model: 'test-claude' }),
      ModelDef.parse({ id: 'codex', label: 'Codex', runner: 'codex', codex_model: 'test-codex', codex_transport: 'app-server' }),
    ] }, local: { model_unavailable: { [provider]: { until: '2999-01-01T00:00:00Z' } } }, items: [], invalid: [], engine: { mode: 'dry-run', paused: false, sessions: [], provider_guards: {} } },
  };
  return other;
}
const render = (component: typeof App | typeof SwitchProviderPage, path: string) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(component)));
it.each(['claude', 'codex'] as const)('offers switching from exhausted %s to the available provider and preselects it', (provider) => {
  const other = state(provider);
  const banner = render(App, '/');
  expect(banner).toContain('href="/switch-provider?provider=' + other + '"');
  expect(banner).not.toContain('href="/switch-provider?provider=' + provider + '"');
  const page = render(SwitchProviderPage, '/switch-provider?provider=' + other);
  expect(page).toContain('<option value="' + other + '" selected="">');
  expect(page).toContain('Switch provider');
  expect(page).toContain('href="' + PROVIDER_GUIDE + '"');
  expect(page).toContain('No restart required.');
});

