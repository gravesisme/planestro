import { describe, it, expect, afterEach } from 'vitest';
import { ModelDef, getSection } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { TurnOptions, Ports, TurnResult } from '../src/engine/ports.ts';
import { makeFixture } from './helpers.ts';

// #366 (HH-538): an app-server Codex row carries its MCP servers through planestro's bridge; a resumed thread keeps the
// tools it started with, so a different set starts a fresh one; planners make no paid calls on either runner.
let store: DataStore; let engine: LiveEngine;
afterEach(async () => { await engine?.stop(); store?.close(); });
async function setup() {
  const fixture = makeFixture(); store = await DataStore.open(fixture.dataDir);
  const codex = ModelDef.parse({ id: 'codex-sound', label: 'Codex sound', runner: 'codex', codex_model: 'test-model', codex_transport: 'app-server', mcp: ['ElevenLabs'], mcp_calls_per_item: 2 });
  store.updateConfig((d) => d.set('models', [...store.config.models, codex]), 'config: test models');
  store.updateLocal({ mcp_servers: { ElevenLabs: { command: 'uvx', args: ['elevenlabs-mcp'], env: { ELEVENLABS_API_KEY: 'k' } } } } as any);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const calls: TurnOptions[] = []; const seen: string[] = [];
  const agent = { runTurn: async (o: TurnOptions): Promise<TurnResult> => {
    calls.push(o);
    if (o.mcpServers?.ElevenLabs) for (let i = 0; i < 3; i++) seen.push((await o.onPermission({ tool: 'mcp__ElevenLabs__text_to_sound_effects', input: { text: 'a staff whoosh' } })).action);
    await o.onQuestion([{ question: 'Which take?' }]);
    return { sessionId: o.resume ?? `thread-${calls.length}`, subtype: 'success', isError: false, parked: 'question', costUsd: 0, numTurns: 1, tokens: 42, text: '' };
  } };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: agent, codex: agent } };
  engine = new LiveEngine(store, ports, () => {});
  return { ...fixture, calls, seen };
}
const fm = (id: string) => store.requireItem(id).file.frontmatter;

describe('MCP servers on a Codex app-server row (#366)', () => {
  it('offers the servers, counts calls against the cap, and records them on the thread', async () => {
    const { codeRepo, calls, seen } = await setup();
    const item = store.createItem({ title: 'Staff sounds', implementer: 'codex-sound', planner: 'codex-sound' });
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', worktree: codeRepo, branch: 'work/sounds' } }], 'user');
    await (engine as any).runTurnFor(item.id, 'implement', 'Generate the takes');
    expect(calls[0].mcpServers).toEqual({ ElevenLabs: { command: 'uvx', args: ['elevenlabs-mcp'], env: { ELEVENLABS_API_KEY: 'k' } } });
    expect(seen).toEqual(['allow', 'allow', 'deny']);
    expect((fm(item.id).op_data as any).mcp_calls).toEqual({ ElevenLabs: 3 });
    expect(fm(item.id).agent_sessions?.codex).toMatchObject({ session_id: 'thread-1', mcp: ['ElevenLabs'] });
  });

  it('resumes a thread whose tools still match, and starts a fresh one when the row carries different servers', async () => {
    const { codeRepo, calls } = await setup();
    const item = store.createItem({ title: 'Staff sounds', description: 'Generate staff sounds', implementer: 'codex-sound', planner: 'codex-sound' });
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', worktree: codeRepo, branch: 'work/sounds', mcp_budget: 50 } }], 'user');
    await (engine as any).runTurnFor(item.id, 'implement', 'Generate the takes');
    await (engine as any).runTurnFor(item.id, 'implement', 'Carry on');
    expect(calls[1].resume).toBe('thread-1');
    expect(fm(item.id).agent_sessions?.codex?.mcp).toEqual(['ElevenLabs']);
    // A thread started before the row had the server (the HH-538 switch): its tools never included it.
    store.mutateItem(item.id, [{ set: { agent_sessions: { codex: { session_id: 'old-thread', role: 'implement', tool_contract: 'app-server-v1', transport: 'app-server' } } } }], 'user');
    await (engine as any).runTurnFor(item.id, 'implement', 'Carry on');
    expect(calls[2].resume).toBeUndefined();
    expect(calls[2].mcpServers?.ElevenLabs).toBeDefined();
    expect(getSection(store.requireItem(item.id).file, 'Activity')).toContain('that thread was started with MCP servers none and Codex sound now has ElevenLabs; a resumed thread keeps the tools it started with');
    expect(fm(item.id).agent_sessions?.codex).toMatchObject({ session_id: 'thread-3', mcp: ['ElevenLabs'] });
  });

  it('gives a planner no MCP servers, on either runner', async () => {
    const { codeRepo, calls } = await setup();
    const item = store.createItem({ title: 'Staff sounds', description: 'Generate the staff sounds with ElevenLabs', implementer: 'codex-sound', planner: 'codex-sound' });
    store.mutateItem(item.id, [{ set: { status: 'PLAN_IN_PROGRESS', worktree: codeRepo, branch: 'work/sounds' } }], 'user');
    await (engine as any).runTurnFor(item.id, 'plan', 'Plan it');
    expect(calls[0].mcpServers).toBeUndefined();
    expect(fm(item.id).blocked).toBeFalsy();
    expect(fm(item.id).agent_sessions?.codex?.mcp).toEqual([]);
  });

  it("tells a planner when the request names a server its implementer lacks (HH-538)", async () => {
    const { codeRepo, calls } = await setup();
    const item = store.createItem({ title: 'Staff sounds', description: 'Generate and audition the staff sounds with ElevenLabs (up to 24 takes).', implementer: 'opus-5', planner: 'codex-sound' });
    store.mutateItem(item.id, [{ set: { status: 'PLAN_IN_PROGRESS', worktree: codeRepo, branch: 'work/sounds' } }], 'user');
    await (engine as any).runTurnFor(item.id, 'plan', 'Plan it');
    expect(calls[0].prompt).toContain('The request names ElevenLabs (MCP), which');
    expect(calls[0].prompt).toContain('mcp__<server>__<tool>');
  });
});
