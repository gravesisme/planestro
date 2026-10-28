import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalConfig, NOT_USER_FACING, SETTINGS, getSection } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { parseDotenv, resolveSecretEnv, redactSecretEnv } from '../src/engine/secretEnv.ts';
import { secretDenial, secretsNamedIn } from '../src/engine/secrets.ts';
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
