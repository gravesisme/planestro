import { it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelDef } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { Orchestrator, type OrchestratorHooks } from '../src/engine/orchestrator.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { CustomTurnOptions, Ports, TurnResult } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore; let orchestrator: Orchestrator;
afterEach(async () => { await orchestrator?.stop(); store?.close(); });
const result: TurnResult = { sessionId: 'conversation', subtype: 'success', costUsd: 0, numTurns: 1, text: '', isError: false };
async function setup(run: (o: CustomTurnOptions) => Promise<TurnResult>) {
  const f = makeFixture(); store = await DataStore.open(f.dataDir);
  store.updateConfig((d) => d.set('models', [...store.config.models, ModelDef.parse({ id: 'general-codex', label: 'General Codex', runner: 'codex', codex_model: 'test-model', codex_transport: 'app-server' })]), 'config: test model');
  const hooks = { planDelegated: () => false, planReviewEnded: vi.fn(), permissionReviewEnded: vi.fn(), triageEnded: vi.fn() } as unknown as OrchestratorHooks;
  const world = new FakeWorld(() => {});
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: { runTurn: async () => result, runCustomTurn: run }, codex: { runTurn: async () => result, runCustomTurn: run } } };
  let paused = true;
  orchestrator = new Orchestrator(store, ports, hooks, () => {}, () => {}, () => paused);
  return { ...f, hooks, ports, go: () => { paused = false; orchestrator.kick(); } };
}
async function settled() { for (let i = 0; i < 200 && orchestrator.busy; i++) await sleep(5); expect(orchestrator.busy).toBe(false); }

it('capped wakes run existing end hooks, journal tokens, and discard the batch without replay', async () => {
  const calls: CustomTurnOptions[] = [];
  const { hooks, dataDir, go } = await setup(async (o) => { calls.push(o); return { ...result, subtype: 'token_cap', isError: true, tokens: 200010 }; });
  const item = store.createItem({ title: 'Synthetic review' });
  orchestrator.wake({ type: 'plan_review', item: item.id });
  orchestrator.wake({ type: 'permission_request', item: item.id });
  go(); await settled();
  expect(hooks.planReviewEnded).toHaveBeenCalledWith(item.id);
  expect(hooks.permissionReviewEnded).toHaveBeenCalledWith(item.id);
  expect(hooks.triageEnded).toHaveBeenCalledWith(item.id);
  expect(orchestrator.reviewing(item.id)).toBe(false);
  orchestrator.kick(); await settled(); expect(calls).toHaveLength(1);
  expect(calls[0].maxTokens).toBe(200000);
  expect(store.journal.read({ type: 'orchestrator.done' })[0].data).toMatchObject({ subtype: 'token_cap', tokens: 200010, token_cap: 200000 });
  expect(readFileSync(join(dataDir, '.planestro/orchestrator.yml'), 'utf8')).not.toMatch(/events|queue|batch/);
});

it('a busy wake finishes on its snapshot; the next provider starts fresh and switching back also rotates', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: CustomTurnOptions[] = [];
  const { go } = await setup(async (o) => { calls.push(o); if (calls.length === 1) await gate; return { ...result, sessionId: 's' + calls.length }; });
  orchestrator.wake({ type: 'user_message', data: { text: 'first' } }); go();
  for (let i = 0; i < 100 && calls.length === 0; i++) await sleep(5);
  store.updateConfig((d) => d.setIn(['orchestrator', 'model'], 'general-codex'), 'config: switch');
  expect(orchestrator.selection.pending).toBe(true);
  orchestrator.wake({ type: 'user_message', data: { text: 'second' } });
  release(); await settled();
  expect(calls.map((o) => o.model)).toEqual(['claude-fable-5', 'test-model']);
  expect(calls[1].resume).toBeUndefined(); expect(calls[1].maxTokens).toBe(200000);
  orchestrator.wake({ type: 'user_message', data: { text: 'third' } }); await settled();
  expect(calls[2].resume).toBe('s2'); expect(calls[2].maxTokens).toBe(50000);
  store.updateConfig((d) => d.setIn(['orchestrator', 'model'], 'fable-5'), 'config: switch back');
  orchestrator.wake({ type: 'user_message', data: { text: 'fourth' } }); await settled();
  expect(calls[3].resume).toBeUndefined();
});
it('inspects item and outside PRs through project-scoped GitHub ports', async () => {
  const { ports, hooks, go } = await setup(async (o) => {
    const tool = (name: string) => o.mcpTools.find((t) => t.name === name)!;
    await tool('pr_view').handler({ pr: 77 });
    await tool('pr_diff').handler({ pr: 77 });
    await tool('run_view').handler({ id: store.listItems()[0].id });
    return result;
  });
  hooks.ciWorkflow = 'Project checks';
  store.updateConfig((d) => d.setIn(['code_repo', 'github'], 'example/project'), 'config: fixture repo');
  const details = vi.fn(async () => 'description and reviews'); ports.gh.prDetails = details;
  const diff = vi.fn(async () => 'diff'); ports.gh.prDiff = diff;
  vi.spyOn(ports.gh, 'prView').mockResolvedValue({ number: 9, headRefName: 'work', headRefOid: 'abc' } as any);
  const ci = vi.spyOn(ports.gh, 'ciForSha').mockResolvedValue({ state: 'failure', runId: 55 } as any);
  const logs = vi.spyOn(ports.gh, 'runFailedLog').mockResolvedValue('failed step');
  const item = store.createItem({ title: 'Project check' });
  store.mutateItem(item.id, [{ set: { pr: 9 } }], 'user');
  orchestrator.wake({ type: 'user_message', data: { text: 'Inspect the PRs' } }); go(); await settled();
  expect(details).toHaveBeenCalledWith(store.config.code_repo.github, 77);
  expect(diff).toHaveBeenCalledWith(store.config.code_repo.github, 77);
  expect(ci).toHaveBeenCalledWith(store.config.code_repo.github, 'work', 'abc', 'Project checks');
  expect(logs).toHaveBeenCalledWith(store.config.code_repo.github, 55, 120);
});
