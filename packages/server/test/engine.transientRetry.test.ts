import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { quietTransientFailure, patchRejected } from '../src/engine/transient.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
/** A turn that failed before it did anything: the network, a 5xx, an overload. */
const quiet = (over: Partial<TurnResult> = {}): TurnResult => ({ ...ok, subtype: 'error_during_execution', isError: true, error: 'fetch failed: ECONNRESET', ...over });

/** A worker whose planning turns fail as `fails` says until it returns undefined, then submit a plan; an orchestrator that records its wakes. */
function agents(fails: (n: number) => TurnResult | undefined, wake: (n: number) => TurnResult = () => ({ ...ok, sessionId: 'orch' })) {
  const prompts: string[] = []; const wakes: string[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      prompts.push(o.prompt);
      const r = fails(prompts.length);
      if (r) return r;
      await o.tools.submit_plan('# the plan');
      return { ...ok, planSubmitted: '# the plan' };
    },
    async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> { wakes.push(o.label); return wake(wakes.length); },
  };
  return { claude, prompts, wakes };
}

async function setup(claude: Ports['agents']['claude'], retryAfterS = 1) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  store.updateConfig((doc) => { doc.setIn(['concurrency', 'transient_retry_after_s'], retryAfterS); }, 'config');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 30 });
  const item = store.createItem({ title: 'Fails once', description: 'x' });
  store.transition(item.id, 'QUEUED', 'user');
  return { store, engine, id: item.id };
}

async function waitFor(pred: () => boolean, ms = 15000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${JSON.stringify(store?.listItems().map((i) => ({ ...i.file.frontmatter, activity: i.file.sections.find((x) => x.title === 'Activity')?.body })))}`); await sleep(15); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const journal = (s: DataStore) => s.journal.read();

describe('a turn that failed transiently before doing anything is retried once by itself (#241)', () => {
  it('waits transient_retry_after_s without needing anyone, then resumes the session through retry_op', async () => {
    const a = agents((n) => (n === 1 ? quiet() : undefined));
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).blocked === true);
    expect(fmOf(s, id).blocked_reason).toBe('turn_error');
    expect(fmOf(s, id).op_data?.transient_retry).toMatchObject({ due_at: expect.any(String) });
    expect(s.derived(s.getItem(id)!).needs_you).toBe(false);
    expect(fmOf(s, id).triage).toBeUndefined();
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(a.prompts).toHaveLength(2);
    expect(a.prompts[1]).toContain('transient failure (turn_error)');
    expect(a.wakes.filter((w) => w.startsWith('blocked_'))).toEqual([]);
    const act = activityOf(s, id);
    expect(act).toMatch(/produced nothing, so planestro retries it once in 1s/);
    expect(act).toContain('[app] unblocked (automatic retry)');
    expect(journal(s).filter((j) => j.type === 'turn.transient_retry' && j.item === id)).toHaveLength(1);
    // The turn that worked ends the retry's run: the marker is gone.
    expect(fmOf(s, id).op_data?.transient_retry).toBeUndefined();
  });

  it('a second failure stops as today: blocked for triage, never a second automatic retry', async () => {
    const a = agents((n) => (n <= 2 ? quiet() : undefined));
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => a.wakes.includes('blocked_turn_error'));
    await sleep(1500);
    expect(a.prompts).toHaveLength(2);
    expect(fmOf(s, id).blocked_reason).toBe('turn_error');
    expect(fmOf(s, id).op_data?.transient_retry).toBeUndefined();
    expect(journal(s).filter((j) => j.type === 'turn.transient_retry')).toHaveLength(1);
  });

  it.each([
    ['a turn that said something', quiet({ text: 'Looking at the tests…' })],
    ['a turn that called a tool', quiet({ acted: true })],
    ['a turn whose report never landed', quiet({ toolFailures: [{ tool: 'add_note', error: 'socket hang up' }] })],
    ['auth_required', quiet({ subtype: 'auth_required', error: 'Codex is not logged in' })],
    ['confirmed quota exhaustion', quiet({ subtype: 'rate_limited', error: 'Codex hit a usage or rate limit: You exceeded your current quota' })],
  ])('%s is not retried: it stops as today', async (_name, r) => {
    const a = agents((n) => (n === 1 ? r : undefined));
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).blocked === true && fmOf(s, id).op === undefined);
    await sleep(1500);
    expect(a.prompts).toHaveLength(1);
    expect(fmOf(s, id).op_data?.transient_retry).toBeUndefined();
    expect(journal(s).filter((j) => j.type === 'turn.transient_retry')).toHaveLength(0);
  });

  it('an app-server connection that closed before the turn did anything is retried, not blocked connection_lost', async () => {
    const a = agents((n) => (n === 1 ? quiet({ subtype: 'connection_lost', error: undefined, connectionDrop: { error: 'app-server connection closed before turn completion', at: '2026-10-08T10:00:00+00:00' } }) : undefined));
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(a.prompts).toHaveLength(2);
    expect(a.wakes.filter((w) => w.startsWith('blocked_'))).toEqual([]);
  });

  it('AUTOMATION PAUSED holds the retry; it is persisted and runs once automation resumes', async () => {
    const a = agents((n) => (n === 1 ? quiet() : undefined));
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).blocked === true);
    e.pause();
    await sleep(1500);
    expect(a.prompts).toHaveLength(1);
    expect(fmOf(s, id).op_data?.transient_retry).toMatchObject({ due_at: expect.any(String) });
    e.resume();
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(a.prompts).toHaveLength(2);
  });

  it('0 turns it off', async () => {
    const a = agents((n) => (n === 1 ? quiet() : undefined));
    const { store: s, engine: e, id } = await setup(a.claude, 0);
    await e.start();
    await waitFor(() => a.wakes.includes('blocked_turn_error'));
    expect(a.prompts).toHaveLength(1);
    expect(fmOf(s, id).op_data?.transient_retry).toBeUndefined();
  });

  it('an orchestrator wake that failed before doing anything is woken again once, after the same wait', async () => {
    const a = agents((n) => (n === 1 ? quiet({ acted: true }) : undefined), (n) => (n <= 2 ? quiet({ subtype: 'runner_error', error: 'serverOverloaded' }) : { ...ok, sessionId: 'orch' }));
    const { store: s, engine: e } = await setup(a.claude);
    await e.start();
    await waitFor(() => a.wakes.length >= 2);
    await sleep(1500);
    expect(a.wakes).toEqual(['blocked_turn_error', 'blocked_turn_error']);
    expect(journal(s).filter((j) => j.type === 'orchestrator.transient_retry')).toHaveLength(1);
  });
});

describe('a Codex turn ended over a rejected multi-operation patch (#344)', () => {
  const rejected = (over: Partial<TurnResult> = {}) => quiet({ acted: true, text: 'Updating the manifest…', error: 'apply_patch verification failed: multiple operations target tmp/pending.json', ...over });

  it('is retried once even though it acted, telling the session what went wrong', async () => {
    const a = agents((n) => (n === 1 ? rejected() : undefined));
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(a.prompts).toHaveLength(2);
    expect(a.prompts[1]).toContain('several of its operations targeted the same file');
    expect(a.prompts[1]).toContain('JSON or manifest file whole');
    expect(activityOf(s, id)).toMatch(/The runner ended the turn over a rejected patch, so planestro retries it once/);
    expect(a.wakes.filter((w) => w.startsWith('blocked_'))).toEqual([]);
  });

  it('a second rejection stops for triage as any second failure does', async () => {
    const a = agents((n) => (n <= 2 ? rejected() : undefined));
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => a.wakes.includes('blocked_turn_error'));
    expect(a.prompts).toHaveLength(2);
    expect(fmOf(s, id).op_data?.transient_retry).toBeUndefined();
  });

  it('only that error, and never over a report the turn made', () => {
    expect(patchRejected(rejected())).toBe(true);
    expect(patchRejected(rejected({ error: undefined, text: 'error: multiple operations target prompts.json' }))).toBe(true);
    expect(patchRejected(rejected({ error: 'apply_patch verification failed: invalid hunk' }))).toBe(false);
    expect(patchRejected(rejected({ done: 'all done' }))).toBe(false);
    expect(patchRejected(rejected({ subtype: 'auth_required' }))).toBe(false);
    expect(patchRejected({ ...ok, text: 'multiple operations target x.json' })).toBe(false);
  });
});

describe('quietTransientFailure', () => {
  it('reads the output, not the subtype alone', () => {
    expect(quietTransientFailure(quiet({ subtype: 'runner_error', error: 'serverOverloaded' }))).toBe(true);
    expect(quietTransientFailure(quiet({ subtype: 'api_error', error: 'API Error: 529 Overloaded' }))).toBe(true);
    expect(quietTransientFailure(quiet({ subtype: 'rate_limited', error: 'Codex hit a usage or rate limit: 429 Too Many Requests' }))).toBe(true);
    expect(quietTransientFailure(quiet({ subtype: 'api_error', error: 'API Error: 400 invalid_request_error' }))).toBe(false);
    expect(quietTransientFailure(quiet({ subtype: 'usage_exhausted' }))).toBe(false);
    expect(quietTransientFailure(quiet({ subtype: 'token_cap', error: 'Token limit reached' }))).toBe(false);
    expect(quietTransientFailure(quiet({ subtype: 'auth_required' }))).toBe(false);
    expect(quietTransientFailure(quiet({ subtype: 'session_lost' }))).toBe(false);
    expect(quietTransientFailure(quiet({ parked: 'permission' }))).toBe(false);
    expect(quietTransientFailure({ ...ok })).toBe(false);
  });
});
