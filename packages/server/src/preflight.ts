/**
 * `planestro check --preflight` (#337): what a first task would otherwise stop on, found up front on this machine.
 * Read-only and local: it runs the tools' own status commands (git, gh, `claude auth status`, `codex login status`),
 * never a session, a model call, a repository hook, or anything that writes outside `<data_dir>/.planestro/preflight.json`.
 * Checks that reach the network (the remote's base branch, `gh auth status`) say so, and `--offline` skips them.
 * Each failure carries one concrete repair. The checks take an injectable environment, so tests run them with fakes.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, LocalConfig } from '@planestro/shared';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface PreflightCheck { id: string; label: string; status: CheckStatus; detail: string; repair?: string; network?: boolean }
export interface PreflightResult { at: string; ok: boolean; checks: PreflightCheck[] }

export interface PreflightEnv {
  run(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }>;
  exists(path: string): boolean;
  /** Whether nothing listens on the port (bound and released at once). */
  portFree(port: number, host: string): Promise<boolean>;
  nodeVersion: string;
}

export interface PreflightInput {
  dataDir: string;
  codeRepo: string;
  defaultBranch: string;
  github?: string;
  /** The runners the project's chosen models run on. */
  runners: ('claude' | 'codex')[];
  accounts: { name: string; runner: 'claude' | 'codex'; home: string }[];
  claudeBin?: string;
  codexBin?: string;
  port: number;
  host: string;
  /** This data dir's own server holds the port (its `planestro start` record names it). */
  ownServerOnPort: boolean;
  afterWorktreeCreate: string[];
  /** Skip the checks that need the network. */
  offline?: boolean;
}

/** Lockfiles that mean a fresh worktree needs an install before anything in it builds or tests. */
const LOCKFILES: Record<string, string> = {
  'package-lock.json': 'npm ci', 'npm-shrinkwrap.json': 'npm ci', 'yarn.lock': 'yarn install --frozen-lockfile', 'pnpm-lock.yaml': 'pnpm install --frozen-lockfile',
  'bun.lock': 'bun install --frozen-lockfile', 'bun.lockb': 'bun install --frozen-lockfile', 'Gemfile.lock': 'bundle install', 'poetry.lock': 'poetry install', 'uv.lock': 'uv sync', 'Pipfile.lock': 'pipenv sync',
};
const MIN_NODE = 24;
const firstLine = (s: string) => s.trim().split('\n')[0]?.trim().slice(0, 200) ?? '';
const homeOf = (p: string) => p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;

export async function preflight(input: PreflightInput, env: PreflightEnv, now = new Date()): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => { checks.push(c); };
  const run = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => env.run(cmd, args, opts).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));

  // Node
  const major = Number(env.nodeVersion.replace(/^v/, '').split('.')[0]);
  add(major >= MIN_NODE ? { id: 'node', label: 'Node', status: 'ok', detail: `Node ${env.nodeVersion}` }
    : { id: 'node', label: 'Node', status: 'fail', detail: `Node ${env.nodeVersion} is older than ${MIN_NODE}`, repair: `install Node ${MIN_NODE} or newer (nvm install ${MIN_NODE})` });

  // git and its identity, as the code repository sees it
  const git = await run('git', ['--version']);
  if (git.code !== 0) add({ id: 'git', label: 'git', status: 'fail', detail: 'git is not on PATH', repair: 'install git (https://git-scm.com/downloads)' });
  else {
    add({ id: 'git', label: 'git', status: 'ok', detail: firstLine(git.stdout) });
    const cwd = env.exists(input.codeRepo) ? input.codeRepo : input.dataDir;
    const name = (await run('git', ['config', 'user.name'], { cwd })).stdout.trim();
    const email = (await run('git', ['config', 'user.email'], { cwd })).stdout.trim();
    const missing = [!name && 'user.name', !email && 'user.email'].filter(Boolean) as string[];
    add(missing.length ? { id: 'git_identity', label: 'git identity', status: 'fail', detail: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set: commits cannot be made`, repair: missing.map((k) => `git config --global ${k} ${k === 'user.name' ? '"Your Name"' : 'you@example.com'}`).join(' && ') }
      : { id: 'git_identity', label: 'git identity', status: 'ok', detail: `${name} <${email}>` });
  }

  // The code repository: a HEAD, a remote, and the base on that remote
  if (!env.exists(input.codeRepo)) add({ id: 'code_repo', label: 'code repository', status: 'fail', detail: `${input.codeRepo} does not exist`, repair: 'set code_repo.path in planestro.yml to your repository' });
  else if (git.code === 0) {
    const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: input.codeRepo });
    add(head.code === 0 ? { id: 'code_repo', label: 'code repository', status: 'ok', detail: `${input.codeRepo} at ${head.stdout.trim().slice(0, 7)}` }
      : { id: 'code_repo', label: 'code repository', status: 'fail', detail: `${input.codeRepo} is not a git repository with a commit`, repair: `cd ${input.codeRepo} && git init && git add -A && git commit -m "first commit"` });
    const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: input.codeRepo });
    if (remote.code !== 0) add({ id: 'code_remote', label: 'code remote', status: 'fail', detail: 'the code repository has no remote named origin: pull requests need one', repair: `cd ${input.codeRepo} && git remote add origin <url> && git push -u origin ${input.defaultBranch}` });
    else {
      add({ id: 'code_remote', label: 'code remote', status: 'ok', detail: `origin is ${remote.stdout.trim()}` });
      if (input.offline) add({ id: 'base_branch', label: 'base branch on origin', status: 'skip', detail: 'skipped (--offline)', network: true });
      else {
        const ls = await run('git', ['ls-remote', '--exit-code', '--heads', 'origin', input.defaultBranch], { cwd: input.codeRepo });
        add(ls.code === 0 ? { id: 'base_branch', label: 'base branch on origin', status: 'ok', detail: `origin has ${input.defaultBranch}`, network: true }
          : ls.code === 2 ? { id: 'base_branch', label: 'base branch on origin', status: 'fail', detail: `origin has no branch ${input.defaultBranch} (code_repo.default_branch)`, repair: `cd ${input.codeRepo} && git push -u origin ${input.defaultBranch}, or set code_repo.default_branch to the branch work merges into`, network: true }
          : { id: 'base_branch', label: 'base branch on origin', status: 'fail', detail: `origin could not be read: ${firstLine(ls.stderr)}`, repair: 'check the remote URL and your git credentials (git fetch origin should work)', network: true });
      }
    }
  }

  // GitHub, when the project has a repository there
  if (input.github) {
    const gh = await run('gh', ['--version']);
    if (gh.code !== 0) add({ id: 'gh', label: 'GitHub CLI', status: 'fail', detail: 'gh is not on PATH: pull requests and CI are read through it', repair: 'install the GitHub CLI (https://cli.github.com) and run gh auth login' });
    else if (input.offline) add({ id: 'gh', label: 'GitHub CLI', status: 'skip', detail: 'sign-in not checked (--offline)', network: true });
    else {
      const auth = await run('gh', ['auth', 'status', '--hostname', 'github.com']);
      add(auth.code === 0 ? { id: 'gh', label: 'GitHub CLI', status: 'ok', detail: `signed in to github.com (${input.github})`, network: true }
        : { id: 'gh', label: 'GitHub CLI', status: 'fail', detail: `gh is not signed in to github.com: ${firstLine(auth.stderr || auth.stdout)}`, repair: 'gh auth login', network: true });
    }
  }

  // The runners the models use: on PATH, and signed in by their own status commands (never a session)
  const claudeSignedIn = async (bin: string, extra?: Record<string, string>) => {
    const r = await run(bin, ['auth', 'status'], extra ? { env: extra } : undefined);
    try { return JSON.parse(r.stdout).loggedIn === true ? 'yes' : 'no'; } catch { return r.code === 0 ? 'unknown' : 'no'; }
  };
  const codexSignedIn = async (bin: string, extra?: Record<string, string>) => ((await run(bin, ['login', 'status'], extra ? { env: extra } : undefined)).code === 0 ? 'yes' : 'no');
  for (const runner of [...new Set(input.runners)].sort()) {
    const bin = runner === 'claude' ? input.claudeBin ?? 'claude' : input.codexBin ?? 'codex';
    const v = await run(bin, ['--version']);
    if (v.code !== 0) { add({ id: runner, label: runner === 'claude' ? 'Claude Code' : 'Codex', status: 'fail', detail: `${bin} is not on PATH, and a model the project uses runs on it`, repair: runner === 'claude' ? 'install Claude Code (npm install -g @anthropic-ai/claude-code)' : 'install the Codex CLI (npm install -g @openai/codex)' }); continue; }
    const signed = runner === 'claude' ? await claudeSignedIn(bin) : await codexSignedIn(bin);
    const label = runner === 'claude' ? 'Claude Code' : 'Codex';
    add(signed === 'yes' ? { id: runner, label, status: 'ok', detail: `${firstLine(v.stdout)}, signed in` }
      : signed === 'unknown' ? { id: runner, label, status: 'warn', detail: `${firstLine(v.stdout)}; could not tell whether it is signed in`, repair: runner === 'claude' ? 'run claude and /login if it asks' : 'codex login' }
      : { id: runner, label, status: 'fail', detail: `${firstLine(v.stdout)}, not signed in`, repair: runner === 'claude' ? 'run claude, then /login' : 'codex login' });
  }

  // Named accounts (#242): each home exists and is signed in
  for (const a of input.accounts) {
    const home = homeOf(a.home);
    const set = a.runner === 'claude' ? `CLAUDE_CONFIG_DIR=${home}` : `CODEX_HOME=${home}`;
    const login = a.runner === 'claude' ? `${set} claude, then /login` : `${set} codex login`;
    if (!env.exists(home)) { add({ id: `account:${a.name}`, label: `account ${a.name}`, status: 'fail', detail: `its home ${home} does not exist`, repair: `mkdir -p ${home} && ${login}` }); continue; }
    const extra: Record<string, string> = a.runner === 'claude' ? { CLAUDE_CONFIG_DIR: home } : { CODEX_HOME: home };
    const bin = a.runner === 'claude' ? input.claudeBin ?? 'claude' : input.codexBin ?? 'codex';
    const signed = a.runner === 'claude' ? await claudeSignedIn(bin, extra) : await codexSignedIn(bin, extra);
    add(signed === 'yes' ? { id: `account:${a.name}`, label: `account ${a.name}`, status: 'ok', detail: `${a.runner}, ${home}, signed in` }
      : { id: `account:${a.name}`, label: `account ${a.name}`, status: signed === 'unknown' ? 'warn' : 'fail', detail: `${a.runner}, ${home}, ${signed === 'unknown' ? 'could not tell whether it is signed in' : 'not signed in'}`, repair: login });
  }

  // The planning data dir: a git repository with a commit; a remote is recommended, not required
  if (git.code === 0) {
    const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: input.dataDir });
    add(head.code === 0 ? { id: 'data_repo', label: 'planning repository', status: 'ok', detail: `${input.dataDir} at ${head.stdout.trim().slice(0, 7)}` }
      : { id: 'data_repo', label: 'planning repository', status: 'fail', detail: `${input.dataDir} is not a git repository with a commit: planestro commits every change there`, repair: `cd ${input.dataDir} && git init && git add -A && git commit -m "planning"` });
    const remotes = (await run('git', ['remote'], { cwd: input.dataDir })).stdout.trim();
    add(remotes ? { id: 'data_remote', label: 'planning remote', status: 'ok', detail: `remote ${remotes.split('\n').join(', ')}` }
      : { id: 'data_remote', label: 'planning remote', status: 'warn', detail: 'the planning repository has no remote: its history is only on this machine', repair: `cd ${input.dataDir} && git remote add origin <url> && git push -u origin HEAD` });
  }

  // The port
  const free = await env.portFree(input.port, input.host).catch(() => false);
  add(free ? { id: 'port', label: 'port', status: 'ok', detail: `${input.host}:${input.port} is free` }
    : input.ownServerOnPort ? { id: 'port', label: 'port', status: 'ok', detail: `${input.port} is held by this project's own server` }
    : { id: 'port', label: 'port', status: 'fail', detail: `something else listens on ${input.port}`, repair: `start planestro with --port <another>, or stop what holds ${input.port} (lsof -i :${input.port})` });

  // A worktree that needs an install before it builds: a warning, never a failure
  if (env.exists(input.codeRepo)) {
    const locks = Object.keys(LOCKFILES).filter((f) => env.exists(join(input.codeRepo, f)));
    if (locks.length && !input.afterWorktreeCreate.length) add({ id: 'worktree_hook', label: 'worktree setup', status: 'warn', detail: `${locks.join(', ')} found but hooks.after_worktree_create is empty: each new worktree starts without its dependencies`, repair: `set hooks.after_worktree_create to ["${LOCKFILES[locks[0]]}"] in planestro.yml` });
    else add({ id: 'worktree_hook', label: 'worktree setup', status: 'ok', detail: input.afterWorktreeCreate.length ? `hooks.after_worktree_create: ${input.afterWorktreeCreate.join('; ')}` : 'no lockfile, no setup hook needed' });
  }

  return { at: now.toISOString(), ok: !checks.some((c) => c.status === 'fail'), checks };
}

/** The runners of the models the project chooses (defaults, the orchestrator, every open item), as warnOnCodexDrift reads them. */
export function runnersInUse(config: Config, refs: (string | undefined)[]): ('claude' | 'codex')[] {
  const chosen = [config.defaults.planner, config.defaults.implementer, config.orchestrator.model, ...refs].filter(Boolean) as string[];
  const used = config.models.filter((m) => chosen.some((r) => r === m.id || r === m.codex_model)).map((m) => m.runner);
  return [...new Set(used.length ? used : ['claude' as const])];
}

export function accountsOf(local: LocalConfig): PreflightInput['accounts'] {
  return Object.entries(local.accounts ?? {}).map(([name, a]) => ({ name, runner: a.runner, home: a.home }));
}

/** The machine as it is: child processes, the filesystem, a real bind. */
export const liveEnv: PreflightEnv = {
  run: (cmd, args, opts) => new Promise((done) => {
    execFile(cmd, args, { cwd: opts?.cwd, env: { ...process.env, ...opts?.env }, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : -1) : 0;
      done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === -1 ? err.message : '') });
    });
  }),
  exists: (p) => existsSync(p),
  portFree: (port, host) => new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, host, () => s.close(() => done(true)));
  }),
  nodeVersion: process.versions.node,
};

export const preflightPath = (dataDir: string) => join(dataDir, '.planestro', 'preflight.json');
/** Kept for the UI to show without running it again. */
export function savePreflight(dataDir: string, r: PreflightResult): void {
  mkdirSync(join(dataDir, '.planestro'), { recursive: true });
  writeFileSync(preflightPath(dataDir), JSON.stringify(r, null, 2) + '\n');
}
export function readPreflight(dataDir: string): PreflightResult | undefined {
  try { return JSON.parse(readFileSync(preflightPath(dataDir), 'utf8')); } catch { return undefined; }
}

/** One line per check, failures with their repair under them. */
export function formatPreflight(r: PreflightResult): string[] {
  const tag: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', skip: 'skip' };
  const out: string[] = [];
  for (const c of r.checks) {
    out.push(`  ${tag[c.status]}  ${c.label}${c.network ? ' (network)' : ''}: ${c.detail}`);
    if (c.repair && c.status !== 'ok') out.push(`        repair: ${c.repair}`);
  }
  const fails = r.checks.filter((c) => c.status === 'fail').length, warns = r.checks.filter((c) => c.status === 'warn').length;
  out.push(r.ok ? `ready${warns ? ` (${warns} warning${warns === 1 ? '' : 's'})` : ''}` : `${fails} problem${fails === 1 ? '' : 's'} to fix before the first task${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}`);
  return out;
}
