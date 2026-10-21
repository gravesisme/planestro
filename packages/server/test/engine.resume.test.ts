import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoLocal, type SessionContext } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

/**
 * #64: what a resume costs, and what the engine does about it. HH-184 spent a +$15 raise reloading
 * its conversation; HH-181 reloaded one to run `git clean`; HH-247 resumed to run two commits, and its
 * reminder to commit was spent at the instant its budget stopped it.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const ok: TurnResult = { sessionId: 's-old', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
async function waitFor(pred: () => boolean, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const ago = (min: number) => isoLocal(new Date(Date.now() - min * 60_000));

type Tool = (name: string) => { handler(a: Record<string, unknown>): Promise<string> };
type Later = (o: TurnOptions, world: FakeWorld, n: number) => Promise<TurnResult>;
/** A turn that commits the work and reports it done, in a conversation of its own. */
const finishes = (session = 's-new', over: Partial<TurnResult> = {}): Later => async (o, world) => {
  world.dirty.delete(o.cwd); world.commits.set(o.cwd, (world.commits.get(o.cwd) ?? 0) + 1); world.worktrees.get(o.cwd)!.head = world.sha();
  await o.tools.report_done('did it');
  return { ...ok, sessionId: o.resume ?? session, costUsd: 1.5, sessionTotalUsd: 1.5, contextTokens: 30_000, cacheTtlS: 3600, done: 'did it', ...over };
};

/**
 * An item in progress whose first work turn stopped (`first`), with a worker whose later turns do
 * `later`. `orchestrate`, when given, is the orchestrator's wake.
 */
async function stopped(opts: { first?: Later; later?: Later; orchestrate?: (w: { label: string; prompt: string; tools: Tool }) => Promise<void>; yml?: (s: string) => string; until?: (s: DataStore, id: string) => boolean; mode?: Ports['mode'] } = {}) {
  const turns: TurnOptions[] = []; const log: string[] = []; const wakes: string[] = [];
  let worked = 0;
  const first: Later = opts.first ?? (async (o) => { await o.tools.report_blocked('which colour?'); return { ...ok, blocked: 'which colour?' }; });
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  // The conversations here hold 800k tokens: the size threshold (#464) is off unless a test turns it on, so the price is what decides.
  writeFileSync(cfg, (opts.yml ?? ((s) => s))(`${readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n')}fresh_above_context_tokens: 0\n`));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld((m) => log.push(m), { 'origin/trunk': 'f'.repeat(40) });
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      turns.push(o);
      if (o.phase === 'plan') { await o.tools.submit_plan('# the plan\n\npaint it'); return { ...ok, planSubmitted: '# the plan\n\npaint it' }; }
      worked += 1;
      return worked === 1 ? first(o, world, worked) : (opts.later ?? finishes())(o, world, worked);
    },
    ...(opts.orchestrate ? { async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
      wakes.push(o.prompt);
      await opts.orchestrate!({ label: o.label, prompt: o.prompt, tools: ((n: string) => o.mcpTools.find((t) => t.name === n)!) as Tool });
      return { ...ok, sessionId: 'orch' };
    } } : {}),
  };
  const ports: Ports = { mode: opts.mode ?? 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const item = store.createItem({ title: 'Paint the door', description: 'The door should be green.' });
  store.transition(item.id, 'QUEUED', 'user');
  await engine.start();
  await waitFor(() => fmOf(store!, item.id).status === 'PLAN_READY');
  await engine.approvePlan(item.id, 'use the dark green');
  await waitFor(() => opts.until ? opts.until(store!, item.id) : (() => { const fm = fmOf(store!, item.id); return Boolean(fm.blocked || fm.awaiting) && !engine!.sessions().length; })(), 8000);
  const model = store.config.models.find((m) => m.id === fmOf(store!, item.id).implementer)!.claude_model!;
  /** A long conversation on the item: 800k tokens at $40 a million to write, so $32 to reload once the cache has expired. */
  const long = (left: number, over: Partial<SessionContext> = {}) => store!.mutateItem(item.id, [{ set: { cost_usd: 10, budget_usd: 10 + left, session_id: 's-old', session_context: { session: 's-old', model, tokens: 800_000, at: ago(120), ttl_s: 3600, write_usd_per_mtok: 40, total_usd: 20, ...over } } }], 'engine');
  return { store, engine, world, id: item.id, turns, log, wakes, long, model, cwd: join(codeRepo, fmOf(store, item.id).worktree ?? '') };
}

describe('what a turn cost, not what its conversation has cost (#64)', () => {
  it("a turn's spend is added to the item; the running total is kept for the next resume to be measured against", async () => {
    const { store: s, engine: e, id, turns } = await stopped({ first: async (o) => { await o.tools.report_blocked('which colour?'); return { ...ok, costUsd: 0.56, sessionTotalUsd: 30.27, contextTokens: 412_000, cacheTtlS: 3600, blocked: 'which colour?' }; } });
    const fm = fmOf(s, id);
    expect(fm.cost_usd).toBe(0.56);
    expect(fm.session_context).toMatchObject({ session: 's-old', tokens: 412_000, ttl_s: 3600, total_usd: 30.27 });
    const end = s.journal.read({ type: 'op.end', item: id }).at(-1)!;
    expect(end.data).toMatchObject({ cost: 0.56, session_total: 30.27, context_tokens: 412_000 });
    await e.unblock(id, 'Green.');
    await waitFor(() => turns.filter((t) => t.phase !== 'plan').length === 2);
    const next = turns.at(-1)!;
    expect(next.resume).toBe('s-old');
    expect(next.resumeTotalUsd).toBe(30.27);
  });

  it('a turn that reported a total but no window still leaves the total for the next resume', async () => {
    const { store: s, engine: e, id, turns } = await stopped({ first: async (o) => { await o.tools.report_blocked('which colour?'); return { ...ok, costUsd: 3, sessionTotalUsd: 3, blocked: 'which colour?' }; } });
    expect(fmOf(s, id).session_context).toMatchObject({ session: 's-old', tokens: 0, total_usd: 3 });
    await e.unblock(id, 'Green.');
    await waitFor(() => turns.filter((t) => t.phase !== 'plan').length === 2);
    expect(turns.at(-1)!.resume).toBe('s-old');                                // nothing is known of its size, so nothing is assumed
    expect(turns.at(-1)!.resumeTotalUsd).toBe(3);
  });

  it('the quote the CLI gave for a resume becomes the price of reloading that conversation', async () => {
    const { store: s, engine: e, id, turns } = await stopped({ later: async (o) => { await o.tools.report_blocked('and the frame?'); return { ...ok, costUsd: 0.2, sessionTotalUsd: 5, contextTokens: 100_000, cacheTtlS: 3600, resumeQuote: { contextTokens: 90_000, cacheWriteUsd: 3.6, cacheExpired: true }, blocked: 'and the frame?' }; } });
    await e.unblock(id, 'Green.');
    await waitFor(() => turns.filter((t) => t.phase !== 'plan').length === 2 && Boolean(fmOf(s, id).blocked));
    expect(fmOf(s, id).session_context).toMatchObject({ session: 's-old', tokens: 100_000, write_usd_per_mtok: 40, total_usd: 5 });
    expect(s.journal.read({ type: 'op.end', item: id }).at(-1)!.data).toMatchObject({ quoted_reload_usd: 3.6, quoted_tokens: 90_000, quoted_cache_expired: true });
  });
});

describe('a resume the item cannot pay for (#64, HH-184)', () => {
  it('becomes a fresh conversation with a brief when the instruction stands on its own, and the item carries on in it', async () => {
    const { store: s, engine: e, id, turns, long } = await stopped();
    long(15);
    await e.unblock(id, 'Resolve the rebase: regenerate messages.pot.');
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    const turn = turns.at(-1)!;
    expect(turn.resume).toBeUndefined();
    expect(turn.resumeTotalUsd).toBeUndefined();
    for (const part of ['You are picking up TP-1', 'The door should be green.', 'paint it', 'Approval notes: use the dark green', 'Resolve the rebase: regenerate messages.pot.', 'BLOCKED (agent_blocked): which colour?', '(no pull request yet)']) expect(turn.prompt, part).toContain(part);
    expect(turn.prompt).not.toContain('Your session was parked');
    expect(turn.prompt).not.toContain('Your plan for TP-1');               // the brief carries the plan; the full opener is not sent as well
    const activity = activityOf(s, id);
    expect(activity).toContain('starting a fresh');
    expect(activity).toContain('instead of resuming s-old');
    expect(activity).toContain('costs about $32.00 before any work and $15.00 is left');
    expect(activity).toContain("this item's conversation is now s-new; the one before it (s-old) was not resumed");
    const fm = fmOf(s, id);
    expect(fm.session_id).toBe('s-new');
    expect(fm.session_context).toMatchObject({ session: 's-new', tokens: 30_000, total_usd: 1.5 });
    expect(fm.cost_usd).toBe(11.5);
    expect(s.journal.read({ type: 'session.replaced', item: id })[0].data).toMatchObject({ from: 's-old', to: 's-new' });
  });

  it('is not started for an answer to the session\'s own question: it stops before anything is spent, with the numbers', async () => {
    const { store: s, engine: e, id, turns, long } = await stopped({ first: async (o) => { await o.onQuestion([{ question: 'Which green?' }]); return { ...ok, parked: 'question' }; } });
    long(15);
    const before = turns.length;
    await e.respond(id, { kind: 'question', answers: { 'Which green?': 'The dark one.' } });
    await waitFor(() => fmOf(s, id).blocked_reason === 'over_budget');
    expect(turns.length).toBe(before);
    expect(fmOf(s, id).cost_usd).toBe(10);
    expect(fmOf(s, id).session_id).toBe('s-old');
    const said = activityOf(s, id);
    expect(said).toContain('$15.00 left of its $25 budget (budget_usd on this item)');
    expect(said).toContain('reloading its conversation (800k tokens) costs about $32.00 before any work');
    expect(said).toContain('nothing was spent');
    expect(said).toContain('The turn was for: ');
    expect(said).toContain('The dark one.');
  });

  it('is started while the cache is still warm: the reload is then a read', async () => {
    const { store: s, engine: e, id, turns, long } = await stopped({ later: async (o) => { await o.tools.report_blocked('again'); return { ...ok, blocked: 'again' }; } });
    long(15, { at: ago(5) });
    await e.unblock(id, 'Green.');
    await waitFor(() => turns.filter((t) => t.phase !== 'plan').length === 2);
    expect(turns.at(-1)!.resume).toBe('s-old');
    expect(turns.at(-1)!.prompt).toContain('Your session was parked');
    expect(turns.at(-1)!.prompt).toContain('Green.');
    expect(activityOf(s, id)).not.toContain('starting a fresh');
  });

  it('with no record of the conversation, the CLI is asked before the first request and a declined resume costs nothing', async () => {
    const asked: string[] = [];
    const later: Later = async (o, world, n) => {
      if (o.resume) { const go = o.onResumeQuote!({ contextTokens: 800_000, cacheWriteUsd: 32, cacheExpired: true, secondsSinceLast: 7200 }); asked.push(go); if (go === 'stop') return { ...ok, subtype: 'resume_declined', numTurns: 0, resumeQuote: { contextTokens: 800_000, cacheWriteUsd: 32, cacheExpired: true, secondsSinceLast: 7200 } }; }
      return finishes()(o, world, n);
    };
    const { store: s, engine: e, id, turns } = await stopped({ later });
    s.mutateItem(id, [{ set: { cost_usd: 10, budget_usd: 25 }, unset: ['session_context'] } as never], 'engine');
    await e.unblock(id, 'Finish it.');
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(asked).toEqual(['stop']);
    const work = turns.filter((t) => t.phase !== 'plan');
    expect(work.at(-2)!.resume).toBe('s-old');
    expect(work.at(-1)!.resume).toBeUndefined();
    expect(work.at(-1)!.prompt).toContain('You are picking up TP-1');
    expect(work.at(-1)!.prompt).toContain('Finish it.');
    expect(activityOf(s, id)).toContain('did not resume this item\'s conversation: the CLI quoted $32.00 to reload its 800k tokens');
    expect(fmOf(s, id).cost_usd).toBe(11.5);                                 // the fresh turn's $1.50 and nothing for the one declined
  });
});

describe('budget_usd_fresh_above (#64)', () => {
  it('above it, an instruction goes to a fresh conversation though the resume could be paid for', async () => {
    const { store: s, engine: e, id, turns, long } = await stopped();
    long(100);
    await e.unblock(id, 'Run git clean and report done.');
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(turns.at(-1)!.resume).toBeUndefined();
    expect(activityOf(s, id)).toContain('above budget_usd_fresh_above ($10)');
  });

  it('0 turns it off: what can be paid for is resumed', async () => {
    const { store: s, engine: e, id, turns, long } = await stopped({ yml: (y) => `${y}\nbudget_usd_fresh_above: 0\n` });
    expect(s.config.budget_usd_fresh_above).toBe(0);
    long(100);
    await e.unblock(id, 'Run git clean and report done.');
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(turns.at(-1)!.resume).toBe('s-old');
  });
});

describe('fresh_above_context_tokens (#464)', () => {
  it('a warm, affordable resume of a window above it goes to a fresh conversation', async () => {
    const { store: s, engine: e, id, turns, long } = await stopped({ yml: (y) => y.replace('fresh_above_context_tokens: 0', 'fresh_above_context_tokens: 300000') });
    expect(s.config.fresh_above_context_tokens).toBe(300_000);
    long(100, { at: ago(5) });
    await e.unblock(id, 'Run git clean and report done.');
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(turns.at(-1)!.resume).toBeUndefined();
    expect(activityOf(s, id)).toContain('800k tokens, above fresh_above_context_tokens (300k)');
  });

  it('below it the warm conversation is resumed', async () => {
    const { store: s, engine: e, id, turns, long } = await stopped({ yml: (y) => y.replace('fresh_above_context_tokens: 0', 'fresh_above_context_tokens: 900000') });
    long(100, { at: ago(5) });
    await e.unblock(id, 'Run git clean and report done.');
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(turns.at(-1)!.resume).toBe('s-old');
  });
});

describe('a conversation from dry-run, after the switch to live', () => {
  it('is not resumed: the live turn starts a fresh conversation with a brief', async () => {
    const { store: s, engine: e, id, turns } = await stopped({ mode: 'live' });
    s.mutateItem(id, [{ set: { session_id: 'dryrun-TP-1-abc123' }, unset: ['session_context'] } as never], 'engine');
    await e.unblock(id, 'Finish it.');
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    const work = turns.filter((t) => t.phase !== 'plan');
    expect(work.at(-1)!.resume).toBeUndefined();
    expect(work.at(-1)!.prompt).toContain('You are picking up TP-1');
  });
});

describe('a fresh session, asked for (#64)', () => {
  it('unblock with fresh starts one whatever the reload costs, and refuses without a task or while planning', async () => {
    const { store: s, engine: e, id, turns } = await stopped();
    await expect(e.unblock(id, undefined, 'user', { fresh: true })).rejects.toThrow('a fresh session needs a message');
    expect(fmOf(s, id).blocked).toBe(true);
    await e.unblock(id, 'Paint it dark green and report done.', 'user', { fresh: true });
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(turns.at(-1)!.resume).toBeUndefined();
    expect(turns.at(-1)!.prompt).toContain('Paint it dark green and report done.');
    expect(activityOf(s, id)).toContain('starting a fresh');
    expect(activityOf(s, id)).toContain('asked for');

    const planning = s.createItem({ title: 'Still planning', description: 'x' });
    s.mutateItem(planning.id, [{ set: { status: 'PLAN_IN_PROGRESS', blocked: true, blocked_reason: 'turn_error', session_id: 'p', worktree: 'w' } }], 'engine');
    await expect(e.unblock(planning.id, 'go', 'user', { fresh: true })).rejects.toThrow('a fresh session is for work in progress or in review');
  });

  it('POST /items/:id/unblock takes fresh', async () => {
    const { store: s, engine: e, id, turns } = await stopped();
    const app = apiRoutes(s, e);
    const bad = await app.request(`/items/${id}/unblock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fresh: true }) });
    expect(bad.status).toBe(400);
    const res = await app.request(`/items/${id}/unblock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Paint it.', fresh: true }) });
    expect(res.status).toBe(200);
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(turns.at(-1)!.resume).toBeUndefined();
  });

  it('a fresh turn that died before its conversation had an id is a fresh turn again after a restart', async () => {
    const { store: s, engine: e, id, turns, long } = await stopped();
    long(15);
    await e.stop();
    // As a killed fresh turn leaves it: the turn's op, the brief's marker, and still the old conversation's id.
    s.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }, { set: { op: 'implement_turn', op_started_at: ago(1), op_data: { ...(fmOf(s, id).op_data ?? {}), fresh_brief: { task: 'Resolve the rebase.', from_session: 's-old' } } } }], 'engine');
    const ports = (e as unknown as { ports: Ports }).ports;
    engine = new LiveEngine(s, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
    await engine.start();
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    const turn = turns.at(-1)!;
    expect(turn.resume).toBeUndefined();
    expect(turn.prompt).toContain('Resolve the rebase.');
    expect(turn.prompt).not.toContain('Your previous turn was interrupted');
    expect(fmOf(s, id).session_id).toBe('s-new');
    expect(fmOf(s, id).op_data?.fresh_brief).toBeUndefined();
  });
});

describe('a dirty tree at a spent budget (#64, HH-247)', () => {
  // The work turn reports done with the tree dirty and spends the item's budget doing it.
  const spends: Later = async (o, world) => { world.dirty.add(o.cwd); world.commits.set(o.cwd, 1); world.worktrees.get(o.cwd)!.head = world.sha(); await o.tools.report_done('painted'); return { ...ok, costUsd: 24.5, sessionTotalUsd: 24.5, contextTokens: 800_000, cacheTtlS: 3600, done: 'painted' }; };

  it('spends no reminder: it stops with the files named, and commit_paths then finish_from_worktree land the work without a turn', async () => {
    const { store: s, engine: e, id, turns, log, cwd } = await stopped({ first: spends });
    await waitFor(() => fmOf(s, id).blocked_reason === 'over_budget');
    const work = turns.filter((t) => t.phase !== 'plan').length;
    expect(work).toBe(1);
    const said = activityOf(s, id);
    expect(said).not.toContain('asking the session to commit');
    expect(fmOf(s, id).op_data?.dirty_tree_turns).toBeUndefined();
    expect(said).toContain('the worktree has 1 uncommitted file (src/fake.ts) and the item cannot pay for a turn to commit them');
    expect(said).toContain('commit_paths commits the ones that belong without a turn');

    expect(await e.finishFromWorktree(id, 'orchestrator')).toContain('not possible: the worktree has uncommitted changes');
    const done = await e.commitPaths(id, ['./src/fake.ts'], 'TP-1: paint the door\n\nThe dark green.');
    expect(done).toMatch(/^committed [0-9a-f]{7}: 1 file\. The tree is clean: finish_from_worktree opens the pull request from here\./);
    expect(done).toContain('Nothing was pushed and TP-1 is as blocked');
    expect(log).toContain(`Would git commit -m "TP-1: paint the door" -- src/fake.ts (in ${cwd})`);
    expect(fmOf(s, id).blocked).toBe(true);
    expect(activityOf(s, id)).toContain('committed 1 file without a session turn');
    expect(s.journal.read({ type: 'op.end', item: id }).at(-1)!.data).toMatchObject({ outcome: 'ok', paths: ['src/fake.ts'] });

    expect(await e.finishFromWorktree(id, 'orchestrator')).toContain('finishing: ');
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(turns.filter((t) => t.phase !== 'plan').length).toBe(work);       // no turn was run for any of it
    expect(fmOf(s, id).cost_usd).toBe(24.5);
  });

  it('with money left the reminder is sent as before, to the conversation whose cache is warm', async () => {
    const { store: s, id, turns } = await stopped({ first: async (o, world) => ({ ...(await spends(o, world, 1)), costUsd: 2, sessionTotalUsd: 2 }), later: finishes('s-old'), until: (st, i) => fmOf(st, i).status === 'FINISHED' });
    expect(activityOf(s, id)).toContain('worktree dirty after turn (1 files); asking the session to commit');
    expect(turns.at(-1)!.resume).toBe('s-old');
    expect(turns.at(-1)!.prompt).toContain('still has uncommitted changes');
  });
});

describe('commit_paths refuses what it cannot vouch for (#64)', () => {
  it('only uncommitted files of the worktree, by relative path, on an item that is idle', async () => {
    const { store: s, engine: e, world, id, cwd } = await stopped();
    world.dirty.add(cwd); world.untracked.set(cwd, ['notes/new.md', 'art/door.png.import']);
    s.updateConfig((doc) => { doc.setIn(['worktrees', 'byproducts'], ['*.import']); }, 'config: byproducts');
    expect(await e.commitPaths(id, ['src/other.ts'], 'm')).toContain("refused: src/other.ts is not among the worktree's uncommitted files (src/fake.ts, notes/new.md");
    expect(await e.commitPaths(id, ['../outside.ts'], 'm')).toContain('is not a path inside the worktree');
    expect(await e.commitPaths(id, ['/etc/passwd'], 'm')).toContain('is not a path inside the worktree');
    expect(await e.commitPaths(id, ['.git/config'], 'm')).toContain('is not a path inside the worktree');
    expect(await e.commitPaths(id, ['--all'], 'm')).toContain('is not a path inside the worktree');
    expect(await e.commitPaths(id, ['art/door.png.import'], 'm')).toContain('is a byproduct');
    expect(await e.commitPaths(id, [], 'm')).toContain('refused: name the files to commit');
    expect(await e.commitPaths(id, ['src/fake.ts'], '  ')).toContain('refused: the commit needs a message');
    expect(world.commits.get(cwd) ?? 0).toBe(0);

    const some = await e.commitPaths(id, ['src/fake.ts'], 'TP-1: the door');
    expect(some).toContain('Still uncommitted: notes/new.md');
    expect(await e.commitPaths(id, ['notes/new.md'], 'TP-1: notes')).toContain('The tree is clean');
    expect(world.commits.get(cwd)).toBe(2);
  });

  it('not while paused, taken over, busy with a step, or in another status', async () => {
    const { store: s, engine: e, world, id, cwd } = await stopped();
    world.dirty.add(cwd);
    s.mutateItem(id, [{ set: { op: 'rebasing' } }], 'engine');
    expect(await e.commitPaths(id, ['src/fake.ts'], 'm')).toBe(`not now: ${id} is rebasing; let it finish first`);
    s.mutateItem(id, [{ unset: ['op'] }, { set: { awaiting: 'question' } }], 'engine');
    expect(await e.commitPaths(id, ['src/fake.ts'], 'm')).toContain('is awaiting question; answer that first');
    s.mutateItem(id, [{ set: { awaiting: 'user', taken_over: { since: ago(1) } } }], 'engine');
    expect(await e.commitPaths(id, ['src/fake.ts'], 'm')).toBe(`not now: the user has taken ${id} over`);
    s.mutateItem(id, [{ unset: ['taken_over'] }], 'engine');
    e.pause();
    expect(await e.commitPaths(id, ['src/fake.ts'], 'm')).toBe('not now: automation is paused; nothing was committed');
    e.resume();
    const planning = s.createItem({ title: 'Planning', description: 'x' });
    s.mutateItem(planning.id, [{ set: { status: 'PLAN_IN_PROGRESS', worktree: 'w', branch: 'b' } }], 'engine');
    expect(await e.commitPaths(planning.id, ['a'], 'm')).toContain('only a worker item in progress or in review has work to commit');
    expect(world.commits.get(cwd) ?? 0).toBe(0);
  });
});

describe('the orchestrator has the numbers, and a raise that can finish (#64)', () => {

  it('the packet says what is left, what the reload costs and which step fits; a raise smaller than the reload is refused with the floor', async () => {
    const replies: string[] = []; const packets: string[] = [];
    const card = (raise: number, fresh = false) => ({ item: 'TP-1', question: 'Give it more budget?', why: 'It is one step from done.', options: [{ label: `+$${raise}${fresh ? ' fresh' : ''}`, description: 'Raise the cap and carry on', recommended: true, raise_budget_usd: raise, ...(fresh ? { fresh: true } : {}) }, { label: 'Stop here', description: 'Leave it blocked' }] });
    let armed = false;
    const { store: s, engine: e, id, turns, long } = await stopped({ orchestrate: async (w) => {
      if (!armed || !w.label.startsWith('blocked_')) return;
      armed = false;
      packets.push(w.prompt);
      const ask = w.tools('ask_user_decision');
      replies.push(await ask.handler(card(15)));
      replies.push(await ask.handler(card(2, true)));
      replies.push(await ask.handler(card(5, true)));
    } });
    await waitFor(() => !fmOf(s, id).triage);
    long(0.5);
    armed = true;
    await e.unblock(id, 'Green.');                                              // $0.50 left: nothing can start
    await waitFor(() => replies.length === 3);
    expect(packets[0]).toContain('Budget: $10.00 spent of $10.5 (budget_usd on this item), $0.50 left.');
    expect(packets[0]).toContain('Resuming its conversation reloads 800k tokens first: about $32.00 before any work');
    expect(packets[0]).toContain('A resume does NOT fit what is left');
    expect(packets[0]).toContain('commit_paths commits named files');
    expect(packets[0]).toContain('a card with raise_budget_usd of at least $35 to resume, or $3 with fresh: true');
    expect(replies[0]).toContain('not recorded: option "+$15" raises the budget by $15, but resuming TP-1\'s conversation costs about $32.00 before any work');
    expect(replies[0]).toContain('Raise by at least $35, or offer a fresh session instead (fresh: true on the option, from +$3)');
    expect(replies[1]).toContain('a fresh session needs about $3');
    expect(replies[2]).toContain('recorded');

    // Tapped with no orchestrator left to carry it out (triage has ended with the card): the session hears it itself, fresh.
    s.updateConfig((doc) => { doc.setIn(['orchestrator', 'triage'], false); }, 'config: no triage');
    await e.answerDecision(id, { choice: '+$5 fresh' });
    await waitFor(() => fmOf(s, id).status === 'FINISHED', 8000);
    expect(fmOf(s, id).budget_usd).toBe(15.5);
    expect(turns.at(-1)!.resume).toBeUndefined();
    expect(turns.at(-1)!.prompt).toContain('Their answer: +$5 fresh');
  });

  it('unblock_item with fresh and commit_paths are the orchestrator\'s tools, and neither touches an item the user has taken over', async () => {
    const replies: string[] = [];
    let armed = false;
    const { store: s, engine: e, world, id, turns, long, cwd } = await stopped({ orchestrate: async (w) => {
      if (!armed || !w.label.startsWith('blocked_')) return;
      armed = false;
      s.mutateItem(id, [{ set: { taken_over: { since: ago(1) } } }], 'user');
      replies.push(await w.tools('commit_paths').handler({ id, paths: ['src/fake.ts'], message: 'm' }));
      replies.push(await w.tools('unblock_item').handler({ id, message: 'go', fresh: true }));
      s.mutateItem(id, [{ unset: ['taken_over'] }], 'user');
      replies.push(await w.tools('unblock_item').handler({ id, fresh: true }));
      replies.push(await w.tools('unblock_item').handler({ id, message: 'Paint it and report done.', fresh: true }));
    } });
    await waitFor(() => !fmOf(s, id).triage);
    world.dirty.add(cwd);
    long(0.5);
    armed = true;
    await e.unblock(id, 'Green.');
    await waitFor(() => replies.length === 4);
    expect(replies[0]).toContain('not permitted: the user has taken TP-1 over');
    expect(replies[1]).toContain('not permitted: the user has taken TP-1 over');
    expect(replies[2]).toContain('not possible: a fresh session needs a message');
    expect(replies[3]).toBe('unblocked; a fresh session starts with a brief and your message as its task');
    // It asked for fresh, but with $0.50 left nothing starts: the stop comes back with the numbers, unspent.
    await waitFor(() => fmOf(s, id).blocked_reason === 'over_budget' && !e.sessions().length);
    expect(turns.filter((t) => t.phase !== 'plan').length).toBe(1);
  });
});
