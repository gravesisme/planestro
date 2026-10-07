import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelDef, budgetTokens, TurnTokenCounter } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import { applySwitch, previewSwitch } from '../src/providerSwitch.ts';
import { normalizeLocalUsage } from '../src/config.ts';
import type { TurnOptions, Ports, TurnResult } from '../src/engine/ports.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore; let engine: LiveEngine;
afterEach(async () => { await engine?.stop(); store?.close(); });
async function setup() {
  const fixture = makeFixture(); store = await DataStore.open(fixture.dataDir);
  const codex = ModelDef.parse({ id: 'code-agent', label: 'Code agent', runner: 'codex', codex_model: 'test-model', codex_transport: 'app-server' });
  const art = ModelDef.parse({ id: 'image-agent', label: 'Image agent', runner: 'codex' });
  store.updateConfig((d) => d.set('models', [...store.config.models, codex, art]), 'config: test models');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const calls: TurnOptions[] = [];
  const agent = { runTurn: async (o: TurnOptions): Promise<TurnResult> => {
    calls.push(o); await o.onQuestion([{ question: 'Keep these changes?' }]);
    return { sessionId: `session-${calls.length}`, subtype: 'success', isError: false, parked: 'question', costUsd: 0, numTurns: 1, tokens: 42, text: '' };
  } };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: agent, codex: agent } };
  engine = new LiveEngine(store, ports, () => {});
  engine.continueAfterProviderSwitch = () => {}; // drive each handoff turn explicitly below
  return { ...fixture, calls, world, ports };
}
describe('provider handoff', () => {
  it('round trips on the same worktree, retaining state and never resuming the original Claude session', async () => {
    const { codeRepo, calls } = await setup();
    const item = store.createItem({ title: 'Approved edits', description: 'Implement the approved change' });
    writeFileSync(join(codeRepo, 'unfinished.txt'), 'uncommitted edits');
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', worktree: codeRepo, branch: 'work/edits', session_id: 'original-claude',
      pr: 12, skip_merge: true, hold_reason: 'wait for review', budget_tokens: 321000, budget_usd: 50,
      op_data: { approval_notes: 'Keep the existing design', pending_messages: ['Keep the button blue'] } } }, { section: 'Notes', body: 'Existing context' }], 'user');
    const request = { model: 'code-agent', items: [item.id] };
    const preview = previewSwitch(store, engine, request);
    expect(preview.items[0].summary).toContain('PR #12 and its hold are kept');
    expect(applySwitch(store, engine, request).items[0].result).toBe('applied');
    expect(applySwitch(store, engine, request).items[0].result).toBe('skipped');
    await (engine as any).runTurnFor(item.id, 'implement', 'Continue');
    expect(calls[0].resume).toBeUndefined();
    expect(calls[0].prompt).toContain('Keep the existing design');
    expect(calls[0].prompt).toContain('Keep the button blue');
    store.mutateItem(item.id, [{ section: 'Notes', body: 'Codex added current findings' }], 'user');
    applySwitch(store, engine, { model: 'opus-5', items: [item.id] });
    await (engine as any).runTurnFor(item.id, 'implement', 'Answer: keep the changes');
    expect(calls[1].resume).toBeUndefined();
    expect(calls[1].prompt).toContain('Codex added current findings');
    expect(calls[1].prompt).toContain('Keep these changes?');
    expect(store.requireItem(item.id).file.frontmatter).toMatchObject({ status: 'IN_PROGRESS', worktree: codeRepo, branch: 'work/edits', pr: 12, skip_merge: true, budget_tokens: 321000, budget_usd: 50 });
    expect(readFileSync(join(codeRepo, 'unfinished.txt'), 'utf8')).toBe('uncommitted edits');
  });
  it('explains busy and taken-over items, preserving approvals and exec art assignments', async () => {
    await setup();
    const busy = store.createItem({ title: 'Busy' }); const taken = store.createItem({ title: 'Owned by user' });
    const art = store.createItem({ title: 'Art PR', implementer: 'image-agent' });
    store.mutateItem(busy.id, [{ set: { status: 'IN_PROGRESS', op: 'implement_turn' } }], 'user');
    store.mutateItem(taken.id, [{ set: { taken_over: { since: new Date().toISOString() } } }], 'user');
    store.mutateItem(art.id, [{ set: { status: 'PLAN_READY', pr: 22, awaiting: 'plan_approval', agent_sessions: { codex: { session_id: 'art-thread', role: 'implement', tool_contract: 'exec-v1', transport: 'exec' } } } }], 'user');
    const result = applySwitch(store, engine, { model: 'code-agent', items: [busy.id, taken.id, art.id] });
    expect(result.items.map((x) => x.result)).toEqual(['skipped', 'skipped', 'applied']);
    expect(result.items[0].summary).toContain('running turn or engine operation');
    expect(result.items[1].summary).toContain('hand the item back');
    expect(store.requireItem(art.id).file.frontmatter).toMatchObject({ status: 'PLAN_READY', awaiting: 'plan_approval', implementer: 'image-agent', pr: 22, agent_sessions: { codex: { session_id: 'art-thread', transport: 'exec' } } });
  });
  it('retries a partial apply without changing the already applied item again', async () => {
    await setup(); const a = store.createItem({ title: 'First' }); const b = store.createItem({ title: 'Second' });
    const mutate = store.mutateItem.bind(store);
    const spy = vi.spyOn(store, 'mutateItem').mockImplementation((id, ...args) => {
      if (id === b.id) throw new Error('temporary write failure');
      return mutate(id, ...args);
    });
    const req = { model: 'code-agent', items: [a.id, b.id] };
    expect(applySwitch(store, engine, req).items.map((i) => i.result)).toEqual(['applied', 'failed']);
    spy.mockRestore();
    expect(applySwitch(store, engine, req).items.map((i) => i.result)).toEqual(['skipped', 'applied']);
  });
  it('recovers an unapplied handoff after a pause and restart without reusing the old conversation', async () => {
    const { dataDir, codeRepo, ports, calls } = await setup();
    const item = store.createItem({ title: 'Paused work' });
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', worktree: codeRepo, branch: 'work/paused', session_id: 'old', blocked: true, blocked_reason: 'usage_exhausted', awaiting: 'user' } }], 'user');
    engine.pause();
    applySwitch(store, engine, { model: 'code-agent', items: [item.id] });
    expect(calls).toHaveLength(0);
    await engine.stop(); store.close();
    store = await DataStore.open(dataDir); engine = new LiveEngine(store, ports, () => {});
    engine.resume();
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls[0].resume).toBeUndefined();
    expect(calls[0].prompt).toContain('Paused work');
  });
  it('replays an epic breakdown report idempotently with every child argument', async () => {
    await setup();
    const item = store.createItem({ title: 'Recover breakdown', kind: 'epic' });
    const children = [{ title: 'First child', description: 'A complete first step', implementer: 'opus-5', planner: 'code-agent', hold_for_review: true }, { title: 'Second child', description: 'A complete second step', implementer: 'opus-5', depends_on: [0] }];
    const outbox = { tool: 'submit_breakdown', args: { plan: 'Two steps', children }, error: 'lost transport' };
    store.mutateItem(item.id, [{ set: { status: 'PLAN_IN_PROGRESS', op_data: { outbox } } }], 'engine');
    const r = { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '' };
    await (engine as any).ingestOutbox(item.id, r);
    const first = store.requireItem(item.id).file.frontmatter;
    expect(first).toMatchObject({ status: 'PLAN_READY', awaiting_data: { children } });
    expect(first.op_data?.outbox).toBeUndefined();
    const timestamp = first.awaiting_data?.requested_at;
    await (engine as any).ingestOutbox(item.id, { ...r, undelivered: outbox });
    expect(store.requireItem(item.id).file.frontmatter.awaiting_data?.requested_at).toBe(timestamp);
  });
  it('validates all requested ids before changing config or an earlier item', async () => {
    await setup(); const item = store.createItem({ title: 'Untouched' });
    const before = store.config.orchestrator.model;
    expect(() => applySwitch(store, engine, { model: 'code-agent', orchestrator: true, items: [item.id, 'MISSING-1'] })).toThrow();
    expect(store.config.orchestrator.model).toBe(before);
    expect(store.requireItem(item.id).file.frontmatter.planner).toBe('fable-5');
  });
});
describe('local usage compatibility and token accounting', () => {
  it('converts only usage-caused global pauses, idempotently preserving reset facts', () => {
    const guard = { resets_at: '2026-10-08T00:00:00Z', resume_at: '2026-10-08T00:01:00Z' };
    for (const paused_by of ['usage_guard', 'user', 'disk']) {
      const raw: any = { engine: { paused: true, paused_by, usage_guard: guard, usage_guard_last: guard } };
      expect(normalizeLocalUsage(raw)).toBe(true);
      expect(raw.engine.provider_guards.claude).toEqual(guard);
      expect(raw.engine.paused).toBe(paused_by !== 'usage_guard');
      expect(normalizeLocalUsage(raw)).toBe(false);
    }
  });
  it('counts uncached input plus output once across cumulative notifications and resumes', () => {
    expect(budgetTokens({ input_tokens: 100, cached_input_tokens: 200, output_tokens: 10 })).toBe(10);
    const counter = new TurnTokenCounter(60);
    const u = { inputTokens: 200, cachedInputTokens: 100, outputTokens: 20 };
    expect(counter.update(u)).toBe(60); expect(counter.update(u)).toBe(60);
    expect(counter.update({ ...u, outputTokens: 30 })).toBe(70);
  });
});
it('clears a usage decision only when it belongs to the replaced usage stop', async () => {
  const { codeRepo } = await setup();
  for (const reason of ['usage_exhausted', 'question']) {
    const item = store.createItem({ title: `Decision: ${reason}` });
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', worktree: codeRepo, blocked: true, blocked_reason: 'usage_exhausted', awaiting: 'user', awaiting_data: { decision: { reason, question: 'Continue?', requested_at: new Date().toISOString() } } } }], 'user');
    applySwitch(store, engine, { model: 'code-agent', items: [item.id] });
    const fm = store.requireItem(item.id).file.frontmatter;
    expect(fm.blocked).toBeUndefined();
    expect(fm.awaiting).toBe(reason === 'usage_exhausted' ? undefined : 'user');
    if (reason === 'question') expect(fm.awaiting_data?.decision).toMatchObject({ reason });
  }
});
it('keeps an art conversation while its planner switches, including the return to Claude', async () => {
  const { codeRepo, calls } = await setup();
  const item = store.createItem({ title: 'Existing art review', planner: 'opus-5', implementer: 'image-agent' });
  store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', worktree: codeRepo, branch: 'work/art-review', session_id: 'original-plan', agent_sessions: { codex: { session_id: 'art-thread', role: 'implement', tool_contract: 'exec-v1', transport: 'exec' } } } }], 'user');
  expect(previewSwitch(store, engine, { model: 'code-agent', items: [item.id] }).items[0].summary).toContain('future planning will start');
  applySwitch(store, engine, { model: 'code-agent', items: [item.id] });
  await (engine as any).runTurnFor(item.id, 'implement', 'Continue the art review');
  expect(calls[0].resume).toBe('art-thread');
  expect(store.requireItem(item.id).file.frontmatter.op_data?.fresh_brief).toBeUndefined();
  expect(store.requireItem(item.id).file.frontmatter.op_data?.fresh_plan).toBe(true);
  applySwitch(store, engine, { model: 'opus-5', items: [item.id] });
  store.mutateItem(item.id, [{ set: { status: 'PLAN_IN_PROGRESS' } }, { section: 'Notes', body: 'Latest art review conditions' }], 'user');
  await (engine as any).runTurnFor(item.id, 'plan', 'Revise the plan');
  expect(calls[1].resume).toBeUndefined();
  expect(calls[1].prompt).toContain('Latest art review conditions');
  expect(calls[1].prompt).toContain('Revise the plan');
  expect(store.requireItem(item.id).file.frontmatter.op_data?.fresh_plan).toBeUndefined();
  expect(store.requireItem(item.id).file.frontmatter.implementer).toBe('image-agent');
});
