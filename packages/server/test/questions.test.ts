import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION, parseThread } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { questionView } from '../src/routes/views.ts';
import { migrate, importJournalQuestions } from '../src/migrations/index.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, git, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Tool = (name: string) => { handler(a: Record<string, unknown>): Promise<string> };
type Wake = { label: string; prompt: string; tools: Tool };
const ok: TurnResult = { sessionId: 'orch', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };

/** A store and a live engine (dry-run ports) whose orchestrator wakes run `orchestrate`. */
async function setup(orchestrate: (w: Wake) => Promise<void> = async () => {}) {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir);
  const wakes: Wake[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(): Promise<TurnResult> { return ok; },
    async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
      const w = { label: o.label, prompt: o.prompt, tools: ((n: string) => o.mcpTools.find((t) => t.name === n)!) as Tool };
      wakes.push(w);
      await orchestrate(w);
      return ok;
    },
  };
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, wakes, dataDir };
}

async function waitFor(pred: () => boolean, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const log = (dir: string) => git(dir, 'log', '--format=%s');
const thread = (s: DataStore, id: string) => parseThread(s.requireQuestion(id).file);

describe('questions in the store', () => {
  it('ask, reply, update, resolve and reopen each write the file and commit semantically', async () => {
    const { store: s, dataDir } = await setup();
    const it = s.createItem({ title: 'Art' });
    const q = s.askQuestion({ headline: 'Keep the raw art?\n(in the repo)', summary: 'Keep the big source files, or only the sprites?', recommendation: 'Only the sprites.', item: it.id });
    expect(q.id).toBe('Q-1');
    expect(q.file.frontmatter).toMatchObject({ status: 'open', item: it.id, headline: 'Keep the raw art? (in the repo)' });
    s.postToQuestion('Q-1', 'user', 'Why keep them at all?');
    s.postToQuestion('Q-1', 'orchestrator', 'No reason.');
    s.updateQuestion('Q-1', { recommendation: 'Delete them.' });
    s.resolveQuestion('Q-1', 'resolved', 'delete the sources', 'orchestrator');
    expect(s.requireQuestion('Q-1').file.frontmatter).toMatchObject({ status: 'resolved', resolution: 'delete the sources' });
    s.reopenQuestion('Q-1');
    expect(s.requireQuestion('Q-1').file.frontmatter.resolution).toBeUndefined();
    expect(thread(s, 'Q-1').map((e) => `${e.actor}: ${e.text}`)).toEqual([
      'user: Why keep them at all?', 'orchestrator: No reason.', 'app: the orchestrator updated the recommendation',
      'app: resolved by the orchestrator: delete the sources', 'app: reopened by you',
    ]);
    expect(log(dataDir).split('\n').slice(0, 6)).toEqual(['Q-1: reopen', 'Q-1: resolve', 'Q-1: update', 'Q-1: reply', 'Q-1: message', 'Q-1: ask']);
    expect(s.askQuestion({ headline: 'Second', summary: 'x' }).id).toBe('Q-2');
    // A reload reads them back from disk.
    s.reload();
    expect(s.listQuestions().map((x) => x.id)).toEqual(['Q-2', 'Q-1']);
    expect(s.invalid).toEqual([]);
  });

  it('the view says who closed a question, so the chat can mark one its item outlived as never answered', async () => {
    const { store: s } = await setup();
    const it = s.createItem({ title: 'Art' });
    for (const h of ['A', 'B', 'C', 'D']) s.askQuestion({ headline: h, summary: 'x', item: it.id });
    s.resolveQuestion('Q-1', 'resolved', 'yes', 'orchestrator');
    s.resolveQuestion('Q-2', 'withdrawn', 'moot', 'user');
    s.resolveQuestion('Q-3', 'resolved', `${it.id} finished`, 'engine');
    const by = (id: string) => questionView(s, s.requireQuestion(id), false, false).closed_by;
    expect([by('Q-1'), by('Q-2'), by('Q-3'), by('Q-4')]).toEqual(['orchestrator', 'you', 'planestro', undefined]);
    s.reopenQuestion('Q-3');
    expect(by('Q-3')).toBeUndefined();
  });

  it('an item that finishes or goes to the icebox resolves its open questions (#57)', async () => {
    const { store: s, engine: e } = await setup();
    const a = s.createItem({ title: 'A' }); const b = s.createItem({ title: 'B' });
    s.askQuestion({ headline: 'About A', summary: 'x', item: a.id });
    s.askQuestion({ headline: 'About B', summary: 'x', item: b.id });
    s.askQuestion({ headline: 'About nothing', summary: 'x' });
    await e.closeAsDone(a.id, 'landed by hand');
    expect(s.requireQuestion('Q-1').file.frontmatter).toMatchObject({ status: 'resolved', resolution: `${a.id} finished` });
    expect(thread(s, 'Q-1').at(-1)!.text).toBe(`resolved by planestro: ${a.id} finished`);
    s.move(b.id, 'icebox');
    expect(s.requireQuestion('Q-2').file.frontmatter).toMatchObject({ status: 'resolved', resolution: `${b.id} moved to the icebox` });
    expect(s.requireQuestion('Q-3').file.frontmatter.status).toBe('open');
  });

  it('a question left open about an item finished while planestro was down resolves at startup', async () => {
    const { store: s, dataDir } = await setup();
    const a = s.createItem({ title: 'A' });
    s.askQuestion({ headline: 'About A', summary: 'x', item: a.id });
    const path = s.requireItem(a.id).path;
    s.close(); store = undefined;
    writeFileSync(path, readFileSync(path, 'utf8').replace('status: NOT_YET_SUBMITTED', 'status: FINISHED'));
    store = await DataStore.open(dataDir);
    expect(store.requireQuestion('Q-1').file.frontmatter.status).toBe('resolved');
  });
});

describe('schema 3 migration', () => {
  it('imports the journal\'s questions: one per text and item, moot ones resolved, and commits once', async () => {
    const { dataDir } = makeFixture();
    const s = await DataStore.open(dataDir);
    const live = s.createItem({ title: 'Live' }); const done = s.createItem({ title: 'Done' });
    s.transition(done.id, 'ICEBOX', 'user');
    s.close();
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(`schema_version: ${SCHEMA_VERSION}`, 'schema_version: 2'));
    git(dataDir, 'commit', '-qam', 'back to schema 2');
    mkdirSync(join(dataDir, 'journal'), { recursive: true });
    const line = (ts: string, item: string | undefined, question: string) => JSON.stringify({ ts, type: 'orchestrator.question', actor: 'orchestrator', ...(item ? { item } : {}), data: { question } });
    appendFileSync(join(dataDir, 'journal', '2026-09.ndjson'), [
      line('2026-09-24T00:07:00-04:00', done.id, 'Keep the raw art?'),
      line('2026-09-24T01:26:00-04:00', live.id, 'Which palette?'),
      JSON.stringify({ ts: '2026-09-24T02:00:00-04:00', type: 'orchestrator.reply', data: { text: 'not a question' } }),
      line('2026-09-25T09:00:00-04:00', live.id, 'Which palette?'),
      line('2026-09-25T10:00:00-04:00', undefined, 'Should releases go out on Fridays?'),
      line('2026-09-25T11:00:00-04:00', 'TP-99', 'About an item since deleted'),
      '{"torn',
    ].join('\n') + '\n');
    const before = await DataStore.open(dataDir, { lock: false });
    expect(before.readOnly).toBe(true);
    before.close();

    const r = await migrate(dataDir);
    expect(r.applied).toEqual([3, 4, 5, 6, 7, 8]);
    expect(readdirSync(join(dataDir, 'questions')).sort()).toEqual(['Q-1.md', 'Q-2.md', 'Q-3.md', 'Q-4.md']);
    expect(git(dataDir, 'log', '-1', '--format=%s')).toBe('planestro: migrate schema 2 → 8\n');
    expect(git(dataDir, 'status', '--porcelain', '--', 'questions', 'planestro.yml')).toBe('');

    const s2 = await DataStore.open(dataDir);
    store = s2;
    expect(s2.readOnly).toBe(false);
    const q = (id: string) => s2.requireQuestion(id).file;
    expect(q('Q-1').frontmatter).toMatchObject({ status: 'resolved', item: done.id, resolution: `${done.id} moved to the icebox`, headline: 'Keep the raw art?' });
    expect(q('Q-2').frontmatter).toMatchObject({ status: 'open', item: live.id, headline: 'Which palette?' });
    expect(q('Q-2').frontmatter.asked_at.slice(0, 10)).toBe('2026-09-24');
    expect(parseThread(q('Q-2')).map((e) => e.text)).toEqual(['the orchestrator asked this again', expect.stringContaining('imported from the journal')]);
    expect(q('Q-3').frontmatter.item).toBeUndefined();
    expect(q('Q-4').frontmatter.item).toBeUndefined();
    expect(s2.listQuestions({ status: 'open' }).map((x) => x.id)).toEqual(['Q-4', 'Q-3', 'Q-2']);
    expect(s2.requireQuestion('Q-4').file.sections.find((x) => x.title === 'Summary')!.body).toBe('About an item since deleted (about TP-99)');
    // Run again: nothing is imported twice.
    expect(importJournalQuestions(dataDir)).toEqual({ imported: 0, settled: 0 });
    expect(existsSync(join(dataDir, 'questions', 'Q-5.md'))).toBe(false);
  });
});

describe('the orchestrator\'s question tools', () => {
  it('ask_user makes a question with its summary and recommendation and returns its id; the old journal line stays', async () => {
    let answer = '';
    const { store: s, engine: e } = await setup(async (w) => {
      answer = await w.tools('ask_user').handler({ question: 'Which palette for the cave?', summary: 'The cave can be cold blue or warm amber. It sets the mood of the whole level.', details: '- blue matches the menu', recommendation: 'Cold blue.', item: 'TP-1' });
      await w.tools('done_with_wake').handler({ summary: 'asked' });
    });
    s.createItem({ title: 'Cave' });
    e.orchestrator.wake({ type: 'review_nudge', item: 'TP-1' });
    await waitFor(() => s.questions.size === 1 && answer !== '');
    expect(answer).toMatch(/^asked as Q-1 /);
    const q = s.requireQuestion('Q-1').file;
    expect(q.frontmatter).toMatchObject({ status: 'open', item: 'TP-1', headline: 'Which palette for the cave?' });
    expect(q.sections.map((x) => [x.title, x.body])).toEqual([['Summary', 'The cave can be cold blue or warm amber. It sets the mood of the whole level.'], ['Details', '- blue matches the menu'], ['Recommendation', 'Cold blue.'], ['Thread', '']]);
    expect(s.journal.read({ type: 'orchestrator.question' }).at(-1)!.data).toEqual({ question: 'Which palette for the cave?', id: 'Q-1' });
    expect(s.getItem('TP-1')!.file.sections.find((x) => x.title === 'Activity')!.body).toContain('question for you (Q-1): Which palette for the cave?');
  });

  it('reply_on_question, update_question and resolve_question change the question; list and read see it', async () => {
    const out: string[] = [];
    const { store: s, engine: e } = await setup(async (w) => {
      out.push(await w.tools('list_questions').handler({}));
      out.push(await w.tools('reply_on_question').handler({ id: 'Q-1', text: 'Blue, then.' }));
      out.push(await w.tools('update_question').handler({ id: 'Q-1', summary: 'Only the colour is left to pick.' }));
      out.push(await w.tools('resolve_question').handler({ id: 'Q-1', status: 'resolved', resolution: 'blue' }));
      out.push(await w.tools('resolve_question').handler({ id: 'Q-1', status: 'withdrawn', resolution: 'again' }));
      out.push(await w.tools('read_question').handler({ id: 'Q-1' }));
      await w.tools('done_with_wake').handler({ summary: 'done' });
    });
    s.askQuestion({ headline: 'Which palette?', summary: 'x' });
    e.orchestrator.wake({ type: 'question_message', data: { question: 'Q-1', message: 'blue' } });
    await waitFor(() => out.length === 6);
    expect(out[0]).toMatch(/^Q-1 \[open\] — asked .* · 0 message\(s\) · Which palette\?$/);
    expect(out.slice(1, 5)).toEqual(['posted in the thread', 'updated', 'resolved', 'Q-1 is already resolved']);
    expect(out[5]).toContain('# Summary\n\nOnly the colour is left to pick.');
    expect(s.requireQuestion('Q-1').file.frontmatter).toMatchObject({ status: 'resolved', resolution: 'blue' });
    await waitFor(() => !e.orchestrator.busy);
    // It answered, so planestro adds nothing of its own.
    expect(thread(s, 'Q-1').map((x) => x.actor)).toEqual(['orchestrator', 'app', 'app']);
  });
});

describe('question wakes', () => {
  it('question_message: the packet holds the whole question and the chat policy; it may create items', async () => {
    const { store: s, engine: e, wakes } = await setup(async (w) => {
      await w.tools('create_item').handler({ title: 'Paint the cave blue', description: 'as agreed in Q-1' });
      await w.tools('reply_on_question').handler({ id: 'Q-1', text: 'Filed it.' });
    });
    s.createItem({ title: 'Cave' });
    s.askQuestion({ headline: 'Which palette?', summary: 'Blue or amber.', recommendation: 'Blue.', item: 'TP-1' });
    s.postToQuestion('Q-1', 'user', 'Go with blue.');
    e.orchestrator.wake({ type: 'question_message', data: { question: 'Q-1', message: 'Go with blue.' } });
    await waitFor(() => wakes.length === 1 && !e.orchestrator.busy);
    const p = wakes[0].prompt;
    expect(wakes[0].label).toBe('question_message');
    expect(p).toContain('Question Q-1 (open), asked');
    expect(p).toContain('# Recommendation\n\nBlue.');
    expect(p).toContain(`] Go with blue.`);
    expect(p).toContain('The user just wrote in its thread:\nGo with blue.');
    expect(p).toContain('answer with reply_on_question (not reply_to_user)');
    expect(p).not.toMatch(/^Item: /m); // the item is described, not woken: a question never ends a triage
    expect(s.getItem('TP-2')?.file.frontmatter.title).toBe('Paint the cave blue');
    expect(thread(s, 'Q-1').map((x) => x.actor)).toEqual(['user', 'orchestrator']);
  });

  it('question_review: the packet has the item as it is now; a review that changes nothing says so', async () => {
    const { store: s, engine: e, wakes } = await setup(async (w) => { await w.tools('done_with_wake').handler({ summary: 'still stands' }); });
    s.createItem({ title: 'Cave' });
    s.mutateItem('TP-1', [{ set: { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }, { activity: { actor: 'app', text: 'blocked: needs a palette' } }], 'engine');
    s.askQuestion({ headline: 'Which palette?', summary: 'Blue or amber.', item: 'TP-1' });
    e.orchestrator.wake({ type: 'question_review', data: { question: 'Q-1' } });
    e.orchestrator.wake({ type: 'question_review', data: { question: 'Q-1' } }); // a second click while queued asks nothing new
    await waitFor(() => wakes.length === 1 && !e.orchestrator.busy && thread(s, 'Q-1').length === 1);
    const p = wakes[0].prompt;
    expect(p).toContain('Its item now: TP-1 — "Cave" · NOT_YET_SUBMITTED · BLOCKED: agent_blocked · awaiting user');
    expect(p).toContain('blocked: needs a palette');
    expect(p).toContain('Relevance check');
    expect(p.match(/Event: question_review/g)).toHaveLength(1);
    expect(thread(s, 'Q-1')[0]).toMatchObject({ actor: 'app', text: 'reviewed, no change' });
  });

  it('a review that withdraws or updates leaves no "no change"; an unanswered message says how the wake ended', async () => {
    const { store: s, engine: e } = await setup(async (w) => {
      if (w.prompt.includes('Relevance check')) await w.tools('resolve_question').handler({ id: 'Q-1', status: 'withdrawn', resolution: 'the item went another way' });
      await w.tools('done_with_wake').handler({ summary: 'looked at it' });
    });
    s.askQuestion({ headline: 'Old one', summary: 'x' });
    s.askQuestion({ headline: 'Other', summary: 'y' });
    e.orchestrator.wake({ type: 'question_review', data: { question: 'Q-1' } });
    await waitFor(() => s.requireQuestion('Q-1').file.frontmatter.status === 'withdrawn' && !e.orchestrator.busy);
    expect(thread(s, 'Q-1').map((x) => x.text)).toEqual(['withdrawn by the orchestrator: the item went another way']);
    s.postToQuestion('Q-2', 'user', 'hello?');
    e.orchestrator.wake({ type: 'question_message', data: { question: 'Q-2', message: 'hello?' } });
    await waitFor(() => thread(s, 'Q-2').length === 2);
    expect(thread(s, 'Q-2')[1]).toMatchObject({ actor: 'app', text: 'the orchestrator did not answer here (it ended with: looked at it)' });
  });

  it('a message a restart left unanswered wakes the orchestrator at startup', async () => {
    const { store: s, engine: e, wakes } = await setup(async (w) => { await w.tools('reply_on_question').handler({ id: 'Q-1', text: 'Sorry, here now.' }); });
    s.askQuestion({ headline: 'Q', summary: 'x' });
    s.askQuestion({ headline: 'Answered', summary: 'y' });
    s.postToQuestion('Q-1', 'user', 'Are you there?');
    s.postToQuestion('Q-2', 'user', 'Thanks'); s.postToQuestion('Q-2', 'orchestrator', 'You are welcome');
    await e.start();
    await waitFor(() => thread(s, 'Q-1').length === 2);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].prompt).toContain('The user just wrote in its thread:\nAre you there?');
  });
});

describe('question routes', () => {
  const call = (app: ReturnType<typeof apiRoutes>, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('list, get, post a message, review, review all, resolve and reopen', async () => {
    let gate!: () => void; const held = new Promise<void>((r) => { gate = r; });
    const { store: s, engine: e, wakes } = await setup(async () => { await held; });
    const app = apiRoutes(s, e);
    s.createItem({ title: 'Cave' });
    s.askQuestion({ headline: 'First', summary: 'one', item: 'TP-1' });
    s.askQuestion({ headline: 'Second', summary: 'two', recommendation: 'Do it.' });

    const list = await (await call(app, 'GET', '/questions?status=open')).json();
    expect(list.map((q: any) => q.id)).toEqual(['Q-2', 'Q-1']);
    expect(list[0]).toMatchObject({ summary: 'two', recommendation: 'Do it.', pending: false, messages: 0 });
    expect(list[0].thread).toBeUndefined();
    expect((await (await call(app, 'GET', '/questions/Q-1')).json())).toMatchObject({ id: 'Q-1', item_title: 'Cave', details: '', thread: [] });
    expect((await call(app, 'GET', '/questions/Q-9')).status).toBe(404);

    const posted = await (await call(app, 'POST', '/questions/Q-2/messages', { text: 'I accept your recommendation' })).json();
    expect(posted.pending).toBe(true);
    expect(posted.thread.map((m: any) => m.text)).toEqual(['I accept your recommendation']);
    expect((await call(app, 'POST', '/questions/Q-2/messages', { text: '  ' })).status).toBe(400);

    expect((await (await call(app, 'POST', '/questions/Q-1/review')).json()).pending).toBe(true);
    expect((await (await call(app, 'POST', '/questions/review-all')).json()).reviewing).toEqual(['Q-2', 'Q-1']);
    gate();
    await waitFor(() => !e.orchestrator.busy && !e.orchestrator.questionPending('Q-1') && !e.orchestrator.questionPending('Q-2'));
    // The message went first, alone; the reviews queued behind it coalesced into one wake.
    expect(wakes.map((w) => w.label)).toEqual(['question_message', 'question_review,question_review']);

    const resolved = await (await call(app, 'POST', '/questions/Q-1/resolve', { resolution: 'did it myself' })).json();
    expect(resolved.frontmatter).toMatchObject({ status: 'resolved', resolution: 'did it myself' });
    expect((await call(app, 'POST', '/questions/Q-1/resolve', {})).status).toBe(400);
    expect((await call(app, 'POST', '/questions/Q-1/review')).status).toBe(400); // closed: reopen it first
    expect((await (await call(app, 'POST', '/questions/Q-1/reopen')).json()).frontmatter.status).toBe('open');
    expect((await call(app, 'POST', '/questions/Q-1/reopen')).status).toBe(400);
    expect(s.journal.read({ type: 'question.resolve' })).toHaveLength(1);
  });
});
