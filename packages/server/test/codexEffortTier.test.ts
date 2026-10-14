import { it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ModelDef, runnerTurnSettings } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunCodexPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

it('only a Codex row contributes effort and tier to a turn (#245)', () => {
  expect(runnerTurnSettings(ModelDef.parse({ id: 'c', label: 'C', runner: 'codex', codex_effort: 'medium', codex_tier: 'default' }))).toEqual({ effort: 'medium', serviceTier: 'default' });
  expect(runnerTurnSettings(ModelDef.parse({ id: 'c', label: 'C', runner: 'codex' }))).toEqual({});
  expect(runnerTurnSettings(ModelDef.parse({ id: 'a', label: 'A', claude_model: 'x', codex_effort: 'high' }))).toEqual({});
  expect(runnerTurnSettings(undefined)).toEqual({});
  expect(runnerTurnSettings(ModelDef.parse({ id: 'c', label: 'C', runner: 'codex', skills: true }))).toEqual({ skills: true });   // #238
  expect(runnerTurnSettings(ModelDef.parse({ id: 'c', label: 'C', runner: 'codex', codex_transport: 'app-server', native_images: true }))).toEqual({ nativeImages: true });   // HH-540
});

it('a worker turn carries its model row\'s reasoning effort and service tier (#245)', async () => {
  store = await DataStore.open(makeFixture().dataDir);
  mkdirSync(join(store.codeRepoPath(), '.git', 'info'), { recursive: true });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunCodexPort(world); const seen: TurnOptions[] = [];
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: inner as never, codex: { runTurn: (o: TurnOptions) => { seen.push(o); return inner.runTurn(o); } } } };
  const model = ModelDef.parse({ id: 'codex-planner', label: 'Codex planner', runner: 'codex', codex_model: 'test-model', codex_transport: 'app-server', codex_effort: 'xhigh', codex_tier: 'priority' });
  store.updateConfig((d) => d.set('models', [...store!.config.models, model]), 'config: test model');
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const item = store.createItem({ title: 'Codex plan', description: 'x', planner: model.id, implementer: model.id });
  store.transition(item.id, 'QUEUED', 'user');
  await engine.start();
  for (let i = 0; i < 250 && !seen.length; i++) await sleep(20);
  expect(seen[0]).toMatchObject({ phase: 'plan', model: 'test-model', transport: 'app-server', effort: 'xhigh', serviceTier: 'priority' });
});
