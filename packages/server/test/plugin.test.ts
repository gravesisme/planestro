import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OPERATOR_TOOLS } from '../src/routes/mcp.ts';

// The Claude Code plugin (#175, step 3): plugins/planestro, listed by .claude-plugin/marketplace.json.
const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PLUGIN = join(ROOT, 'plugins', 'planestro');
const SCRIPT = join(PLUGIN, 'scripts', 'planestro');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('the Claude Code plugin (#175)', () => {
  it('the marketplace lists it, and its manifest names it', () => {
    const market = json(join(ROOT, '.claude-plugin', 'marketplace.json'));
    const entry = market.plugins.find((p: { name: string }) => p.name === 'planestro');
    expect(entry).toBeDefined();
    expect(resolve(ROOT, entry.source)).toBe(PLUGIN);
    expect(json(join(PLUGIN, '.claude-plugin', 'plugin.json'))).toMatchObject({ name: 'planestro', version: json(join(ROOT, 'packages', 'server', 'package.json')).version });
  });

  it('the skill runs only when the user types it, and uses only the read-only operator tools', () => {
    const skill = readFileSync(join(PLUGIN, 'skills', 'planestro', 'SKILL.md'), 'utf8');
    const front = skill.split('---')[1];
    expect(front).toMatch(/^disable-model-invocation: true$/m);
    expect(front).toMatch(/^name: planestro$/m);
    const tools = [...skill.matchAll(/planestro" call (\w+)/g)].map((m) => m[1]);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(OPERATOR_TOOLS).toContain(t);
    expect(skill).toMatch(/never with `run_in_background`/);
  });

  it('registers the running server\'s operator endpoint, port overridable', () => {
    expect(json(join(PLUGIN, '.mcp.json')).mcpServers.planestro).toEqual({ type: 'http', url: '${PLANESTRO_URL:-http://127.0.0.1:4300}/mcp' });
  });

  it('its script is executable and finds the data dir from the repo, a subdirectory or a linked worktree', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'planestro-plugin-')));
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'planning')); writeFileSync(join(repo, 'planning', 'planestro.yml'), 'x: 1\n');
    mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'a.txt'), 'a\n');
    writeFileSync(join(repo, '.gitignore'), 'planning/\n');
    git(repo, 'add', '-A'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const wt = join(repo, '..', `${repo.split('/').pop()}-wt`);
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'x');
    const env = { ...process.env, PLANESTRO_DATA_DIR: '' };
    const locate = (cwd: string) => execFileSync(SCRIPT, ['locate'], { cwd, env, encoding: 'utf8' }).trim();
    expect(locate(repo)).toBe(join(repo, 'planning'));
    expect(locate(join(repo, 'src'))).toBe(join(repo, 'planning'));
    expect(locate(wt)).toBe(join(repo, 'planning'));            // the worktree has no planning/: the main checkout's
    expect(locate(join(repo, 'planning'))).toBe(join(repo, 'planning'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'planestro-none-'));
    expect(() => execFileSync(SCRIPT, ['locate'], { cwd: elsewhere, env, stdio: 'pipe' })).toThrow();
    expect(existsSync(join(PLUGIN, 'skills', 'planestro', 'SKILL.md'))).toBe(true);
  });

  it('the CLI it reads is `planestro status --json`: an array, or one record (null, exit 3) for a data dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'planestro-home-'));
    const run = (...a: string[]) => execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'packages', 'server', 'src', 'cli.ts'), 'status', ...a], { cwd: ROOT, env: { ...process.env, PLANESTRO_HOME: home }, encoding: 'utf8' });
    expect(JSON.parse(run('--json'))).toEqual([]);
    let code = 0, out = '';
    try { run(home, '--json'); } catch (e) { code = (e as { status: number }).status; out = (e as { stdout: string }).stdout; }
    expect(code).toBe(3);
    expect(JSON.parse(out)).toBeNull();
  });
});
