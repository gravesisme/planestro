import { describe, it, expect, afterEach } from 'vitest';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine, setupHookRetries } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, ProcPort } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

// #561 (HH-743 and four before it): a fresh worktree's `godot --headless --import` exited 128 on "Unexpected NUL
// character" while other worktrees cut in the same minute passed, and a retry passed. A failed setup hook runs once
// more before it blocks; setup hooks of a project's worktrees never overlap (concurrency.max_local_jobs, 1 by default).

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

/** `codes[dir]` scripts each run's exit in that worktree, in order; past the end a run passes. */
async function setup(codes: Record<string, number[]> = {}) {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir, { emit: () => {} });
  store.updateConfig((doc) => { doc.setIn(['hooks', 'after_worktree_create'], ['import --headless']); }, 'config: hook');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const log: string[] = [];
  const runs = new Map<string, number>();
  const proc: ProcPort = {
    async run(command, { cwd }) {
      const n = runs.get(cwd) ?? 0; runs.set(cwd, n + 1);
      log.push(`start ${cwd}`); await sleep(40); log.push(`end ${cwd}`);
      const code = codes[cwd]?.[n] ?? 0;
      return { code, stdout: 'importing…\n', stderr: code ? `ERROR: Unicode parsing error: Unexpected NUL character (${command})\n` : '' };
    },
  };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc, agents: { claude: new DryRunClaudePort(world) as unknown as Ports['agents']['claude'] } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async (ms) => { await sleep(Math.min(ms, 20)); }, tickMs: 50, log: () => {} });
  const item = (title: string) => store!.createItem({ title, description: 'x' }).id;
  const hooks = (id: string, dir: string) => (engine as any).runSetupHooks(id, dir, store!.journal.begin('creating_worktree', id, {})) as Promise<boolean>;
  return { store, engine, log, item, hooks };
}
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

describe('setup hooks (#561)', () => {
  it('a hook that fails once runs once more, said in Activity, and the item goes on unblocked', async () => {
    const { store, log, item, hooks } = await setup({ '/wt/a': [128] });
    const id = item('Fresh worktree');
    expect(await hooks(id, '/wt/a')).toBe(true);
    expect(log).toEqual(['start /wt/a', 'end /wt/a', 'start /wt/a', 'end /wt/a']);
    const fm = store.getItem(id)!.file.frontmatter;
    expect(fm.blocked).toBeFalsy();
    const activity = activityOf(store, id);
    expect(activity).toMatch(/setup hook failed: import --headless exited 128: ERROR: Unicode parsing error: Unexpected NUL character \(import --headless\); running it once more before blocking/);
    expect(activity).toMatch(/hook ok: import --headless \(on its second run\)/);
  });

  it('a hook that fails twice blocks hook_failed after its second run, saying so', async () => {
    const { store, log, item, hooks } = await setup({ '/wt/a': [128, 1] });
    const id = item('Broken hook');
    expect(await hooks(id, '/wt/a')).toBe(false);
    expect(log).toHaveLength(4);
    const fm = store.getItem(id)!.file.frontmatter;
    expect(fm.blocked).toBe(true);
    expect(fm.blocked_reason).toBe('hook_failed');
    expect(activityOf(store, id)).toMatch(/import --headless exited 1 \(again, on its second run\)/);
  });

  it('a hook that timed out or could not be started is not run again', async () => {
    for (const code of [124, 126, 127]) {
      const { store, log, item, hooks } = await setup({ '/wt/a': [code] });
      const id = item(`Exit ${code}`);
      expect(await hooks(id, '/wt/a')).toBe(false);
      expect(log).toEqual(['start /wt/a', 'end /wt/a']);
      expect(store.getItem(id)!.file.frontmatter.blocked_reason).toBe('hook_failed');
      expect(activityOf(store, id)).not.toMatch(/running it once more/);
      await engine!.stop(); store.close(); engine = undefined;
    }
    store = undefined;
  });

  it('the setup hooks of worktrees created at once run one at a time, and a second run queues behind the hook already waiting', async () => {
    const { store, log, item, hooks } = await setup({ '/wt/a': [128] });
    expect(store.config.concurrency.max_local_jobs).toBe(1);
    const a = item('A'), b = item('B');
    expect(await Promise.all([hooks(a, '/wt/a'), hooks(b, '/wt/b')])).toEqual([true, true]);
    expect(log).toEqual(['start /wt/a', 'end /wt/a', 'start /wt/b', 'end /wt/b', 'start /wt/a', 'end /wt/a']);
  });

  it('a second run not yet started waits while automation is paused, and goes on at Resume', async () => {
    const { store, engine, log, item, hooks } = await setup({ '/wt/a': [128] });
    const id = item('Paused between runs');
    const run = hooks(id, '/wt/a');
    while (!log.includes('start /wt/a')) await sleep(5);
    engine.pause();
    await sleep(200);
    expect(log).toEqual(['start /wt/a', 'end /wt/a']);
    expect(activityOf(store, id)).toMatch(/setup hook held while automation is paused: import --headless/);
    engine.resume();
    expect(await run).toBe(true);
    expect(log).toHaveLength(4);
  });

  it('setupHookRetries: any failure but a timeout or stop (124) and a command that could not run (126, 127)', () => {
    expect([1, 2, 128, 137, 255].every(setupHookRetries)).toBe(true);
    expect([0, 124, 126, 127].some(setupHookRetries)).toBe(false);
  });
});
