import { describe, it, expect, afterEach } from 'vitest';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { likelyMatches, noteMarker, NOTE_LINK_TYPE } from '../src/engine/feedback.ts';
import type { Ports } from '../src/engine/ports.ts';
import { makeFixture } from './helpers.ts';

/**
 * The orchestrator's notes about planestro become issues in the repo the user names (#231, milestone 1): filed once,
 * linked when someone already filed them (by the note's marker, or a likely match the user confirms), or marked
 * handled by hand. Everything goes through the gh port; these tests drive the dry-run world, never GitHub.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup(repo?: string) {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir, { emit: () => {} });
  if (repo) store.updateConfig((doc) => { doc.setIn(['feedback', 'issue_repo'], repo); }, 'config: feedback repo');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const app = apiRoutes(store, engine);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  const note = (text: string, item?: string, ts?: string) => store!.journal.append({ type: 'orchestrator.planestro_note', item, actor: 'orchestrator', data: { text }, ...(ts ? { ts } : {}) });
  return { store, world, call, note };
}

describe('filing orchestrator notes as issues (#231)', () => {
  it('is offered only once feedback.issue_repo names a repo', async () => {
    const { call, note } = await setup();
    const n = note('The budget card should carry the raise itself.', 'TP-1');
    const list = await call('GET', '/orchestrator/notes');
    expect(list.body.issue_repo).toBeNull();
    expect(list.body.notes[0]).toMatchObject({ ts: n.ts, links: { issues: [], handled: false } });
    const r = await call('POST', '/orchestrator/notes/file', { note: n.ts });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/feedback\.issue_repo/);
  });

  it('files a note once, with its text, its item and a hidden marker, and records the link', async () => {
    const { call, note, world, store } = await setup('acme/tool');
    const n = note('The budget card should carry the raise itself, so the user does not have to type it.', 'TP-1');
    const r = await call('POST', '/orchestrator/notes/file', { note: n.ts });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('filed');
    expect(world.issues).toHaveLength(1);
    const issue = world.issues[0];
    expect(issue.title).toContain('TP-1');
    expect(issue.body).toContain('The budget card should carry the raise itself');
    expect(issue.body).toContain(noteMarker(n.ts));
    expect(store.journal.read({ type: NOTE_LINK_TYPE })).toHaveLength(1);
    const list = await call('GET', '/orchestrator/notes');
    expect(list.body.issue_repo).toBe('acme/tool');
    expect(list.body.notes[0].links.issues).toEqual([{ number: issue.number, url: issue.url }]);
    // A linked note offers no second filing.
    const again = await call('POST', '/orchestrator/notes/file', { note: n.ts });
    expect(again.status).toBe(409);
    expect(world.issues).toHaveLength(1);
  });

  it('links an issue that already carries the note\'s marker instead of filing it again', async () => {
    const { call, note, world } = await setup('acme/tool');
    const n = note('Sync conflict details name the wrong file.', 'TP-2');
    world.issues.push({ number: 42, title: 'Something else entirely', body: `Filed earlier.\n\n${noteMarker(n.ts)}`, url: 'https://github.com/acme/tool/issues/42', state: 'CLOSED' });
    const r = await call('POST', '/orchestrator/notes/file', { note: n.ts });
    expect(r.body).toMatchObject({ outcome: 'linked', issue: { number: 42 } });
    expect(world.issues).toHaveLength(1);
    expect((await call('GET', '/orchestrator/notes')).body.notes[0].links.issues).toEqual([{ number: 42, url: 'https://github.com/acme/tool/issues/42' }]);
  });

  it('offers a likely match first, and files only when told to file anyway', async () => {
    const { call, note, world } = await setup('acme/tool');
    const n = note('The stall watchdog unblocked TP-3 while its permission request was still parked.', 'TP-3');
    world.issues.push({ number: 7, title: 'Stall watchdog unblocks a parked permission request (TP-3)', body: 'The watchdog carried on an item that was waiting on a permission.', url: 'https://github.com/acme/tool/issues/7', state: 'OPEN' });
    const r = await call('POST', '/orchestrator/notes/file', { note: n.ts });
    expect(r.body.outcome).toBe('candidates');
    expect(r.body.candidates.map((c: { number: number }) => c.number)).toEqual([7]);
    expect(world.issues).toHaveLength(1);
    expect((await call('GET', '/orchestrator/notes')).body.notes[0].links.issues).toEqual([]);
    const forced = await call('POST', '/orchestrator/notes/file', { note: n.ts, force: true });
    expect(forced.body.outcome).toBe('filed');
    expect(world.issues).toHaveLength(2);
  });

  it('marks notes handled by hand, with several issues or none, in one call (the backfill), and creates nothing', async () => {
    const { call, note, world } = await setup('acme/tool');
    const a = note('First.', 'TP-1', '2026-09-25T00:50:41-04:00');
    const b = note('Second.', undefined, '2026-09-25T01:05:02-04:00');
    const r = await call('POST', '/orchestrator/notes/mark', { links: [{ note: a.ts, issues: [55, 133] }, { note: b.ts, handled: true, comment: 'declined' }] });
    expect(r.status).toBe(200);
    expect(world.issues).toHaveLength(0);
    const notes = (await call('GET', '/orchestrator/notes')).body.notes;
    const byTs = Object.fromEntries(notes.map((x: any) => [x.ts, x.links]));
    expect(byTs[a.ts].issues.map((i: { number: number }) => i.number)).toEqual([55, 133]);
    expect(byTs[a.ts].issues[0].url).toBe('https://github.com/acme/tool/issues/55');
    expect(byTs[b.ts]).toMatchObject({ issues: [], handled: true, comments: ['declined'] });
    // A note that does not exist is refused, and nothing in the batch is recorded.
    const bad = await call('POST', '/orchestrator/notes/mark', { links: [{ note: a.ts, issues: [9] }, { note: '2020-01-01T00:00:00+00:00', issues: [1] }] });
    expect(bad.status).toBe(400);
    expect(byTs[a.ts].issues).toHaveLength(2);
    expect((await call('GET', '/orchestrator/notes')).body.notes.find((x: any) => x.ts === a.ts).links.issues).toHaveLength(2);
    // Filing a note that is already marked handled is refused.
    expect((await call('POST', '/orchestrator/notes/file', { note: b.ts })).status).toBe(409);
  });
});

describe('likelyMatches', () => {
  const issue = (number: number, title: string, body = '') => ({ number, title, body, url: `u/${number}`, state: 'OPEN' });
  it('finds an issue naming the item with words from the note, and ignores unrelated ones', () => {
    const note = { ts: 't', item: 'HH-174', text: 'CI gate misread a skipped draft run as red when planestro marked the PR ready.' };
    const found = likelyMatches(note, [issue(1, 'Skipped draft run misread as red CI', 'Seen on HH-174.'), issue(2, 'Mobile reorder drops cards'), issue(3, 'HH-174 art brief')]);
    expect(found.map((i) => i.number)).toEqual([1]);
  });
  it('does not match on an item id alone', () => {
    expect(likelyMatches({ ts: 't', item: 'HH-9', text: 'Codex workers cannot write the main checkout tmp directory.' }, [issue(4, 'HH-9 follow-up')])).toEqual([]);
  });
});
