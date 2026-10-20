import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, UndeliveredReport, ConnectionDrop } from '../src/engine/ports.ts';
import type { ServerEvent } from '@planestro/shared';
import { makeFixture, git, sleep } from './helpers.ts';

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

describe('LiveEngine lifecycle (dry-run ports)', () => {
  it('a turn that says nothing for concurrency.turn_quiet_min is stopped and blocked turn_quiet', async () => {
    const hung = () => ({
      runTurn: (o: TurnOptions) => new Promise<TurnResult>((resolve) => {
        o.signal?.addEventListener('abort', () => resolve({ subtype: 'killed', isError: false, costUsd: 0, numTurns: 0, text: '' }), { once: true });
      }),
    });
    const { store, engine } = await setup({ claude: hung as any });
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'turn_quiet_min'], 0.002); }, 'config: quiet');
    const item = store.createItem({ title: 'Hangs', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked_reason === 'turn_quiet', 6000);
    expect(activityOf(store, item.id)).toMatch(/turn stopped: no output for 0\.002 min \(concurrency\.turn_quiet_min\)/);
    expect(engine.sessions()).toEqual([]);   // its slot is free
  });

  it('a turn waiting for a session slot stops waiting when it is stopped (Discard, take over, shutdown)', async () => {
    const started: string[] = [];
    const hung = () => ({
      runTurn: (o: TurnOptions) => new Promise<TurnResult>((resolve) => {
        started.push(o.itemId);
        o.signal?.addEventListener('abort', () => resolve({ subtype: 'killed', isError: false, costUsd: 0, numTurns: 0, text: '' }), { once: true });
      }),
    });
    const { store, engine } = await setup({ claude: hung as any });
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'max_sessions'], 1); }, 'config: one');
    const a = store.createItem({ title: 'A', description: 'x' }); const b = store.createItem({ title: 'B', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => started.length === 1);
    store.mutateItem(b.id, [{ set: { status: 'PLAN_IN_PROGRESS', worktree: store.getItem(a.id)!.file.frontmatter.worktree!, branch: 'tp/2-b' } }], 'engine');
    (engine as any).queueTurn(b.id, 'plan', 'go');   // as an unblock or a plan approval does: it never passed admission
    await waitFor(() => (engine as any).sessionWaiters.length === 1);   // B is queued for the one slot A holds
    // Discarding B waits on B's job, which waited on A's slot: it hung until A's turn ended, however long.
    const t0 = Date.now();
    await engine.discard(b.id, 'not wanted', {});
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((engine as any).sessionWaiters).toHaveLength(0);
    expect(started).toEqual([a.id]);
    await engine.stop();
  });

  it('a GitHub outage longer than its retries is waited through in the CI wait, never an engine_error block', async () => {
    const { store, engine } = await setup();
    const gh = (engine as any).ports.gh;
    const real = gh.ciForSha.bind(gh);
    let fails = 3;
    gh.ciForSha = async (...a: unknown[]) => { if (fails-- > 0) throw new Error('gh run list failed: HTTP 502: Bad Gateway'); return real(...a); };
    const item = store.createItem({ title: 'Outage', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(activityOf(store, item.id).match(/GitHub did not answer about CI for \w{7} \(gh run list failed: HTTP 502: Bad Gateway\); still waiting/g)).toHaveLength(1);
    expect(activityOf(store, item.id)).not.toContain('engine_error');
  });

  it('reconcile says a finished item\'s leftover remote branch once per tip, and never runs two passes at once', async () => {
    const { store, engine, world } = await setup();
    const item = store.createItem({ title: 'Left', description: 'x' });
    world.remoteBranches.set('tp/1-left', world.sha());
    store.mutateItem(item.id, [{ set: { status: 'FINISHED', branch: 'tp/1-left' } }], 'engine');
    const [a, b] = [engine.reconcile('manual'), engine.reconcile('periodic')];
    expect(a).toBe(b);
    const leftover = (c: string[]) => c.filter((x) => /remote branch tp\/1-left still exists after finish/.test(x));
    expect(leftover(await a)).toHaveLength(1);
    const before = store.getItem(item.id)!.file.frontmatter.updated_at;
    expect(leftover(await engine.reconcile('periodic'))).toHaveLength(0);   // the item is not rewritten every pass
    expect(store.getItem(item.id)!.file.frontmatter.updated_at).toBe(before);
    world.remoteBranches.set('tp/1-left', world.sha());
    expect(leftover(await engine.reconcile('periodic'))).toHaveLength(1);   // a new tip is news
  });

  it('drives one item NOT_YET_SUBMITTED → FINISHED with a user plan approval in the middle', async () => {
    const { store, engine, world, dataDir } = await setup();
    const item = store.createItem({ title: 'Add version flag', description: 'print the version' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    let fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.branch).toBe('tp/1-add-version-flag');
    expect(fm.worktree).toBe('.claude/worktrees/tp-1-add-version-flag');
    expect(fm.awaiting).toBe('plan_approval');
    expect(store.getItem(item.id)!.file.sections.find((s) => s.title === 'Plan')!.body).toContain('Plan (dry-run)');
    expect(store.derived(store.getItem(item.id)!).needs_you).toBe(true);
    expect(world.worktrees.size).toBe(1);
    expect(engine.sessions()).toEqual([]); // parked: no live process

    await engine.approvePlan(item.id, 'looks good');
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.pr).toBe(100);
    expect(fm.ci_result).toBe('green');
    expect(fm.merged_at).toBeDefined(); expect(fm.finished_at).toBeDefined();
    expect(fm.worktree).toBeUndefined(); expect(fm.op).toBeUndefined();
    expect(world.worktrees.size).toBe(0); expect(world.remoteBranches.has('tp/1-add-version-flag')).toBe(false);
    expect(world.prs.get(100)!.state).toBe('MERGED');
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    for (const step of ['creating worktree', 'PLAN_IN_PROGRESS → PLAN_READY', 'approval notes', 'status PLAN_READY → IN_PROGRESS', 'opened PR #100', 'waiting for CI', 'merged PR #100', 'removed worktree']) expect(activity, step).toContain(step);
    await store.git.idle();
    const log = git(dataDir, 'log', '--format=%s');
    for (const m of ['TP-1: begin planning', 'TP-1: submit plan', 'TP-1: approve plan', 'TP-1: open PR #100', 'TP-1: merge', 'TP-1: finish']) expect(log, m).toContain(m);
    expect(log).not.toMatch(/CI/);
    expect(store.journal.openOps()).toEqual([]);
  });

  it('a branch already on the base tip is neither rebased nor pushed; its CI run is reused', async () => {
    const { store, engine, world } = await setup();
    const item = store.createItem({ title: 'Up to date', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = (engine as any).absWorktree(store.getItem(item.id)!.file.frontmatter.worktree!);
    world.behind.set(cwd, 0);
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const activity = activityOf(store, item.id);
    expect(activity).toContain('already on trunk@');
    expect(activity).not.toContain('rebased onto');
    expect(store.getItem(item.id)!.file.frontmatter.ci_result).toBe('green');
  });

  it('a stale head sha right after the push is propagation lag, not a moved head', async () => {
    const { store, engine, world } = await setup();
    world.headLagPolls = 3; // gh pr view keeps reporting the replaced sha for three polls after a push
    const item = store.createItem({ title: 'Laggy head', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const activity = activityOf(store, item.id);
    expect(activity.match(/rebased onto/g)?.length ?? 0).toBe(1);
    expect(JSON.stringify(store.journal.read({ item: item.id }))).not.toContain('head_moved');
  });

  it('a cancelled run that nothing replaces is re-run once, and its new attempt merges the PR (HH-321)', async () => {
    const { store, engine, world } = await setup();
    world.ciCancelOnce = true;
    const item = store.createItem({ title: 'Cancelled', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 12000);
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    expect(activity).toMatch(/CI run 5 for \w{7} was cancelled and no other run replaced it; re-running it/);
    expect(activity).not.toContain('did not finish within');
    expect(activity.match(/re-running it/g)).toHaveLength(1);   // once per head
  });

  it("a PR the project's CI skips by its own path filters counts as green at once, with no local gate (HH-324)", async () => {
    const { store, engine, world } = await setup();
    const git = (engine as any).ports.git; const gh = (engine as any).ports.gh;
    git.trackedAt = async (_cwd: string, _ref: string, paths: string[]) => paths[0] === '.github/workflows' ? ['.github/workflows/ci.yml'] : [];
    git.readBlob = async (_cwd: string, _ref: string, path: string) => path.endsWith('ci.yml') ? Buffer.from("name: CI\non:\n  pull_request:\n    paths-ignore: ['**.md', 'docs/**']\n") : null;
    git.changedFiles = async () => [{ path: 'docs/design.md', change: 'added' }];
    gh.ciForSha = async (_r: string, _b: string, sha: string) => ({ state: 'none', sha });   // GitHub never starts a run
    const item = store.createItem({ title: 'Docs only', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 10000);
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    expect(activity).toMatch(/CI does not run for \w{7}: \.github\/workflows\/ci\.yml every changed file matches its paths-ignore \(\*\*\.md, docs\/\*\*\); nothing to check, so it counts as green/);
    expect(activity).not.toContain('GitHub Actions is blocked');
    void world;
  });

  it('a merge is journaled as a notification for the browser, and on_merge gets its title and message (#70)', async () => {
    const { store, engine } = await setup();
    store.updateConfig((doc) => { doc.setIn(['notifications', 'on_merge'], 'echo merged'); }, 'config: on_merge');
    const runs: { command: string; env?: Record<string, string> }[] = [];
    const proc = (engine as any).ports.proc; const inner = proc.run.bind(proc);
    proc.run = async (command: string, opts: { cwd: string; env?: Record<string, string> }) => { runs.push({ command, env: opts.env }); return inner(command, opts); };
    const item = store.createItem({ title: 'Lamps at a rhythm', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 10000);
    const n = store.journal.read({ type: 'notification' });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ item: item.id, data: { event: 'on_merge', title: `${item.id} merged` } });
    expect(String(n[0].data!.message)).toMatch(/^PR #\d+ merged into trunk: Lamps at a rhythm$/);
    expect(runs.find((r) => r.command === 'echo merged')?.env).toEqual({ PLANESTRO_TITLE: `${item.id} merged`, PLANESTRO_MESSAGE: n[0].data!.message });
  });

  it("a cancelled run planestro re-runs gets the whole CI timeout again, not what was left (HH-323, HH-326, HH-328)", async () => {
    const { store, engine, world } = await setup();
    let t = 0; (engine as any).ciNow = () => (t += 7 * 60_000);    // seven minutes pass per look; ci.timeout_min is 45
    world.ciCancelOnce = true;
    const item = store.createItem({ title: 'Cancelled late', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED' || store.getItem(item.id)!.file.frontmatter.blocked === true, 12000);
    expect(store.getItem(item.id)!.file.frontmatter.blocked_reason).toBeUndefined();   // was ci_timeout: 6 cancelled looks used 42 of the 45 minutes
    expect(status(store, item.id)).toBe('FINISHED');
  });

  it('the same red run re-observed is not a second failure', async () => {
    const { store, engine, world } = await setup({ ci: 'red-once' });
    world.ciMode = 'red-once';
    const item = store.createItem({ title: 'Same-run', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => (store.getItem(item.id)!.file.frontmatter.ci_failed_count ?? 0) === 1, 8000);
    // simulate the merge job re-seeing the SAME completed red run before a re-run flips it
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect((fm.op_data as any).last_red).toBeDefined();
    await (engine as any).onCiRed(item.id, store.journal.begin('merge', item.id), fm.ci_head_sha ?? 'x', undefined, 'github', true);
    const after = store.getItem(item.id)!.file.frontmatter;
    expect(after.ci_failed_count).toBe(1); // NOT incremented
    expect(after.blocked).toBeUndefined();
    expect(after.ci_result).toBe('pending');
    await waitFor(() => status(store, item.id) === 'FINISHED', 10000);
  });

  it('CI red once → the session fixes it → merged; conflict once → session rebases', async () => {
    const { store, engine, world } = await setup({ ci: 'red-once' });
    world.ciMode = 'red-once';
    const item = store.createItem({ title: 'Flaky', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.ci_failed_count).toBe(1);
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    expect(activity).toContain('CI red (github, attempt 1)');
    expect(activity).toContain('session updated the branch');
    expect(activity).toContain('merged PR #100');
  });

  it('rebase conflict is handed to the session and the pipeline resumes after its fix', async () => {
    const { store, engine, world } = await setup();
    world.ciMode = 'conflict-once'; world.conflictArmed = true;
    const item = store.createItem({ title: 'Conflicty', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    expect(activity).toContain('conflicted in src/conflicted.ts');
    expect(activity).toContain('merged PR #100');
  });

  it('a question parks the session with awaiting=question; answering resumes the same session', async () => {
    let calls = 0;
    const asking = (_world: FakeWorld) => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        calls += 1;
        if (calls === 1) { await o.onQuestion([{ question: 'Short or long?', options: [{ label: 'Short' }, { label: 'Long' }] }]); return { sessionId: 'sess-1', subtype: 'success', isError: false, costUsd: 0.1, numTurns: 1, text: 'asked', parked: 'question' }; }
        expect(o.resume).toBe('sess-1');
        expect(o.prompt).toContain('A: Long');
        await o.tools.submit_plan('# plan after answer');
        return { sessionId: 'sess-1', subtype: 'success', isError: false, costUsd: 0.1, numTurns: 1, text: 'planned', planSubmitted: '# plan after answer' };
      },
    });
    const { store, engine } = await setup({ claude: asking });
    const item = store.createItem({ title: 'Q', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.awaiting === 'question');
    expect(status(store, item.id)).toBe('PLAN_IN_PROGRESS');
    expect(store.derived(store.getItem(item.id)!).needs_you).toBe(true);
    expect((store.getItem(item.id)!.file.frontmatter.awaiting_data as any).questions[0].question).toBe('Short or long?');
    await engine.respond(item.id, { kind: 'question', answers: { 'Short or long?': 'Long' } });
    // PLAN_READY lands inside the turn (submit_plan); the turn's cost is booked when it returns
    await waitFor(() => status(store, item.id) === 'PLAN_READY' && store.getItem(item.id)!.file.frontmatter.turns === 2);
    expect(store.getItem(item.id)!.file.frontmatter.cost_usd).toBeCloseTo(0.2);
    expect(store.getItem(item.id)!.file.frontmatter.turns).toBe(2);
  });

  it('a permission prompt parks; "allow" resumes with the exact rule; policy denies pushes outright', async () => {
    const seen: string[][] = [];
    const permy = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        seen.push(o.allowedTools);
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        if (seen.length === 2) {
          expect((await o.onPermission({ tool: 'Bash', input: { command: 'git push origin HEAD' } })).action).toBe('deny');
          expect((await o.onPermission({ tool: 'Bash', input: { command: 'git checkout trunk' } })).action).toBe('deny');
          expect((await o.onPermission({ tool: 'Bash', input: { command: 'node -e 1' } })).action).toBe('park');
          return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'permission' };
        }
        await o.tools.report_done('did it');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'did it' };
      },
    });
    const { store, engine, world } = await setup({ claude: permy });
    const item = store.createItem({ title: 'P', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.awaiting === 'permission');
    expect((store.getItem(item.id)!.file.frontmatter.awaiting_data as any).input.command).toBe('node -e 1');
    world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-p'), 1); // the third turn "commits"
    await engine.respond(item.id, { kind: 'permission', decision: 'always' });
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(seen[2]).toContain('Bash(node -e 1)');
    // an approved chained command that matches no rule is allowed once via the one-shot pass
    const chain = "awk 'x' f.html > /tmp/o.js && node --check /tmp/o.js";
    const it2 = store.createItem({ title: 'Chain' });
    store.mutateItem(it2.id, [{ set: { status: 'IN_PROGRESS', branch: 'tp/x', worktree: '.claude/worktrees/tp-x', awaiting: 'permission', awaiting_data: { tool: 'Bash', input: { command: chain } } } }], 'engine');
    let oneShotResult: string | undefined;
    (engine as any).ports.agents.claude.runTurn = async (o: TurnOptions) => {
      oneShotResult = (await o.onPermission({ tool: 'Bash', input: { command: chain } })).action;
      expect((await o.onPermission({ tool: 'Bash', input: { command: chain } })).action).toBe('park'); // consumed
      return { sessionId: 's2', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'permission' };
    };
    await engine.respond(it2.id, { kind: 'permission', decision: 'allow' });
    await waitFor(() => oneShotResult !== undefined);
    expect(oneShotResult).toBe('allow');
    expect(store.config.permissions.allow).toContain('Bash(node -e 1)');
  });

  it('a park is a wait (#168): report_blocked is refused in words while parked, and the resume states the ruling', async () => {
    const prompts: string[] = []; const refusals: string[] = [];
    let work = 0;
    const parky = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        prompts.push(o.prompt); work += 1;
        if (work === 1 || work === 2) {
          expect((await o.onPermission({ tool: 'Bash', input: { command: `node -e ${work}` } })).action).toBe('park');
          refusals.push(await o.tools.report_blocked('a permission was denied'));   // the misreading this guards against
          return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'permission' };
        }
        await o.tools.report_done('did it');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'did it' };
      },
    });
    const { store, engine, world } = await setup({ claude: parky });
    const item = store.createItem({ title: 'W', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.awaiting === 'permission' && !(engine as any).jobs.has(item.id));
    expect(refusals[0]).toBe('Not recorded: you are parked on `node -e 1`; wait. A park is not a denial and not a block: end your turn now with no report, and planestro resumes you with the ruling.');
    expect(store.getItem(item.id)!.file.frontmatter.blocked).toBeUndefined();
    await engine.respond(item.id, { kind: 'permission', decision: 'deny', reason: 'use the check script' });
    await waitFor(() => work === 2 && store.getItem(item.id)!.file.frontmatter.awaiting === 'permission' && !(engine as any).jobs.has(item.id));
    expect(prompts[1]).toContain('DENIED: The user denied your command `node -e 1`: use the check script. This exact command is denied: do not run it again, reworded or by another route');
    world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-w'), 1);
    await engine.respond(item.id, { kind: 'permission', decision: 'allow' });
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(prompts[2]).toContain('APPROVED: The user approved your command `node -e 2`. Run it now, as it was');
    expect(store.getItem(item.id)!.file.frontmatter.blocked).toBeUndefined();
  });

  it('a message that resumes an agent_blocked session clears the block, so the finished turn opens its PR', async () => {
    let work = 0;
    const blocky = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        work += 1;
        if (work === 1) { await o.tools.report_blocked('a permission was denied'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' }; }
        expect(o.prompt).toContain('try the plain form');
        await o.tools.report_done('did it');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'did it' };
      },
    });
    const { store, engine, world } = await setup({ claude: blocky });
    const item = store.createItem({ title: 'B', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked_reason === 'agent_blocked' && !(engine as any).jobs.has(item.id));
    world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-b'), 1); // the resumed turn "commits"
    await engine.message(item.id, 'try the plain form');
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(store.getItem(item.id)!.file.frontmatter.blocked).toBeUndefined();
  });

  it('an item stranded agent_blocked after its session reported done heals itself on the next tick', async () => {
    const blocky = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        await o.tools.report_blocked('a permission was denied');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', blocked: 'a permission was denied' };
      },
    });
    const { store, engine, world } = await setup({ claude: blocky });
    const item = store.createItem({ title: 'S', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked_reason === 'agent_blocked' && !(engine as any).jobs.has(item.id));
    // the stranded state on disk: done recorded after the block, flag never cleared, nobody clicks anything
    world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-s'), 1);
    store.mutateItem(item.id, [{ set: { op_data: { done_summary: 'did it' } } }], 'engine');
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(activityOf(store, item.id)).toContain('cleared a stale agent_blocked flag');
    expect(world.prs.get(100)!.state).toBe('MERGED');
  });

  it('a turn that commits without report_done is asked once for its report before the pull request (#99)', async () => {
    const implementPrompts: string[] = [];
    const quiet = (reportWhenAsked: boolean) => () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        implementPrompts.push(o.prompt);
        const asked = o.prompt.includes('without calling report_done');
        if (asked && reportWhenAsked) { await o.tools.report_done('suite 412/412; captures in docs/captures/'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'suite 412/412; captures in docs/captures/' }; }
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: 'committed' };
      },
    });
    for (const reports of [true, false]) {
      implementPrompts.length = 0;
      const { store, engine, world } = await setup({ claude: quiet(reports) });
      const item = store.createItem({ title: 'Q', description: 'x' });
      store.transition(item.id, 'QUEUED', 'user');
      await engine.start();
      await waitFor(() => status(store, item.id) === 'PLAN_READY');
      world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-q'), 1);
      await engine.approvePlan(item.id, 'report the suite tally and the capture paths');
      await waitFor(() => ['IN_REVIEW', 'MERGED', 'FINISHED'].includes(status(store, item.id)), 8000);
      expect(implementPrompts).toHaveLength(2);                                   // the work, then exactly one ask
      expect(implementPrompts[1]).toContain('The approval notes asked for this in your report as well:\nreport the suite tally and the capture paths');
      const log = activityOf(store, item.id);
      expect(log).toContain('turn ended with commits but without report_done; asking the session for its report before the pull request');
      if (reports) expect(log).toContain('done: suite 412/412');
      else expect(log).toContain('turn ended with commits but without report_done (asked once already); proceeding to a pull request');
      await engine.stop(); store.close();
    }
  });

  it('report_blocked after report_done withdraws the done, so a real block is never healed away', async () => {
    const fickle = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        await o.tools.report_done('thought so');
        await o.tools.report_blocked('actually stuck');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'thought so', blocked: 'actually stuck' };
      },
    });
    const { store, engine, world } = await setup({ claude: fickle });
    const item = store.createItem({ title: 'F', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-f'), 1);
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked_reason === 'agent_blocked' && !(engine as any).jobs.has(item.id));
    await sleep(300); // several ticks
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.status).toBe('IN_PROGRESS');
    expect(fm.blocked).toBe(true);
    expect(fm.op_data?.done_summary).toBeUndefined();
    expect(world.prs.size).toBe(0);
  });

  it('no commits after "done" blocks the item with a reason instead of opening a PR', async () => {
    const lazy = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        await o.tools.report_done('nothing really');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'nothing really' };
      },
    });
    const { store, engine } = await setup({ claude: lazy });
    const item = store.createItem({ title: 'Lazy', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked === true);
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.status).toBe('IN_PROGRESS');
    expect(fm.blocked_reason).toBe('no_commits');
    expect(fm.pr).toBeUndefined();
    // The way out of that block when the work really is on the base already: close without a PR.
    await engine.closeAsDone(item.id, 'landed before this was queued');
    const closed = store.getItem(item.id)!;
    expect(closed.file.frontmatter.status).toBe('FINISHED');
    expect(closed.file.frontmatter.blocked).toBeUndefined();
    expect(closed.file.frontmatter.awaiting).toBeUndefined();
    expect(closed.file.frontmatter.finished_at).toBeDefined();
    expect(activityOf(store, item.id)).toContain('closed as done without a pull request: landed before this was queued');
  });

  it('close as done removes an unused worktree and branch, and leaves one holding work in place', async () => {
    const { store, engine, world } = await setup();
    const unused = store.createItem({ title: 'Already shipped', description: 'x' });
    store.transition(unused.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, unused.id) === 'PLAN_READY');
    const branch = store.getItem(unused.id)!.file.frontmatter.branch!;
    expect(world.worktrees.size).toBe(1);
    expect(world.localBranches.has(branch)).toBe(true);
    await engine.closeAsDone(unused.id);
    expect(status(store, unused.id)).toBe('FINISHED');
    expect(world.worktrees.size).toBe(0);
    expect(world.localBranches.has(branch)).toBe(false);
    expect(activityOf(store, unused.id)).toContain('removed unused worktree and branch');

    const dirty = store.createItem({ title: 'Half started', description: 'x' });
    store.transition(dirty.id, 'QUEUED', 'user');
    engine.poke();
    await waitFor(() => status(store, dirty.id) === 'PLAN_READY');
    const cwd = [...world.worktrees.keys()][0]!;
    world.dirty.add(cwd);
    await engine.closeAsDone(dirty.id);
    expect(status(store, dirty.id)).toBe('FINISHED');
    expect(world.worktrees.has(cwd)).toBe(true);
    expect(world.localBranches.has(store.getItem(dirty.id)!.file.frontmatter.branch!)).toBe(true);
    expect(activityOf(store, dirty.id)).toMatch(/left worktree .* in place: uncommitted changes/);

    // A pull request decides the outcome once one exists; a backlog item needs no engine work at all.
    const idle = store.createItem({ title: 'Never needed', description: 'x' });
    await engine.closeAsDone(idle.id);
    expect(status(store, idle.id)).toBe('FINISHED');
    store.transition(idle.id, 'NOT_YET_SUBMITTED', 'user');
    expect(status(store, idle.id)).toBe('NOT_YET_SUBMITTED');
  });

  it('an item iceboxed mid-flight and queued again reuses its worktree instead of failing to re-create it', async () => {
    const { store, engine, world } = await setup();
    const item = store.createItem({ title: 'Round trip', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    const cwd = [...world.worktrees.keys()][0]!;
    // the dry-run port would happily "add" twice; the real one refuses, so make the fake refuse too
    const add = world.worktrees.set.bind(world.worktrees);
    world.worktrees.set = (k, v) => { if (world.worktrees.has(k)) throw new Error(`fatal: '${k}' already exists`); return add(k, v); };
    for (const to of ['ICEBOX', 'NOT_YET_SUBMITTED', 'QUEUED'] as const) store.transition(item.id, to, 'user');
    engine.poke();
    await waitFor(() => activityOf(store, item.id).includes('reusing the worktree'));
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    expect(store.getItem(item.id)!.file.frontmatter.blocked).toBeUndefined();
    expect([...world.worktrees.keys()]).toEqual([cwd]);
  });

  it('pause stops admissions; resume continues; a restart resumes an interrupted turn', async () => {
    const { store, engine, dataDir } = await setup();
    engine.pause();
    const item = store.createItem({ title: 'Paused', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await sleep(200);
    expect(status(store, item.id)).toBe('QUEUED');
    engine.resume();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    // simulate a crash mid-implementation: op left behind on disk
    await engine.stop();
    store.mutateItem(item.id, [{ transition: { to: 'IN_PROGRESS', actor: 'user' } }, { set: { op: 'implement_turn', op_started_at: '2026-01-01T00:00:00+00:00' } }], 'user');
    const world2 = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const wtPath = join(store.codeRepoPath(), '.claude/worktrees/tp-1-paused');
    world2.worktrees.set(wtPath, { path: wtPath, head: 'a'.repeat(40), branch: 'tp/1-paused' });
    const engine2 = new LiveEngine(store, { mode: 'dry-run', git: new DryRunGitPort(world2), gh: new DryRunGhPort(world2), proc: new DryRunProcPort(world2), agents: { claude: new DryRunClaudePort(world2) } }, () => {}, { sleep: async () => {}, tickMs: 50 });
    await engine2.start();
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    expect(activity).toContain('interrupted by a restart; resuming');
    await engine2.stop();
    expect(dataDir).toBeTruthy();
  });

  it('stopping while a pull request waits for CI is not a CI timeout: the wait resumes at the next start', async () => {
    const { store, engine, world } = await setup();
    const item = store.createItem({ title: 'Slow CI', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    (engine as any).sleep = () => sleep(15);
    (engine as any).ports.gh.ciForSha = async (_r: string, _b: string, sha: string) => ({ state: 'pending', runId: 1, sha, url: 'https://example/run/1' });
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.op === 'awaiting_ci', 8000);
    await engine.stop();
    let fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.blocked).toBeUndefined();
    expect(fm.op).toBe('awaiting_ci');
    expect(activityOf(store, item.id)).not.toContain('ci_timeout');

    const engine2 = new LiveEngine(store, { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } }, () => {}, { sleep: async () => {}, tickMs: 50 });
    await engine2.start();
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.blocked).toBeUndefined(); // the startup reconcile cleared the stale wait and the pipeline picked it up again
    expect(activityOf(store, item.id)).not.toContain('ci_timeout');
    await engine2.stop();
  });

  it('an unblock with nothing to resume starts a fresh conversation with the full phase prompt, not just the note', async () => {
    const prompts: { phase: string; resume?: string; prompt: string }[] = [];
    const port = () => ({ async runTurn(o: TurnOptions): Promise<TurnResult> { prompts.push({ phase: o.phase, resume: o.resume, prompt: o.prompt }); await o.tools.report_done('ok'); return { sessionId: 'fresh', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'ok' }; } });
    const { store, engine, world } = await setup({ claude: port });
    const item = store.createItem({ title: 'Lost thread', description: 'x' });
    // the implement turn died at launch: IN_PROGRESS, a plan, approval notes, and no conversation id for this runner
    store.mutateItem(item.id, [{ transition: { to: 'QUEUED', actor: 'user' } }, { transition: { to: 'PLAN_IN_PROGRESS', actor: 'engine' } }, { section: 'Plan', body: '# The plan\nDo the thing.' }, { transition: { to: 'PLAN_READY', actor: 'engine' } }, { transition: { to: 'IN_PROGRESS', actor: 'user' } },
      { set: { branch: 'tp/1-lost-thread', worktree: '.claude/worktrees/tp-1-lost-thread', op_data: { approval_notes: 'mind the flag' }, blocked: true, blocked_reason: 'turn_error', awaiting: 'user' } }], 'engine');
    const wt = join(store.codeRepoPath(), '.claude/worktrees/tp-1-lost-thread');
    world.worktrees.set(wt, { path: wt, head: 'a'.repeat(40), branch: 'tp/1-lost-thread' }); world.commits.set(wt, 1);
    await engine.start();
    await engine.unblock(item.id, 'try again');
    await waitFor(() => prompts.length === 1);
    expect(prompts[0].resume).toBeUndefined();
    expect(prompts[0].prompt).toContain('was approved. Implement it now');   // the implement-plan opener…
    expect(prompts[0].prompt).toContain('Do the thing.');                    // …with the plan…
    expect(prompts[0].prompt).toContain('mind the flag');                    // …and the approval notes…
    expect(prompts[0].prompt).toContain('try again');                        // …then the message
    expect(activityOf(store, item.id)).toContain('starting a fresh one with the full implement prompt');
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
  });

  it('a turn killed by a clean stop is resumed at the next start and does not sit holding a slot', async () => {
    // What a live port does on stop(): the turn ends 'killed', not with an error and not with a plan.
    const hanging = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        await new Promise<void>((done) => o.signal?.addEventListener('abort', () => done(), { once: true }));
        return { sessionId: 'sess-k', subtype: 'killed', isError: false, costUsd: 0.2, numTurns: 1, text: '' };
      },
    });
    const { store, engine } = await setup({ claude: hanging });
    const item = store.createItem({ title: 'Stopped mid plan', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => engine.sessions().length === 1);
    await engine.stop();
    let fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.status).toBe('PLAN_IN_PROGRESS');
    expect(fm.op).toBe('planning_turn'); // the evidence the next start needs: without it nothing ever resumed the item
    expect(fm.session_id).toBe('sess-k');
    expect(activityOf(store, item.id)).toContain('turn interrupted (engine stopping); resumable');

    const world2 = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const wtPath = join(store.codeRepoPath(), fm.worktree!);
    world2.worktrees.set(wtPath, { path: wtPath, head: 'a'.repeat(40), branch: fm.branch! });
    const engine2 = new LiveEngine(store, { mode: 'dry-run', git: new DryRunGitPort(world2), gh: new DryRunGhPort(world2), proc: new DryRunProcPort(world2), agents: { claude: new DryRunClaudePort(world2) } }, () => {}, { sleep: async () => {}, tickMs: 50 });
    await engine2.start();
    // The op clears when the turn has fully ended, a few ticks after submit_plan moved it to PLAN_READY.
    await waitFor(() => status(store, item.id) === 'PLAN_READY' && !store.getItem(item.id)!.file.frontmatter.op);
    fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.op).toBeUndefined();
    expect(activityOf(store, item.id)).toContain('interrupted by a restart; resuming');
    await engine2.stop();
  });
});

describe('planestro tool calls lost in transport', () => {
  const ok = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
  const lost = { tool: 'submit_plan', error: 'Tool permission request failed: AbortError: Stream closed' };

  it('a lost submit_plan gets one resumed retry, and a duplicate hand-in does not wake the orchestrator twice', async () => {
    const prompts: string[] = [];
    const flaky = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        prompts.push(o.prompt);
        if (prompts.length === 1) return { ...ok, toolFailures: [lost] };
        await o.tools.submit_plan('# p');
        expect(await o.tools.submit_plan('# p')).toContain('already recorded');
        return { ...ok, planSubmitted: '# p' };
      },
    });
    const { store, engine } = await setup({ claude: flaky });
    const wakes: string[] = [];
    const wake = (engine as any).orchestrator.wake.bind((engine as any).orchestrator);
    (engine as any).orchestrator.wake = (ev: { type: string }) => { wakes.push(ev.type); return wake(ev); };
    const item = store.createItem({ title: 'Lost', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    expect(prompts[1]).toContain('Call submit_plan again');
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.blocked, `${fm.blocked_reason}\n${activityOf(store, item.id)}`).toBeUndefined();
    expect(fm.op_data?.plan_retry_turns).toBeUndefined();
    expect(activityOf(store, item.id)).toContain('planestro tool submit_plan failed before reaching planestro');
    expect(wakes.filter((w) => w === 'plan_review')).toHaveLength(1);
  });

  it('a planning turn that hits its cap is asked once for the plan it has, under the per-turn cap (p41)', async () => {
    const caps: number[] = []; const prompts: string[] = [];
    const claude = () => ({ async runTurn(o: TurnOptions): Promise<TurnResult> {
      caps.push(o.maxBudgetUsd ?? -1); prompts.push(o.prompt);
      if (prompts.length === 1) return { ...ok, subtype: 'error_max_budget_usd', isError: true, costUsd: 15 };
      await o.tools.submit_plan('# from what I know'); return { ...ok, planSubmitted: '# from what I know' };
    } });
    const { store, engine } = await setup({ claude });
    store.updateConfig((doc) => { doc.setIn(['budget_usd_per_item'], 60); doc.setIn(['budget_usd_per_plan_turn'], 15); }, 'config: caps');
    const item = store.createItem({ title: 'Researcher', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    expect(caps).toEqual([15, 15]);                                               // min(budget left, plan-turn cap), both times
    expect(prompts[1]).toContain('hit the $15 planning-turn cap (budget_usd_per_plan_turn)');
    expect(prompts[1]).toContain('Do not research further. Write the plan now from what you already know');
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.blocked).toBeUndefined();
    expect(fm.op_data?.plan_retry_turns).toBeUndefined();
    expect(activityOf(store, item.id)).toContain('no plan yet: it hit the $15 planning-turn cap');
  });

  it('a turn that just stops without a plan is asked once; the second miss is no_plan', async () => {
    let turns = 0;
    const { store, engine } = await setup({ claude: () => ({ async runTurn(): Promise<TurnResult> { turns += 1; return ok; } }) });
    const item = store.createItem({ title: 'Silent', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked === true);
    expect(turns).toBe(2);
    expect(store.getItem(item.id)!.file.frontmatter.blocked_reason).toBe('no_plan');
    expect(activityOf(store, item.id)).toContain('it ended without calling submit_plan, and again after being asked for the plan');
  });

  it('a second loss blocks no_plan naming the transport, never a budget', async () => {
    let turns = 0;
    const dead = () => ({ async runTurn(): Promise<TurnResult> { turns += 1; return { ...ok, toolFailures: [lost] }; } });
    const { store, engine } = await setup({ claude: dead });
    const item = store.createItem({ title: 'Dead', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked === true);
    expect(turns).toBe(2);
    expect(store.getItem(item.id)!.file.frontmatter.blocked_reason).toBe('no_plan');
    expect(activityOf(store, item.id)).toMatch(/its submit_plan call failed in transport \(Tool permission request failed: AbortError: Stream closed\), and again after being asked for the plan/);
  });
});

describe('a report lost in transport is applied from the turn record (#167)', () => {
  const ok = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
  const STREAM = 'Tool permission request failed: AbortError: Stream closed';
  /** The dry-run worker, except that the named report never reaches planestro: the port saw it go out and fail. */
  const losing = (tool: 'submit_plan' | 'report_done', turns: { phase: string }[]) => (world: FakeWorld) => {
    const base = new DryRunClaudePort(world);
    return { async runTurn(o: TurnOptions): Promise<TurnResult> {
      turns.push({ phase: o.phase });
      if (turns.filter((t) => t.phase === o.phase).length > 1) return base.runTurn(o);
      let lost: UndeliveredReport | undefined;
      const tools = { ...o.tools, [tool]: async (first: string) => { lost = { tool, args: tool === 'submit_plan' ? { plan: first } : { summary: first }, error: STREAM }; o.onUndelivered?.(lost); return ''; } };
      const r = await base.runTurn({ ...o, tools });
      return { ...r, planSubmitted: undefined, done: undefined, undelivered: lost, toolFailures: [{ tool, error: STREAM }] };
    } };
  };
  const wakesOf = (engine: LiveEngine) => { const wakes: string[] = []; const orch = (engine as any).orchestrator; const wake = orch.wake.bind(orch); orch.wake = (ev: { type: string }) => { wakes.push(ev.type); return wake(ev); }; return wakes; };

  it('a dropped submit_plan lands as the plan with no retry turn and no wake but the review', async () => {
    const turns: { phase: string }[] = [];
    const { store, engine } = await setup({ claude: losing('submit_plan', turns) });
    const wakes = wakesOf(engine);
    const item = store.createItem({ title: 'Lost plan', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY' && !store.getItem(item.id)!.file.frontmatter.op);
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(turns).toEqual([{ phase: 'plan' }]);
    expect(fm.blocked).toBeUndefined();
    expect(fm.op_data?.outbox).toBeUndefined();
    expect(fm.op_data?.plan_retry_turns).toBeUndefined();
    expect(store.getItem(item.id)!.file.sections.find((x) => x.title === 'Plan')!.body).toContain('Plan (dry-run)');
    expect(activityOf(store, item.id)).toContain("the session's submit_plan never reached planestro");
    expect(wakes.filter((w) => /^blocked_|^worker_|stall/.test(w))).toEqual([]);
  });

  it('a dropped report_done lands as done: the pull request opens with its summary and no nudge turn', async () => {
    const turns: { phase: string }[] = [];
    const { store, engine } = await setup({ claude: losing('report_done', turns) });
    const wakes = wakesOf(engine);
    const item = store.createItem({ title: 'Lost done', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(turns.filter((t) => t.phase === 'implement')).toHaveLength(1);
    const activity = activityOf(store, item.id);
    expect(activity).toContain("the session's report_done never reached planestro");
    expect(activity).toContain('done: Implemented the plan and committed (dry-run).');
    expect(activity).not.toContain('without report_done');
    expect(wakes.filter((w) => /^blocked_|^worker_|stall/.test(w))).toEqual([]);
  });

  it('a report lost as the engine stopped is applied at the next start instead of resuming the turn', async () => {
    const report: UndeliveredReport = { tool: 'report_done', args: { summary: 'All done before the drop.' }, error: STREAM };
    const hanging = () => ({ async runTurn(o: TurnOptions): Promise<TurnResult> {
      o.onUndelivered?.(report);
      await new Promise<void>((done) => o.signal?.addEventListener('abort', () => done(), { once: true }));
      return { ...ok, subtype: 'killed', undelivered: report };
    } });
    const { store, engine } = await setup({ claude: hanging });
    const item = store.createItem({ title: 'Stopped after done', description: 'x' });
    store.mutateItem(item.id, [{ transition: { to: 'QUEUED', actor: 'user' } }, { transition: { to: 'PLAN_IN_PROGRESS', actor: 'engine' } }, { section: 'Plan', body: '# p' }, { transition: { to: 'PLAN_READY', actor: 'engine' } }, { transition: { to: 'IN_PROGRESS', actor: 'user' } },
      { set: { branch: 'tp/1-stopped-after-done', worktree: '.claude/worktrees/tp-1-stopped-after-done', session_id: 'sess-1', blocked: true, blocked_reason: 'turn_error', awaiting: 'user' } }], 'engine');
    await engine.start();
    await engine.unblock(item.id, 'go on');
    await waitFor(() => engine.sessions().length === 1);
    await engine.stop();
    let fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.op).toBe('implement_turn');
    expect((fm.op_data?.outbox as UndeliveredReport | undefined)?.tool).toBe('report_done');

    const world2 = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const wtPath = join(store.codeRepoPath(), fm.worktree!);
    world2.worktrees.set(wtPath, { path: wtPath, head: 'a'.repeat(40), branch: fm.branch! }); world2.commits.set(wtPath, 1);
    let turns2 = 0;
    const counting = { async runTurn(): Promise<TurnResult> { turns2 += 1; return ok; } };
    const engine2 = new LiveEngine(store, { mode: 'dry-run', git: new DryRunGitPort(world2), gh: new DryRunGhPort(world2), proc: new DryRunProcPort(world2), agents: { claude: counting } }, () => {}, { sleep: async () => {}, tickMs: 50 });
    await engine2.start();
    await waitFor(() => ['IN_REVIEW', 'MERGED', 'FINISHED'].includes(status(store, item.id)), 8000);
    fm = store.getItem(item.id)!.file.frontmatter;
    expect(turns2).toBe(0);
    expect(fm.op_data?.outbox).toBeUndefined();
    expect(activityOf(store, item.id)).toContain('done: All done before the drop.');
    await engine2.stop();
  });

  it('report tools are idempotent: a retry of one that landed records nothing twice', async () => {
    let answers: string[] = [];
    const twice = (world: FakeWorld) => { const base = new DryRunClaudePort(world); return { async runTurn(o: TurnOptions): Promise<TurnResult> {
      if (o.phase !== 'implement') return base.runTurn(o);
      answers = [await o.tools.report_done('same summary'), await o.tools.report_done('same summary')];
      return base.runTurn(o);
    } }; };
    const { store, engine } = await setup({ claude: twice });
    const item = store.createItem({ title: 'Twice', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => answers.length === 2);
    expect(answers[1]).toContain('Already recorded');
    expect(activityOf(store, item.id).match(/done: same summary/g)).toHaveLength(1);
  });
});

describe('a lost connection to planestro is flagged on the item; an unrecovered one wakes the orchestrator (#167, HH-377)', () => {
  const STREAM = 'Tool permission request failed: AbortError: Stream closed';
  const DROP: ConnectionDrop = { error: STREAM, at: '2026-10-03T12:00:00.000Z', tool: 'Bash' };
  const LAST = 'All 357 checks pass and the work is committed. report_done failed with Stream closed, so: implemented the cavern fix.';
  const wakesOf = (engine: LiveEngine) => { const wakes: { type: string; data?: Record<string, unknown> }[] = []; const orch = (engine as any).orchestrator; const wake = orch.wake.bind(orch); orch.wake = (ev: { type: string; data?: Record<string, unknown> }) => { wakes.push(ev); return wake(ev); }; return wakes; };
  /**
   * The dry-run worker, except that its first turn of `phase` loses the connection: the report it makes then is delivered
   * anyway, lost with its arguments seen (the outbox applies it), or lost with nothing to apply.
   */
  const dropping = (phase: string, mode: 'delivered' | 'outbox' | 'lost', seen: { store?: DataStore; flagged?: unknown; turns: string[] }) => (world: FakeWorld) => {
    const base = new DryRunClaudePort(world);
    return { async runTurn(o: TurnOptions): Promise<TurnResult> {
      seen.turns.push(o.phase);
      if (o.phase !== phase || seen.turns.filter((t) => t === phase).length > 1) return base.runTurn(o);
      o.onConnectionDrop?.(DROP);
      seen.flagged = seen.store!.listItems()[0].file.frontmatter.op_data?.mcp_drop;
      if (mode === 'delivered') return { ...(await base.runTurn(o)), connectionDrop: DROP };
      let lost: UndeliveredReport | undefined;
      const tools = { ...o.tools, report_done: async (summary: string) => { if (mode === 'outbox') { lost = { tool: 'report_done', args: { summary }, error: STREAM }; o.onUndelivered?.(lost); } return ''; } };
      const r = await base.runTurn({ ...o, tools });
      return { ...r, done: undefined, undelivered: lost, connectionDrop: DROP, lastMessage: LAST };
    } };
  };

  it('a drop is on the item within the turn, and a turn that runs with its connection clears it', async () => {
    const seen: { store?: DataStore; flagged?: unknown; turns: string[] } = { turns: [] };
    const { store, engine } = await setup({ claude: dropping('plan', 'delivered', seen) });
    seen.store = store;
    const item = store.createItem({ title: 'Flaky line', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY' && !store.getItem(item.id)!.file.frontmatter.op);
    expect(seen.flagged).toEqual(DROP);
    expect(store.getItem(item.id)!.file.frontmatter.op_data?.mcp_drop).toEqual(DROP);
    expect(activityOf(store, item.id)).toContain(`the session lost its connection to planestro at ${DROP.at} (on Bash): ${STREAM}`);
    expect(store.getItem(item.id)!.file.frontmatter.blocked).toBeUndefined();
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(activityOf(store, item.id)).toContain("the session's connection to planestro held this turn; the earlier drop is cleared");
  });

  it('a turn that ends after a drop with no report to apply stops as connection_lost and wakes the orchestrator with its last message', async () => {
    const seen: { store?: DataStore; flagged?: unknown; turns: string[] } = { turns: [] };
    const { store, engine } = await setup({ claude: dropping('implement', 'lost', seen) });
    seen.store = store;
    const wakes = wakesOf(engine);
    const item = store.createItem({ title: 'Lost line', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked === true);
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.blocked_reason).toBe('connection_lost');
    expect((fm.op_data?.mcp_drop as { final_message?: string }).final_message).toBe(LAST);
    expect(seen.turns.filter((t) => t === 'implement')).toHaveLength(1);       // no report nudge into a dead line
    await waitFor(() => wakes.some((w) => w.type === 'blocked_connection_lost'));
    expect(String(wakes.find((w) => w.type === 'blocked_connection_lost')!.data?.detail)).toContain(LAST);
    expect(activityOf(store, item.id)).toContain(LAST);
  });

  it('a drop whose report the outbox applied lands as done and wakes nobody', async () => {
    const seen: { store?: DataStore; flagged?: unknown; turns: string[] } = { turns: [] };
    const { store, engine } = await setup({ claude: dropping('implement', 'outbox', seen) });
    seen.store = store;
    const wakes = wakesOf(engine);
    const item = store.createItem({ title: 'Recovered line', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(seen.flagged).toEqual(DROP);
    const activity = activityOf(store, item.id);
    expect(activity).toContain('the session lost its connection to planestro');
    expect(activity).toContain("the session's report_done never reached planestro");
    expect(activity).not.toContain('connection_lost');
    expect(wakes.filter((w) => /^blocked_|^worker_|stall/.test(w.type))).toEqual([]);
  });
});
