import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { plannedWorktreeName } from '../src/engine/cleanupReconcile.ts';
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

describe('session slots and stalls (p25, f1)', () => {
  /** An IN_PROGRESS worker item with a worktree and nothing driving it. */
  function idleItem(store: DataStore, engine: LiveEngine, world: FakeWorld, title: string, set: Record<string, unknown> = {}) {
    const item = store.createItem({ title, description: 'x' });
    const rel = `.claude/worktrees/${item.id.toLowerCase()}`;
    const cwd = (engine as any).absWorktree(rel);
    world.worktrees.set(cwd, { path: cwd, head: world.sha(), branch: `tp/${item.id}` });
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', branch: `tp/${item.id}`, worktree: rel, session_id: 's-old', ...set } }], 'engine');
    return { id: item.id, cwd };
  }

  it('an epic and an item nothing drives hold no slot: a queued item is still admitted', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'max_sessions'], 1); doc.setIn(['concurrency', 'stall_after_min'], 0); }, 'config');
    const epic = store.createItem({ title: 'Epic', description: 'x', kind: 'epic' });
    store.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/epic' } }], 'engine');
    idleItem(store, engine, world, 'Idle');
    const queued = store.createItem({ title: 'Next', description: 'x' });
    store.transition(queued.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, queued.id) === 'PLAN_READY');
  });

  it('an item parked until others merge (resume_after) is not a stall (HH-265)', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'stall_after_min'], 0.002); }, 'config');
    const { id } = idleItem(store, engine, world, 'Waiting');
    const other = store.createItem({ title: 'Crawler sheet', description: 'x' });
    store.mutateItem(id, [{ set: { resume_after: { items: [other.id], message: 'wire the sheet once it merges', since: '2026-09-29T15:48:39-04:00' } } }], 'orchestrator');
    await engine.start();
    await sleep(600);                                                              // many ticks past stall_after_min
    expect(activityOf(store, id)).not.toContain('stalled: nothing has driven this item');
    expect(store.getItem(id)!.file.frontmatter.resume_after?.items).toEqual([other.id]);
  });

  it('a stalled item with committed work is carried on to its pull request', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'stall_after_min'], 0.002); }, 'config');
    const { id, cwd } = idleItem(store, engine, world, 'Forgotten');
    world.commits.set(cwd, 2);
    await engine.start();
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
    expect(activityOf(store, id)).toMatch(/stalled: nothing has driven this item for \d+ min; carrying on/);
  });

  it('an item orphaned between its setup and its first planning turn is planned (HH-123)', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'stall_after_min'], 0.002); }, 'config');
    const item = store.createItem({ title: 'Orphan', description: 'x' });
    const rel = '.claude/worktrees/tp-orphan', cwd = (engine as any).absWorktree(rel);
    world.worktrees.set(cwd, { path: cwd, head: world.sha(), branch: 'tp/orphan' });
    store.mutateItem(item.id, [{ set: { status: 'PLAN_IN_PROGRESS', branch: 'tp/orphan', worktree: rel } }], 'engine');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY', 8000);
    const activity = activityOf(store, item.id);
    expect(activity).toContain('stalled: nothing has driven this item');
    expect(activity).toContain('starting a fresh one with the full plan prompt');
  });

  it('a second stall within the hour blocks as stalled instead of looping', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'stall_after_min'], 0.002); }, 'config');
    const { id } = idleItem(store, engine, world, 'Again', { op_data: { stall_resumed_at: isoNow() } });
    await engine.start();
    await waitFor(() => store.getItem(id)!.file.frontmatter.blocked_reason === 'stalled', 8000);
  });
});

const isoNow = () => new Date().toISOString();

describe('API errors returned as text (p5)', () => {
  it('a worker turn that ended on "too old for this model" blocks as cli_too_old', async () => {
    const claude = () => ({ async runTurn(): Promise<TurnResult> { return { sessionId: 's', subtype: 'cli_too_old', isError: true, costUsd: 0, numTurns: 1, text: '', error: 'API Error: 400 Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required.' }; } });
    const { store, engine } = await setup({ claude });
    const item = store.createItem({ title: 'Old CLI', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked_reason === 'cli_too_old');
  });

  it('an orchestrator wake that fails on an API error is retried once after transient_retry_after_s, and the journal says it failed (#241)', async () => {
    let wakes = 0;
    const scripted = (world: FakeWorld) => {
      const inner = new DryRunClaudePort(world);
      return {
        runTurn: (o: TurnOptions) => inner.runTurn(o),
        async runCustomTurn(): Promise<TurnResult> { wakes += 1; return { sessionId: 'o', subtype: 'api_error', isError: true, costUsd: 0, numTurns: 1, text: 'API Error: 500', error: 'API Error: 500 internal' }; },
      };
    };
    const { store, engine } = await setup({ claude: scripted });
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'transient_retry_after_s'], 0.05); }, 'config');
    await engine.start();
    engine.orchestrator.wake({ type: 'user_message', data: { message: 'hi' } });
    await waitFor(() => store.journal.read({ type: 'orchestrator.done' }).length === 1);
    expect(wakes).toBe(2);
    expect(store.journal.read({ type: 'orchestrator.transient_retry' })).toHaveLength(1);
    expect(String(store.journal.read({ type: 'orchestrator.done' })[0].data?.summary)).toBe('(failed: api_error) API Error: 500 internal');
  });
});

describe('the host note (p21)', () => {
  it("is appended to a worker's system prompt", async () => {
    const appends: string[] = [];
    const claude = (world: FakeWorld) => { const inner = new DryRunClaudePort(world); return { async runTurn(o: TurnOptions): Promise<TurnResult> { appends.push(o.systemAppend); return inner.runTurn(o); }, runCustomTurn: inner.runCustomTurn.bind(inner) }; };
    const { store, engine } = await setup({ claude });
    const item = store.createItem({ title: 'Host', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => appends.length > 0);
    expect(appends[0]).toContain('planestro worker session');
    expect(appends[0]).toContain('## This host');
    expect(appends[0]).toContain('exit code 127');
  });
});

describe('ordinary commands in the worktree, and the pinned directory (#96)', () => {
  it('allows a chain that stays in the worktree, refuses a cd out of it, and parks only what names something outside', async () => {
    const seen: TurnOptions[] = [];
    const answers: Record<string, string> = {};
    const claude = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        seen.push(o);
        if (o.phase === 'plan') {
          for (const c of ['grep -rn TODO src | head -3; echo "exit $?"', 'echo notes > notes.txt']) answers[`plan: ${c}`] = (await o.onPermission({ tool: 'Bash', input: { command: c } })).action;
          // The second of those parked the planning turn; nothing else is asked of it here.
          return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'permission' };
        }
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
      },
      runCustomTurn: async (): Promise<TurnResult> => ({ subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '' }),
    });
    const { store, engine } = await setup({ claude });
    store.updateConfig((doc) => { doc.setIn(['permissions', 'allow'], ['Bash(npm run *)@worktree', 'Bash(npx tsc*)']); }, 'config: allow');
    const item = store.createItem({ title: 'Parks', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.awaiting === 'permission');
    const o = seen[0];
    const wt = join(store.codeRepoPath(), '.claude/worktrees/tp-1-parks');
    expect(o.cwd).toBe(wt);
    // The SDK's allow-list never sees a scoped rule, built in or the project's.
    expect(o.allowedTools).toContain('Bash(npx tsc*)');
    expect(o.allowedTools.filter((r) => r.includes('@worktree'))).toEqual([]);
    expect(o.systemAppend).toContain('## Your working directory');
    expect(o.systemAppend).toContain(`Every Bash command starts in your worktree (${wt})`);
    expect(answers).toEqual({ 'plan: grep -rn TODO src | head -3; echo "exit $?"': 'allow', 'plan: echo notes > notes.txt': 'park' });
    expect((store.getItem(item.id)!.file.frontmatter.awaiting_data as any).input.command).toBe('echo notes > notes.txt');
    // A cd out of the worktree is refused, not parked: the turn goes on.
    const ask = async (command: string) => o.onPermission({ tool: 'Bash', input: { command } });
    expect(await ask('cd ../../.. && ls node_modules')).toMatchObject({ action: 'deny', message: expect.stringContaining('pinned to your worktree') });
    expect((await ask('npm run build > build.log 2>&1; echo "exit $?"')).action).toBe('park');  // a planning turn writes nothing
    expect((await ask('npm run check 2>&1 | tail -5; echo "exit $?"')).action).toBe('allow');
    expect(activityOf(store, item.id)).toContain('denied Bash: your working directory is pinned');
  });
});

describe('what parks cost (#108)', () => {
  it('journals each park and its answer, tags the resuming turn, totals it per item, and offers the rule on the second park', async () => {
    let asks = 0;
    const claude = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0.5, numTurns: 1, text: '', planSubmitted: '# p' }; }
        if (asks < 2) { asks++; const r = await o.onPermission({ tool: 'Bash', input: { command: asks === 1 ? 'npx tsx tools/check-1.ts' : 'grep -n check tools/list.txt | npx tsx tools/check-2.ts' } }); if (r.action === 'park') return { sessionId: 's', subtype: 'success', isError: false, costUsd: 2, numTurns: 1, text: '', parked: 'permission' }; }
        await o.tools.report_done('done');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 7.25, numTurns: 1, text: '', done: 'done' };
      },
    });
    const { store, engine, world } = await setup({ claude });
    const item = store.createItem({ title: 'Parks', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-parks'), 1);
    await engine.approvePlan(item.id);
    const app = apiRoutes(store, engine);
    const view = async () => (await (await app.request(`/items/${item.id}`)).json()) as { park_hint: unknown };
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.awaiting === 'permission');
    expect((await view()).park_hint).toBeNull();                                    // the first time is not a pattern
    await engine.respond(item.id, { kind: 'permission', decision: 'allow' });
    await waitFor(() => asks === 2 && store.getItem(item.id)!.file.frontmatter.awaiting === 'permission');
    expect((await view()).park_hint).toEqual({ shape: 'npx tsx', parks: 2, rule: 'Bash(npx tsx *)@worktree' });
    await engine.respond(item.id, { kind: 'permission', decision: 'allow' });
    await waitFor(() => ['IN_REVIEW', 'MERGED', 'FINISHED'].includes(status(store, item.id)), 8000);
    const parked = store.journal.read({ item: item.id, type: 'permission.parked' });
    const answered = store.journal.read({ item: item.id, type: 'permission.answered' });
    // the second parked on its npx tsx, not on the grep its line starts with (#503's audit blamed the first word)
    expect(parked.map((p) => p.data?.shape)).toEqual(['npx tsx', 'npx tsx']);
    expect(answered.map((a) => [a.data?.park, a.data?.by, a.data?.decision])).toEqual(parked.map((p) => [p.data?.park, 'user', 'allow']));
    expect(answered.map((a) => [a.data?.tool, a.data?.command])).toEqual([['Bash', 'npx tsx tools/check-1.ts'], ['Bash', 'grep -n check tools/list.txt | npx tsx tools/check-2.ts']]);   // replayable (#169)
    const resumes = store.journal.read({ item: item.id, type: 'op.begin' }).filter((b) => b.data?.resumes_park);
    expect(resumes.map((b) => b.data?.resumes_park)).toEqual(parked.map((p) => p.data?.park));
    expect(store.getItem(item.id)!.file.frontmatter.op_data?.resume_park).toBeUndefined();
    const summary = await (await app.request('/parks')).json();
    expect(summary).toEqual([expect.objectContaining({ item: item.id, parks: 2, open: 0, resume_cost: 9.25, shapes: [{ shape: 'npx tsx', parks: 2, rule: 'Bash(npx tsx *)@worktree' }] })]);
    const suggest = await (await app.request('/permissions/suggest?min=2&min_items=1')).json();
    expect(suggest).toMatchObject({ allowed: 2, denied: 0, suggestions: [{ rule: 'Bash(npx tsx *)@worktree', approvals: 2 }], replay: { proposed: { false_allows: 0 } } });
  });
});

describe('preparing to restart (f3)', () => {
  it('lets the running turn finish, starts nothing new, says when it is safe, and is not persisted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = (world: FakeWorld) => { const inner = new DryRunClaudePort(world); return { async runTurn(o: TurnOptions): Promise<TurnResult> { await gate; return inner.runTurn(o); }, runCustomTurn: inner.runCustomTurn.bind(inner) }; };
    const { store, engine } = await setup({ claude: slow });
    const a = store.createItem({ title: 'Running', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => engine.sessions().length === 1);
    engine.drain();
    const b = store.createItem({ title: 'Waiting', description: 'x' });
    store.transition(b.id, 'QUEUED', 'user');
    let r = engine.restartReadiness();
    expect(r).toMatchObject({ draining: true, idle: false });
    expect(r.running).toContain(`${a.id}: plan turn`);
    release();
    await waitFor(() => engine.restartReadiness().idle);
    expect(status(store, a.id)).toBe('PLAN_READY');                    // the running turn finished
    await sleep(200);
    expect(status(store, b.id)).toBe('QUEUED');                        // nothing new started
    expect(store.local.engine.paused).toBe(false);                     // a restart comes back running
    engine.undrain();
    await waitFor(() => status(store, b.id) === 'PLAN_READY');
    r = engine.restartReadiness();
    expect(r.draining).toBe(false);
  });
});

describe('draining for a planestro update (#90)', () => {
  it('says it is an update, is not a pause, and a wait for CI does not hold the restart', async () => {
    const { store, engine } = await setup();
    const waiting = store.createItem({ title: 'Waiting on CI' });
    store.mutateItem(waiting.id, [{ set: { status: 'IN_REVIEW' } }, { set: { pr: 400, op: 'awaiting_ci', op_started_at: '2026-01-01T00:00:00+00:00', branch: 'tp/1-w', ci_result: 'pending' } }], 'engine');
    const app = apiRoutes(store, engine);
    const r = await (await app.request('/engine/drain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'update' }) })).json();
    expect(r).toMatchObject({ draining: true, by: 'update', idle: true, running: [] });   // GitHub finishes the CI; the next start resumes the wait
    expect(engine.paused).toBe(false);
    expect(store.local.engine.paused_by).toBeUndefined();                                  // nothing a person would have to resume
    expect((await (await app.request('/engine/drain', { method: 'POST' })).json()).by).toBe('user');  // the Console's button, no body
    engine.undrain();
    expect(engine.restartReadiness()).toEqual({ draining: false, idle: true, running: [] });
  });
});

describe('regenerated files that collide with the base (p17)', () => {
  /** An item IN_REVIEW with an open PR, its worktree carrying `untracked` files, ready for the merge pipeline. */
  async function inReview(untracked: string[], opts: { trackedChange?: boolean } = {}) {
    const ctx = await setup();
    const { store, engine, world } = ctx;
    const item = store.createItem({ title: 'Sidecars', description: 'x' });
    const branch = 'tp/1-sidecars', rel = '.claude/worktrees/tp-1-sidecars';
    const cwd = (engine as any).absWorktree(rel);
    const head = world.sha();
    world.worktrees.set(cwd, { path: cwd, head, branch }); world.remoteBranches.set(branch, head);
    world.prs.set(200, { number: 200, url: 'u', state: 'OPEN', headRefOid: head, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    world.untracked.set(cwd, untracked);
    if (opts.trackedChange) world.dirty.add(cwd);
    store.mutateItem(item.id, [{ set: { status: 'IN_REVIEW', branch, worktree: rel, pr: 200, ci_result: 'pending' } }], 'engine');
    return { ...ctx, id: item.id, cwd };
  }

  it('untracked files the base now tracks are moved aside, not deleted, and the sync goes on', async () => {
    const { store, engine, world, id, cwd } = await inReview(['assets/enemy_a.png.import', 'assets/enemy_b.png.import']);
    world.baseFiles.add('assets/enemy_a.png.import'); world.baseFiles.add('assets/enemy_b.png.import');
    await engine.start();
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
    expect(world.untracked.get(cwd)).toEqual([]);
    expect(activityOf(store, id)).toMatch(/moved 2 untracked files that trunk now tracks out of the way \(regenerated copies; nothing deleted\) to \S+\.displaced\/tp-1-/);
  });

  it('an untracked file the base does not track is the worker\'s: the item blocks as before', async () => {
    const { store, engine, world, id, cwd } = await inReview(['assets/enemy_a.png.import', 'notes/mine.txt']);
    world.baseFiles.add('assets/enemy_a.png.import');
    await engine.start();
    await waitFor(() => store.getItem(id)!.file.frontmatter.blocked_reason === 'dirty_tree');
    expect(world.untracked.get(cwd)).toHaveLength(2);
  });

  it('a change to a tracked file blocks even when the untracked ones collide', async () => {
    const { store, engine, world, id, cwd } = await inReview(['assets/enemy_a.png.import'], { trackedChange: true });
    world.baseFiles.add('assets/enemy_a.png.import');
    await engine.start();
    await waitFor(() => store.getItem(id)!.file.frontmatter.blocked_reason === 'dirty_tree');
    expect(world.untracked.get(cwd)).toHaveLength(1);
  });
});

describe('untracked byproducts are never dirt (p52)', () => {
  it('an implement turn that leaves only byproducts goes straight to its pull request, and cleanup sets them aside', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['worktrees', 'byproducts'], ['*.import']); }, 'config: byproducts');
    const item = store.createItem({ title: 'Art import', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.untracked.set(cwd, ['assets/ui/a.png.import', 'docs/shot.png.import']);
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const log = activityOf(store, item.id);
    expect(log).not.toMatch(/worktree dirty after turn/);
    expect(log).toMatch(/set aside 2 byproducts \(worktrees\.byproducts\) before removing the worktree: \S+\.displaced\//);
    expect(world.untracked.get(cwd)).toEqual([]);
  });

  it('the merge pipeline syncs past byproducts, and names the files when something else is in the way', async () => {
    const ctx = await setup();
    const { store, engine, world } = ctx;
    store.updateConfig((doc) => { doc.setIn(['worktrees', 'byproducts'], ['assets/**/*.import']); }, 'config: byproducts');
    const item = store.createItem({ title: 'Sidecars', description: 'x' });
    const branch = 'tp/1-sidecars', rel = '.claude/worktrees/tp-1-sidecars';
    const cwd = (engine as any).absWorktree(rel);
    const head = world.sha();
    world.worktrees.set(cwd, { path: cwd, head, branch }); world.remoteBranches.set(branch, head);
    world.prs.set(200, { number: 200, url: 'u', state: 'OPEN', headRefOid: head, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    world.untracked.set(cwd, ['assets/ui/a.png.import', 'b.png.import', 'notes/mine.txt']);
    store.mutateItem(item.id, [{ set: { status: 'IN_REVIEW', branch, worktree: rel, pr: 200, ci_result: 'pending' } }], 'engine');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked_reason === 'dirty_tree');
    expect(activityOf(store, item.id)).toMatch(/cannot be synced: b\.png\.import, notes\/mine\.txt/);
    expect(world.untracked.get(cwd)).toHaveLength(3);
  });

  it('finish from worktree does not count them', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['worktrees', 'byproducts'], ['*.import']); }, 'config: byproducts');
    const item = store.createItem({ title: 'Finish', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.untracked.set(cwd, ['a.png.import']);
    expect(await (engine as any).worktreeDirt(cwd)).toEqual({ clean: true, dirty: [], byproducts: ['a.png.import'] });
    world.untracked.set(cwd, ['a.png.import', 'a.png']);
    expect((await (engine as any).worktreeDirt(cwd)).dirty).toEqual(['a.png']);
  });
});

describe('max_sessions holds for every turn, not only admission (p51)', () => {
  it('two plans approved together never run more implement turns than max_sessions', async () => {
    let running = 0; let peak = 0; let hold = false; const gates: Array<() => void> = [];
    const claude = (world: FakeWorld) => { const inner = new DryRunClaudePort(world); return {
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        running += 1; peak = Math.max(peak, running);
        try { if (hold && o.phase === 'implement') await new Promise<void>((r) => gates.push(r)); return await inner.runTurn(o); } finally { running -= 1; }
      },
      runCustomTurn: inner.runCustomTurn.bind(inner),
    }; };
    const { store, engine } = await setup({ claude });
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'max_sessions'], 1); }, 'config: one session');
    const a = store.createItem({ title: 'First', description: 'x' });
    const b = store.createItem({ title: 'Second', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user'); store.transition(b.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, a.id) === 'PLAN_READY' && status(store, b.id) === 'PLAN_READY', 8000);
    peak = 0; hold = true;
    // Plan approval resumes an active item straight into its implement turn: it never passes through admit().
    await Promise.all([engine.approvePlan(a.id), engine.approvePlan(b.id)]);
    await waitFor(() => gates.length >= 1);
    await sleep(200);
    expect(peak).toBe(1);
    expect(engine.sessions().some((x) => x.op === 'implement: waiting for a session slot')).toBe(true);
    hold = false; while (gates.length) gates.shift()!();
    await waitFor(() => gates.length >= 0 && status(store, a.id) !== 'IN_PROGRESS' && status(store, b.id) !== 'IN_PROGRESS', 8000).catch(() => undefined);
    expect(peak).toBe(1);
  });
});

describe('files a worktree must not take with it (p40)', () => {
  it('what worktrees.keep_on_remove names is set aside before cleanup removes the worktree, tracked or ignored', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['worktrees', 'keep_on_remove'], ['tmp']); }, 'config: keep tmp');
    const item = store.createItem({ title: 'Raws', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.ignored.set(cwd, ['tmp/cc_dressing/source/a.png', 'tmp/cc_dressing/source/b.png', '.godot/imported/x.md5']);
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(activityOf(store, item.id)).toMatch(/set aside 2 files under tmp \(worktrees\.keep_on_remove\) before removing the worktree: \S+\.displaced\//);
    expect(world.ignored.get(cwd)).toEqual(['.godot/imported/x.md5']);        // only what was named moved; caches stay with the worktree
  });

  it('a tracked file under the named folder stays: moving it would dirty the worktree (p46)', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['worktrees', 'keep_on_remove'], ['tmp']); }, 'config: keep tmp');
    world.baseFiles.add('tmp/.gdignore');
    const item = store.createItem({ title: 'Tracked marker', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.ignored.set(cwd, ['tmp/raw.png']);
    const moved: string[][] = [];
    const git = (engine as any).ports.git; const inner = git.moveAside.bind(git);
    git.moveAside = async (c: string, paths: string[], dest: string) => { moved.push(paths); return inner(c, paths, dest); };
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(activityOf(store, item.id)).toMatch(/set aside 1 file under tmp/);
    expect(moved.flat()).toEqual(['tmp/raw.png']);
  });

  it('copy_to_checkout copies a merged worker\'s untracked files into the main checkout, never over a different file, and keeps them (#72)', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['worktrees', 'copy_to_checkout'], ['tmp']); }, 'config: copy tmp');
    world.baseFiles.add('tmp/.gdignore');
    world.checkout.set(store.codeRepoPath(), new Set(['tmp/raws/b.png']));   // already in the checkout, other content
    const item = store.createItem({ title: 'Art raws', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.ignored.set(cwd, ['tmp/raws/a.png', 'tmp/raws/b.png']);
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect([...world.checkout.get(store.codeRepoPath())!].sort()).toEqual(['tmp/raws/a.png', 'tmp/raws/b.png']);
    const log = activityOf(store, item.id);
    expect(log).toMatch(/copied 1 file under tmp into the main checkout \(worktrees\.copy_to_checkout\); 1 file not copied because the checkout has a different file at that path, kept only in \.displaced\/: tmp\/raws\/b\.png/);
    expect(log).toMatch(/set aside 2 files under tmp/);                          // the originals are kept as keep_on_remove keeps them
  });

  it('a copy into the checkout that fails blocks cleanup_dirty and removes nothing (#72)', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['worktrees', 'copy_to_checkout'], ['tmp']); }, 'config: copy tmp');
    const item = store.createItem({ title: 'Disk full', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.ignored.set(cwd, ['tmp/raw.png']);
    (engine as any).ports.git.copyInto = async () => { throw new Error('ENOSPC: no space left on device'); };
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked_reason === 'cleanup_dirty', 8000);
    expect(activityOf(store, item.id)).toMatch(/copying tmp into the main checkout failed \(ENOSPC.*\); nothing was removed/);
    expect(world.worktrees.has(cwd)).toBe(true);
    expect(world.ignored.get(cwd)).toEqual(['tmp/raw.png']);
  });

  it('close as done sets them aside too, before it removes an unused worktree', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['worktrees', 'keep_on_remove'], ['tmp']); }, 'config: keep tmp');
    const item = store.createItem({ title: 'Unused', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.ignored.set(cwd, ['tmp/raw.png']); world.commits.set(cwd, 0); world.behind.set(cwd, 0);
    await engine.closeAsDone(item.id, 'landed elsewhere');
    expect(status(store, item.id)).toBe('FINISHED');
    expect(activityOf(store, item.id)).toMatch(/removed .*; set aside 1 file under tmp/);
    expect(world.ignored.get(cwd)).toEqual([]);
  });

  it('with nothing named, cleanup is as before', async () => {
    const { store, engine, world } = await setup();
    const item = store.createItem({ title: 'Plain', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.ignored.set(cwd, ['tmp/raw.png']);
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(activityOf(store, item.id)).not.toContain('set aside');
  });
});

describe('resume when other items merge (p14)', () => {
  async function parked(opts: { conflict?: boolean } = {}) {
    const prompts: { phase: string; prompt: string }[] = [];
    const claude = (world: FakeWorld) => { const inner = new DryRunClaudePort(world); return { async runTurn(o: TurnOptions): Promise<TurnResult> { prompts.push({ phase: o.phase, prompt: o.prompt }); return inner.runTurn(o); }, runCustomTurn: inner.runCustomTurn.bind(inner) }; };
    const ctx = await setup({ claude });
    const { store, engine, world } = ctx;
    const flag = store.createItem({ title: 'Normalizer flag', description: 'x' });
    const art = store.createItem({ title: 'Boss atlas', description: 'x' });
    const rel = '.claude/worktrees/tp-2-boss-atlas', cwd = (engine as any).absWorktree(rel);
    world.worktrees.set(cwd, { path: cwd, head: world.sha(), branch: 'tp/2-boss-atlas' });
    store.mutateItem(art.id, [{ set: { status: 'IN_PROGRESS', branch: 'tp/2-boss-atlas', worktree: rel, session_id: 's-art', blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }], 'engine');
    if (opts.conflict) world.conflictArmed = true;
    await engine.start();
    return { ...ctx, flag: flag.id, art: art.id, prompts };
  }

  it('a parked item stops needing you, and resumes on a rebased branch with the message once the other merges', async () => {
    const { store, engine, flag, art, prompts } = await parked();
    expect(await engine.resumeAfter(art, [flag], 'Build the final pack with --row-jump-overrides.')).toContain('parked');
    const fm = store.getItem(art)!.file.frontmatter;
    expect(fm.blocked).toBeUndefined();
    expect(store.derived(store.getItem(art)!).needs_you).toBe(false);
    await sleep(200);
    expect(prompts).toHaveLength(0);                                   // nothing resumes while it waits
    store.mutateItem(flag, [{ set: { status: 'MERGED' } }], 'engine');
    await waitFor(() => prompts.length === 1);
    expect(prompts[0].prompt).toContain(`${flag} has merged. Your branch was rebased onto origin/trunk`);
    expect(prompts[0].prompt).toContain('Build the final pack with --row-jump-overrides.');
    expect(store.getItem(art)!.file.frontmatter.resume_after).toBeUndefined();
    expect(activityOf(store, art)).toContain('rebased onto origin/trunk before resuming');
  });

  it('waits on a pull request a person opened, by number: resumes when it merges, blocks when it closes unmerged (#136, HH-298)', async () => {
    const { store, engine, world, art, prompts } = await parked();
    const pr = (n: number, state: 'OPEN' | 'MERGED' | 'CLOSED') => world.prs.set(n, { number: n, url: `u${n}`, state, headRefOid: world.sha(), headRefName: `hand/${n}`, baseRefName: 'trunk', polls: 0, failOnce: false });
    expect(await engine.resumeAfter(art, [], 'x', 'user', [999])).toMatch(/no pull request #999/);
    pr(471, 'CLOSED');
    expect(await engine.resumeAfter(art, [], 'x', 'user', [471])).toMatch(/PR #471 was closed without merging/);
    pr(468, 'OPEN');
    expect(await engine.resumeAfter(art, [], 'Wire the new road.', 'user', [468])).toBe(`parked: ${art} resumes when PR #468 has merged`);
    expect(store.derived(store.getItem(art)!).needs_you).toBe(false);
    expect(activityOf(store, art)).toContain('waits for PR #468 to merge, then resumes with: Wire the new road.');
    await sleep(200);
    expect(prompts).toHaveLength(0);
    world.prs.get(468)!.state = 'MERGED';
    (engine as any).waitedPrs.clear();                                // a minute later, as the tick reads it again
    await waitFor(() => prompts.length === 1);
    expect(prompts[0].prompt).toContain('PR #468 has merged.');
    expect(prompts[0].prompt).toContain('Wire the new road.');
    // closed without merging: the wait ends in a block that says so
    store.mutateItem(art, [{ set: { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }], 'engine');
    await waitFor(() => !(engine as any).jobs.has(art));
    pr(470, 'OPEN');
    expect(await engine.resumeAfter(art, [], 'y', 'user', [470])).toContain('parked');
    world.prs.get(470)!.state = 'CLOSED'; (engine as any).waitedPrs.clear();
    await waitFor(() => store.getItem(art)!.file.frontmatter.blocked_reason === 'waited_on_gone');
    expect(activityOf(store, art)).toContain('it was waiting for PR #470, closed without merging');
  });

  it('a rebase conflict on resume goes to a fix turn, and the message follows once the rebase is finished', async () => {
    const { store, engine, flag, art, prompts } = await parked({ conflict: true });
    await engine.resumeAfter(art, [flag], 'Now wire the flag in.');
    store.mutateItem(flag, [{ set: { status: 'FINISHED' } }], 'engine');
    await waitFor(() => prompts.length >= 2);
    expect(prompts[0].phase).toBe('fix');
    expect(prompts[0].prompt).toContain('src/conflicted.ts');
    expect(prompts[0].prompt).not.toContain('Now wire the flag in.');
    // The message is what the session does once planestro has finished the rebase with its resolution (HH-532).
    expect(prompts[1].prompt).toContain('planestro finished rebasing your branch');
    expect(prompts[1].prompt).toContain('Now wire the flag in.');
  });

  it('an item it waits for that is deleted blocks it, with the message kept; nonsense is refused', async () => {
    const { store, engine, flag, art } = await parked();
    expect(await engine.resumeAfter(art, [art], 'x')).toContain('cannot wait for itself');
    expect(await engine.resumeAfter(art, ['TP-404'], 'x')).toContain('not an item');
    expect(await engine.resumeAfter(flag, [art], 'x')).toContain('not possible');       // not planning or in progress
    await engine.resumeAfter(art, [flag], 'Use the flag.');
    store.deleteItem(flag);
    await waitFor(() => store.getItem(art)!.file.frontmatter.blocked_reason === 'waited_on_gone');
    expect(activityOf(store, art)).toContain('its message was: Use the flag.');
  });
});

describe('the orchestrator\'s notes about planestro (f8)', () => {
  it('note_planestro lands in a journal list of its own, not on the item', async () => {
    let reply = '';
    const scripted = (world: FakeWorld) => {
      const inner = new DryRunClaudePort(world);
      return {
        runTurn: (o: TurnOptions) => inner.runTurn(o),
        async runCustomTurn(o: any): Promise<TurnResult> {
          const t = (n: string) => o.mcpTools.find((x: any) => x.name === n);
          reply = await t('note_planestro').handler({ title: 'Budget card should carry the raise itself', text: 'The budget card should carry the raise itself.', item: 'TP-1' });
          await t('done_with_wake').handler({ summary: 'noted' });
          return { sessionId: 'o', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
        },
      };
    };
    const { store, engine } = await setup({ claude: scripted });
    const item = store.createItem({ title: 'Cardy', description: 'x' });
    engine.orchestrator.wake({ type: 'user_message', item: item.id, data: { message: 'hi' } });
    await waitFor(() => store.journal.read({ type: 'orchestrator.planestro_note' }).length === 1);
    expect(reply).toContain('planestro feedback');
    const note = store.journal.read({ type: 'orchestrator.planestro_note' })[0];
    expect(note.item).toBe(item.id);
    expect(note.data?.text).toBe('The budget card should carry the raise itself.');
    expect(note.data?.title).toBe('Budget card should carry the raise itself');
    expect(activityOf(store, item.id)).not.toContain('budget card should carry');
  });
});

describe('a held epic PR whose CI goes red (#116, HH-242)', () => {
  it('is polled while held, and its red run goes to the orchestrator: never silent to both', async () => {
    const { store, engine, world } = await setup();
    store.updateConfig((doc) => { doc.setIn(['ci', 'draft_while_held'], false); }, 'config: no drafts');
    const epic = store.createItem({ title: 'Game Over dashboard', description: 'x', kind: 'epic' } as any);
    const branch = 'feature/game-over';
    world.remoteBranches.set(branch, world.sha());
    world.prs.set(428, { number: 428, url: 'u', state: 'OPEN', headRefOid: world.remoteBranches.get(branch)!, headRefName: branch, baseRefName: 'trunk', polls: 5, failOnce: true });
    store.mutateItem(epic.id, [{ set: { status: 'IN_REVIEW' } }, { set: { pr: 428, branch, skip_merge: true, hold_reason: 'for the designer to play it', ci_result: 'pending' } }], 'engine');
    expect(store.derived(store.getItem(epic.id)!).needs_you).toBe(true);           // held for the designer from the start
    await engine.start();
    await waitFor(() => store.getItem(epic.id)!.file.frontmatter.blocked_reason === 'ci_red', 8000);
    const fm = store.getItem(epic.id)!.file.frontmatter;
    expect(fm.ci_result).toBe('red');
    // the orchestrator looks first (the dry-run one ends its triage at once, so it is read from the log)
    expect(store.getItem(epic.id)!.file.sections.find((x) => x.title === 'Activity')!.body).toContain('the orchestrator is triaging this (ci_red)');
    expect(store.journal.read({ item: epic.id, type: 'orchestrator.wake' }).some((w) => w.data?.event === 'blocked_ci_red')).toBe(true);
    expect(fm.skip_merge).toBe(true);                                                // the hold stands
  });
});

describe('a message queued for the session is never merged over (HH-263)', () => {
  it('goes to the session before the pull request merges, and the PR merges after', async () => {
    const prompts: { phase: string; prompt: string; status: string }[] = [];
    let store!: DataStore;
    const claude = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        prompts.push({ phase: o.phase, prompt: o.prompt, status: store.getItem(o.itemId)!.file.frontmatter.status });
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        await o.tools.report_done('done');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'done' };
      },
    });
    const ctx = await setup({ claude });
    store = ctx.store;
    const { engine, world } = ctx;
    const item = store.createItem({ title: 'Crawler', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-crawler'), 1);
    store.mutateItem(item.id, [{ set: { skip_merge: true } }], 'user');                  // held until the designer says
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'IN_REVIEW' && !(engine as any).jobs.has(item.id), 8000);
    // the designer's ruling reaches the queue while something else drives the item (HH-263: a CI wait)
    const cur = store.getItem(item.id)!.file.frontmatter;
    store.mutateItem(item.id, [{ set: { op_data: { ...(cur.op_data ?? {}), pending_messages: ['ship the Crawler with the width waiver'] } } }], 'user');
    await engine.releaseHold(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const fix = prompts.find((p) => p.prompt.includes('ship the Crawler with the width waiver'))!;
    expect(fix).toMatchObject({ phase: 'fix', status: 'IN_REVIEW' });                    // delivered while the PR was still open
    expect(fix.prompt).toContain('was about to merge: it waits for what you do with these');
    const log = activityOf(store, item.id);
    expect(log.indexOf('sending 1 queued message to the session before its pull request merges')).toBeGreaterThan(-1);
    expect(log.indexOf('sending 1 queued message')).toBeLessThan(log.indexOf('status IN_REVIEW → MERGED'));
  });
});

describe('a pull request attached by hand (p44)', () => {
  /** An item with a worker branch, a worktree and an open PR the engine did not open. */
  function handMade(store: DataStore, engine: LiveEngine, world: FakeWorld, status: 'IN_PROGRESS' | 'IN_REVIEW', extra: Record<string, unknown> = {}) {
    const item = store.createItem({ title: 'By hand', description: 'x' });
    const branch = 'tp/1-by-hand', rel = '.claude/worktrees/tp-1-by-hand';
    const cwd = (engine as any).absWorktree(rel);
    const head = world.sha();
    world.worktrees.set(cwd, { path: cwd, head, branch }); world.remoteBranches.set(branch, head); world.commits.set(cwd, 1);
    world.prs.set(350, { number: 350, url: 'u', state: 'OPEN', headRefOid: head, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    store.mutateItem(item.id, [{ set: { status, branch, worktree: rel, ...extra } }], 'engine');
    return item.id;
  }
  const json = (body: unknown) => ({ method: 'PATCH' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('a held item needs you whatever its CI says (#116); one that is not held does not', async () => {
    const { store } = await setup();
    const item = store.createItem({ title: 'Held', description: 'x' });
    const needs = (set: Record<string, unknown>) => { store.mutateItem(item.id, [{ set }], 'engine'); return store.derived(store.getItem(item.id)!).needs_you; };
    expect(needs({ status: 'IN_REVIEW', skip_merge: true, ci_result: 'pending' })).toBe(true);
    expect(needs({ status: 'IN_REVIEW', skip_merge: true, ci_result: 'green' })).toBe(true);
    expect(needs({ status: 'IN_REVIEW', skip_merge: true, ci_result: 'red' })).toBe(true);    // HH-242: held to be played, red on something else
    expect(needs({ status: 'IN_REVIEW', skip_merge: false, ci_result: 'green' })).toBe(false);
    expect(needs({ status: 'IN_REVIEW', skip_merge: true, ci_result: 'pending', op_data: { pr_draft: true } })).toBe(true);   // a held draft: CI waits for the release
  });

  it('PATCHing a pr onto an item in review marks its CI pending, so the pipeline takes it once it is free to', async () => {
    const { store, engine, world } = await setup();
    const id = handMade(store, engine, world, 'IN_REVIEW', { skip_merge: true, ci_result: 'unknown' });   // held: the pipeline leaves it alone
    await engine.start();
    const app = apiRoutes(store, engine);
    const r = await app.request(`/items/${id}`, json({ fields: { pr: 350 } }));
    expect(r.status).toBe(200);
    expect((await r.json()).frontmatter.ci_result).toBe('pending');
    await sleep(300);
    expect(status(store, id)).toBe('IN_REVIEW');                                 // still held
    await engine.releaseHold(id);
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
  });

  it('moving an item with a pr into review by hand does the same, and says so', async () => {
    const { store, engine, world } = await setup();
    const id = handMade(store, engine, world, 'IN_PROGRESS', { pr: 350 });
    await engine.start();
    const app = apiRoutes(store, engine);
    const r = await app.request(`/items/${id}/transition`, { ...json({ to: 'IN_REVIEW' }), method: 'POST' });
    expect(r.status).toBe(200);
    expect(activityOf(store, id)).toContain('PR #350 attached by hand: entering the merge pipeline');
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
  });
});

describe('finish from here (f2)', () => {
  async function stuck(extra: Record<string, unknown> = {}) {
    const ctx = await setup();
    const { store, engine } = ctx;
    const item = store.createItem({ title: 'Done by hand', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', blocked: true, blocked_reason: 'over_budget', awaiting: 'user', op_data: { done_summary: 'All eight rows drawn.' }, ...extra } }], 'engine');
    return { ...ctx, id: item.id, cwd };
  }

  it('committed work on a clean worktree goes to a pull request, clearing the block, with the summary it reported', async () => {
    const { store, engine, world, id, cwd } = await stuck();
    world.commits.set(cwd, 2);
    expect(await engine.finishFromWorktree(id)).toBe('finishing: 2 commits go to a pull request');
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
    expect(activityOf(store, id)).toContain('finish from here: 2 commits ahead of origin/trunk, tree clean; opening the pull request (it was blocked: over_budget)');
  });

  it('refuses a dirty tree, nothing ahead, or the wrong status, and says which', async () => {
    const { store, engine, world, id, cwd } = await stuck();
    expect(await engine.finishFromWorktree(id)).toContain('nothing ahead of origin/trunk');
    world.commits.set(cwd, 1); world.dirty.add(cwd);
    expect(await engine.finishFromWorktree(id)).toContain('uncommitted changes');
    world.dirty.delete(cwd);
    store.mutateItem(id, [{ set: { status: 'PLAN_READY' } }], 'engine');
    expect(await engine.finishFromWorktree(id)).toContain('is PLAN_READY');
    expect(store.getItem(id)!.file.frontmatter.blocked).toBe(true);                 // nothing was cleared by a refusal
  });

  it('the route answers 400 with the reason, 200 when it starts', async () => {
    const { store, engine, world, id, cwd } = await stuck();
    const app = apiRoutes(store, engine);
    const post = () => app.request(`/items/${id}/finish`, { method: 'POST' });
    expect((await post()).status).toBe(400);
    world.commits.set(cwd, 1);
    expect((await post()).status).toBe(200);
    await waitFor(() => status(store, id) === 'FINISHED', 8000);
  });
});

describe('an audition: sounds and models are reviewed like images (f5)', () => {
  it('review files carry their kind, the file route serves audio as audio, and the thumbnail skips sounds', async () => {
    const { store, engine, world } = await setup();
    const item = store.createItem({ title: 'Door sounds', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const fm = store.getItem(item.id)!.file.frontmatter;
    world.files.set(fm.branch!, new Map([['sfx/door_a.mp3', Buffer.from('ID3fake')], ['sfx/door_b.wav', Buffer.from('RIFFfake')], ['models/crate.glb', Buffer.from('glTFfake')], ['notes.txt', Buffer.from('n')]]));
    const files = await engine.reviewImages(item.id);
    expect(files.map((f) => [f.path, f.kind])).toEqual([['sfx/door_a.mp3', 'audio'], ['sfx/door_b.wav', 'audio'], ['models/crate.glb', 'model'], ['notes.txt', 'text']]);
    const app = apiRoutes(store, engine);
    const r = await app.request(`/items/${item.id}/image?path=sfx%2Fdoor_a.mp3&side=after`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/mpeg');
    expect((await app.request(`/items/${item.id}/thumb`)).status).toBe(404);   // no image among them
  });
});

describe('orchestrator', () => {
  it('wakes on plan_review with a context packet, uses tools, and rotates after the configured wakes', async () => {
    const wakes: { label: string; prompt: string; resume?: string }[] = [];
    const scripted = (world: FakeWorld) => {
      const inner = new DryRunClaudePort(world);
      return {
        runTurn: (o: TurnOptions) => inner.runTurn(o),
        async runCustomTurn(o: any): Promise<TurnResult> {
          wakes.push({ label: o.label, prompt: o.prompt, resume: o.resume });
          const t = (n: string) => o.mcpTools.find((x: any) => x.name === n);
          if (o.label.includes('plan_review')) {
            expect(o.prompt).toContain('Event: plan_review');
            expect(o.prompt).toContain('submitted plan');
            await t('annotate_item').handler({ id: 'TP-1', text: 'plan looks tight; scope matches' });
            expect(await t('approve_plan').handler({ id: 'TP-1' })).toContain('not permitted');
          }
          await t('done_with_wake').handler({ summary: `handled ${o.label}` });
          return { sessionId: 'orch-1', subtype: 'success', isError: false, costUsd: 0.05, numTurns: 1, text: '' };
        },
      };
    };
    const { store, engine } = await setup({ claude: scripted });
    const { readFileSync, writeFileSync } = await import('node:fs');
    const cfg = `${store.dataDir}/planestro.yml`;
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('rotate_after_wakes: 40', 'rotate_after_wakes: 2'));
    store.reload();
    const item = store.createItem({ title: 'Orchestrated', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await waitFor(() => wakes.length >= 1);
    expect(wakes[0].label).toContain('plan_review');
    expect(wakes[0].resume).toBeUndefined();
    const activity = () => store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    await waitFor(() => activity().includes('[orchestrator] plan looks tight'));
    // second wake resumes the same session; third rotates (rotate_after_wakes: 2)
    // what the chat route journals beside each wake
    const say = (text: string, item?: string) => { store.journal.append({ type: 'orchestrator.user_message', item, actor: 'user', data: { text } }); engine.orchestrator.wake({ type: 'user_message', item, data: { message: text } }); };
    say('as each child of the epic merges, submit its dependents yourself', item.id);
    await waitFor(() => wakes.length >= 2);
    expect(wakes[1].resume).toBe('orch-1');
    expect(wakes[1].prompt).not.toContain('What the user said to you lately'); // the live conversation already has it
    say('again');
    await waitFor(() => wakes.length >= 3);
    expect(wakes[2].resume).toBeUndefined(); // rotated: files are the memory
    // #49: each wake says which conversation it was in, its place in it, and whether it began one
    await waitFor(() => store.journal.read({ type: 'orchestrator.done' }).length >= 3);
    expect(store.journal.read({ type: 'orchestrator.done' }).map((e) => [e.data?.session, e.data?.wake, e.data?.fresh ?? false])).toEqual([['orch-1', 1, true], ['orch-1', 2, false], ['orch-1', 1, true]]);
    // #59: the instruction given to the rotated-away conversation is carried into the fresh one
    expect(wakes[2].prompt).toContain('What the user said to you lately');
    expect(wakes[2].prompt).toContain(`user (on ${item.id}): as each child of the epic merges, submit its dependents yourself`);
  });
});

describe('reconcile and the merge queue in the same second (LM-22)', () => {
  it('a PR the merge queue is merging is not "merged outside planestro"; a status that moved during the check is left alone', async () => {
    const { store, engine, world } = await setup();
    const it1 = store.createItem({ title: 'Trees' });
    store.mutateItem(it1.id, [{ set: { status: 'IN_REVIEW' } }, { set: { pr: 51, branch: 'tp/1-trees', ci_result: 'green' } }], 'engine');
    world.prs.set(51, { number: 51, url: 'u', state: 'MERGED', headRefOid: world.sha(), headRefName: 'tp/1-trees', baseRefName: 'trunk', polls: 9, failOnce: false } as any);
    // the merge job is in flight for it
    let release!: () => void;
    (engine as any).jobs.set(it1.id, new Promise<void>((r) => { release = r; }));
    let out = await engine.reconcile('manual');
    expect(out.some((c) => c.startsWith(`${it1.id}:`))).toBe(false);
    expect(status(store, it1.id)).toBe('IN_REVIEW');
    release(); (engine as any).jobs.delete(it1.id);
    // the merge job moves it to MERGED while reconcile waits on GitHub
    const gh = (engine as any).ports.gh; const inner = gh.prView.bind(gh);
    gh.prView = async (...a: unknown[]) => { const pr = await inner(...a); store.mutateItem(it1.id, [{ transition: { to: 'MERGED', actor: 'engine' } }], 'engine'); return pr; };
    out = await engine.reconcile('manual');
    expect(out.some((c) => c.includes('merged outside planestro') || c.includes('reconcile error'))).toBe(false);
    const fm = store.getItem(it1.id)!.file.frontmatter;
    expect(fm.status).toBe('MERGED');
    expect(fm.blocked).toBeUndefined();
  });
});

describe('reconciler (chaos: crash markers left on disk)', () => {
  it('converges stale ops, adopts pre-crash PRs, observes external merges, blocks on missing worktrees, reports orphans', async () => {
    const { store, engine, world } = await setup();
    const mk = (title: string, set: Record<string, unknown>, status?: string) => {
      const it = store.createItem({ title });
      const ops: any[] = [];
      if (status) ops.push({ set: { status } });
      ops.push({ set });
      return store.mutateItem(it.id, ops, 'engine').id;
    };
    // a: crash during creating_pr, but the PR made it to GitHub
    const a = mk('A', { op: 'creating_pr', op_started_at: '2026-01-01T00:00:00+00:00', branch: 'tp/1-a', worktree: '.claude/worktrees/tp-1-a' }, 'IN_PROGRESS');
    world.worktrees.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-a'), { path: join(store.codeRepoPath(), '.claude/worktrees/tp-1-a'), head: world.sha(), branch: 'tp/1-a' });
    world.remoteBranches.set('tp/1-a', world.sha());
    world.prs.set(300, { number: 300, url: 'u', state: 'OPEN', headRefOid: world.remoteBranches.get('tp/1-a')!, headRefName: 'tp/1-a', baseRefName: 'trunk', polls: 9, failOnce: false });
    // b: PR merged outside planestro while IN_REVIEW (its worktree exists and is clean)
    const b = mk('B', { pr: 301, branch: 'tp/2-b', worktree: '.claude/worktrees/tp-2-b', ci_head_sha: 'x'.repeat(40) }, 'IN_REVIEW');
    world.worktrees.set(join(store.codeRepoPath(), '.claude/worktrees/tp-2-b'), { path: join(store.codeRepoPath(), '.claude/worktrees/tp-2-b'), head: world.sha(), branch: 'tp/2-b' });
    world.prs.set(301, { number: 301, url: 'u', state: 'MERGED', mergedAt: new Date().toISOString(), headRefOid: 'x'.repeat(40), headRefName: 'tp/2-b', baseRefName: 'trunk', mergeCommit: world.sha(), polls: 9, failOnce: false });
    // c: worktree vanished mid-implementation
    const c = mk('C', { branch: 'tp/3-c', worktree: '.claude/worktrees/tp-3-c' }, 'IN_PROGRESS');
    // d: stale awaiting_ci marker
    const d = mk('D', { pr: 302, op: 'awaiting_ci', op_started_at: '2026-01-01T00:00:00+00:00', branch: 'tp/4-d', worktree: '.claude/worktrees/tp-4-d', ci_result: 'pending' }, 'IN_REVIEW');
    world.worktrees.set(join(store.codeRepoPath(), '.claude/worktrees/tp-4-d'), { path: join(store.codeRepoPath(), '.claude/worktrees/tp-4-d'), head: world.sha(), branch: 'tp/4-d' });
    world.prs.set(302, { number: 302, url: 'u', state: 'OPEN', headRefOid: world.sha(), headRefName: 'tp/4-d', baseRefName: 'trunk', polls: 9, failOnce: false });
    // orphan worktree nobody owns
    world.worktrees.set(join(store.worktreesRoot(), 'tp-99-ghost'), { path: join(store.worktreesRoot(), 'tp-99-ghost'), head: world.sha(), branch: 'tp/99-ghost' });

    const wakes: string[] = [];
    (engine as any).orchestrator.wake = (ev: { type: string }) => { wakes.push(ev.type); };
    const corrections = await engine.reconcile('manual');
    expect(corrections.join('\n')).toContain(`${a}: adopted PR #300`);
    expect(status(store, a)).toBe('IN_REVIEW');
    expect(store.getItem(a)!.file.frontmatter.pr).toBe(300);
    expect(corrections.join('\n')).toContain(`${b}: PR #301 was merged outside planestro`);
    await waitFor(() => status(store, b) === 'FINISHED', 8000);
    expect(store.getItem(c)!.file.frontmatter.blocked).toBe(true);
    expect(store.getItem(c)!.file.frontmatter.blocked_reason).toBe('worktree_missing');
    expect(status(store, c)).toBe('IN_PROGRESS'); // phase preserved
    expect(store.getItem(d)!.file.frontmatter.op).toBeUndefined();
    expect(corrections.join('\n')).toContain('orphan worktrees');
    // idempotent: a second pass only re-reports the environment, changes nothing —
    // and an unchanged orphan set never wakes the orchestrator again
    expect(wakes.filter((w) => w === 'orphans_found')).toHaveLength(1);
    const again = await engine.reconcile('manual');
    expect(again.filter((x) => !x.includes('orphan') && !x.includes('resuming cleanup'))).toEqual([]);
    expect(wakes.filter((w) => w === 'orphans_found')).toHaveLength(1);
    // #100: a worktree a tool made inside an item's worktree is that item's; one that comes and goes never re-asks about the rest
    const nested = join(store.codeRepoPath(), '.claude/worktrees/tp-4-d/tools/cache/.baseline/7618f38');
    world.worktrees.set(nested, { path: nested, head: world.sha() });
    expect((await engine.reconcile('manual')).join('\n')).not.toContain('7618f38');
    world.worktrees.delete(nested);
    const second = join(store.worktreesRoot(), 'tp-98-other');
    world.worktrees.set(second, { path: second, head: world.sha(), branch: 'tp/98-other' });
    await engine.reconcile('manual');
    expect(wakes.filter((w) => w === 'orphans_found')).toHaveLength(2);   // a new one: told
    world.worktrees.delete(second);
    await engine.reconcile('manual');
    world.worktrees.set(second, { path: second, head: world.sha(), branch: 'tp/98-other' });
    await engine.reconcile('manual');
    expect(wakes.filter((w) => w === 'orphans_found')).toHaveLength(2);   // gone and back, or fewer: nothing new to tell
    // #416: another tool's worktree in the shared root (Claude Code's agent-*, a person's perf-*) is listed, never woken on
    for (const name of ['agent-a4c58be5', 'perf-audit', 'tp-feature']) {
      const p = join(store.worktreesRoot(), name);
      world.worktrees.set(p, { path: p, head: world.sha(), branch: `worktree-${name}` });
      expect((await engine.reconcile('manual')).join('\n')).toContain(name);
    }
    expect(wakes.filter((w) => w === 'orphans_found')).toHaveLength(2);
    // an epic's leftover merge worktree is planestro's own: it still wakes
    const merge = join(store.worktreesRoot(), `merge-${store.config.project.id_prefix.toLowerCase()}-77`);
    world.worktrees.set(merge, { path: merge, head: world.sha(), branch: 'feature/x' });
    await engine.reconcile('manual');
    expect(wakes.filter((w) => w === 'orphans_found')).toHaveLength(3);
  });
});

describe('plannedWorktreeName (#416)', () => {
  it('matches the folders dir_pattern can make, and nothing else in the shared root', () => {
    const re = plannedWorktreeName('{{prefix_lower}}-{{number}}-{{slug}}', 'hh');
    expect(['hh-532-forge-golem', 'hh-1-x'].every((n) => re.test(n))).toBe(true);
    expect(['agent-a4c58be5', 'perf-audit', 'hh-forge', 'xhh-5-a', 'lm-5-a'].some((n) => re.test(n))).toBe(false);
    expect(plannedWorktreeName('wt/{{prefix_lower}}.{{number}}', 'a.b').test('wt/a.b.12')).toBe(true);
    expect(plannedWorktreeName('wt/{{prefix_lower}}.{{number}}', 'a.b').test('wt/aXb.12')).toBe(false);
  });
});

describe('reconcile never judges a worktree that is being made (dogfood p55, LM-12)', () => {
  it('a pass that runs during `git worktree add` leaves the item unblocked; planning goes on', async () => {
    const { store, engine } = await setup();
    const git = (engine as any).ports.git as DryRunGitPort;
    const add = git.worktreeAdd.bind(git);
    let adding = false; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    git.worktreeAdd = async (...a: Parameters<DryRunGitPort['worktreeAdd']>) => { adding = true; await gate; return add(...a); };
    const item = store.createItem({ title: 'Race the reconciler', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => adding);
    expect(store.getItem(item.id)!.file.frontmatter.op).toBe('creating_worktree');
    const corrections = await engine.reconcile('periodic');
    expect(corrections.join('\n')).not.toContain('worktree missing');
    expect(store.getItem(item.id)!.file.frontmatter.blocked).toBeFalsy();
    release();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    expect(store.getItem(item.id)!.file.frontmatter.blocked).toBeFalsy();
    expect(activityOf(store, item.id)).not.toContain('no longer exists');
  });
});

describe('cleanup proves what it deletes (dogfood p39)', () => {
  it('ignores a stale ci_head_sha, finishes when the hand already cleaned up, and blocks when a real tip is not in the base', async () => {
    const { store, engine, world } = await setup();
    const mk = (title: string, n: number, pr: number, head: string | null) => {
      const branch = `tp/${n}-x`; const wt = `.claude/worktrees/tp-${n}-x`;
      const id = store.mutateItem(store.createItem({ title }).id, [{ set: { status: 'IN_REVIEW' } }, { set: { pr, branch, worktree: wt, ci_head_sha: 's'.repeat(40) } }], 'engine').id;
      if (head) world.worktrees.set(join(store.codeRepoPath(), wt), { path: join(store.codeRepoPath(), wt), head, branch });
      world.prs.set(pr, { number: pr, url: 'u', state: 'MERGED', mergedAt: new Date().toISOString(), headRefOid: head ?? world.sha(), headRefName: branch, baseRefName: 'trunk', mergeCommit: world.sha(), polls: 9, failOnce: false });
      return id;
    };
    world.unreachable.add('s'.repeat(40)); // the sha planestro last pushed, since rewritten outside it
    const stale = mk('stale sha, real tip merged', 1, 401, world.sha());
    const gone = mk('worktree and branches removed by hand', 2, 402, null);
    const lost = mk('worktree holds commits the base lacks', 3, 403, 'u'.repeat(40));
    world.unreachable.add('u'.repeat(40));
    await engine.reconcile('manual');
    await waitFor(() => status(store, stale) === 'FINISHED' && status(store, gone) === 'FINISHED', 8000);
    await waitFor(() => store.getItem(lost)!.file.frontmatter.blocked === true, 8000);
    expect(store.getItem(lost)!.file.frontmatter.blocked_reason).toBe('cleanup_unverifiable');
    expect(activityOf(store, lost)).toContain('worktree HEAD uuuuuuu');
    expect(world.worktrees.has(join(store.codeRepoPath(), '.claude/worktrees/tp-3-x'))).toBe(true); // nothing deleted
  });
});

describe('unblocking a merged item retries its cleanup (p50)', () => {
  it('a cleanup that failed is run again on unblock, with a message too, not five minutes later by reconcile', async () => {
    const { store, engine, world } = await setup();
    const branch = 'tp/1-x', wt = '.claude/worktrees/tp-1-x', abs = join(store.codeRepoPath(), wt);
    const id = store.mutateItem(store.createItem({ title: 'Merged, cleanup failed' }).id, [{ set: { status: 'IN_REVIEW' } }, { set: { pr: 410, branch, worktree: wt } }], 'engine').id;
    store.mutateItem(id, [{ set: { status: 'MERGED' } }], 'engine');
    const head = world.sha();
    world.worktrees.set(abs, { path: abs, head, branch }); world.localBranches.add(branch);
    world.prs.set(410, { number: 410, url: 'u', state: 'MERGED', mergedAt: new Date().toISOString(), headRefOid: head, headRefName: branch, baseRefName: 'trunk', mergeCommit: world.sha(), polls: 9, failOnce: false });
    (engine as any).block(id, 'engine_error', 'git worktree remove failed: Directory not empty');
    expect(store.getItem(id)!.file.frontmatter.blocked).toBe(true);
    await engine.unblock(id, 'I cleared the directory; try again');
    await waitFor(() => status(store, id) === 'FINISHED', 4000);
    expect(world.worktrees.has(abs)).toBe(false);
    expect(activityOf(store, id)).toContain('removed worktree and branch tp/1-x');
  });
});
