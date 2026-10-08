import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { makePolicy, sdkRules } from '../src/engine/policy.ts';
import { machinePolicyPath, readMachinePolicy, permissionRules } from '../src/machinePolicy.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { makeFixture, sleep } from './helpers.ts';

const bash = (command: string) => ({ tool: 'Bash', input: { command } });
const home = () => mkdtempSync(join(tmpdir(), 'planestro-home-'));
const writePolicy = (h: string, text: string) => { mkdirSync(h, { recursive: true }); writeFileSync(machinePolicyPath(h), text); };

describe('the machine policy file (#229)', () => {
  it('lives in the planestro home, which tests point away from the real one', () => {
    expect(machinePolicyPath('/x/.planestro')).toBe('/x/.planestro/policy.yml');
    expect(process.env.PLANESTRO_HOME).toBeTruthy();
    expect(machinePolicyPath()).toBe(join(process.env.PLANESTRO_HOME!, 'policy.yml'));
  });

  it('reads allow and deny, and is empty when there is no file', () => {
    const h = home();
    expect(readMachinePolicy(machinePolicyPath(h))).toMatchObject({ exists: false, allow: [], deny: [] });
    writePolicy(h, 'allow:\n  - Bash(npm test*)\ndeny:\n  - Bash(npm publish *)\n');
    expect(readMachinePolicy(machinePolicyPath(h))).toMatchObject({ exists: true, allow: ['Bash(npm test*)'], deny: ['Bash(npm publish *)'] });
  });

  it('says what is wrong with a file it cannot read', () => {
    const h = home();
    writePolicy(h, 'allow: Bash(npm test*)\n');
    expect(readMachinePolicy(machinePolicyPath(h)).error).toMatch(/allow/);
  });

  it('merges machine, project and local: every list unioned, each rule with where it came from', () => {
    const r = permissionRules({
      machine: { allow: ['Bash(npm test*)'], deny: ['Bash(git status*)'] },
      project: { allow: ['Bash(git status*)', 'Bash(npm test*)'], deny: [] },
      local: { allow: ['Bash(make*)'], deny: ['rm -rf'] },
    });
    expect(r.allow).toEqual(['Bash(npm test*)', 'Bash(git status*)', 'Bash(make*)']);
    expect(r.deny).toEqual(['Bash(git status*)', 'rm -rf']);
    expect(r.rules).toEqual([
      { rule: 'Bash(npm test*)', list: 'allow', sources: ['machine', 'project'] },
      { rule: 'Bash(git status*)', list: 'deny', sources: ['machine'] },
      { rule: 'Bash(git status*)', list: 'allow', sources: ['project'] },
      { rule: 'Bash(make*)', list: 'allow', sources: ['local'] },
      { rule: 'rm -rf', list: 'deny', sources: ['local'] },
    ]);
  });

  it('a deny anywhere wins: the SDK never pre-approves what a deny covers, and the policy refuses it', () => {
    const deny = ['Bash(git status*)', 'npm publish'];
    expect(sdkRules(['Bash(git status*)', 'Bash(npm *)', 'Bash(npm test*)', 'Read'], deny)).toEqual(['Bash(npm test*)', 'Read']);
    const cfg = { code_repo: { release_branch: undefined }, permissions: { allow: ['Bash(git status*)'], deny: [] } } as any;
    const policy = makePolicy(cfg, 'trunk', '/wt', {}, deny);
    expect(policy.deny(bash('git status'))).toMatch(/denied by planestro policy \(git status\)/);
    expect(policy.deny(bash('npm publish --tag x'))).toMatch(/npm publish/);
    expect(policy.deny(bash('npm test'))).toBeNull();
  });
});

describe('the machine policy in a running project (#229)', () => {
  let store: DataStore | undefined; let engine: LiveEngine | undefined;
  afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

  async function setup(runTurn: (o: TurnOptions) => Promise<TurnResult>) {
    const { dataDir, codeRepo } = makeFixture();
    mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n').replace(/^permissions:\n(  .*\n)*/m, 'permissions:\n  allow:\n    - Bash(node -e*)\n  deny: []\n'));
    writePolicy(process.env.PLANESTRO_HOME!, 'allow:\n  - Bash(make lint*)\ndeny:\n  - Bash(node -e*)\n');
    store = await DataStore.open(dataDir, {});
    const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: { runTurn } as any } };
    engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
    return { store, engine };
  }

  it('a machine deny beats a project allow, and a machine allow applies in every project', async () => {
    const seen: { allowed: string[]; node: string; make: string }[] = [];
    const s = await setup(async (o) => {
      if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
      seen.push({ allowed: o.allowedTools, node: (await o.onPermission(bash('node -e 1'))).action, make: (await o.onPermission(bash('make lint'))).action });
      return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'permission' };
    });
    expect(s.store.config.permissions.allow).toContain('Bash(node -e*)');
    const item = s.store.createItem({ title: 'P', description: 'x' });
    s.store.transition(item.id, 'QUEUED', 'user');
    await s.engine.start();
    const t0 = Date.now();
    while (s.store.getItem(item.id)!.file.frontmatter.status !== 'PLAN_READY') { if (Date.now() - t0 > 4000) throw new Error('timeout'); await sleep(20); }
    await s.engine.approvePlan(item.id);
    while (!seen.length) { if (Date.now() - t0 > 8000) throw new Error('timeout'); await sleep(20); }
    expect(seen[0].node).toBe('deny');
    expect(seen[0].make).toBe('allow');
    expect(seen[0].allowed).toContain('Bash(make lint*)');
    expect(seen[0].allowed).not.toContain('Bash(node -e*)');
  });

  it('the state says where each rule came from, and picks up an edit to the file', async () => {
    const s = await setup(async () => ({ sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' }));
    const app = apiRoutes(s.store, s.engine);
    const state = async () => (await (await app.request('/state')).json()).permissions;
    let p = await state();
    expect(p.machine_path).toBe(machinePolicyPath());
    expect(p.rules).toEqual(expect.arrayContaining([
      { rule: 'Bash(make lint*)', list: 'allow', sources: ['machine'] },
      { rule: 'Bash(node -e*)', list: 'deny', sources: ['machine'] },
      { rule: 'Bash(node -e*)', list: 'allow', sources: ['project'] },
    ]));
    writePolicy(process.env.PLANESTRO_HOME!, 'allow: []\ndeny: []\n');
    const later = new Date(Date.now() + 5000); utimesSync(machinePolicyPath(), later, later);
    p = await state();
    expect(p.rules.filter((r: { sources: string[] }) => r.sources.includes('machine'))).toEqual([]);
    // A file broken while running keeps the last rules it read, and says so.
    writePolicy(process.env.PLANESTRO_HOME!, 'deny: [Bash(node -e*)]\n');
    const later2 = new Date(Date.now() + 10000); utimesSync(machinePolicyPath(), later2, later2);
    expect((await state()).rules).toEqual(expect.arrayContaining([{ rule: 'Bash(node -e*)', list: 'deny', sources: ['machine'] }]));
    writePolicy(process.env.PLANESTRO_HOME!, 'deny: Bash(node -e*)\n');
    const later3 = new Date(Date.now() + 15000); utimesSync(machinePolicyPath(), later3, later3);
    p = await state();
    expect(p.machine_error).toMatch(/deny/);
    expect(p.rules).toEqual(expect.arrayContaining([{ rule: 'Bash(node -e*)', list: 'deny', sources: ['machine'] }]));
  });
});
