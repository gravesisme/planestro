import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { ConnectionDrop, Ports, TurnOptions, TurnResult, UndeliveredReport } from '../src/engine/ports.ts';
import { getSection, DEBUG_BEGIN, DEBUG_END } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * A debugging item (#240): instrumentation lives only inside marked blocks, and every block is gone before the
 * work is handed in. planestro refuses report_done in words while the branch still adds a marker, naming each
 * file and line, so the worker removes them and calls again; a lost report it replays is refused the same way.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
const PLAN = '# Plan\n\n1. State the hypotheses.\n2. Instrument, find the cause, fix it, remove the instrumentation.\n';
const INSTRUMENTED = `export function f(x: number) {\n  // ${DEBUG_BEGIN}\n  console.log('f', x);\n  // ${DEBUG_END}\n  return x + 1;\n}\n`;
const CLEAN = 'export function f(x: number) {\n  return x + 1;\n}\n';

async function setup(work: (o: TurnOptions, world: FakeWorld, n: number) => Promise<TurnResult>) {
  const { dataDir } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(world);
  const prompts: string[] = []; let n = 0;
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      if (o.phase === 'plan') { await o.tools.submit_plan(PLAN); return { ...ok, planSubmitted: PLAN }; }
      prompts.push(o.prompt);
      return work(o, world, n++);
    },
    async runCustomTurn(o) { return inner.runCustomTurn(o); },
  };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, prompts };
}

async function waitFor(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => getSection(s.getItem(id)!.file, 'Activity');
/** The worker commits `src/f.ts` with these contents on its branch. */
const commitFile = (o: TurnOptions, world: FakeWorld, text: string) => {
  const wt = world.worktrees.get(o.cwd)!;
  world.files.set(wt.branch!, new Map([['src/f.ts', Buffer.from(text)]]));
  world.commits.set(o.cwd, (world.commits.get(o.cwd) ?? 0) + 1); wt.head = world.sha();
};

async function approved(s: DataStore, e: LiveEngine) {
  const item = s.createItem({ title: 'f returns the wrong value', description: 'Find out why.' });
  s.transition(item.id, 'QUEUED', 'user');
  await e.start();
  await waitFor(() => fmOf(s, item.id).status === 'PLAN_READY');
  await e.approvePlan(item.id);
  return item.id;
}

describe('the debug template (#240)', () => {
  it('ships as a starting point that states hypotheses first and fences instrumentation in markers', async () => {
    const { store } = await setup(async () => ok);
    const p = store.getPrompt('debug')!;
    expect(p.file.frontmatter.kind).toBe('template');
    expect(p.file.frontmatter.role).toBeUndefined();
    expect(p.file.body).toMatch(/hypothes/i);
    expect(p.file.body).toContain(DEBUG_BEGIN);
    expect(p.file.body).toContain(DEBUG_END);
    expect(p.file.body).toContain('report_done');
  });
});

describe('report_done while a marked debug block remains (#240)', () => {
  it('is refused in words naming the file and lines, records nothing, and lands once the blocks are gone', async () => {
    const answers: string[] = [];
    const { store, engine } = await setup(async (o, world) => {
      commitFile(o, world, INSTRUMENTED);
      answers.push(await o.tools.report_done('found it'));
      answers.push(await o.tools.report_done('found it'));
      commitFile(o, world, CLEAN);
      answers.push(await o.tools.report_done('fixed the off-by-one'));
      return { ...ok, done: 'fixed the off-by-one' };
    });
    const id = await approved(store, engine);
    await waitFor(() => fmOf(store, id).status === 'FINISHED', 8000);
    expect(answers[0]).toMatch(/^Rejected:/);
    expect(answers[0]).toContain('src/f.ts:2');
    expect(answers[0]).toContain('src/f.ts:4');
    expect(answers[1]).toBe(answers[0]);                       // the same refusal, however often it is asked
    expect(answers[2]).toMatch(/^Recorded/);
    const log = activityOf(store, id);
    expect(log).not.toContain('done: found it');
    expect(log).toContain('done: fixed the off-by-one');
    expect(fmOf(store, id).blocked).toBeUndefined();
  });

  it('a lost report_done replayed over a marker is refused the same way: the session is told, never blocked', async () => {
    const STREAM = 'Tool permission request failed: AbortError: Stream closed';
    const DROP: ConnectionDrop = { error: STREAM, at: '2026-10-08T12:00:00.000Z', tool: 'report_done' };
    const { store, engine, prompts } = await setup(async (o, world, n) => {
      if (n === 0) {
        commitFile(o, world, INSTRUMENTED);
        const lost: UndeliveredReport = { tool: 'report_done', args: { summary: 'found it' }, error: STREAM };
        o.onUndelivered?.(lost);
        return { ...ok, undelivered: lost, toolFailures: [{ tool: 'report_done', error: STREAM }], connectionDrop: DROP, lastMessage: 'found it' };
      }
      commitFile(o, world, CLEAN);
      await o.tools.report_done('fixed the off-by-one');
      return { ...ok, done: 'fixed the off-by-one' };
    });
    const id = await approved(store, engine);
    await waitFor(() => fmOf(store, id).status === 'FINISHED', 8000);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('src/f.ts:2');
    expect(prompts[1]).toMatch(/report_done/);
    const fm = fmOf(store, id);
    expect(fm.op_data?.outbox).toBeUndefined();
    const log = activityOf(store, id);
    expect(log).not.toContain('BLOCKED');
    expect(log).not.toContain('done: found it');
    expect(log).toContain('done: fixed the off-by-one');
  });
});
