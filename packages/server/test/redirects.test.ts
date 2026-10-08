import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { makePolicy, sdkRules } from '../src/engine/policy.ts';
import { machinePolicyPath, readMachinePolicy, permissionRules } from '../src/machinePolicy.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { formatSuggestReport, suggestForStore, type RulingSource } from '../src/engine/allowSuggest.ts';
import { makeFixture, sleep } from './helpers.ts';

const bash = (command: string) => ({ tool: 'Bash', input: { command } });
const writePolicy = (h: string, text: string) => { mkdirSync(h, { recursive: true }); writeFileSync(machinePolicyPath(h), text); };
const cfg = { code_repo: { release_branch: undefined }, permissions: { allow: [], deny: [], redirect: [] } } as any;

describe('permission redirects (#203)', () => {
  it('are read from the machine policy and merged across layers, each with its message and where it came from', () => {
    const h = mkdtempSync(join(tmpdir(), 'planestro-home-'));
    writePolicy(h, 'redirect:\n  - rule: Bash(python3 *)\n    message: use the Edit tool\n');
    expect(readMachinePolicy(machinePolicyPath(h))).toMatchObject({ exists: true, allow: [], deny: [], redirect: [{ rule: 'Bash(python3 *)', message: 'use the Edit tool' }] });
    const r = permissionRules({
      machine: { allow: [], deny: [], redirect: [{ rule: 'Bash(python3 *)', message: 'use the Edit tool' }] },
      project: { allow: [], deny: [], redirect: [{ rule: 'Bash(python3 *)', message: 'another reason' }, { rule: 'pkill', message: 'stop only what you started' }] },
    });
    expect(r.redirect).toEqual([{ rule: 'Bash(python3 *)', message: 'use the Edit tool' }, { rule: 'pkill', message: 'stop only what you started' }]);
    expect(r.rules).toEqual([
      { rule: 'Bash(python3 *)', list: 'redirect', message: 'use the Edit tool', sources: ['machine', 'project'] },
      { rule: 'pkill', list: 'redirect', message: 'stop only what you started', sources: ['project'] },
    ]);
  });

  it('refuse a matching command up front with the redirect\'s message; a deny and the secret list still come first', () => {
    const policy = makePolicy(cfg, 'trunk', '/wt', {}, { deny: ['Bash(python3 -c*)'], redirect: [{ rule: 'Bash(python3 *)', message: 'use the Edit tool' }, { rule: 'pkill', message: 'stop only what you started' }] });
    expect(policy.deny(bash("python3 - <<'EOF'\nopen('a','w').write('x')\nEOF"))).toMatch(/use the Edit tool/);
    expect(policy.deny(bash('npm test && timeout 5 pkill -f vite'))).toMatch(/stop only what you started/);
    expect(policy.deny(bash('python3 -c 1'))).toMatch(/denied by planestro policy \(python3 -c\)/);
    expect(policy.deny(bash('python3 x.py > .env'))).toMatch(/secret/i);
    expect(policy.deny(bash('npm test'))).toBeNull();
    // A project's own redirects apply when no merged list is given.
    expect(makePolicy({ ...cfg, permissions: { ...cfg.permissions, redirect: [{ rule: 'pkill', message: 'no' }] } }, 'trunk', '/wt').deny(bash('pkill x'))).toMatch(/no/);
  });

  it('keep the SDK from pre-approving what they cover', () => {
    expect(sdkRules(['Bash(python3 *)', 'Bash(npm test*)'], { deny: [], redirect: [{ rule: 'Bash(python3 *)', message: 'm' }] })).toEqual(['Bash(npm test*)']);
  });
});

describe('redirect candidates from permissions suggest (#203)', () => {
  const entry = (i: number) => ({ ts: `2026-10-0${1 + (i % 7)}T10:00:00-04:00`, type: 'permission.answered', actor: 'orchestrator', item: `TP-${(i % 3) + 1}`, data: { tool: 'Bash', decision: 'deny', command: "python3 - <<'EOF'\nopen('a','w').write('x')\nEOF", reason: 'use the Edit tool' } });
  const source = (redirect: { rule: string; message: string }[]): RulingSource => ({
    listItems: () => [], codeRepoPath: () => '/repo', worktreesRoot: () => '/repo/.claude/worktrees',
    journal: { read: (o) => [4, 5, 6].map(entry).filter((e) => !o?.type || e.type === o.type) as any },
    config: { permissions: { allow: [], deny: [], redirect: [] }, code_repo: { default_branch: 'trunk' } } as any,
    permissionRules: () => ({ allow: [], deny: [], redirect }),
  });

  it('say how to install one, and are not offered again once one covers them', () => {
    const rep = suggestForStore(source([]), { minApprovals: 3, minItems: 2 });
    expect(rep.redirects.map((x) => x.rule)).toEqual(['Bash(python3)']);
    expect(rep.redirects[0].snippet).toBe('permissions:\n  redirect:\n    - rule: Bash(python3)\n      message: use the Edit tool\n');
    expect(formatSuggestReport(rep)).toMatch(/permissions:\n\s+redirect:\n\s+- rule: Bash\(python3\)/);
    expect(suggestForStore(source([{ rule: 'Bash(python3 *)', message: 'use the Edit tool' }]), { minApprovals: 3, minItems: 2 }).redirects).toEqual([]);
  });
});

describe('redirects in a running project (#203)', () => {
  let store: DataStore | undefined; let engine: LiveEngine | undefined;
  afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

  it('a worker\'s matching call is refused with the message, never parked, and the state lists the redirect', async () => {
    const { dataDir, codeRepo } = makeFixture();
    mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
    const file = join(dataDir, 'planestro.yml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n').replace(/^permissions:\n(  .*\n)*/m, 'permissions:\n  allow:\n    - Bash(pkill *)\n  deny: []\n  redirect:\n    - rule: Bash(pkill *)\n      message: stop only what you started\n'));
    writePolicy(process.env.PLANESTRO_HOME!, 'allow: []\ndeny: []\n');
    store = await DataStore.open(dataDir, {});
    const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const seen: { allowed: string[]; answer: { action: string; message?: string } }[] = [];
    const runTurn = async (o: TurnOptions): Promise<TurnResult> => {
      if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
      seen.push({ allowed: o.allowedTools, answer: await o.onPermission(bash('pkill -f vite')) as any });
      return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
    };
    const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: { runTurn } as any } };
    engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
    const item = store.createItem({ title: 'P', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    const t0 = Date.now();
    while (store.getItem(item.id)!.file.frontmatter.status !== 'PLAN_READY') { if (Date.now() - t0 > 4000) throw new Error('timeout'); await sleep(20); }
    await engine.approvePlan(item.id);
    while (!seen.length) { if (Date.now() - t0 > 8000) throw new Error('timeout'); await sleep(20); }
    expect(seen[0].answer.action).toBe('deny');
    expect(seen[0].answer.message).toMatch(/stop only what you started/);
    expect(seen[0].allowed).not.toContain('Bash(pkill *)');
    expect(store.journal.read({ item: item.id, type: 'permission.parked' })).toEqual([]);
    const state = await (await apiRoutes(store, engine).request('/state')).json();
    expect(state.permissions.rules).toEqual(expect.arrayContaining([{ rule: 'Bash(pkill *)', list: 'redirect', message: 'stop only what you started', sources: ['project'] }]));
  });
});
