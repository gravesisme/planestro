import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import type { ServerEvent } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';
import { apiRoutes } from '../src/routes/api.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup(opts: { ci?: string; claude?: (world: FakeWorld) => Ports['agents']['claude'] } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  const { readFileSync, writeFileSync } = await import('node:fs');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('github: ', 'github: ').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n').replace('after_worktree_create: []', 'after_worktree_create: ["echo hook"]'));
  if (opts.ci) process.env.PLANESTRO_DRYRUN_CI = opts.ci; else delete process.env.PLANESTRO_DRYRUN_CI;
  const events: ServerEvent[] = [];
  store = await DataStore.open(dataDir, { emit: (e) => events.push(e) });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: opts.claude ? opts.claude(world) : new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, (e) => events.push(e), { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world, events, dataDir, codeRepo };
}

async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const status = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter.status;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

describe('plan approval delegated to the orchestrator', () => {
  /** An orchestrator whose plan reviews are scripted: each wake about a plan runs the next step. */
  const reviewer = (steps: ((t: (n: string) => { handler(a: Record<string, unknown>): Promise<unknown> }, prompt: string) => Promise<void>)[], prompts: string[] = []) => (world: FakeWorld) => {
    const inner = new DryRunClaudePort(world);
    return {
      runTurn: (o: TurnOptions) => inner.runTurn(o),
      async runCustomTurn(o: any): Promise<TurnResult> {
        if (o.label.includes('plan_review')) { prompts.push(o.prompt); await steps.shift()?.((n) => o.mcpTools.find((x: any) => x.name === n), o.prompt); }
        return { sessionId: 'orch-1', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
      },
    };
  };
  async function delegated(claude: (world: FakeWorld) => Ports['agents']['claude'], opts: { gate?: boolean; optIn?: boolean } = {}) {
    const ctx = await setup({ claude });
    const { readFileSync, writeFileSync } = await import('node:fs');
    const cfg = `${ctx.store.dataDir}/planestro.yml`;
    if (opts.gate !== false) { writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('may_approve_plans: false', 'may_approve_plans: true')); ctx.store.reload(); }
    const item = ctx.store.createItem({ title: 'Small fix', description: 'x' });
    if (opts.optIn !== false) ctx.store.mutateItem(item.id, [{ set: { auto_approve_plan: true } }], 'user');
    ctx.store.transition(item.id, 'QUEUED', 'user');
    return { ...ctx, id: item.id };
  }
  const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;

  it('a plan it already reviewed for you is decided from that review when approval is delegated later (p8)', async () => {
    const prompts: string[] = [];
    const { store, engine, id } = await delegated(reviewer([
      async (t) => { await t('annotate_item').handler({ id, text: 'risky: the migration has no rollback step' }); },
      async (t) => { expect(await t('approve_plan').handler({ id, notes: 'add the rollback step' })).toBe('approved'); },
    ], prompts), { optIn: false });
    await engine.start();
    await waitFor(() => prompts.length === 1 && activityOf(store, id).includes('[orchestrator] risky: the migration has no rollback step'));
    expect(prompts[0]).toContain("Plan approval: the user's");
    store.mutateItem(id, [{ set: { auto_approve_plan: true } }], 'user');
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
    expect(prompts[1]).toContain('You already reviewed this version of the plan');
    expect(prompts[1]).toContain('- risky: the migration has no rollback step');
  });

  /** A reviewer that also records what the planner is told. */
  const amending = (steps: ((t: (n: string) => { handler(a: Record<string, unknown>): Promise<unknown> }) => Promise<void>)[], reviewPrompts: string[], planPrompts: string[]) => (world: FakeWorld) => {
    const inner = new DryRunClaudePort(world);
    return {
      async runTurn(o: TurnOptions): Promise<TurnResult> { if (o.phase === 'plan') planPrompts.push(o.prompt); return inner.runTurn(o); },
      async runCustomTurn(o: any): Promise<TurnResult> {
        if (o.label.includes('plan_review')) { reviewPrompts.push(o.prompt); await steps.shift()?.((n) => o.mcpTools.find((x: any) => x.name === n)); }
        return { sessionId: 'orch-1', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
      },
    };
  };

  it('amend_plan sends a stipulation to the planner, outside the fix rounds; the user then approves a complete plan (f7)', async () => {
    const reviewPrompts: string[] = []; const planPrompts: string[] = []; const replies: string[] = [];
    const { store, engine, id } = await delegated(amending([
      async (t) => { replies.push(String(await t('amend_plan').handler({ id: 'TP-1', amendments: 'Add a 30-day retention step before the purge.' }))); },
      async () => { /* the revision: nothing to add */ },
    ], reviewPrompts, planPrompts), { optIn: false });
    await engine.start();
    await waitFor(() => reviewPrompts.length === 2 && fmOf(store, id).awaiting === 'plan_approval', 8000);
    expect(replies[0]).toBe('sent back to be amended; you will review the revised plan (its approval stays with the user)');
    expect(reviewPrompts[0]).toContain("Plan approval: the user's");
    expect(reviewPrompts[0]).toContain('amend_plan sends it to the planner');
    expect(planPrompts[1]).toContain('approves your plan with these amendments');
    expect(planPrompts[1]).toContain('Add a 30-day retention step before the purge.');
    expect(reviewPrompts[1]).toContain('Amended: you sent this plan back to be amended with: Add a 30-day retention step');
    let fm = fmOf(store, id);
    expect(fm.plan_revisions).toBeUndefined();                                   // not a fix round
    expect(fm.op_data?.plan_amended).toBe('Add a 30-day retention step before the purge.');
    expect(activityOf(store, id)).toContain('plan sent back to be amended: Add a 30-day retention step');
    await engine.approvePlan(id);
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
    fm = fmOf(store, id);
    expect(fm.op_data?.plan_amended).toBeUndefined();
  });

  it('a delegated review can amend, then approve the revision itself', async () => {
    const reviewPrompts: string[] = []; const planPrompts: string[] = [];
    const { store, engine, id } = await delegated(amending([
      async (t) => { await t('amend_plan').handler({ id: 'TP-1', amendments: 'Name the flag `--dry-run`.' }); },
      async (t) => { expect(await t('approve_plan').handler({ id: 'TP-1' })).toBe('approved'); },
    ], reviewPrompts, planPrompts));
    await engine.start();
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
    expect(planPrompts[1]).toContain('Name the flag `--dry-run`.');
    expect(fmOf(store, id).plan_revisions).toBeUndefined();
    expect(activityOf(store, id)).toContain('approved the plan on your behalf');
  });

  it('approves a sound plan, and the item never needs you on the way to its pull request', async () => {
    const prompts: string[] = []; const needed: boolean[] = [];
    const { store, engine, id } = await delegated(reviewer([async (t) => { needed.push(store.derived(store.getItem(id)!).needs_you); expect(fmOf(store, id).awaiting).toBe('orchestrator'); expect(await t('approve_plan').handler({ id, notes: 'watch the flag name' })).toBe('approved'); }], prompts));
    await engine.start();
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
    expect(needed).toEqual([false]);
    expect(prompts[0]).toContain('Plan approval: DELEGATED TO YOU');
    expect(prompts[0]).toContain('0 of 2 fix rounds used');
    expect(activityOf(store, id)).toContain('[orchestrator] approved the plan on your behalf: watch the flag name');
    expect(activityOf(store, id)).not.toContain('plan needs your approval');
  });

  it('gets two fix rounds; a third request is refused and the plan is handed to you with what it still wanted', async () => {
    const replies: unknown[] = [];
    const ask = (msg: string) => async (t: any) => { replies.push(await t('request_plan_changes').handler({ id: 'TP-1', message: msg })); };
    const { store, engine, id } = await delegated(reviewer([ask('name the flag'), ask('cover the empty case'), ask('one more thing')]));
    await engine.start();
    await waitFor(() => fmOf(store, id).awaiting === 'plan_approval', 8000);
    expect(replies.map(String)).toEqual([expect.stringContaining('fix round 1 of 2'), expect.stringContaining('fix round 2 of 2'), expect.stringContaining('not sent: all 2 fix rounds')]);
    expect(status(store, id)).toBe('PLAN_READY');
    expect(fmOf(store, id).plan_revisions).toBe(2);
    expect(store.derived(store.getItem(id)!).needs_you).toBe(true);
    expect(activityOf(store, id)).toContain('plan needs your approval: the orchestrator still wanted changes after 2 fix rounds: one more thing');
    await sleep(200); // handed back once: the tick does not delegate the same plan again
    expect(fmOf(store, id).awaiting).toBe('plan_approval');
    await engine.approvePlan(id);
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
  });

  it('hands the plan to you when the orchestrator says so, or decides nothing at all', async () => {
    const a = await delegated(reviewer([async (t) => { await t('hand_plan_to_user').handler({ id: 'TP-1', reason: 'this changes pricing' }); }]));
    await a.engine.start();
    await waitFor(() => fmOf(a.store, a.id).awaiting === 'plan_approval');
    expect(activityOf(a.store, a.id)).toContain('plan needs your approval: the orchestrator left it to you: this changes pricing');
    await a.engine.stop(); a.store.close();
    const b = await delegated(reviewer([async () => { /* looks, decides nothing */ }]));
    await b.engine.start();
    await waitFor(() => fmOf(b.store, b.id).awaiting === 'plan_approval');
    expect(activityOf(b.store, b.id)).toContain('the orchestrator reviewed it without deciding');
  });

  it('is off unless both the project and the item say so', async () => {
    for (const opts of [{ gate: false }, { optIn: false }]) {
      const c = await delegated(reviewer([async (t, prompt) => { expect(prompt).toContain("Plan approval: the user's"); expect(String(await t('approve_plan').handler({ id: 'TP-1' }))).toContain('not permitted'); }]), opts);
      await c.engine.start();
      await waitFor(() => status(c.store, c.id) === 'PLAN_READY');
      await sleep(250);
      expect(fmOf(c.store, c.id).awaiting).toBe('plan_approval');
      expect(status(c.store, c.id)).toBe('PLAN_READY');
      await c.engine.stop(); c.store.close();
    }
  });

  it('picks up a plan that was waiting when the box was ticked, and one whose review a restart dropped', async () => {
    const { store, engine, id } = await delegated(reviewer([async () => {}, async (t) => { await t('approve_plan').handler({ id: 'TP-1' }); }]), { optIn: false });
    await engine.start();
    await waitFor(() => fmOf(store, id).awaiting === 'plan_approval');
    store.mutateItem(id, [{ set: { auto_approve_plan: true } }], 'user'); // ticked after the plan arrived
    await waitFor(() => status(store, id) !== 'PLAN_READY', 8000);
    expect(activityOf(store, id)).toContain('plan approval delegated to the orchestrator');
    await waitFor(() => status(store, id) === 'FINISHED', 8000);

    await engine.stop(); store.close();

    // after a restart: PLAN_READY + awaiting orchestrator on disk, and no wake queued in memory
    const prompts: string[] = [];
    const d = await setup({ claude: reviewer([async (t) => { await t('hand_plan_to_user').handler({ id: 'TP-1', reason: 'seen after the restart' }); }], prompts) });
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(`${d.store.dataDir}/planestro.yml`, readFileSync(`${d.store.dataDir}/planestro.yml`, 'utf8').replace('may_approve_plans: false', 'may_approve_plans: true'));
    d.store.reload();
    const parked = d.store.createItem({ title: 'Parked', description: 'x' });
    d.store.mutateItem(parked.id, [{ set: { auto_approve_plan: true } }, { transition: { to: 'QUEUED', actor: 'user' } }, { transition: { to: 'PLAN_IN_PROGRESS', actor: 'engine' } }, { section: 'Plan', body: '# a plan' }, { transition: { to: 'PLAN_READY', actor: 'engine' } }, { set: { awaiting: 'orchestrator' } }], 'engine');
    expect(d.store.derived(d.store.getItem(parked.id)!).needs_you).toBe(false);
    await d.engine.start();
    await waitFor(() => fmOf(d.store, parked.id).awaiting === 'plan_approval');
    expect(prompts).toHaveLength(1);
    expect(activityOf(d.store, parked.id)).toContain('seen after the restart');
  });
});

describe('permission requests delegated to the orchestrator', () => {
  /** A worker that asks for `node -e 1` on its first implement turn (and on every turn while `again` says so), then reports done. */
  function world(decide: (t: (n: string) => { handler(a: Record<string, unknown>): Promise<unknown> }, prompt: string) => Promise<void>, opts: { again?: () => boolean } = {}) {
    const seen = { prompts: [] as string[], oneShots: 0, implementPrompts: [] as string[] };
    const claude = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        const ok = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { ...ok, planSubmitted: '# p' }; }
        seen.implementPrompts.push(o.prompt);
        if (seen.implementPrompts.length === 1 || opts.again?.()) { expect((await o.onPermission({ tool: 'Bash', input: { command: 'node -e 1', description: 'try it' } })).action).toBe('park'); return { ...ok, parked: 'permission' as const }; }
        await o.tools.report_done('did it');
        return { ...ok, done: 'did it', ran: [{ tool: 'Bash', command: 'npm test', n: 2 }] };
      },
      async runCustomTurn(o: any): Promise<TurnResult> {
        if (o.label.includes('permission_request')) { seen.prompts.push(o.prompt); await decide((n) => o.mcpTools.find((x: any) => x.name === n), o.prompt); }
        return { sessionId: 'orch-1', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
      },
    });
    return { claude, seen };
  }
  async function begin(claude: () => Ports['agents']['claude'], on = true) {
    const ctx = await setup({ claude });
    if (on) { const { readFileSync, writeFileSync } = await import('node:fs'); const cfg = `${ctx.store.dataDir}/planestro.yml`; writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('may_decide_permissions: false', 'may_decide_permissions: true')); ctx.store.reload(); }
    const item = ctx.store.createItem({ title: 'P', description: 'x' });
    ctx.store.transition(item.id, 'QUEUED', 'user');
    await ctx.engine.start();
    await waitFor(() => status(ctx.store, item.id) === 'PLAN_READY');
    ctx.world.commits.set(join(ctx.store.codeRepoPath(), '.claude/worktrees/tp-1-p'), 1);
    await ctx.engine.approvePlan(item.id);
    return { ...ctx, id: item.id };
  }
  const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
  /** The request id the packet shows (#342). */
  const requestOf = (prompt: string) => /Its request id: (\S+)/.exec(prompt)?.[1] ?? '';

  it('allows ordinary work without you: the session resumes with a one-shot pass and the item finishes', async () => {
    const needed: boolean[] = [];
    const w = world(async (t, prompt) => { needed.push(store!.derived(store!.getItem('TP-1')!).needs_you); expect(await t('decide_permission').handler({ id: 'TP-1', request: requestOf(prompt), decision: 'allow', reason: 'a harmless local check' })).toContain('allowed once'); });
    const ctx = await begin(w.claude);
    await waitFor(() => status(ctx.store, ctx.id) === 'FINISHED', 8000);
    expect(needed).toEqual([false]);
    expect(w.seen.prompts[0]).toContain('Permission request: DELEGATED TO YOU');
    expect(w.seen.prompts[0]).toContain('node -e 1');
    expect(w.seen.implementPrompts[1]).toContain('APPROVED: The orchestrator approved your command `node -e 1` (a harmless local check). Run it now, as it was');
    expect(activityOf(ctx.store, ctx.id)).toContain('[orchestrator] permission allow (a harmless local check): Bash(node -e 1)');
    expect(ctx.store.config.permissions.allow).not.toContain('Bash(node -e 1)'); // it never writes allow rules
    expect(w.seen.prompts[0]).toContain('Ruling rubric');
    // #203: what the turn ran without a park is journaled once per turn, for drift
    expect(ctx.store.journal.read({ item: ctx.id, type: 'tools.ran' }).map((e) => e.data?.ran)).toEqual([[{ tool: 'Bash', command: 'npm test', n: 2 }]]);
  });

  it('a ruling binds to the request it was judged on: one parked over it is refused, then decided by its own id (#342)', async () => {
    const replies: string[] = [];
    const w = world(async (t, prompt) => {
      const judged = requestOf(prompt);
      expect(judged).toMatch(/^park-/);
      // a second request parks on the item a moment later, while this one is being judged
      const fm = store!.getItem('TP-1')!.file.frontmatter;
      store!.mutateItem('TP-1', [{ set: { awaiting_data: { ...fm.awaiting_data, input: { command: './run_checks.sh' }, park: 'park-second' } } }], 'engine');
      replies.push(String(await t('decide_permission').handler({ id: 'TP-1', request: judged, decision: 'allow', reason: 'a read-only runner query' })));
      replies.push(String(await t('decide_permission').handler({ id: 'TP-1', request: 'park-second', decision: 'allow', reason: "the project's own checks" })));
    });
    const ctx = await begin(w.claude);
    await waitFor(() => status(ctx.store, ctx.id) === 'FINISHED', 8000);
    expect(replies[0]).toContain('not applied: request park-');
    expect(replies[0]).toContain('The request parked now is park-second, for `./run_checks.sh`');
    expect(replies[1]).toContain('allowed once');
    expect(activityOf(ctx.store, ctx.id)).not.toContain('a read-only runner query');
    expect(activityOf(ctx.store, ctx.id)).toContain("[orchestrator] permission allow (the project's own checks): Bash(./run_checks.sh)");
  });

  it('asks you when it says so or decides nothing, and you answer as before', async () => {
    const w = world(async (t, prompt) => { await t('decide_permission').handler({ id: 'TP-1', request: requestOf(prompt), decision: 'ask_user', reason: 'writes outside the worktree' }); });
    const ctx = await begin(w.claude);
    await waitFor(() => fmOf(ctx.store, ctx.id).awaiting === 'permission');
    expect(ctx.store.derived(ctx.store.getItem(ctx.id)!).needs_you).toBe(true);
    expect(activityOf(ctx.store, ctx.id)).toContain('permission needs your decision: the orchestrator left it to you: writes outside the worktree');
    await sleep(200); // handed back once: the tick does not pass the same request round again
    expect(fmOf(ctx.store, ctx.id).awaiting).toBe('permission');
    await ctx.engine.respond(ctx.id, { kind: 'permission', decision: 'allow' });
    await waitFor(() => status(ctx.store, ctx.id) === 'FINISHED', 8000);
    await ctx.engine.stop(); ctx.store.close();

    const silent = world(async () => { /* looks, decides nothing */ });
    const c2 = await begin(silent.claude);
    await waitFor(() => fmOf(c2.store, c2.id).awaiting === 'permission');
    expect(activityOf(c2.store, c2.id)).toContain('the orchestrator looked at it without deciding');
  });

  it('a denial resumes the worker with the reason; after three denials on one item the requests come to you', async () => {
    let denials = 0;
    const w = world(async (t, prompt) => { denials += 1; await t('decide_permission').handler({ id: 'TP-1', request: requestOf(prompt), decision: 'deny', reason: 'use the project check script instead' }); }, { again: () => true });
    const ctx = await begin(w.claude);
    await waitFor(() => fmOf(ctx.store, ctx.id).awaiting === 'permission', 8000);
    expect(denials).toBe(3);
    // #203: the next request of the same kind is shown the ruling it got before
    expect(w.seen.prompts[0]).not.toContain('Earlier rulings');
    expect(w.seen.prompts[1]).toMatch(/Earlier rulings on `node` commands[\s\S]*deny \(orchestrator\): use the project check script instead/);
    expect(w.seen.implementPrompts[1]).toContain('DENIED: The orchestrator denied your command `node -e 1`: use the project check script instead. This exact command is denied: do not run it again, reworded or by another route');
    expect(fmOf(ctx.store, ctx.id).op_data?.orchestrator_denials).toBe(3);
    // #95: the card says why it came to you, and your approval hands the item's next requests back to the orchestrator
    expect(fmOf(ctx.store, ctx.id).awaiting_data?.escalated).toBe('orchestrator_denials');
    expect(activityOf(ctx.store, ctx.id)).toContain('(to you: the orchestrator denied its last 3 requests)');
    await ctx.engine.respond(ctx.id, { kind: 'permission', decision: 'allow' });
    expect(fmOf(ctx.store, ctx.id).op_data?.orchestrator_denials).toBe(0);
    expect((ctx.engine as any).mayAskOrchestrator(fmOf(ctx.store, ctx.id))).toBe(true);
  });

  it('is off by default: the request parks on you and the orchestrator is never asked', async () => {
    const w = world(async () => { throw new Error('should not be woken for a permission'); });
    const ctx = await begin(w.claude, false);
    await waitFor(() => fmOf(ctx.store, ctx.id).awaiting === 'permission');
    await sleep(200);
    expect(w.seen.prompts).toEqual([]);
  });
});

describe('hand-off between items', () => {
  it('a worker hands files to the item that waits on it: attachments, notes, both logs, and the receiver\'s session is told', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const turns: { item: string; prompt: string }[] = [];
    let art = '';
    const port = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        turns.push({ item: o.itemId, prompt: o.prompt });
        const ok = { sessionId: `s-${o.itemId}`, subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { ...ok, planSubmitted: '# p' }; }
        if (o.itemId === art) {
          writeFileSync(join(o.cwd, 'out.png'), Buffer.from('png-bytes'));
          expect(await o.tools.hand_off('TP-9', ['out.png'], 'the tile')).toContain('no item TP-9');
          writeFileSync(join(o.cwd, '..', 'escape.txt'), 'x');
          expect(await o.tools.hand_off('TP-2', ['../escape.txt'], 'x')).toContain('outside the worktree');
          expect(await o.tools.hand_off('TP-2', ['nope.png'], 'x')).toContain('does not exist');
          expect(await o.tools.hand_off('TP-2', ['out.png'], 'Use it as the south wall tile.')).toMatch(/^Delivered to TP-2: 1 file attached; its session has been resumed/);
          await o.tools.report_done('drew it');
          return { ...ok, done: 'drew it' };
        }
        await o.tools.report_done('used it');
        return { ...ok, done: 'used it' };
      },
    });
    const { store, engine, world } = await setup({ claude: port });
    const a = store.createItem({ title: 'Art', description: 'draw' }); art = a.id;
    const b = store.createItem({ title: 'Code', description: 'use the art', depends_on: [] });
    // b waits on a in spirit but is already implementing (a real worktree holds the copy source; b's session is idle, parked on nothing)
    store.mutateItem(b.id, [{ set: { depends_on: [a.id] } }], 'user');
    for (const it of [a, b]) {
      const wt = join(store.codeRepoPath(), `.claude/worktrees/tp-${idNumberOf(it.id)}-${it.file.frontmatter.title.toLowerCase()}`);
      mkdirSync(wt, { recursive: true }); world.worktrees.set(wt, { path: wt, head: 'a'.repeat(40), branch: `tp/${idNumberOf(it.id)}` }); world.commits.set(wt, 1);
      store.mutateItem(it.id, [{ transition: { to: 'QUEUED', actor: 'user' } }, { transition: { to: 'PLAN_IN_PROGRESS', actor: 'engine' } }, { section: 'Plan', body: '# p' }, { transition: { to: 'PLAN_READY', actor: 'engine' } }, { transition: { to: 'IN_PROGRESS', actor: 'user' } }, { set: { branch: `tp/${idNumberOf(it.id)}`, worktree: `.claude/worktrees/tp-${idNumberOf(it.id)}-${it.file.frontmatter.title.toLowerCase()}`, session_id: `s-${it.id}` } }], 'engine');
    }
    await engine.start();
    await engine.message(a.id, 'go');
    await waitFor(() => turns.some((t) => t.item === b.id), 8000);
    const bt = turns.find((t) => t.item === b.id)!;
    expect(bt.prompt).toContain(`${a.id} handed off 1 file to you`);
    expect(bt.prompt).toContain('Use it as the south wall tile.');
    const bf = store.getItem(b.id)!.file;
    expect(bf.frontmatter.attachments).toHaveLength(1);
    expect(bf.frontmatter.attachments[0].path).toMatch(/^attachments\/TP-2\/\d{8}-\d{6}-out\.png$/);
    expect(getSectionText(store, b.id, 'Notes')).toContain(`Hand-off from ${a.id}`);
    expect(activityOf(store, b.id)).toContain(`received 1 file from ${a.id}'s worker: out.png`);
    expect(activityOf(store, a.id)).toContain(`[worker] handed 1 file to ${b.id}: out.png`);
    await waitFor(() => status(store, b.id) === 'FINISHED' && status(store, a.id) === 'FINISHED', 10000);
  });

  it('is refused between unrelated items, and queues for a busy or parked receiver', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { store, engine } = await setup();
    const a = store.createItem({ title: 'A' }); const b = store.createItem({ title: 'B' });
    const wt = join(store.codeRepoPath(), '.claude/worktrees/tp-1-a'); mkdirSync(wt, { recursive: true }); writeFileSync(join(wt, 'f.txt'), 'hi');
    store.mutateItem(a.id, [{ set: { worktree: '.claude/worktrees/tp-1-a' } }], 'engine');
    expect(await engine.handOff(a.id, b.id, ['f.txt'], '')).toContain('does not wait on');
    store.mutateItem(b.id, [{ set: { depends_on: [a.id] } }], 'user');
    expect(await engine.handOff(a.id, b.id, ['f.txt'], '')).toMatch(/no session yet/);
    // parked on a permission: the hand-off waits in its pending messages, the park is untouched
    store.mutateItem(b.id, [{ transition: { to: 'QUEUED', actor: 'user' } }, { transition: { to: 'PLAN_IN_PROGRESS', actor: 'engine' } }, { set: { awaiting: 'permission', awaiting_data: { tool: 'Bash', input: { command: 'x' } } } }], 'engine');
    expect(await engine.handOff(a.id, b.id, ['f.txt'], 'again')).toContain('parked (awaiting permission)');
    const fm = store.getItem(b.id)!.file.frontmatter;
    expect(fm.awaiting).toBe('permission');
    expect((fm.op_data?.pending_messages as string[])[0]).toContain('handed off 1 file');
    expect(fm.attachments).toHaveLength(2);
    // blocked (a cap, a failure: awaiting the user): the block and its card stay, and no turn runs past them
    store.mutateItem(b.id, [{ unset: ['awaiting', 'awaiting_data'] }, { set: { blocked: true, blocked_reason: 'turn_budget', awaiting: 'user', awaiting_data: { decision: { question: 'Raise the cap?', options: [{ label: 'Yes' }, { label: 'No' }] } }, op_data: {} } }], 'engine');
    expect(await engine.handOff(a.id, b.id, ['f.txt'], 'third')).toContain('blocked (turn_budget) and will read the hand-off when it is unblocked');
    const blocked = store.getItem(b.id)!.file.frontmatter;
    expect(blocked.blocked).toBe(true);
    expect(blocked.awaiting_data?.decision).toBeTruthy();
    expect((blocked.op_data?.pending_messages as string[])).toHaveLength(1);
    expect((engine as any).jobs.has(b.id)).toBe(false);
  });
});

const idNumberOf = (id: string) => id.split('-')[1];
const getSectionText = (s: DataStore, id: string, title: string) => s.getItem(id)!.file.sections.find((x) => x.title === title)!.body;


describe('orchestrator chat', () => {
  it('in a user_message wake it replies, creates items and unblocks; only a chat wake may create items', async () => {
    const results: Record<string, string> = {};
    const scripted = (world: FakeWorld) => {
      const inner = new DryRunClaudePort(world);
      return {
        runTurn: (o: TurnOptions) => inner.runTurn(o),
        async runCustomTurn(o: any): Promise<TurnResult> {
          const t = (n: string) => o.mcpTools.find((x: any) => x.name === n);
          if (o.label.includes('user_message')) {
            expect(o.prompt).toContain('They see only what you send with reply_to_user');
            results.create = await t('create_item').handler({ title: 'Dark mode', description: 'Add a dark theme toggle' });
            results.unblock = await t('unblock_item').handler({ id: 'TP-1', message: 'use the project check script instead' });
            results.notBlocked = await t('unblock_item').handler({ id: 'TP-2', message: 'x' });
            await t('reply_to_user').handler({ text: 'Created TP-2 and unblocked TP-1.' });
          } else {
            results.unasked = await t('create_item').handler({ title: 'Sneaky', description: 'x' });
          }
          await t('done_with_wake').handler({ summary: `handled ${o.label}` });
          return { sessionId: 'orch-1', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
        },
      };
    };
    const { store, engine } = await setup({ claude: scripted });
    const blocked = store.createItem({ title: 'Stuck', description: 'x' });
    store.mutateItem(blocked.id, [{ set: { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }], 'engine');
    engine.orchestrator.wake({ type: 'orchestrator_note', data: { note: 'routine' } });
    await waitFor(() => results.unasked !== undefined);
    expect(results.unasked).toContain('not permitted');
    expect(store.listItems()).toHaveLength(1);

    engine.orchestrator.wake({ type: 'user_message', data: { message: 'add dark mode, and fix TP-1' } });
    await waitFor(() => results.create !== undefined && results.notBlocked !== undefined);
    expect(results.create).toBe('created TP-2 (not submitted; the user or submit_item queues it)');
    const created = store.getItem('TP-2')!;
    expect(created.file.frontmatter.status).toBe('NOT_YET_SUBMITTED');
    expect(activityOf(store, 'TP-2')).toContain('[orchestrator] created from the chat');
    expect(results.unblock).toContain('unblocked');
    expect(store.getItem(blocked.id)!.file.frontmatter.blocked).toBeUndefined();
    expect(activityOf(store, blocked.id)).toContain('unblocked: use the project check script instead');
    expect(results.notBlocked).toContain('nothing to unblock');
    await waitFor(() => store.journal.read({ type: 'orchestrator.reply' }).length === 1);
    expect(store.journal.read({ type: 'orchestrator.reply' })[0].data).toEqual({ text: 'Created TP-2 and unblocked TP-1.' });
  });

  it('the dry-run orchestrator answers a chat message', async () => {
    const { store, engine } = await setup();
    engine.orchestrator.wake({ type: 'user_message', data: { message: 'what is blocked?' } });
    await waitFor(() => store.journal.read({ type: 'orchestrator.reply' }).length === 1);
    expect(String(store.journal.read({ type: 'orchestrator.reply' })[0].data?.text)).toContain('what is blocked?');
  });
});

describe('starting an epic with no children (dogfood p56, LM-2)', () => {
  const post = (body: unknown) => ({ method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const offered = async (app: ReturnType<typeof apiRoutes>, id: string) => ((await (await app.request(`/items/${id}/transitions`)).json()) as { to: string }[]).map((t) => t.to);

  it('"start" is not offered; started anyway it plans the breakdown and opens no branch; open refuses', async () => {
    const { store, engine, world } = await setup();
    const epic = store.createItem({ title: 'Lonely', description: 'x', kind: 'epic' });
    await engine.start();
    const app = apiRoutes(store, engine);
    expect(await offered(app, epic.id)).toEqual(expect.arrayContaining(['PLAN_IN_PROGRESS']));
    expect(await offered(app, epic.id)).not.toContain('IN_PROGRESS');
    const opened = await app.request(`/items/${epic.id}/epic/open`, { method: 'POST' });
    expect(opened.status).toBe(400);
    expect((await opened.json()).error).toBe(`${epic.id} has no children yet: plan the breakdown, or add children first`);
    const r = await app.request(`/items/${epic.id}/transition`, post({ to: 'IN_PROGRESS' }));
    expect(r.status).toBe(200);
    expect(['PLAN_IN_PROGRESS', 'PLAN_READY']).toContain(status(store, epic.id));   // the dry-run planner may already have handed its breakdown in
    expect(activityOf(store, epic.id)).toContain('start: no children yet, so the planner breaks the epic down first: planning the breakdown');
    expect(world.remoteBranches.has('feature/lonely')).toBe(false);
    await waitFor(() => status(store, epic.id) === 'PLAN_READY');
    expect(await offered(app, epic.id)).toContain('IN_PROGRESS');   // "approve breakdown": its children only exist once it is approved
  });

  it('an epic with a child still starts: its integration branch opens', async () => {
    const { store, engine, world } = await setup();
    const epic = store.createItem({ title: 'Crowded', description: 'x', kind: 'epic' });
    store.createItem({ title: 'Kid', description: 'x', parent: epic.id });
    await engine.start();
    const app = apiRoutes(store, engine);
    expect(await offered(app, epic.id)).toContain('IN_PROGRESS');
    const r = await app.request(`/items/${epic.id}/transition`, post({ to: 'IN_PROGRESS' }));
    expect(r.status).toBe(200);
    expect(status(store, epic.id)).toBe('IN_PROGRESS');
    expect(world.remoteBranches.has('feature/crowded')).toBe(true);
  });
});

describe('dirty-tree reminders (dogfood p54, HH-215/HH-222)', () => {
  /** An item whose implement turns run `turn(n, o, world)` (n counts implement turns from 1), planned and dirty, ahead of its base. */
  async function dirtyWorld(turn: (n: number, o: TurnOptions, world: FakeWorld) => Promise<Partial<TurnResult>>) {
    let n = 0;
    const ctx = await setup({ claude: (world) => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        const ok = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { ...ok, planSubmitted: '# p' }; }
        n += 1;
        return { ...ok, ...(await turn(n, o, world)) };
      },
    }) as unknown as Ports['agents']['claude'] });
    const item = ctx.store.createItem({ title: 'D', description: 'x' });
    ctx.store.transition(item.id, 'QUEUED', 'user');
    await ctx.engine.start();
    await waitFor(() => status(ctx.store, item.id) === 'PLAN_READY');
    const cwd = (ctx.engine as any).absWorktree(ctx.store.getItem(item.id)!.file.frontmatter.worktree!);
    ctx.world.commits.set(cwd, 1); ctx.world.dirty.add(cwd);
    return { ...ctx, id: item.id, cwd, turns: () => n };
  }
  const reminders = (s: DataStore, id: string) => activityOf(s, id).match(/worktree dirty after turn/g)?.length ?? 0;
  const done = async (o: TurnOptions) => { await o.tools.report_done('did it'); return { done: 'did it' }; };

  it('an unblock starts the reminder count again: the resumed session is reminded before another block', async () => {
    const ctx = await dirtyWorld(async (n, o, world) => { if (n === 5) world.dirty.delete(o.cwd); return done(o); });
    await ctx.engine.approvePlan(ctx.id);
    await waitFor(() => ctx.store.getItem(ctx.id)!.file.frontmatter.blocked_reason === 'dirty_tree');
    expect(ctx.turns()).toBe(3); // the turn and its two reminders
    await ctx.engine.unblock(ctx.id, 'commit or remove the stray files', 'orchestrator');
    await waitFor(() => status(ctx.store, ctx.id) === 'FINISHED' || ctx.store.getItem(ctx.id)!.file.frontmatter.blocked === true, 8000);
    expect(ctx.store.getItem(ctx.id)!.file.frontmatter.blocked).toBeUndefined();
    expect(status(ctx.store, ctx.id)).toBe('FINISHED');
    expect(ctx.turns()).toBe(5); // the resumed turn was reminded, not re-blocked at once
    expect(activityOf(ctx.store, ctx.id).split('unblocked: commit or remove')[1]).toMatch(/worktree dirty after turn/);
  });

  it('a clean turn ends the count', async () => {
    const ctx = await dirtyWorld(async (n, o, world) => { if (n === 2) world.dirty.delete(o.cwd); return done(o); });
    ctx.store.mutateItem(ctx.id, [{ set: { skip_merge: true } }], 'user'); // held: it stays in review, op_data and all
    await ctx.engine.approvePlan(ctx.id);
    await waitFor(() => status(ctx.store, ctx.id) === 'IN_REVIEW', 8000);
    expect(reminders(ctx.store, ctx.id)).toBe(1);
    expect(ctx.store.getItem(ctx.id)!.file.frontmatter.op_data?.dirty_tree_turns).toBeUndefined();
  });

  it('a reminder turn that parks on its `rm` and reports done keeps the request: its approval cleans the tree', async () => {
    const ctx = await dirtyWorld(async (n, o, world) => {
      if (n === 2) { expect((await o.onPermission({ tool: 'Bash', input: { command: 'rm stray.txt' } })).action).toBe('park'); return { ...(await done(o)), parked: 'permission' }; }
      if (n === 3) world.dirty.delete(o.cwd);
      return done(o);
    });
    await ctx.engine.approvePlan(ctx.id);
    await waitFor(() => ctx.turns() >= 2 && !ctx.engine.sessions().length);
    await sleep(150);
    const fm = ctx.store.getItem(ctx.id)!.file.frontmatter;
    expect(fm.blocked).toBeUndefined();
    expect(fm.awaiting).toBe('permission');
    expect(fm.op_data?.dirty_tree_turns).toBe(1); // the parked turn spent no reminder
    await ctx.engine.respond(ctx.id, { kind: 'permission', decision: 'allow' });
    await waitFor(() => status(ctx.store, ctx.id) === 'FINISHED', 8000);
    expect(ctx.turns()).toBe(3);
    expect(reminders(ctx.store, ctx.id)).toBe(1);
  });

  it('a turn that parked and was answered before it ended is not judged: the answer\'s turn is', async () => {
    const ctx = await dirtyWorld(async (n, o, world) => {
      if (n === 2) {
        expect((await o.onPermission({ tool: 'Bash', input: { command: 'rm stray.txt' } })).action).toBe('park');
        await engine!.respond(o.itemId, { kind: 'permission', decision: 'allow' }, 'orchestrator');
        return { ...(await done(o)), parked: 'permission' };
      }
      if (n === 3) world.dirty.delete(o.cwd);
      return done(o);
    });
    await ctx.engine.approvePlan(ctx.id);
    await waitFor(() => status(ctx.store, ctx.id) === 'FINISHED', 8000);
    expect(ctx.turns()).toBe(3);
    expect(reminders(ctx.store, ctx.id)).toBe(1);
  });
});

describe('a message to an epic past its breakdown (HH-256, HH-259)', () => {
  it('goes to the orchestrator for its children instead of blocking the epic; the orchestrator is told why it cannot message one', async () => {
    const { store, engine } = await setup();
    const epic = store.createItem({ title: 'Surface update', description: 'x', kind: 'epic' } as any);
    const child = store.createItem({ title: 'Authored layout', description: 'x', parent: epic.id });
    store.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/surface-update' } }], 'engine');
    await engine.start();
    await engine.message(epic.id, 'No treasure for Hometown.');
    const fm = store.getItem(epic.id)!.file.frontmatter;
    expect(fm.blocked).toBeFalsy();
    expect(fm.status).toBe('IN_PROGRESS');
    expect(store.getItem(epic.id)!.file.sections.find((s) => s.title === 'Activity')!.body).toContain('message: No treasure for Hometown.');
    expect(store.journal.read({ item: epic.id, type: 'orchestrator.wake' }).some((w) => w.data?.event === 'epic_message')).toBe(true);
    await expect(engine.message(epic.id, 'from the orchestrator', 'orchestrator')).rejects.toThrow(new RegExp(`no session past its breakdown; message its children \\(${child.id}\\)`));
  });
});

describe('the disk guard (#161, HH-355)', () => {
  it('pauses below min_free_gib so nothing new starts, resumes at resume_free_gib, and an ENOSPC stop is disk_full, not triaged', async () => {
    const { store, engine, world } = await setup();
    world.freeBytes = 3 * 2 ** 30;                                   // 3 GiB: under the 10 GiB default
    await engine.start();
    await (engine as any).checkDisk(true);
    expect(store.local.engine).toMatchObject({ paused: true, paused_by: 'disk', disk_guard: { free_gib: 3 } });
    expect(store.journal.read({ type: 'disk.guard_tripped' })).toHaveLength(1);
    const item = store.createItem({ title: 'Waits for disk', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.tick(); await sleep(150);
    expect(status(store, item.id)).toBe('QUEUED');                    // nothing new started
    world.freeBytes = 12 * 2 ** 30;                                  // above min, under the resume margin
    await (engine as any).checkDisk(true);
    expect(engine.paused).toBe(true);
    world.freeBytes = 20 * 2 ** 30;
    await (engine as any).checkDisk(true);
    expect(engine.paused).toBe(false);
    expect(store.local.engine.disk_guard).toBeUndefined();
    await waitFor(() => status(store, item.id) !== 'QUEUED');
    // a worker that hit the full disk anyway: its stop is said as disk_full and goes to no one's triage
    const other = store.createItem({ title: 'Hit it', description: 'x' });
    store.mutateItem(other.id, [{ set: { status: 'IN_PROGRESS' } }], 'engine');
    (engine as any).block(other.id, 'agent_blocked', 'cp: write error: No space left on device');
    const fm = store.getItem(other.id)!.file.frontmatter;
    expect(fm.blocked_reason).toBe('disk_full');
    expect(fm.triage).toBeUndefined();
  });
});
