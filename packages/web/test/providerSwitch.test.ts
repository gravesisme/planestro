import { it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ItemFrontmatter, ModelDef, SCHEMA_VERSION } from '@planestro/shared';
import type { ItemView } from '../src/api.ts';
const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector?: (s: any) => any) => selector ? selector(fixture.current) : fixture.current, act: () => {} }));
vi.mock('../src/components/OrchestratorChat.tsx', () => ({ OrchestratorChat: () => null }));
import { SwitchProviderPage, PROVIDER_GUIDE } from '../src/pages/SwitchProvider.tsx';
import { App } from '../src/App.tsx';
import { AwaitingPanels } from '../src/components/AwaitingPanels.tsx';
import { ProviderSwitchBoard } from '../src/components/ProviderSwitchBoard.tsx';
it('does not offer unusable allow actions for native sandbox requests, including legacy records', () => {
  for (const grantable of [undefined, false]) {
    const markup = renderToStaticMarkup(createElement(AwaitingPanels, { item: { id: 'TP-1', frontmatter: { awaiting: 'permission', awaiting_data: { tool: 'CodexApproval', grantable, input: {} } } } as any }));
    expect(markup).not.toContain('Allow once'); expect(markup).not.toContain('Always allow');
    expect(markup).toContain('Take over'); expect(markup).toContain('Deny');
  }
  const regular = renderToStaticMarkup(createElement(AwaitingPanels, { item: { id: 'TP-2', frontmatter: { awaiting: 'permission', awaiting_data: { tool: 'Bash', input: { command: 'npm test' } } } } as any }));
  expect(regular).toContain('Allow once'); expect(regular).toContain('Always allow');
});
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

function item(id: string, status: ItemView['frontmatter']['status'], fields = {}): ItemView {
  return { id, path: '', frontmatter: ItemFrontmatter.parse({ schema: SCHEMA_VERSION, id, title: `${status} example`, status,
    category: 'Tools', rank: 1, planner: 'claude', implementer: 'claude',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...fields }),
    derived: { lane: 'board', children: [], deps_satisfied: true, needs_you: false, external: false, flavor: 'worker' },
    sections: { Description: '', Notes: '', Plan: '', Activity: '' }, activity: [] };
}

it.each(['claude', 'codex'] as const)('separates the %s switch board from collapsed backlog and leaves future defaults alone', (provider) => {
  state(provider === 'claude' ? 'codex' : 'claude');
  fixture.current.state.items = [
    item('TP-1', 'NOT_YET_SUBMITTED'), item('TP-2', 'IN_REVIEW', { pr: 12, skip_merge: true }),
    item('TP-3', 'QUEUED'), item('TP-4', 'PLAN_IN_PROGRESS'), item('TP-5', 'PLAN_READY', { awaiting: 'plan_approval' }),
    item('TP-6', 'IN_PROGRESS'), item('TP-7', 'FINISHED'), item('TP-8', 'ICEBOX'), item('TP-9', 'MERGED'),
  ];
  const page = render(SwitchProviderPage, `/switch-provider?provider=${provider}`);
  const [active, backlog] = page.split('<details class="provider-backlog">');
  expect(backlog).toBeDefined(); // closed by default: no open attribute
  expect(active).not.toContain('TP-1');
  for (const id of ['TP-2', 'TP-3', 'TP-4', 'TP-5', 'TP-6']) expect(active).toContain(id);
  expect(backlog).toContain('TP-1');
  for (const id of ['TP-7', 'TP-8', 'TP-9']) expect(page).not.toContain(id);
  expect(page).toContain('Select only queued and underway');
  expect(page).toContain('0 items selected');
  expect(page).toContain('It never submits or approves them');
  expect(page).toContain('<input type="checkbox"/> Change defaults for new items');
  expect(active).toContain('PR #12'); expect(active).toContain('held · CI pending');
  expect(active).toContain('awaiting plan approval');
  expect(page).not.toContain('aria-roledescription="sortable"');
});

it('shows selected cards and column counts without enabling board lifecycle actions', () => {
  state('claude');
  const items = [item('TP-1', 'QUEUED'), item('TP-2', 'IN_PROGRESS'), item('TP-3', 'NOT_YET_SUBMITTED')];
  fixture.current.state.items = items;
  const page = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ProviderSwitchBoard, { items, selected: ['TP-1'], onChange: () => {} })));
  expect(page).toContain('aria-label="Select all QUEUED items" checked=""');
  expect(page).toContain('provider-select-card selected');
  expect(page).toContain('1 selected');
  expect(page).not.toContain('Queue for planning');
  expect(page).not.toContain('data-state="closed"'); // no context menu trigger
});
