import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModelDef } from '@planestro/shared';
import { DataStore } from '../packages/server/src/store/DataStore.ts';
import { LiveEngine } from '../packages/server/src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../packages/server/src/engine/dryrun-ports.ts';
import { CodexAppServerPort, Connection, isolatedCodexHome } from '../packages/server/src/engine/sessions/CodexAppServerPort.ts';
import type { TurnOptions, CustomTurnOptions, TurnResult, Ports } from '../packages/server/src/engine/ports.ts';
import { makeFixture } from '../packages/server/test/helpers.ts';

const fixture = makeFixture({ git: false });
const scratch = mkdtempSync(join(tmpdir(), 'planestro-representative-'));
const home = isolatedCodexHome(join(scratch, 'home'));
const bin = process.env.PLANESTRO_CODEX_BIN ?? 'codex';
const model = process.env.PLANESTRO_CODEX_MODEL ?? 'gpt-6-astra';
const store = await DataStore.open(fixture.dataDir);
const measurements: unknown[] = [];
const port = new CodexAppServerPort(bin, home);
const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
const measured = async (role: string, call: () => Promise<TurnResult>) => {
  const r = await call(); measurements.push({ role, tokens: r.tokens, context: r.contextTokens, subtype: r.subtype, error: r.error, plan: Boolean(r.planSubmitted), toolsLost: Boolean(r.connectionDrop) });
  return r;
};
const agents = { claude: { runTurn: async () => { throw new Error('Claude must never start'); } }, codex: {
  runTurn: (o: TurnOptions) => measured('fresh planning turn', () => port.runTurn({ ...o, signal: AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(120000)]) })),
  runCustomTurn: (o: CustomTurnOptions) => measured('fresh orchestrator wake', () => port.runCustomTurn({ ...o, signal: AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(120000)]) })),
} };
const ports: Ports = { mode: 'live', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents };
const engine = new LiveEngine(store, ports, () => {});
try {
  const def = ModelDef.parse({ id: 'validation-model', label: 'Validation model', runner: 'codex', codex_model: model, codex_transport: 'app-server' });
  store.updateConfig((d) => { d.set('models', [def]); d.setIn(['orchestrator','model'], def.id); d.setIn(['orchestrator','triage'], false); d.setIn(['defaults','planner'],def.id); d.setIn(['defaults','implementer'],def.id); d.setIn(['code_repo','path'],resolve('.')); }, 'config: disposable validation');
  for (const title of ['Approved uncommitted edits', 'Held PR awaiting review', 'Plan needs user approval', 'Dependent change']) store.createItem({ title, description: 'Synthetic backlog context for a representative fresh wake. Preserve existing decisions and explain next steps.' });
  await (engine.orchestrator as any).runWake([{ type: 'user_message', data: { message: 'Inspect the synthetic backlog through your tools and read packages/shared/src/schema.ts and packages/server/src/engine/orchestrator.ts. Tell me in one paragraph how review decisions are preserved. Do not change items or create work. Reply through reply_to_user, then done_with_wake.' } }]);
  const item = store.createItem({ title: 'Configurable run-view excerpt limit', description: 'Plan a configurable line limit for orchestrator run-view log excerpts. Read the shared schema and settings, the orchestrator and GitHub ports, and relevant tests before submitting a concise implementation plan. Preserve project neutrality. Do not implement.' });
  store.mutateItem(item.id, [{ set: { status: 'PLAN_IN_PROGRESS', worktree: resolve('.'), branch: 'validation-only' } }], 'user');
  await (engine as any).runTurnFor(item.id, 'plan', store.renderPrompt('plan-item', store.requireItem(item.id)), [], [], { opener: true });
  const rpc = new Connection(bin, home, home);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'planestro-validation', version: '1' }, capabilities: { experimentalApi: true } });
    const rates = await rpc.request('account/rateLimits/read', {});
    console.log(JSON.stringify({ stage: 'rate-limit-shape', topLevelKeys: Object.keys(rates), readings: rates.rateLimits ? { ...rates.rateLimits, credits: undefined } : undefined }));
  } catch (e) { console.log(JSON.stringify({ stage: 'rate-limit-read', error: String(e) })); } finally { await rpc.stop(); }
  const emptyHome = isolatedCodexHome(join(scratch,'unauthenticated'), false);
  const unauth = new CodexAppServerPort(bin, emptyHome, false);
  const r = await unauth.runCustomTurn({ label: 'authentication failure', cwd: scratch, model, permissionMode: 'dontAsk', allowedTools: [], mcpTools: [], systemAppend: 'Reply OK.', prompt: 'Reply OK.', signal: AbortSignal.timeout(20000), onOutput: () => {} });
  console.log(JSON.stringify({ stage: 'isolated-no-login', subtype: r.subtype, error: r.error }));
  console.log(JSON.stringify({ measurements }));
} finally { await engine.stop(); store.close(); rmSync(scratch,{ recursive:true,force:true }); rmSync(fixture.root,{ recursive:true,force:true }); }
