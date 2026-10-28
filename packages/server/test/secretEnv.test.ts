import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, LocalConfig, NOT_USER_FACING, SETTINGS, getSection } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { parseDotenv, resolveSecretEnv, redactSecretEnv } from '../src/engine/secretEnv.ts';
import { secretDenial, secretsNamedIn } from '../src/engine/secrets.ts';
import { makePolicy } from '../src/engine/policy.ts';
import { secretHook } from '../src/engine/sessions/LiveClaudePort.ts';
import { codexEnv, secretEnvArgs } from '../src/engine/sessions/CodexAppServerPort.ts';
import { workerCommandEnv } from '../src/engine/sessions/commandEnv.ts';
import { makeFixture, sleep } from './helpers.ts';

/**
 * LM-50 (#501): an approved step read an API key from the main checkout's .env.local and the secret deny list (#227)
 * refused it after the dry run. The file stays denied; the user hands the one value over by name (`secret_env`).
 */
describe('secret_env: a value from a secret file, never the file (#501)', () => {
  it('reads dotenv lines: export, quotes, comments', () => {
    const m = parseDotenv('# keys\nexport ELEVENLABS_API_KEY=sk_abc123 # trailing\nQUOTED="a b\\nc"\nSINGLE=\'x # y\'\n  EMPTY=\nnot a line\n');
    expect(m.get('ELEVENLABS_API_KEY')).toBe('sk_abc123');
    expect(m.get('QUOTED')).toBe('a b\nc');
    expect(m.get('SINGLE')).toBe('x # y');
    expect(m.get('EMPTY')).toBe('');
    expect(m.has('not')).toBe(false);
  });

  it('resolves each name from its file, relative to the code repo, and says what it could not read by name only', () => {
    const files: Record<string, string> = { '/repo/.env.local': 'ELEVENLABS_API_KEY=sk_live_secret\nSERVICE_TOKEN=tok_9999\n', '/h/keys.env': 'B=bee1' };
    const read = (p: string) => { if (p in files) return files[p]; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    const { env, missing } = resolveSecretEnv({
      ELEVENLABS_API_KEY: { file: '.env.local' }, OTHER: { file: '/repo/.env.local', key: 'SERVICE_TOKEN' }, B: { file: '~/keys.env' },
      GONE: { file: '.env.local' }, NOFILE: { file: 'missing.env' }, GH_TOKEN: { file: '.env.local' }, PATH: { file: '.env.local' },
    }, '/repo', { home: '/h', read });
    expect(env).toEqual({ ELEVENLABS_API_KEY: 'sk_live_secret', OTHER: 'tok_9999', B: 'bee1' });
    expect(missing).toEqual(['GONE: /repo/.env.local has no GONE', 'NOFILE: /repo/missing.env does not exist', 'GH_TOKEN: planestro keeps that variable for itself', 'PATH: planestro keeps that variable for itself']);
    expect(missing.join(' ')).not.toContain('sk_live_secret');
  });

  it('redacts a handed-over value from what a command printed', () => {
    expect(redactSecretEnv('key is sk_live_secret, ok', { K: 'sk_live_secret' })).toBe('key is [secret_env K], ok');
    expect(redactSecretEnv('abc', { K: 'ab' })).toBe('abc'); // too short to redact without noise
    expect(redactSecretEnv('x', undefined)).toBe('x');
  });

  it('the file stays denied, and the refusal says how to get a value from it', () => {
    const req = { tool: 'Bash', input: { command: 'cat .env.local' } };
    const plain = secretDenial(req, '/repo/wt', { exists: () => true })!;
    expect(plain).toContain('no rule overrides that');
    expect(plain).toContain('secret_env in planestro.local.yml');
    const handed = secretDenial(req, '/repo/wt', { exists: () => true, env: ['ELEVENLABS_API_KEY'] })!;
    expect(handed).toContain('already holds $ELEVENLABS_API_KEY');
    expect(secretDenial({ tool: 'Read', input: { file_path: '/repo/.env.local' } }, '/repo/wt', { env: ['ELEVENLABS_API_KEY'] })).toContain('$ELEVENLABS_API_KEY');
  });

  it('finds the secret files a plan names, by shape', () => {
    const plan = '1. Bake the voice lines: `scripts/bake.ts` reads ELEVENLABS_API_KEY from the main checkout\'s .env.local.\n2. Never touch ~/.aws/credentials, .env.example or *.pem (see https://x.test/.env).\n3. Edit src/.git/config? no.';
    expect(secretsNamedIn(plan, '/repo', { home: '/h' })).toEqual([{ path: '.env.local', what: '.env files' }, { path: '~/.aws/credentials', what: '~/.aws' }]);
    expect(secretsNamedIn('Add a unit test for the parser.', '/repo')).toEqual([]);
  });

  it('reaches a Codex process and a run_heavy command; Codex is told to keep it', () => {
    expect(codexEnv([], '/ch', { ELEVENLABS_API_KEY: 'v' })).toMatchObject({ ELEVENLABS_API_KEY: 'v', CODEX_HOME: '/ch' });
    expect(codexEnv([], '/ch', { CODEX_HOME: '/elsewhere' }).CODEX_HOME).toBe('/ch');
    expect(secretEnvArgs({ K: 'v' })).toEqual(['-c', 'shell_environment_policy.ignore_default_excludes=true']);
    expect(secretEnvArgs({})).toEqual([]);
    const config = { codex_env_passthrough: [] } as never;
    expect(workerCommandEnv('claude', config, { K: 'v' })).toEqual({ env: { K: 'v' } });
    expect(workerCommandEnv('claude', config)).toEqual({});
    expect(workerCommandEnv('codex', config, { K: 'v' })).toMatchObject({ env: { K: 'v' }, cleanEnv: true });
  });

  it('is hand-edited only: in the local schema, on no Settings row', () => {
    expect(LocalConfig.parse({ secret_env: { ELEVENLABS_API_KEY: { file: '.env.local' } } }).secret_env).toEqual({ ELEVENLABS_API_KEY: { file: '.env.local' } });
    expect(() => LocalConfig.parse({ secret_env: { 'BAD-NAME': { file: 'x' } } })).toThrow();
    expect(SETTINGS.some((s) => s.key.startsWith('secret_env'))).toBe(false);
    expect(NOT_USER_FACING.local).toContain('secret_env');
  });
});

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });
const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }

describe('secret_env in a live turn (#501, LM-50)', () => {
  async function setup(plan: string) {
    const { dataDir, codeRepo } = makeFixture();
    mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
    writeFileSync(join(codeRepo, '.env.local'), 'ELEVENLABS_API_KEY=sk_live_lm50\n');
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
    delete process.env.PLANESTRO_DRYRUN_CI;
    store = await DataStore.open(dataDir, { emit: () => {} });
    store.updateLocal({ secret_env: { ELEVENLABS_API_KEY: { file: '.env.local' }, MISSING_KEY: { file: '.env.local' } } });
    const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const inner = new DryRunClaudePort(world);
    const turns: { phase: string; env?: Record<string, string>; prompt: string; systemAppend: string }[] = [];
    const outputs: string[] = [];
    const claude: Ports['agents']['claude'] = {
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        turns.push({ phase: o.phase, env: o.env, prompt: o.prompt, systemAppend: o.systemAppend });
        if (o.phase === 'plan') { await o.tools.submit_plan(plan); return { ...ok, planSubmitted: plan }; }
        o.onOutput('baked with sk_live_lm50');
        return inner.runTurn(o);
      },
      runCustomTurn: (o) => inner.runCustomTurn(o),
    };
    const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
    engine = new LiveEngine(store, ports, (e) => { if (e.type === 'session.output') outputs.push(e.text); }, { sleep: async () => {}, tickMs: 50 });
    return { store, engine, turns, outputs };
  }

  it('warns at hand-in when the plan names a secret file; the implement turn gets the value, the planner never does', async () => {
    const { store, engine, turns, outputs } = await setup('# Plan\n\n1. Run the ElevenLabs bake; it reads the key from the main checkout\'s .env.local.\n');
    const item = store.createItem({ title: 'Bake voice lines', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.status === 'PLAN_READY');
    const activity = () => getSection(store.getItem(item.id)!.file, 'Activity');
    expect(activity()).toContain('its plan names .env.local (.env files): planestro\'s secret deny list refuses every worker read of that file');
    expect(activity()).toContain('secret_env in planestro.local.yml');
    await engine.approvePlan(item.id, undefined, 'user', { syncFirst: false });
    await waitFor(() => turns.some((t) => t.phase === 'implement'));
    expect(turns.find((t) => t.phase === 'plan')!.env).toBeUndefined();
    const impl = turns.find((t) => t.phase === 'implement')!;
    expect(impl.env).toEqual({ ELEVENLABS_API_KEY: 'sk_live_lm50' });
    // The value is in the environment only: not the prompt, the item file, the journal or the live output.
    expect(impl.prompt + impl.systemAppend).not.toContain('sk_live_lm50');
    await waitFor(() => outputs.length > 0);
    expect(outputs.join('\n')).toContain('baked with [secret_env ELEVENLABS_API_KEY]');
    expect(outputs.join('\n')).not.toContain('sk_live_lm50');
    expect(activity()).toContain('secret_env not handed to this turn: MISSING_KEY:');
    // Nothing planestro wrote holds it: item files, the journal, planestro.local.yml (which names the file, not the value).
    const written = (readdirSync(store.dataDir, { recursive: true }) as string[]).filter((f) => !f.split('/').includes('.git') && statSync(join(store.dataDir, f)).isFile());
    expect(written.length).toBeGreaterThan(3);
    expect(written.filter((f) => readFileSync(join(store.dataDir, f), 'utf8').includes('sk_live_lm50'))).toEqual([]);
  });
});

/**
 * The user's own files are on the deny list (#501 review): a Bash write outside the worktree only parks, and a ruling
 * (the orchestrator's decide_permission) could grant it, so a worker could append its own secret_env. No longer.
 */
describe('planestro.local.yml and ~/.planestro/policy.yml: no worker reads or writes them (#501)', () => {
  let root: string, home: string, wt: string, data: string;
  const config = () => Config.parse({
    schema_version: 2, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'T' },
    code_repo: { path: '..', default_branch: 'trunk' },
    models: [{ id: 'm', label: 'M', claude_model: 'x' }], defaults: { planner: 'm', implementer: 'm', category: 'C' }, categories: ['C'],
    permissions: { allow: ['Bash(*)', 'Write', 'Edit', 'Read'], deny: [] },
  });
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pl-userfiles-')));
    home = join(root, 'home'); wt = join(root, 'repo', 'wt'); data = join(root, 'repo', 'planning');
    mkdirSync(join(home, '.planestro'), { recursive: true }); mkdirSync(wt, { recursive: true }); mkdirSync(data, { recursive: true });
    writeFileSync(join(home, '.planestro', 'policy.yml'), 'allow: []\n');
    writeFileSync(join(data, 'planestro.local.yml'), 'mcp_servers: {}\n');
    writeFileSync(join(data, 'planestro.yml'), 'x: 1\n');
    writeFileSync(join(wt, 'a.txt'), 'x');
    symlinkSync(join(data, 'planestro.local.yml'), join(wt, 'innocent.txt'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('refuses every Bash form that writes or reads them, before any rule or ruling', () => {
    const o = { home };
    const local = join(data, 'planestro.local.yml');
    const commands = [
      `printf 'secret_env: {X: {file: ~/.ssh/id_ed25519}}' >> ${local}`,
      `echo 'secret_env: {}' > ../planning/planestro.local.yml`,
      `echo x | tee -a ../planning/planestro.local.yml`,
      `sed -i '' 's/a/b/' ${local}`,
      `cp /tmp/evil.yml ${local}`,
      `mv /tmp/evil.yml ../planning/./planestro.local.yml`,
      `cat ../planning/../planning/planestro.local.yml`,
      `cat ../planning/*.yml`,
      `cat ../planning/planestro.local.y?l`,
      `cd ../planning && cat planestro.local.yml`,
      `cd ../planning && echo x >> planestro.local.yml`,
      `cd ${data} && cat *`,
      `echo x >> ~/.planestro/policy.yml`,
      `cat $HOME/.planestro/policy.yml`,
      `cat ~/.planestro/pol*`,
      `cat innocent.txt`,
    ];
    for (const command of commands) {
      const why = secretDenial({ tool: 'Bash', input: { command } }, wt, o) ?? `not refused: ${command}`;
      expect(why, command).toMatch(/the user's own planestro configuration/);
      expect(why, command).toContain('no rule or ruling overrides that');
    }
    // The policy refuses it first, whatever allow rule matches (Bash(*) here).
    const policy = makePolicy(config(), 'trunk', wt, o);
    for (const command of commands) expect(policy.deny({ tool: 'Bash', input: { command } }) ?? `not refused: ${command}`, command).toMatch(/user's own planestro configuration/);
  });

  it('refuses the file tools on them, by absolute path, .., ~ or a symlink', () => {
    const o = { home };
    const policy = makePolicy(config(), 'trunk', wt, o);
    for (const [tool, input] of [
      ['Write', { file_path: join(data, 'planestro.local.yml'), content: 'secret_env: {}' }],
      ['Edit', { file_path: '../planning/planestro.local.yml', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: '~/.planestro/policy.yml', edits: [] }],
      ['Read', { file_path: join(wt, 'innocent.txt') }],
      ['Read', { file_path: `${data}/../planning/planestro.local.yml` }],
      ['Glob', { pattern: 'planestro.local.yml', path: data }],
    ] as const) {
      expect(policy.deny({ tool, input: input as Record<string, unknown> }) ?? `not refused: ${tool} ${JSON.stringify(input)}`, `${tool} ${JSON.stringify(input)}`).toMatch(/user's own planestro configuration/);
    }
  });

  it('the PreToolUse hook refuses it too, before anything the CLI approves by itself', async () => {
    const hook = secretHook(wt, { home });
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo x >> ${join(data, 'planestro.local.yml')}` }, tool_use_id: 't' } as never, 't', { signal: new AbortController().signal });
    expect(JSON.stringify(out)).toContain('deny');
  });

  it('leaves ordinary work alone: a count in the worktree, the project config, a search for the name', () => {
    const o = { home };
    for (const command of ['wc -l *', 'cat a.txt', 'cat /tmp/*', `cat ${join(data, 'planestro.yml')}`, 'grep -rn planestro.local.yml src', 'rm -f /tmp/*.log', 'git commit -m "document planestro.local.yml"'])
      expect(secretDenial({ tool: 'Bash', input: { command } }, wt, o), command).toBeNull();
  });
});
