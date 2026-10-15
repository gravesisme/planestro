import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight, formatPreflight, savePreflight, readPreflight, runnersInUse, type PreflightEnv, type PreflightInput } from '../src/preflight.ts';
import { readConfig } from '../src/config.ts';
import { makeFixture } from './helpers.ts';

// #337: what a first task would stop on, found up front with fakes for every tool; no model, no session, no network unless asked.

type Reply = { code: number; stdout?: string; stderr?: string };
/** A ready machine; `over` replaces the reply to one command line (`git config user.email`). */
function fakeEnv(over: Record<string, Reply> = {}, opts: { node?: string; missing?: string[]; portFree?: boolean } = {}) {
  const calls: string[] = [];
  const ready: Record<string, Reply> = {
    'git --version': { code: 0, stdout: 'git version 2.50.0' },
    'git config user.name': { code: 0, stdout: 'Ada' },
    'git config user.email': { code: 0, stdout: 'ada@example.com' },
    'git rev-parse --verify HEAD': { code: 0, stdout: 'abcdef1234567890' },
    'git remote get-url origin': { code: 0, stdout: 'git@github.com:acme/repo.git' },
    'git ls-remote --exit-code --heads origin trunk': { code: 0, stdout: 'abc refs/heads/trunk' },
    'git remote': { code: 0, stdout: 'origin' },
    'gh --version': { code: 0, stdout: 'gh version 2.80.0' },
    'gh auth status --hostname github.com': { code: 0, stdout: 'Logged in' },
    'claude --version': { code: 0, stdout: '2.1.300 (Claude Code)' },
    'claude auth status': { code: 0, stdout: '{"loggedIn": true}' },
    'codex --version': { code: 0, stdout: 'codex-cli 0.50.0' },
    'codex login status': { code: 0, stdout: 'Logged in using ChatGPT' },
  };
  const env: PreflightEnv = {
    run: async (cmd, args, o) => {
      const line = [cmd, ...args].join(' ');
      calls.push(`${line}${o?.env ? ` ${JSON.stringify(o.env)}` : ''}`);
      const r = over[line] ?? ready[line] ?? { code: 127, stderr: `${cmd}: not found` };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    exists: (p) => !(opts.missing ?? []).some((m) => p === m || p.endsWith(`/${m}`)),
    portFree: async () => opts.portFree ?? true,
    nodeVersion: opts.node ?? '24.11.1',
  };
  return { env, calls };
}
const input = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  dataDir: '/p/planning', codeRepo: '/p/code', defaultBranch: 'trunk', github: 'acme/repo', runners: ['claude'], accounts: [],
  port: 4300, host: '127.0.0.1', ownServerOnPort: false, afterWorktreeCreate: ['npm ci'], ...over,
});
const failing = (r: Awaited<ReturnType<typeof preflight>>) => r.checks.filter((c) => c.status === 'fail').map((c) => c.id);
const check = (r: Awaited<ReturnType<typeof preflight>>, id: string) => r.checks.find((c) => c.id === id)!;

describe('planestro check --preflight (#337)', () => {
  it('a ready machine passes, and runs no session: only version and status commands', async () => {
    const { env, calls } = fakeEnv();
    const r = await preflight(input({ runners: ['claude', 'codex'] }), env);
    expect(failing(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(formatPreflight(r).at(-1)).toBe('ready');
    // Nothing that could start a model: only --version, auth/login status, git reads, gh auth status.
    for (const c of calls) expect(c).toMatch(/^(git (--version|config|rev-parse|remote|ls-remote)|gh (--version|auth status)|claude (--version|auth status)|codex (--version|login status))/);
  });

  const cases: [string, Record<string, Reply>, Parameters<typeof fakeEnv>[1], Partial<PreflightInput>, string, RegExp][] = [
    ['an old Node', {}, { node: '22.3.0' }, {}, 'node', /nvm install 24/],
    ['no git', { 'git --version': { code: -1, stderr: 'ENOENT' } }, {}, {}, 'git', /install git/],
    ['no git identity', { 'git config user.email': { code: 1 } }, {}, {}, 'git_identity', /git config --global user\.email/],
    ['no code repository', {}, { missing: ['/p/code'] }, {}, 'code_repo', /code_repo\.path/],
    ['a code repository with no commit', { 'git rev-parse --verify HEAD': { code: 128 } }, {}, { dataDir: '/p/code' }, 'code_repo', /git init/],
    ['no remote', { 'git remote get-url origin': { code: 2 } }, {}, {}, 'code_remote', /git remote add origin/],
    ['no base branch on the remote', { 'git ls-remote --exit-code --heads origin trunk': { code: 2 } }, {}, {}, 'base_branch', /git push -u origin trunk/],
    ['no gh', { 'gh --version': { code: -1 } }, {}, {}, 'gh', /cli\.github\.com/],
    ['gh signed out', { 'gh auth status --hostname github.com': { code: 1, stderr: 'You are not logged into any GitHub hosts' } }, {}, {}, 'gh', /gh auth login/],
    ['no claude', { 'claude --version': { code: -1 } }, {}, {}, 'claude', /install Claude Code/],
    ['claude signed out', { 'claude auth status': { code: 1, stdout: '{"loggedIn": false}' } }, {}, {}, 'claude', /\/login/],
    ['codex signed out', { 'codex login status': { code: 1 } }, {}, { runners: ['codex'] }, 'codex', /codex login/],
    ['an account home that is missing', {}, { missing: ['/h/work'] }, { accounts: [{ name: 'work', runner: 'claude', home: '/h/work' }] }, 'account:work', /mkdir -p \/h\/work && CLAUDE_CONFIG_DIR=\/h\/work claude/],
    ['a planning dir that is not a repository', { 'git rev-parse --verify HEAD': { code: 128 } }, {}, {}, 'data_repo', /cd \/p\/planning && git init/],
    ['a port held by something else', {}, { portFree: false }, {}, 'port', /--port/],
  ];
  for (const [what, over, opts, inp, id, repair] of cases) {
    it(`names ${what} and its repair`, async () => {
      const { env } = fakeEnv(over, opts);
      const r = await preflight(input(inp), env);
      expect(r.ok).toBe(false);
      expect(failing(r)).toContain(id);
      expect(check(r, id).repair).toMatch(repair);
      expect(formatPreflight(r).join('\n')).toMatch(/problems? to fix before the first task/);
    });
  }

  it('an account is checked signed in with its own home', async () => {
    const { env, calls } = fakeEnv({ 'codex login status': { code: 1 } });
    const r = await preflight(input({ runners: ['claude'], accounts: [{ name: 'night', runner: 'codex', home: '/h/night' }] }), env);
    expect(check(r, 'account:night')).toMatchObject({ status: 'fail', repair: 'CODEX_HOME=/h/night codex login' });
    expect(calls).toContain('codex login status {"CODEX_HOME":"/h/night"}');
  });

  it('warnings that do not fail: no planning remote, a lockfile with no setup hook', async () => {
    const { env } = fakeEnv({ 'git remote': { code: 0, stdout: '' } });
    const r = await preflight(input({ afterWorktreeCreate: [] }), env);
    expect(r.ok).toBe(true);
    expect(check(r, 'data_remote').status).toBe('warn');
    expect(check(r, 'worktree_hook')).toMatchObject({ status: 'warn', repair: expect.stringContaining('npm ci') });
    expect(formatPreflight(r).at(-1)).toBe('ready (2 warnings)');
  });

  it('a port held by this project\'s own server is fine; network checks are labelled, and --offline skips them', async () => {
    const { env, calls } = fakeEnv({}, { portFree: false });
    const r = await preflight(input({ ownServerOnPort: true, offline: true }), env);
    expect(check(r, 'port').status).toBe('ok');
    expect(check(r, 'base_branch')).toMatchObject({ status: 'skip', network: true });
    expect(check(r, 'gh')).toMatchObject({ status: 'skip', network: true });
    expect(calls.some((c) => c.startsWith('git ls-remote') || c.startsWith('gh auth'))).toBe(false);
  });

  it('is persisted for the UI, and reads the runners from the models the project chooses', async () => {
    const { dataDir } = makeFixture();
    const { env } = fakeEnv();
    const r = await preflight(input({ dataDir }), env);
    savePreflight(dataDir, r);
    expect(readPreflight(dataDir)).toEqual(r);
    expect(runnersInUse(readConfig(dataDir), [])).toEqual(['claude']);
    expect(readPreflight(mkdtempSync(join(tmpdir(), 'pf-')))).toBeUndefined();
  });
});
