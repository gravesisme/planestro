import { afterEach, expect, it, vi } from 'vitest';
import { ModelDef } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { itemModelSwitchOps } from '../src/providerSwitch.ts';
import { itemView } from '../src/routes/views.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore;
let engine: LiveEngine;
afterEach(async () => { await engine?.stop(); store?.close(); });
const success: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
async function until(f: () => boolean) { for (let n = 0; !f(); n++) { if (n > 300) throw new Error('not settled'); await sleep(5); } }
async function setup(run?: (o: TurnOptions) => Promise<TurnResult>) {
  const fixture = makeFixture(); store = await DataStore.open(fixture.dataDir);
  store.updateConfig((d) => {
    d.set('models', [...store.config.models, ModelDef.parse({ id: 'codex-general', label: 'Codex', runner: 'codex', codex_transport: 'app-server' }), ModelDef.parse({ id: 'outside', label: 'Outside', external: true })]);
    d.setIn(['concurrency', 'runner_limits'], { claude: 1, codex: 1 });
  }, 'config: test runners');
  const calls: TurnOptions[] = [];
  const agent = { runTurn: async (o: TurnOptions): Promise<TurnResult> => {
    calls.push(o);
    if (run) return run(o);
    await o.onQuestion([{ question: 'Review current work?' }]);
    return { ...success, parked: 'question', sessionId: 'new-session' };
  } };
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: agent, codex: agent } };
  engine = new LiveEngine(store, ports, () => {});
  const item = (extra = {}) => {
    const i = store.createItem({ title: 'Synthetic continuation' });
    store.mutateItem(i.id, [{ set: { status: 'IN_PROGRESS', branch: 'work/synthetic', worktree: fixture.codeRepo, session_id: 'prior-session', ...extra } }], 'engine');
    return i.id;
  };
  const restart = async () => {
    await engine.stop(); store.close(); store = await DataStore.open(fixture.dataDir);
    engine = new LiveEngine(store, ports, () => {});
    await (engine as any).resumeInterrupted();
  };
  return { ...fixture, ports, calls, item, restart };
}

it.each(['pause', 'drain', 'guard'] as const)('keeps a slot-waiting CI instruction across %s and restart', async (reason) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const ctx = await setup(async (o) => {
    if (first) { first = false; await gate; }
    await o.onQuestion([{ question: 'Review?' }]);
    return { ...success, parked: 'question' };
  });
  const a = ctx.item(), b = ctx.item();
  const active = (engine as any).runTurnFor(a, 'implement', 'first');
  await until(() => ctx.calls.length === 1);
  const waiting = (engine as any).runTurnFor(b, 'fix', 'Fix ONLY the failing parser test', ['Bash(npm test)'], ['npm test'], { fresh: 'auto' });
  await until(() => engine.sessions().some((s) => s.item === b));
  if (reason === 'pause') engine.pause();
  else if (reason === 'drain') engine.drain();
  else (engine as any).usageSeen({ status: 'rejected', window: 'five_hour', resetsAt: new Date(Date.now() + 60000).toISOString() });
  release(); await Promise.all([active, waiting]);
  expect(ctx.calls).toHaveLength(1);
  expect(store.requireItem(b).file.frontmatter.op).toBeUndefined();
  expect(store.requireItem(b).file.frontmatter.op_data?.pending_turn).toMatchObject({ phase: 'fix', prompt: 'Fix ONLY the failing parser test', oneShotCommands: ['npm test'] });
  await ctx.restart();
  if (reason === 'guard') engine.retryProvider('claude');
  engine.resume();
  await until(() => ctx.calls.length === 2);
  expect(ctx.calls[1].prompt).toContain('Fix ONLY the failing parser test');
  expect(ctx.calls[1].allowedTools).toContain('Bash(npm test)');
  await until(() => engine.sessions().length === 0);
  expect(store.requireItem(b).file.frontmatter.op_data?.pending_turn).toBeUndefined();
  expect(store.requireItem(b).file.frontmatter.op_data?.active_turn).toBeUndefined();
});

it('preserves a question answer under a provider guard and auto-resumes it exactly once', async () => {
  const ctx = await setup();
  store.updateConfig((d) => d.setIn(['usage_guard', 'auto_resume'], true), 'config: auto resume');
  const id = ctx.item({ awaiting: 'question', awaiting_data: { questions: [{ question: 'Which color?' }] } });
  (engine as any).usageSeen({ status: 'rejected', window: 'five_hour', resetsAt: new Date(Date.now() + 60000).toISOString() });
  await engine.respond(id, { kind: 'question', answers: { 'Which color?': 'Use blue, keep the border' } });
  await until(() => !(engine as any).jobs.has(id));
  expect(ctx.calls).toHaveLength(0);
  expect(store.requireItem(id).file.frontmatter.blocked).toBeUndefined();
  expect((store.requireItem(id).file.frontmatter.op_data?.pending_turn as any).prompt).toContain('Use blue, keep the border');
  await engine.message(id, 'Also preserve keyboard navigation');
  expect((store.requireItem(id).file.frontmatter.op_data?.pending_turn as any).prompt).toContain('Use blue, keep the border');
  await ctx.restart();
  store.updateLocal({ engine: { ...store.local.engine, provider_guards: { claude: { ...store.local.engine.provider_guards!.claude, resume_at: new Date(Date.now() - 1000).toISOString() } } } });
  (engine as any).guardResume();
  await until(() => ctx.calls.length === 1 && engine.sessions().length === 0);
  await engine.tick();
  expect(ctx.calls).toHaveLength(1);
  expect(ctx.calls[0].prompt).toContain('Q: Which color?\n  A: Use blue, keep the border');
  expect(ctx.calls[0].prompt).toContain('Also preserve keyboard navigation');
});

it('saves an answer while the previous process is still ending, without that process erasing it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const ctx = await setup(async (o) => {
    if (first) { first = false; await o.onQuestion([{ question: 'Proceed?' }]); await gate; }
    return { ...success, parked: 'question' };
  });
  const id = ctx.item();
  (engine as any).runJob(id, () => (engine as any).runTurnFor(id, 'implement', 'First instruction'));
  await until(() => store.requireItem(id).file.frontmatter.awaiting === 'question');
  engine.pause();
  await engine.respond(id, { kind: 'question', answers: { 'Proceed?': 'Keep existing changes' } });
  release(); await until(() => !(engine as any).jobs.has(id));
  expect((store.requireItem(id).file.frontmatter.op_data?.pending_turn as any).prompt).toContain('Keep existing changes');
  await ctx.restart(); engine.resume();
  await until(() => ctx.calls.length === 2);
  expect(ctx.calls[1].prompt).toContain('Keep existing changes');
});

it('refuses unusable native Codex grants without persisting a fake allow rule; denial can resume', async () => {
  const ctx = await setup();
  const id = ctx.item({ implementer: 'codex-general', awaiting: 'permission', awaiting_data: { tool: 'CodexApproval', input: { command: 'needs network', method: 'item/commandExecution/requestApproval' } } });
  const rules = store.config.permissions.allow;
  await expect(engine.respond(id, { kind: 'permission', decision: 'allow' })).rejects.toThrow('cannot be granted here');
  await expect(engine.respond(id, { kind: 'permission', decision: 'always' })).rejects.toThrow('only be allowed once');
  expect(store.config.permissions.allow).toEqual(rules);
  expect(store.requireItem(id).file.frontmatter.awaiting).toBe('permission');
  await engine.respond(id, { kind: 'permission', decision: 'deny', reason: 'Use the project inspection tool' });
  await until(() => ctx.calls.length === 1);
  expect(ctx.calls[0].prompt).toContain('Use the project inspection tool');
});

it('an orchestrator allow of an ungrantable Codex request is refused in words, and the request stays with it (#297)', async () => {
  const ctx = await setup();
  store.updateConfig((d) => d.setIn(['orchestrator', 'may_decide_permissions'], true), 'config: delegate');
  Object.defineProperty((engine as any).orchestrator, 'enabled', { value: true });
  const id = ctx.item({ implementer: 'codex-general', awaiting: 'orchestrator', awaiting_data: { kind: 'permission', tool: 'CodexApproval', input: { method: 'item/commandExecution/requestApproval', command: 'curl https://example.test', cwd: ctx.codeRepo, networkApprovalContext: { host: 'example.test' } } } });
  const answer = await (engine as any).orchestratorDecidesPermission(id, 'park-1', 'allow', 'looks fine');
  expect(answer).toMatch(/^not possible: These Codex sandbox permissions cannot be granted here: the request also asks for network access\..* Decide again with deny \(and what to do instead\) or ask_user\.$/);
  expect(store.requireItem(id).file.frontmatter.awaiting).toBe('orchestrator');
  expect(itemView(store, store.requireItem(id)).frontmatter.awaiting_data?.grant_refusal).toContain('the request also asks for network access');
  expect(ctx.calls).toHaveLength(0);
});

it('persists an exact Codex approval through pause/restart and consumes it once before accepting', async () => {
  const seen: unknown[] = [];
  let req: { tool: string; input: Record<string, unknown> };
  const ctx = await setup(async (o) => {
    // A different command cannot spend the grant.
    seen.push(await o.onApproval!({ ...req, input: { ...req.input, command: 'different command' } }));
    seen.push(await o.onApproval!(req));
    expect((store.requireItem(o.itemId).file.frontmatter.op_data?.active_turn as any).opts.commandGrant).toBeUndefined();
    seen.push(await o.onApproval!(req));
    return { ...success, parked: 'permission' };
  });
  req = { tool: 'CodexApproval', input: { method: 'item/commandExecution/requestApproval', command: 'gh api repos/owner/project/actions/runners', cwd: ctx.codeRepo, environmentId: 'local' } };
  const id = ctx.item({ implementer: 'codex-general', awaiting: 'permission', awaiting_data: { ...req, grantable: false } });
  expect(itemView(store, store.requireItem(id)).frontmatter.awaiting_data?.grantable).toBe(true);
  expect(store.requireItem(id).file.frontmatter.awaiting_data?.grantable).toBe(false); // old files need no rewrite
  const rules = [...store.config.permissions.allow];
  engine.pause();
  await expect(engine.respond(id, { kind: 'permission', decision: 'always' })).rejects.toThrow('only be allowed once');
  await engine.respond(id, { kind: 'permission', decision: 'allow' });
  await until(() => !(engine as any).jobs.has(id));
  expect((store.requireItem(id).file.frontmatter.op_data?.pending_turn as any).opts.commandGrant).toMatchObject({ command: req.input.command, cwd: ctx.codeRepo });
  await ctx.restart(); engine.resume();
  await until(() => ctx.calls.length === 1 && engine.sessions().length === 0);
  expect(seen).toEqual([undefined, 'allow', undefined]);
  expect(store.config.permissions.allow).toEqual(rules);
  expect(ctx.calls[0].allowedTools).not.toContain('CodexApproval');
  expect(ctx.calls[0].prompt).toContain(req.input.command);
});

it('does not resurrect a consumed Codex grant after a process is interrupted', async () => {
  let req: { tool: string; input: Record<string, unknown> };
  let accepted = 0;
  const ctx = await setup(async (o) => {
    const answer = await o.onApproval!(req);
    if (answer === 'allow') {
      accepted++;
      await new Promise<void>((resolve) => o.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { ...success, subtype: 'killed' };
    }
    return { ...success, parked: 'permission' };
  });
  req = { tool: 'CodexApproval', input: { method: 'item/commandExecution/requestApproval', command: 'gh api repos/owner/project/actions/runners', cwd: ctx.codeRepo } };
  const id = ctx.item({ implementer: 'codex-general', awaiting: 'permission', awaiting_data: req });
  await engine.respond(id, { kind: 'permission', decision: 'allow' });
  await until(() => accepted === 1);
  await ctx.restart(); engine.resume();
  await until(() => ctx.calls.length === 2 && engine.sessions().length === 0);
  expect(accepted).toBe(1);
  expect(store.requireItem(id).file.frontmatter.awaiting).toBe('permission');
});

it('refuses a native grant outside the item worktree and applies worker hard denials to shell bodies', async () => {
  const ctx = await setup();
  for (const input of [
    { command: 'echo ok', cwd: '/outside' },
    { command: '/bin/zsh -lc "git push origin worker"', cwd: ctx.codeRepo },
  ]) {
    const id = ctx.item({ implementer: 'codex-general', awaiting: 'permission', awaiting_data: { tool: 'CodexApproval', input: { method: 'item/commandExecution/requestApproval', ...input } } });
    await expect(engine.respond(id, { kind: 'permission', decision: 'allow' })).rejects.toThrow();
    expect(store.requireItem(id).file.frontmatter.awaiting).toBe('permission');
  }
  expect(ctx.calls).toHaveLength(0);
});

it.each(['rejected', 'throws', 'wrong-phase'])('quarantines a %s outbox once and surfaces recovery instead of stalling', async (mode) => {
  const ctx = await setup();
  const id = ctx.item();
  const box = { tool: 'report_done', args: { summary: 'Finished', attach: ['capture.png'], review: 'review text' }, error: 'lost connection' };
  store.mutateItem(id, [{ set: { status: mode === 'wrong-phase' ? 'PLAN_IN_PROGRESS' : 'IN_PROGRESS', op: 'implement_turn', op_data: { outbox: box } } }], 'engine');
  const report = vi.fn(async () => { if (mode === 'throws') throw new Error('validation failed'); return 'Rejected: needs a loop review'; });
  vi.spyOn(engine as any, 'makeTools').mockReturnValue({ report_done: report });
  await (engine as any).resumeInterrupted();
  await until(() => !(engine as any).jobs.has(id));
  const fm = store.requireItem(id).file.frontmatter;
  expect(fm).toMatchObject({ blocked: true, blocked_reason: 'connection_lost' });
  expect(fm.op_data?.outbox).toBeUndefined();
  expect(fm.op_data?.rejected_report).toMatchObject({ report: box });
  await (engine as any).resumeInterrupted();
  await (engine as any).ingestOutbox(id, { ...success, undelivered: box });
  expect(report).toHaveBeenCalledTimes(mode === 'wrong-phase' ? 0 : 1);
  expect(ctx.calls).toHaveLength(0);
});

it('allows external implementers through shared editing validation and the orchestrator', async () => {
  const ctx = await setup(); const a = ctx.item(), b = ctx.item();
  store.mutateItem(a, itemModelSwitchOps(store, engine, a, { implementer: 'outside' }), 'user');
  expect(store.requireItem(a).file.frontmatter.implementer).toBe('outside');
  expect(store.requireItem(a).file.frontmatter.op_data?.fresh_brief).toBeUndefined();
  expect(() => itemModelSwitchOps(store, engine, a, { planner: 'outside' })).toThrow('cannot serve as planner');
  await (engine as any).orchestratorSetsFields(b, { implementer: 'outside' });
  expect(store.requireItem(b).file.frontmatter.implementer).toBe('outside');
});

it('never merges over a deferred fix and discards its instruction on a manual takeover', async () => {
  const ctx = await setup(); const id = ctx.item({ status: 'IN_REVIEW', pr: 12, ci_result: 'green' });
  (engine as any).usageSeen({ status: 'rejected', window: 'five_hour' });
  (engine as any).queueTurn(id, 'fix', 'Fix the approved detail before merging');
  await until(() => !(engine as any).jobs.has(id));
  const fetch = vi.spyOn(ctx.ports.git, 'fetch');
  await (engine as any).mergeStep(id);
  expect(fetch).not.toHaveBeenCalled();
  await engine.takeOver(id);
  expect(store.requireItem(id).file.frontmatter.op_data?.pending_turn).toBeUndefined();
  expect(store.requireItem(id).file.frontmatter.op_data?.active_turn).toBeUndefined();
  expect(ctx.calls).toHaveLength(0);
});

it.each([
  { allow: true, stop: 'none', runs: true },
  { allow: false, stop: 'none', runs: false },
  { allow: true, stop: 'all-models', runs: false },
  { allow: true, stop: 'provider', runs: false },
])('admits a saved instruction with fallback=$allow, stop=$stop', async ({ allow, stop, runs }) => {
  const ctx = await setup();
  const id = ctx.item({ implementer: 'fable-5', allow_model_fallback: allow });
  const turn = { key: 'saved', phase: 'implement', prompt: 'Keep the approved details', extraAllowed: ['Bash(npm test)'], oneShotCommands: ['npm test'], opts: {} };
  (engine as any).savePendingTurn(id, turn);
  const outage = { since: new Date().toISOString(), until: new Date(Date.now() + 60000).toISOString(), reason: 'usage limit' };
  store.updateLocal({ model_unavailable: { 'fable-5': outage, ...(stop === 'all-models' ? { 'opus-5': outage } : {}) } });
  if (stop === 'provider') (engine as any).usageSeen({ status: 'rejected', window: 'five_hour' });
  (engine as any).drivePendingTurns();
  await until(() => !(engine as any).jobs.has(id));
  expect(ctx.calls).toHaveLength(runs ? 1 : 0);
  if (runs) {
    expect(ctx.calls[0]).toMatchObject({ model: 'claude-opus-5', prompt: expect.stringContaining(turn.prompt) });
    expect(ctx.calls[0].allowedTools).toContain('Bash(npm test)');
    expect(store.requireItem(id).file.frontmatter.op_data?.pending_turn).toBeUndefined();
    expect(store.requireItem(id).file.frontmatter.implementer).toBe('fable-5');
  } else expect(store.requireItem(id).file.frontmatter.op_data?.pending_turn).toEqual(turn);
});

it('does not let a deferred slot wait replace a newer saved instruction, even across restart', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const ctx = await setup(async (o) => {
    if (first) { first = false; await gate; }
    await o.onQuestion([{ question: 'Review?' }]);
    return { ...success, parked: 'question' };
  });
  const a = ctx.item(), b = ctx.item();
  const active = (engine as any).runTurnFor(a, 'implement', 'Occupy the slot');
  await until(() => ctx.calls.length === 1);
  (engine as any).queueTurn(b, 'fix', 'Old instruction');
  await until(() => engine.sessions().some((s) => s.item === b));
  (engine as any).queueTurn(b, 'fix', 'New instruction', ['Bash(npm test)'], ['npm test']);
  const latest = store.requireItem(b).file.frontmatter.op_data?.pending_turn;
  engine.pause();
  release(); await active;
  await until(() => !(engine as any).jobs.has(b));
  expect(store.requireItem(b).file.frontmatter.op_data?.pending_turn).toEqual(latest);
  await ctx.restart(); engine.resume();
  await until(() => ctx.calls.length === 2 && engine.sessions().length === 0);
  expect(ctx.calls[1].prompt).toContain('New instruction');
  expect(ctx.calls[1].prompt).not.toContain('Old instruction');
  expect(ctx.calls[1].allowedTools).toContain('Bash(npm test)');
  expect(store.requireItem(b).file.frontmatter.op_data?.pending_turn).toBeUndefined();
});

it('resumes an interrupted active turn with its saved instruction, permission ruling and existing session', async () => {
  const ctx = await setup();
  const turn = { key: 'active', phase: 'implement', prompt: 'Implement the approved plan; keep the existing edits', extraAllowed: ['Bash(npm test)'], oneShotCommands: ['npm test'], opts: {} };
  const id = ctx.item({ op: 'implement_turn', op_data: { active_turn: turn } });
  await ctx.restart(); engine.resume();
  await until(() => ctx.calls.length === 1 && engine.sessions().length === 0);
  expect(ctx.calls[0]).toMatchObject({ prompt: expect.stringContaining(turn.prompt), resume: 'prior-session' });
  expect(ctx.calls[0].allowedTools).toContain('Bash(npm test)');
  expect(store.requireItem(id).file.frontmatter.op_data?.pending_turn).toBeUndefined();
});

it('leaves operational data alone when stopping an item with no saved work', async () => {
  const ctx = await setup();
  for (const op_data of [undefined, { unrelated: 'keep', pending_messages: [] }]) {
    const id = ctx.item({ op_data });
    expect((engine as any).stopSessionWork(id, 'test')).toEqual({ said: [], ops: [] });
    await engine.takeOver(id);
    expect(store.requireItem(id).file.frontmatter.op_data).toEqual(op_data);
  }
});

it('resumes after permission rulings without charging turns against the cap (#295)', async () => {
  // HH-439's shape: a Codex turn parks on a command approval, the ruling resumes it, it parks on the next one.
  let n = 0;
  const ctx = await setup(async (o) => {
    n++;
    if (n <= 5) {
      await o.onApproval!({ tool: 'CodexApproval', input: { method: 'item/commandExecution/requestApproval', command: `npm run check-${n}`, cwd: ctx.codeRepo } });
      return { ...success, tokens: 100, parked: 'permission' };
    }
    return { ...success, tokens: 100 };
  });
  const id = ctx.item({ implementer: 'codex-general', budget_turns: 1 });
  (engine as any).runJob(id, () => (engine as any).runTurnFor(id, 'implement', 'First instruction'));
  for (let k = 1; k <= 5; k++) {
    await until(() => store.requireItem(id).file.frontmatter.blocked === true || (store.requireItem(id).file.frontmatter.awaiting === 'permission' && !(engine as any).jobs.has(id)));
    expect(store.requireItem(id).file.frontmatter.blocked_reason).toBeUndefined();
    await engine.respond(id, { kind: 'permission', decision: k % 2 ? 'allow' : 'deny', reason: 'ruled' }, k % 2 ? 'user' : 'orchestrator');
  }
  await until(() => ctx.calls.length === 6 && !(engine as any).jobs.has(id));
  const fm = store.requireItem(id).file.frontmatter;
  expect(fm.blocked_reason).not.toBe('turn_budget');
  expect(fm.agent_turns).toBe(1);   // the turn the rulings resumed, charged once
  expect(fm.tokens).toBe(600);      // what the resumes spent still counts
  // A turn that is not a ruling's resume is charged, and stopped at the cap.
  await (engine as any).runTurnFor(id, 'implement', 'Another instruction');
  expect(store.requireItem(id).file.frontmatter.blocked_reason).toBe('turn_budget');
  expect(ctx.calls).toHaveLength(6);
});

it("answers a Codex command from the person's allow rules, as for Claude's Bash; denials, other folders and defaults still park (HH-535)", async () => {
  const blender = `/Applications/Blender.app/Contents/MacOS/Blender --background tmp/rig.blend --python tmp/render_09.py`;
  const seen: unknown[] = [];
  let reqs: { tool: string; input: Record<string, unknown> }[] = [];
  const ctx = await setup(async (o) => {
    for (const r of reqs) seen.push(await o.onApproval!(r));
    return { ...success, parked: 'permission' };
  });
  store.updateConfig((d) => { d.setIn(['permissions', 'allow'], [...store.config.permissions.allow, 'Bash(/Applications/Blender.app/Contents/MacOS/Blender --background *)@worktree']); }, 'config: blender rule');
  const ask = (command: string, cwd = ctx.codeRepo) => ({ tool: 'CodexApproval', input: { method: 'item/commandExecution/requestApproval', command, cwd } });
  reqs = [
    ask(`/bin/zsh -lc '${blender}'`),                              // the rule, behind Codex's launcher: allowed now
    ask(`/bin/zsh -lc '${blender} && git push origin worker'`),    // a hard denial in the same command: parks
    ask(`/bin/zsh -lc '${blender}'`, '/outside'),                  // not this worktree: parks
    ask(`/bin/zsh -lc 'git status'`),                              // only planestro's defaults cover it: parks
  ];
  const id = ctx.item({ implementer: 'codex-general' });
  await (engine as any).runTurnFor(id, 'implement', 'Render iteration 09');
  expect(seen).toEqual(['allow', undefined, undefined, undefined]);
  const activity = (await import('@planestro/shared')).getSection(store.requireItem(id).file, 'Activity');
  expect(activity).toContain(`allowed by rule Bash(/Applications/Blender.app/Contents/MacOS/Blender --background *)@worktree: ${blender}`);
  expect(store.requireItem(id).file.frontmatter.awaiting).toBe('permission');
});
