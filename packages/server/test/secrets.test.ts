import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '@planestro/shared';
import { allowedByRules, makePolicy, BASE_ALLOWED } from '../src/engine/policy.ts';
import { secretDenial, secretInCommand, secretPath } from '../src/engine/secrets.ts';
import { secretHook } from '../src/engine/sessions/LiveClaudePort.ts';

const bash = (command: string) => ({ tool: 'Bash', input: { command } });

describe('the built-in deny list for secret files (#227)', () => {
  let root: string, home: string, wt: string;
  const config = () => Config.parse({
    schema_version: 2, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'T' },
    code_repo: { path: '..', default_branch: 'trunk' },
    models: [{ id: 'm', label: 'M', claude_model: 'x' }], defaults: { planner: 'm', implementer: 'm', category: 'C' }, categories: ['C'],
    // A user rule that would allow everything still loses to the list.
    permissions: { allow: ['Bash(cat *)', 'Bash(cat *)@worktree', 'Read'], deny: [] },
  });

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pl-secrets-')));
    home = join(root, 'home');
    wt = join(root, 'repo', 'wt');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'KEY');
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(join(home, '.aws', 'credentials'), 'AWS');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.env'), 'TOKEN=1');
    writeFileSync(join(wt, '.env.example'), 'TOKEN=');
    writeFileSync(join(wt, 'src', 'a.ts'), 'x');
    symlinkSync(join(home, '.ssh', 'id_ed25519'), join(wt, 'notes.txt'));
    symlinkSync(join(home, '.aws'), join(wt, 'cfg'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('names what is on the list, as written and through symlinks', () => {
    const o = { home };
    expect(secretPath('~/.ssh/id_ed25519', wt, o)).toBe('~/.ssh');
    expect(secretPath(join(home, '.gnupg', 'x'), wt, o)).toBe('~/.gnupg');
    expect(secretPath(join(home, '.config', 'gcloud', 'credentials.db'), wt, o)).toBe('~/.config/gcloud');
    expect(secretPath('.git/config', wt, o)).toBe('.git/config');
    expect(secretPath('.env.local', wt, o)).toBe('.env files');
    expect(secretPath('certs/server.pem', wt, o)).toBe('*.pem');
    expect(secretPath('tls.key', wt, o)).toBe('*.key');
    expect(secretPath('id_rsa.pub', wt, o)).toBe('SSH keys');
    expect(secretPath('config/credentials.json', wt, o)).toBe('credentials.json');
    expect(secretPath('secrets.yml', wt, o)).toBe('secrets.*');
    expect(secretPath(join(home, '.planestro', 'codex', 'auth.json'), wt, o)).not.toBeNull();
    expect(secretPath(join(home, 'ch', 'auth.json'), wt, { home, codexHome: join(home, 'ch') })).not.toBeNull();
    expect(secretPath('notes.txt', wt, o)).toBe('~/.ssh');
    expect(secretPath('cfg/credentials', wt, o)).toBe('~/.aws');
    for (const p of ['.env.example', 'src/a.ts', 'README.md', 'src/keys.ts', '.git/HEAD']) expect(secretPath(p, wt, o), p).toBeNull();
  });

  it('refuses tail and head on a denied path, and through a symlink, though the read-only helpers allow them', () => {
    const policy = makePolicy(config(), 'trunk', wt, { home });
    for (const c of [`tail ${home}/.ssh/id_ed25519`, 'head -n 5 ~/.ssh/id_ed25519', 'tail notes.txt', 'head cfg/credentials', 'tail -f .env', 'cat ~/.aws/credentials', 'cat "$HOME/.ssh/id_ed25519"', 'git --no-pager show HEAD:.env', 'wc -l .env']) {
      // The rules alone would let these through: the list is what stops them.
      if (c.startsWith('tail') || c.startsWith('head')) expect(allowedByRules(bash(c), [...BASE_ALLOWED.implement], wt), c).toBe(true);
      expect(policy.deny(bash(c)), c).toMatch(/secret file/);
    }
  });

  it('refuses the file tools on a denied path, writes included', () => {
    const policy = makePolicy(config(), 'trunk', wt, { home });
    expect(policy.deny({ tool: 'Read', input: { file_path: join(home, '.ssh', 'id_ed25519') } })).toMatch(/secret file/);
    expect(policy.deny({ tool: 'Read', input: { file_path: join(wt, 'notes.txt') } })).toMatch(/secret file/);
    expect(policy.deny({ tool: 'Write', input: { file_path: join(wt, '.env'), content: 'x' } })).toMatch(/secret file/);
    expect(policy.deny({ tool: 'Edit', input: { file_path: join(wt, '.git', 'config') } })).toMatch(/git's own config/);
    expect(policy.deny({ tool: 'Grep', input: { pattern: 'TOKEN', path: '.env' } })).toMatch(/secret file/);
    expect(policy.deny({ tool: 'Grep', input: { pattern: 'TOKEN', glob: '**/.env*' } })).toMatch(/secret file/);
    expect(policy.deny({ tool: 'Glob', input: { pattern: '~/.ssh/*' } })).toMatch(/secret file/);
    expect(policy.deny({ tool: 'Read', input: { file_path: join(wt, '.env.example') } })).toBeNull();
    expect(policy.deny({ tool: 'Grep', input: { pattern: 'id_rsa', path: 'src' } })).toBeNull();
    expect(policy.deny({ tool: 'Edit', input: { file_path: join(wt, 'src', 'a.ts') } })).toBeNull();
  });

  it('leaves ordinary work alone: a bare name counts only when it is a file, a glob or a redirection target', () => {
    const o = { home };
    for (const c of ['grep -rn id_rsa src', 'grep credentials.json src', 'jq .key package.json', 'cat .env.example', 'npm test', 'curl https://example.com/.env', 'tail -30 build.log', 'git commit -m "Load .env and config/.env.local"'])
      expect(secretInCommand(c, wt, o), c).toBeNull();
    for (const c of ['echo TOKEN=2 > .env.local', 'cat *.pem', 'cp .env.example .env && cat .env', 'sed -n 1p --file=~/.ssh/config'])
      expect(secretInCommand(c, wt, o), c).not.toBeNull();
  });

  it('runs before any allow rule in the Claude port: the PreToolUse hook denies what the SDK would approve by itself', async () => {
    const hook = secretHook(wt, { home });
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'tail ~/.ssh/id_ed25519' } } as any, undefined, { signal: new AbortController().signal });
    expect((out as any).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(wt, 'src', 'a.ts') } } as any, undefined, { signal: new AbortController().signal })).toEqual({ continue: true });
    expect(secretDenial({ tool: 'mcp__planestro__add_note', input: { path: '.env' } }, wt, { home })).toBeNull();
  });
});
