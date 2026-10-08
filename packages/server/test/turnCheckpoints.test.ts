import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { LiveGitPort } from '../src/engine/live-ports.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, git, sleep } from './helpers.ts';

/**
 * Per-turn checkpoints and "Undo last turn" (#234). Each worker turn is bracketed by two checkpoints of the
 * worktree (index and files, untracked ones included) under refs/planestro/checkpoints/<item>/<n>/; refs are only
 * added. Undo puts the worktree back as it was before the last turn, only on positive evidence (invariant 7):
 * nothing live on the item, the worktree exactly as the turn left it, and nothing of the turn's on the remote.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const refs = (repo: string, prefix: string) => git(repo, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean);

describe('checkpoints in git (#234)', () => {
  it('records the index and every non-ignored file without touching the real index, and restores them exactly', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'planestro-cp-'));
    git(repo, 'init', '-q', '-b', 'trunk');
    writeFileSync(join(repo, '.gitignore'), 'build/\n'); writeFileSync(join(repo, 'a.txt'), 'a\n'); writeFileSync(join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
    writeFileSync(join(repo, 'a.txt'), 'a staged\n'); git(repo, 'add', 'a.txt');           // staged
    writeFileSync(join(repo, 'b.txt'), 'b unstaged\n');                                     // unstaged
    writeFileSync(join(repo, 'loose.txt'), 'untracked\n');                                  // untracked
    mkdirSync(join(repo, 'build')); writeFileSync(join(repo, 'build/out.bin'), 'ignored\n');
    const status = git(repo, 'status', '--porcelain');
    const port = new LiveGitPort();
    const before = await port.checkpoint(repo, 'refs/planestro/checkpoints/TP-1/1/before');
    expect(git(repo, 'status', '--porcelain')).toBe(status);                                // the real index is untouched
    expect(git(repo, 'rev-parse', 'refs/planestro/checkpoints/TP-1/1/before').trim()).toBe(before.sha);
    expect(git(repo, 'show', `${before.tree}:loose.txt`)).toBe('untracked\n');
    expect(git(repo, 'show', `${before.index}:a.txt`)).toBe('a staged\n');
    expect(git(repo, 'show', `${before.index}:b.txt`)).toBe('b\n');
    expect(() => git(repo, 'show', `${before.tree}:build/out.bin`)).toThrow();
    await expect(port.checkpoint(repo, 'refs/planestro/checkpoints/TP-1/1/before')).rejects.toThrow();   // never overwritten

    // "a turn": a commit, an edit, a new file, a deletion
    writeFileSync(join(repo, 'c.txt'), 'c\n'); git(repo, 'add', 'c.txt'); git(repo, 'commit', '-q', '-m', 'turn');
    writeFileSync(join(repo, 'b.txt'), 'b by the turn\n'); writeFileSync(join(repo, 'new.txt'), 'n\n'); rmSync(join(repo, 'loose.txt'));
    const after = await port.checkpoint(repo, 'refs/planestro/checkpoints/TP-1/1/after');
    expect(await port.snapshot(repo)).toEqual({ head: after.head, index: after.index, tree: after.tree });
    const listed = await port.checkpoints(repo, 'refs/planestro/checkpoints/TP-1/');
    expect(listed.map((c) => c.ref).sort()).toEqual(['refs/planestro/checkpoints/TP-1/1/after', 'refs/planestro/checkpoints/TP-1/1/before']);
    expect(listed.find((c) => c.ref.endsWith('/before'))).toMatchObject({ sha: before.sha, head: before.head, index: before.index, tree: before.tree });
    const diff = await port.treeDiff(repo, before.tree, after.tree);
    expect(diff.files.map((f) => `${f.change} ${f.path}`).sort()).toEqual(['added c.txt', 'added new.txt', 'deleted loose.txt', 'modified b.txt']);
    expect(diff.patch).toContain('+b by the turn');

    await port.restoreSnapshot(repo, after, before);
    expect(await port.snapshot(repo)).toEqual({ head: before.head, index: before.index, tree: before.tree });
    expect(git(repo, 'status', '--porcelain')).toBe(status);
    expect(readFileSync(join(repo, 'loose.txt'), 'utf8')).toBe('untracked\n');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(existsSync(join(repo, 'c.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'build/out.bin'), 'utf8')).toBe('ignored\n');           // ignored files are never touched
    expect(git(repo, 'rev-parse', 'refs/planestro/checkpoints/TP-1/1/after').trim()).toBe(after.sha);   // the undone work is kept

    await port.deleteRef(repo, 'refs/planestro/checkpoints/TP-1/1/after', before.sha);    // leased: a different sha keeps it
    expect(refs(repo, 'refs/planestro/')).toHaveLength(2);
    await port.deleteRef(repo, 'refs/planestro/checkpoints/TP-1/1/after', after.sha);
    expect(refs(repo, 'refs/planestro/')).toEqual(['refs/planestro/checkpoints/TP-1/1/before']);
  });
});

/** A real code repo with a bare origin, an item IN_PROGRESS in its own worktree, and a worker whose turns run `work` in it. */
async function realSetup(work: (cwd: string, o: TurnOptions) => Promise<TurnResult | void>) {
  const { dataDir, codeRepo, root } = makeFixture();
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', origin);
  git(codeRepo, 'remote', 'add', 'origin', origin); git(codeRepo, 'push', '-q', 'origin', 'trunk'); git(codeRepo, 'fetch', '-q', 'origin');
  git(codeRepo, 'config', 'user.name', 't'); git(codeRepo, 'config', 'user.email', 't@t');
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(world);
  const claude: Ports['agents']['claude'] = {
    async runTurn(o) { const r = await work(o.cwd, o); return r ?? { sessionId: 's-1', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: 'done for now' }; },
    runCustomTurn: (o) => inner.runCustomTurn(o),
  };
  const ports: Ports = { mode: 'live', git: new LiveGitPort(), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const item = store.createItem({ title: 'Siren', description: 'x' });
  const rel = '.claude/worktrees/siren'; const branch = 'tp/siren';
  const cwd = (engine as any).absWorktree(rel) as string;
  git(codeRepo, 'worktree', 'add', '-q', '-b', branch, cwd, 'trunk');
  store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', worktree: rel, branch, session_id: 's-1' } }], 'engine');
  return { id: item.id, cwd, codeRepo, branch, store, engine };
}
const fmOf = (id: string) => store!.requireItem(id).file.frontmatter;
async function turnEnds(id: string) { await sleep(20); const t0 = Date.now(); while ((engine as any).jobs.has(id) || (engine as any).turns.has(id)) { if (Date.now() - t0 > 8000) throw new Error('turn did not end'); await sleep(20); } }

/** The turn writes, commits and leaves a mess; then it asks a question (parks), so nothing follows it. */
const messyTurn = async (cwd: string, o: TurnOptions) => {
  writeFileSync(join(cwd, 'README.md'), 'rewritten by the turn\n');
  writeFileSync(join(cwd, 'feature.ts'), 'export const x = 1;\n');
  git(cwd, 'add', 'feature.ts'); git(cwd, 'commit', '-q', '-m', 'the turn commits');
  writeFileSync(join(cwd, 'scratch.txt'), 'half done\n');
  await o.onQuestion([{ question: 'which way?' }]);
  return { sessionId: 's-1', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'question' as const };
};

describe('undo last turn (#234)', () => {
  it('a turn is bracketed by checkpoints; undo shows what it discards, restores the worktree, keeps the work under a ref, and refuses a second time', async () => {
    const s = await realSetup(messyTurn);
    writeFileSync(join(s.cwd, 'mine.txt'), 'uncommitted before the turn\n');
    const headBefore = git(s.cwd, 'rev-parse', 'HEAD').trim();
    await s.engine.message(s.id, 'go on');
    await turnEnds(s.id);
    expect(fmOf(s.id).awaiting).toBe('question');
    expect(refs(s.codeRepo, `refs/planestro/checkpoints/${s.id}/`).sort()).toEqual([`refs/planestro/checkpoints/${s.id}/1/after`, `refs/planestro/checkpoints/${s.id}/1/before`]);

    const preview = await s.engine.undoTurnPreview(s.id);
    expect(preview.refusal).toBeNull();
    expect(preview.turn).toBe(1);
    expect(preview.files!.map((f) => `${f.change} ${f.path}`).sort()).toEqual(['added feature.ts', 'added scratch.txt', 'modified README.md']);
    expect(preview.patch).toContain('+rewritten by the turn');
    expect(preview.commits).toContain('the turn commits');
    await expect(s.engine.undoTurn(s.id, 'f'.repeat(40))).rejects.toThrow(/changed since you looked/);   // the user confirms what they saw

    const said = await s.engine.undoTurn(s.id, preview.expect!);
    expect(said).toMatch(/undid turn 1/);
    expect(git(s.cwd, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(readFileSync(join(s.cwd, 'README.md'), 'utf8')).toBe('hi\n');
    expect(existsSync(join(s.cwd, 'feature.ts'))).toBe(false);
    expect(existsSync(join(s.cwd, 'scratch.txt'))).toBe(false);
    expect(readFileSync(join(s.cwd, 'mine.txt'), 'utf8')).toBe('uncommitted before the turn\n');   // what was there before the turn stays
    const undone = `refs/planestro/checkpoints/${s.id}/1/undone`;
    expect(git(s.codeRepo, 'show', `${undone}:scratch.txt`)).toBe('half done\n');                 // even the undo can be undone
    const activity = getSection(store!.requireItem(s.id).file, 'Activity');
    expect(activity).toContain(undone);
    expect(fmOf(s.id).op_data?.turn_undone).toMatchObject({ turn: 1 });

    expect((await s.engine.undoTurnPreview(s.id)).refusal).toMatch(/already undone/);
    await expect(s.engine.undoTurn(s.id, preview.expect!)).rejects.toThrow(/already undone/);
  });

  it('the next turn is told its last turn was undone, and its own checkpoints are the next number', async () => {
    const prompts: string[] = [];
    let n = 0;
    const s = await realSetup(async (cwd, o) => { prompts.push(o.prompt); if (n++ === 0) return messyTurn(cwd, o); });
    await s.engine.message(s.id, 'go on'); await turnEnds(s.id);
    await s.engine.undoTurn(s.id, (await s.engine.undoTurnPreview(s.id)).expect!);
    await s.engine.respond(s.id, { kind: 'question', answers: { 'which way?': 'left' } });
    await turnEnds(s.id);
    expect(prompts[1]).toMatch(/undid your last turn/);
    expect(fmOf(s.id).op_data?.turn_undone).toBeUndefined();
    expect(refs(s.codeRepo, `refs/planestro/checkpoints/${s.id}/2/`).sort()).toEqual([`refs/planestro/checkpoints/${s.id}/2/after`, `refs/planestro/checkpoints/${s.id}/2/before`]);
  });

  it('refuses, and discards nothing, when the worktree changed after the turn or the turn\'s work is on the remote', async () => {
    const s = await realSetup(messyTurn);
    await s.engine.message(s.id, 'go on'); await turnEnds(s.id);
    writeFileSync(join(s.cwd, 'scratch.txt'), 'edited by a person afterwards\n');
    expect((await s.engine.undoTurnPreview(s.id)).refusal).toMatch(/changed since turn 1 ended/);
    writeFileSync(join(s.cwd, 'scratch.txt'), 'half done\n');
    const ok = await s.engine.undoTurnPreview(s.id);
    expect(ok.refusal).toBeNull();
    git(s.cwd, 'push', '-q', 'origin', `HEAD:refs/heads/${s.branch}`);
    expect((await s.engine.undoTurnPreview(s.id)).refusal).toMatch(/on the remote/);
    await expect(s.engine.undoTurn(s.id, ok.expect!)).rejects.toThrow(/on the remote/);
    expect(readFileSync(join(s.cwd, 'scratch.txt'), 'utf8')).toBe('half done\n');
    expect(refs(s.codeRepo, `refs/planestro/checkpoints/${s.id}/1/undone`)).toEqual([]);
  });

  it('refuses while a turn is live on the item', async () => {
    let release!: () => void;
    const s = await realSetup(async () => { await new Promise<void>((r) => { release = r; }); });
    await s.engine.message(s.id, 'go on');
    const t0 = Date.now(); while (!release) { if (Date.now() - t0 > 5000) throw new Error('turn did not start'); await sleep(10); }
    try { expect((await s.engine.undoTurnPreview(s.id)).refusal).toMatch(/running/); }
    finally { release(); await turnEnds(s.id); }
  });
});

describe('checkpoint refs at FINISHED (#234)', () => {
  it('are recorded for each worker turn and dropped by the positive-evidence cleanup', async () => {
    const { dataDir, codeRepo } = makeFixture();
    mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
    delete process.env.PLANESTRO_DRYRUN_CI;
    store = await DataStore.open(dataDir, { emit: () => {} });
    const lines: string[] = [];
    const world = new FakeWorld((m) => lines.push(m), { 'origin/trunk': 'f'.repeat(40) });
    const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
    engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
    const item = store.createItem({ title: 'Add version flag', description: 'print the version' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    const t0 = Date.now(); while (store.requireItem(item.id).file.frontmatter.status !== 'PLAN_READY') { if (Date.now() - t0 > 5000) throw new Error('no plan'); await sleep(20); }
    await engine.approvePlan(item.id, 'ok');
    const t1 = Date.now(); while (store.requireItem(item.id).file.frontmatter.status !== 'FINISHED') { if (Date.now() - t1 > 8000) throw new Error('not finished'); await sleep(20); }
    expect(lines.some((l) => /^Would record checkpoint refs\/planestro\/checkpoints\/TP-1\/1\/before/.test(l))).toBe(true);
    expect(lines.some((l) => /^Would delete ref refs\/planestro\/checkpoints\/TP-1\/1\/after/.test(l))).toBe(true);
    expect([...world.refs.keys()].filter((r) => r.startsWith('refs/planestro/checkpoints/TP-1/'))).toEqual([]);
    expect(getSection(store.requireItem(item.id).file, 'Activity')).toMatch(/dropped 2 checkpoint refs/);
  });
});
