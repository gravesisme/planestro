#!/usr/bin/env -S npx tsx
/**
 * Live acceptance for the Codex runner: the REAL engine, REAL git (a local bare repo stands in for
 * the remote) and the REAL Codex CLI — only GitHub and the Claude planner are fakes, because neither
 * is what is being proven here. Spends Codex quota; never touches a real repository or remote.
 *
 *   npm run spike:codex-live -- item      one art item: plan → Codex draws and commits → PR → CI → review hold → approve → merged
 *   npm run spike:codex-live -- review    the same, sent back once with a note before approval
 *   npm run spike:codex-live -- epic      a planned epic: two art children drawn by Codex block a (stand-in) Claude logic child
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore } from '../packages/server/src/store/DataStore.ts';
import { LiveEngine } from '../packages/server/src/engine/LiveEngine.ts';
import { initDataDir } from '../packages/server/src/init.ts';
import { LiveGitPort, LiveProcPort } from '../packages/server/src/engine/live-ports.ts';
import { FakeWorld, DryRunGhPort, DryRunClaudePort } from '../packages/server/src/engine/dryrun-ports.ts';
import { LiveCodexPort } from '../packages/server/src/engine/sessions/LiveCodexPort.ts';
import type { Ports } from '../packages/server/src/engine/ports.ts';

const scenario = process.argv[2] ?? 'item';
// realpath: git reports worktrees by their real path, and macOS's tmpdir is a symlink
const root = realpathSync(mkdtempSync(join(tmpdir(), 'planestro-live-')));
process.env.PLANESTRO_HOME = join(root, 'home');
const remote = join(root, 'origin.git');
const repo = join(root, 'tidepool');
const dataDir = join(root, 'planning');
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=planestro live', '-c', 'user.email=live@planestro.invalid', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

// ---- a real repository with a real (local) remote
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'README.md'), '# tidepool\n\nTide times from the command line.\n');
writeFileSync(join(repo, 'AGENTS.md'), '# Conventions\n\n- Art lives under `assets/`. PNG, transparent background unless the task says otherwise.\n- Commit messages: imperative, one line.\n');
writeFileSync(join(repo, 'src/cli.js'), "console.log('tidepool');\n");
git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'planestro live'); git(repo, 'config', 'user.email', 'live@planestro.invalid');
git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'tidepool'); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-q', '-u', 'origin', 'main');
mkdirSync(dataDir); git(dataDir, 'init', '-q', '-b', 'planning'); git(dataDir, 'config', 'user.name', 'planestro live'); git(dataDir, 'config', 'user.email', 'live@planestro.invalid');
initDataDir({ dataDir, codeRepo: repo, name: 'tidepool live', prefix: 'TD', defaultBranch: 'main', github: 'example/tidepool', gdignore: false, register: false, commit: true });
const cfg = join(dataDir, 'planestro.yml');
writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('models:\n', 'models:\n  - { id: codex-art, label: Codex Art, runner: codex, hold_for_review: true, description: "All raster art: icons, sprites, illustrations. The Claude models cannot generate images." }\n'));

// ---- GitHub is faked, but a "merge" really merges, so cleanup's reachability proof is real
class LocalMergeGh extends DryRunGhPort {
  constructor(private readonly world: FakeWorld) { super(world); }
  /** The engine compares the PR's head with the commit it pushed; with real git that has to be the real remote sha. */
  override async prView(r: string, number: number) {
    const pr = await super.prView(r, number);
    const sha = git(repo, 'ls-remote', 'origin', `refs/heads/${pr.headRefName}`).split('\t')[0]?.trim();
    return sha ? { ...pr, headRefOid: sha } : pr;
  }
  override async mergePr(r: string, number: number, opts: { headSha: string }) {
    const pr = this.world.prs.get(number)!;
    if ((await this.prView(r, number)).headRefOid !== opts.headSha) return 'head_moved' as const;
    // in a scratch clone, so the engine's own worktrees and checkouts are never disturbed
    const scratch = mkdtempSync(join(root, 'merge-'));
    execFileSync('git', ['clone', '-q', remote, scratch]);
    git(scratch, 'checkout', '-q', pr.baseRefName); git(scratch, 'merge', '-q', '--no-ff', '-m', `Merge PR #${number}`, `origin/${pr.headRefName}`); git(scratch, 'push', '-q', 'origin', pr.baseRefName);
    pr.headRefOid = opts.headSha;
    return super.mergePr(r, number, opts);
  }
}

/** The Claude side is not under test here, but with real git its "work" has to be a real commit. */
class CommittingClaude extends DryRunClaudePort {
  override async runTurn(o: Parameters<DryRunClaudePort['runTurn']>[0]) {
    if (o.phase !== 'plan') {
      const seen = ['assets/icon.png', 'assets/header.png'].filter((p) => existsSync(join(o.cwd, p)));
      writeFileSync(join(o.cwd, `src/${o.itemId.toLowerCase()}.js`), `// ${o.itemId}: written by the stand-in implementer\n// art present in my base: ${seen.join(', ') || 'NONE'}\n`);
      git(o.cwd, 'add', '-A'); git(o.cwd, 'commit', '-q', '-m', `${o.itemId}: stand-in implementation`);
      deliveredSeen.set(o.itemId, { files: seen, prompt: o.prompt });
    }
    return super.runTurn(o);
  }
}
const deliveredSeen = new Map<string, { files: string[]; prompt: string }>();

const store = await DataStore.open(dataDir);
const world = new FakeWorld(() => {}, {});
const ports: Ports = { mode: 'live', git: new LiveGitPort(), gh: new LocalMergeGh(world), proc: new LiveProcPort(), agents: { claude: new CommittingClaude(world), codex: new LiveCodexPort() } };
const engine = new LiveEngine(store, ports, (e) => { if (e.type === 'session.output') console.log(`    │ ${String((e as any).text).split('\n')[0].slice(0, 150)}`); if (e.type === 'engine.log') log(`engine: ${(e as any).message}`); }, { tickMs: 500, sleep: (ms) => sleep(Math.min(ms, 300)) }); // the fake CI needs no real waiting
const fm = (id: string) => store.getItem(id)!.file.frontmatter;
async function until(what: string, pred: () => boolean, ms = 15 * 60_000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`); await sleep(500); }
  log(`✓ ${what}`);
}
const failIfBlocked = (id: string) => { if (fm(id).blocked) throw new Error(`${id} blocked (${fm(id).blocked_reason}): ${store.getItem(id)!.file.sections.find((s) => s.title === 'Activity')!.body.split('\n').slice(-2).join(' | ')}`); return false; };
const onMain = (path: string) => { git(repo, 'fetch', '-q', 'origin'); try { return execFileSync('git', ['-C', repo, 'cat-file', '-s', `origin/main:${path}`], { encoding: 'utf8' }).trim(); } catch { return undefined; } };

const before0Ref: { v: Buffer | null } = { v: null };
async function artItem(sendBack: boolean) {
  const item = store.createItem({ title: 'App icon: a teal wave', implementer: 'codex-art', description: 'Generate the app icon and save it as `assets/icon.png`: a single stylised teal ocean wave on a dark navy rounded-square tile, flat vector look, transparent outside the tile, 1024×1024. Commit it.' });
  store.transition(item.id, 'QUEUED', 'user');
  await engine.start();
  await until('planned by the (fake) Claude planner', () => failIfBlocked(item.id) || fm(item.id).status === 'PLAN_READY');
  await engine.approvePlan(item.id);
  log('approved — the real Codex CLI now runs in the worktree');
  await until('Codex committed, PR opened, CI green, parked for review', () => failIfBlocked(item.id) || fm(item.id).awaiting === 'review');
  log(`  codex thread ${fm(item.id).agent_sessions?.codex} · ${fm(item.id).agent_turns} turn(s) · ${fm(item.id).tokens} tokens · PR #${fm(item.id).pr}`);
  if (sendBack) {
    log(`  reviewing: ${(await engine.reviewImages(item.id)).map((i) => `${i.path} ${i.width}x${i.height} ${i.bytes}B`).join(', ')}`);
    before0Ref.v = await engine.reviewImage(item.id, 'assets/icon.png', 'after');
    await engine.requestReviewChanges(item.id, 'Make the tile background a lighter, brighter blue so the wave has less contrast with it. Keep everything else.');
    await until('sent back; Codex revised on the same thread and it is parked for review again', () => failIfBlocked(item.id) || (fm(item.id).awaiting === 'review' && (fm(item.id).agent_turns ?? 0) >= 2));
  }
  if (sendBack) { const after = await engine.reviewImage(item.id, 'assets/icon.png', 'after'); log(`  revision differs from the first delivery: ${Boolean(before0Ref.v && after && !after.equals(before0Ref.v))}`); }
  await engine.releaseHold(item.id, 'approved in the live acceptance run');
  await until('merged and cleaned up', () => failIfBlocked(item.id) || fm(item.id).status === 'FINISHED');
  const size = onMain('assets/icon.png');
  if (!size) throw new Error('assets/icon.png is not on origin/main');
  log(`✓ origin/main has assets/icon.png (${size} bytes); worktrees left: ${git(repo, 'worktree', 'list').trim().split('\n').length - 1}`);
  return item.id;
}

/** The planner is the dry-run one (a canned two-art / two-logic breakdown); the two art children are drawn by the real Codex CLI. */
async function mixedEpic() {
  const epic = store.createItem({ title: 'Tide chart view', kind: 'epic', description: 'A chart of the day\'s tide for the CLI\'s HTML report, with its own icon and header illustration. Teal on dark navy, flat vector look.' });
  await engine.start();
  await engine.planEpic(epic.id);
  await until('the planner proposed a breakdown', () => failIfBlocked(epic.id) || fm(epic.id).awaiting === 'breakdown_approval');
  const proposal = fm(epic.id).awaiting_data!.children as { title: string; implementer: string; depends_on?: number[] }[];
  log(`  proposed: ${proposal.map((c, i) => `#${i} ${c.title} → ${c.implementer}${c.depends_on?.length ? ` (waits on ${c.depends_on.join(',')})` : ''}`).join(' | ')}`);
  // What the user does in the breakdown editor: the canned proposal says "matching the existing art", and this
  // repository has none — so give the artist a real brief. (Left as proposed, Codex correctly asks for a reference.)
  const briefs = [
    'Draw the icon for the tide chart view and save it as `assets/icon.png`: a single stylised teal wave crest inside a circle, flat vector look, teal (#19d3c5) on dark navy (#0b2545), transparent outside the circle, 512×512 PNG. There is no existing art to match: this sets the style. Commit it.',
    'Draw the header illustration for the tide chart view and save it as `assets/header.png`: a wide, calm seascape band — layered teal waves under a dark navy sky with a small pale moon, flat vector look, the same teal (#19d3c5) and navy (#0b2545) as the icon, 1200×400 PNG, no text. There is no existing art to match. Commit it.',
  ];
  const edited = (proposal as any[]).map((c, i) => i < 2 ? { ...c, description: briefs[i] } : c);
  const [icon, header, code, docs] = await engine.approveBreakdown(epic.id, edited);
  const ok = (id: string) => failIfBlocked(id);
  for (const art of [icon, header]) { await until(`${art} planned`, () => ok(art) || fm(art).status === 'PLAN_READY'); await engine.approvePlan(art); }
  log('both art plans approved — the real Codex CLI draws them (one at a time: runner_limits.codex is 1)');
  await until('both art children drawn by Codex, through CI, parked for review', () => ok(icon) || ok(header) || (fm(icon).awaiting === 'review' && fm(header).awaiting === 'review'), 25 * 60_000);
  for (const art of [icon, header]) log(`  ${art}: ${(await engine.reviewImages(art)).map((i) => `${i.path} ${i.width}x${i.height}`).join(', ')}`);
  if (fm(code).status !== 'QUEUED' || deliveredSeen.has(code)) throw new Error('the logic child started before the art merged');
  log('  ✓ the logic child is still QUEUED: it waits on the art');
  await engine.releaseHold(icon); await engine.releaseHold(header);
  await until('art merged into the epic branch', () => ok(icon) || ok(header) || (fm(icon).status === 'FINISHED' && fm(header).status === 'FINISHED'));
  await until('logic child planned — after the art', () => ok(code) || fm(code).status === 'PLAN_READY');
  await engine.approvePlan(code);
  await until('logic child merged', () => ok(code) || fm(code).status === 'FINISHED');
  const saw = deliveredSeen.get(code)!;
  if (saw.files.length !== 2) throw new Error(`the logic child's worktree did not contain the art: saw ${saw.files.join(', ') || 'nothing'}`);
  if (!saw.prompt.includes('assets/icon.png') || !saw.prompt.includes('merged into your base branch')) throw new Error('the logic child was not told what its dependencies delivered');
  log(`  ✓ the logic child's worktree had ${saw.files.join(' and ')}, and its prompt listed them as delivered`);
  await until('docs child planned', () => ok(docs) || fm(docs).status === 'PLAN_READY'); await engine.approvePlan(docs);
  await until('epic PR opened and merged; epic finished', () => ok(docs) || ok(epic.id) || fm(epic.id).status === 'FINISHED');
  for (const p of ['assets/icon.png', 'assets/header.png', `src/${code.toLowerCase()}.js`]) if (!onMain(p)) throw new Error(`${p} is not on origin/main`);
  log('✓ origin/main has the icon, the header and the code that uses them');
}

try {
  if (scenario === 'item') await artItem(false);
  else if (scenario === 'review') await artItem(true);
  else if (scenario === 'epic') await mixedEpic();
  else throw new Error(`unknown scenario ${scenario}`);
  log(`PASS (${scenario}) — everything is under ${root}`);
} catch (e) {
  log(`FAIL (${scenario}): ${(e as Error).message}\n  inspect ${root}`);
  process.exitCode = 1;
} finally {
  await engine.stop(); store.close();
  if (existsSync(join(repo, 'assets/icon.png'))) log(`  open ${join(repo, 'assets/icon.png')}`);
}
