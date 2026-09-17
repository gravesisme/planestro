#!/usr/bin/env -S npx tsx
/**
 * Live acceptance for the Codex runner: the REAL engine, REAL git (a local bare repo stands in for
 * the remote) and the REAL Codex CLI — only GitHub and the Claude planner are fakes, because neither
 * is what is being proven here. Spends Codex quota; never touches a real repository or remote.
 *
 *   npm run spike:codex-live -- item      one art item: plan → Codex draws and commits → PR → CI → review hold → approve → merged
 *   npm run spike:codex-live -- review    the same, sent back once with a note before approval
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
  override async mergePr(r: string, number: number, opts: { deleteBranch: boolean }) {
    const pr = this.world.prs.get(number)!;
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'checkout', '-q', pr.baseRefName); git(repo, 'merge', '-q', '--no-ff', '-m', `Merge PR #${number}`, `origin/${pr.headRefName}`); git(repo, 'push', '-q', 'origin', pr.baseRefName);
    await super.mergePr(r, number, opts);
  }
}

const store = await DataStore.open(dataDir);
const world = new FakeWorld(() => {}, {});
const ports: Ports = { mode: 'live', git: new LiveGitPort(), gh: new LocalMergeGh(world), proc: new LiveProcPort(), agents: { claude: new DryRunClaudePort(world), codex: new LiveCodexPort() } };
const engine = new LiveEngine(store, ports, (e) => { if (e.type === 'session.output') console.log(`    │ ${String((e as any).text).split('\n')[0].slice(0, 150)}`); if (e.type === 'engine.log') log(`engine: ${(e as any).message}`); }, { tickMs: 500, sleep: (ms) => sleep(Math.min(ms, 300)) }); // the fake CI needs no real waiting
const fm = (id: string) => store.getItem(id)!.file.frontmatter;
async function until(what: string, pred: () => boolean, ms = 15 * 60_000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`); await sleep(500); }
  log(`✓ ${what}`);
}
const failIfBlocked = (id: string) => { if (fm(id).blocked) throw new Error(`${id} blocked (${fm(id).blocked_reason}): ${store.getItem(id)!.file.sections.find((s) => s.title === 'Activity')!.body.split('\n').slice(-2).join(' | ')}`); return false; };
const onMain = (path: string) => { git(repo, 'fetch', '-q', 'origin'); try { return execFileSync('git', ['-C', repo, 'cat-file', '-s', `origin/main:${path}`], { encoding: 'utf8' }).trim(); } catch { return undefined; } };

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
    await (engine as any).requestArtChanges(item.id, 'Make the tile background a lighter, brighter blue so the wave has less contrast with it. Keep everything else.');
    await until('sent back; Codex revised on the same thread and it is parked for review again', () => failIfBlocked(item.id) || (fm(item.id).awaiting === 'review' && (fm(item.id).agent_turns ?? 0) >= 2));
  }
  await engine.releaseHold(item.id, 'approved in the live acceptance run');
  await until('merged and cleaned up', () => failIfBlocked(item.id) || fm(item.id).status === 'FINISHED');
  const size = onMain('assets/icon.png');
  if (!size) throw new Error('assets/icon.png is not on origin/main');
  log(`✓ origin/main has assets/icon.png (${size} bytes); worktrees left: ${git(repo, 'worktree', 'list').trim().split('\n').length - 1}`);
  return item.id;
}

try {
  if (scenario === 'item') await artItem(false);
  else if (scenario === 'review') await artItem(true);
  else throw new Error(`unknown scenario ${scenario}`);
  log(`PASS (${scenario}) — everything is under ${root}`);
} catch (e) {
  log(`FAIL (${scenario}): ${(e as Error).message}\n  inspect ${root}`);
  process.exitCode = 1;
} finally {
  await engine.stop(); store.close();
  if (existsSync(join(repo, 'assets/icon.png'))) log(`  open ${join(repo, 'assets/icon.png')}`);
}
