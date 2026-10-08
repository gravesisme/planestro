import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decisionOf } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { claudeEnv } from '../src/engine/sessions/LiveClaudePort.ts';
import { codexHomeOf } from '../src/engine/sessions/LiveCodexPort.ts';
import { secretPath } from '../src/engine/secrets.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

/**
 * A second account for the same provider (#242): named in planestro.local.yml with its own credential source (a config
 * folder, or the name of an environment variable holding a key), its own usage guard and its own remembered outages.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; delete process.env.PLANESTRO_TEST_KEY_2; });

const RESET = '2099-01-01T09:00:00.000Z';
interface Used { item?: string; account?: string; home?: string; apiKeyEnv?: string; resume?: string }

/** A Claude port on which some accounts are out of usage: their turns fail the way the CLI does. Fakes only: no credentials are read. */
function accountsClaude(exhausted: Set<string>, used: Used[], rateLimit?: { account: string }) {
  return (world: FakeWorld) => {
    const inner = new DryRunClaudePort(world);
    return {
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        const account = o.account?.name ?? 'default';
        used.push({ item: o.itemId, account, home: o.account?.home, apiKeyEnv: o.account?.apiKeyEnv, resume: o.resume });
        if (exhausted.has(account)) return { sessionId: o.resume ?? `s-${o.itemId}-${account}`, subtype: 'usage_exhausted', isError: true, costUsd: 0, numTurns: 0, text: '', usageLimit: { message: "You've hit your limit", resetsAt: RESET }, error: "You've hit your limit" };
        const r = await inner.runTurn(o);
        return rateLimit?.account === account ? { ...r, rateLimit: { status: 'rejected', window: 'five_hour', resetsAt: RESET } } : r;
      },
      async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> { used.push({ account: o.account?.name ?? 'default', home: o.account?.home }); return inner.runCustomTurn(o); },
    };
  };
}

async function setup(claude: (w: FakeWorld) => Ports['agents']['claude'], edit: (yml: string) => string = (y) => y) {
  const { root, dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, edit(readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n')));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  store.updateLocal({ accounts: { work: { runner: 'claude', home: join(root, 'claude-work'), label: 'Work Max' }, api: { runner: 'claude', api_key_env: 'PLANESTRO_TEST_KEY_2' } } });
  process.env.PLANESTRO_TEST_KEY_2 = 'fake-key-for-tests';
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: claude(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, root };
}

async function waitFor(pred: () => boolean, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fm = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activity = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

describe('a second account for the same provider (#242)', () => {
  it('on exhaustion the card offers the other accounts; one on the same login folder resumes the conversation', async () => {
    const used: Used[] = [];
    const { store, engine } = await setup(accountsClaude(new Set(['default']), used));
    const a = store.createItem({ title: 'Plan me', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => decisionOf(fm(store, a.id)) !== undefined);
    const f = fm(store, a.id);
    expect(f.blocked_reason).toBe('usage_exhausted');
    expect(f.triage).toBeUndefined(); // spending on another account is the user's call, said by code: no triage wake
    const card = decisionOf(f)!;
    expect(card.options.map((o) => o.label)).toEqual(['Continue on Work Max', 'Continue on api', 'Wait for the reset']);
    expect(card.options[0].action).toEqual({ tool: 'continue_on_account', args: { id: a.id, account: 'work' } });
    expect(store.local.model_unavailable?.['fable-5']?.until).toBe(RESET);

    await engine.answerDecision(a.id, { choice: 'Continue on api' });
    await waitFor(() => fm(store, a.id).status === 'PLAN_READY');
    expect(fm(store, a.id).account).toBe('api');
    const turns = used.filter((u) => u.item === a.id);
    expect(turns.map((u) => u.account)).toEqual(['default', 'api']);
    expect(turns[1]).toMatchObject({ apiKeyEnv: 'PLANESTRO_TEST_KEY_2', resume: `s-${a.id}-default` });
    await waitFor(() => fm(store, a.id).agent_sessions?.claude?.account === 'api'); // recorded as the turn ends, after its plan landed
    expect(activity(store, a.id)).toContain('continues on api');
  });

  it('an account with its own login folder cannot see the transcript, so it starts from a fresh brief', async () => {
    const used: Used[] = [];
    const { store, engine, root } = await setup(accountsClaude(new Set(['default']), used));
    const a = store.createItem({ title: 'Plan me', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => decisionOf(fm(store, a.id)) !== undefined);
    await engine.answerDecision(a.id, { choice: 'Continue on Work Max' });
    await waitFor(() => fm(store, a.id).status === 'PLAN_READY');
    const second = used.filter((u) => u.item === a.id)[1];
    expect(second).toMatchObject({ account: 'work', home: join(root, 'claude-work'), resume: undefined });
    expect(activity(store, a.id)).toMatch(/starting a fresh Fable 5 conversation with a brief/);
  });

  it('outages are remembered per account: the other account still blocks once it is out too, and the card leaves out spent accounts', async () => {
    const used: Used[] = [];
    const { store, engine } = await setup(accountsClaude(new Set(['default', 'api']), used));
    const a = store.createItem({ title: 'Plan me', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => decisionOf(fm(store, a.id)) !== undefined);
    await engine.answerDecision(a.id, { choice: 'Continue on api' });
    await waitFor(() => fm(store, a.id).blocked === true && decisionOf(fm(store, a.id))?.options[0].label === 'Continue on Work Max');
    expect(store.local.model_unavailable?.['fable-5@api']?.until).toBe(RESET);
    expect(decisionOf(fm(store, a.id))!.options.map((o) => o.label)).toEqual(['Continue on Work Max', 'Wait for the reset']); // the default login is out too
    await engine.answerDecision(a.id, { choice: 'Wait for the reset' });
    const after = fm(store, a.id);
    expect(after.blocked_reason).toBe('usage_exhausted');
    expect(decisionOf(after)).toBeUndefined();
    // It waits for the reset without needing anyone, and planestro retries it once then (#296).
    expect(after.op_data?.usage_retry).toEqual({ due_at: new Date(Date.parse(RESET) + 60_000).toISOString(), by: 'user' });
    expect(store.derived(store.getItem(a.id)!).needs_you).toBe(false);
  });

  it("a model row's account is where its turns run; one this machine lacks is a stop, not the default login", async () => {
    const used: Used[] = [];
    const { store, engine } = await setup(accountsClaude(new Set(), used), (y) => y.replace('claude_model: claude-fable-5, fallback: opus-5 }', 'claude_model: claude-fable-5, fallback: opus-5, account: work }').replace('claude_model: claude-opus-5 }', 'claude_model: claude-opus-5, account: elsewhere }'));
    const a = store.createItem({ title: 'Plan me', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(store, a.id).status === 'PLAN_READY');
    expect(used.filter((u) => u.item === a.id).map((u) => u.account)).toEqual(['work']);
    await engine.approvePlan(a.id);
    await waitFor(() => fm(store, a.id).blocked === true);
    expect(fm(store, a.id).blocked_reason).toBe('account_missing');
    expect(activity(store, a.id)).toMatch(/account "elsewhere".*planestro\.local\.yml/);
    expect(used.filter((u) => u.item === a.id).length).toBe(1);
  });

  it("each account has its own usage guard: one account's window holds only its own turns", async () => {
    const used: Used[] = [];
    const { store, engine } = await setup(accountsClaude(new Set(), used, { account: 'work' }), (y) => y.replace('claude_model: claude-fable-5, fallback: opus-5 }', 'claude_model: claude-fable-5, fallback: opus-5, account: work }'));
    const a = store.createItem({ title: 'Plan me', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.local.engine.provider_guards?.['claude:work'] !== undefined);
    expect(store.local.engine.provider_guards?.claude).toBeUndefined();
  });
});

describe('the orchestrator on an account (#242)', () => {
  it("wakes on its model row's account, and that account's outage holds it, not the default's", async () => {
    const used: Used[] = [];
    const { store, engine } = await setup(accountsClaude(new Set(), used), (y) => y.replace('claude_model: claude-fable-5, fallback: opus-5 }', 'claude_model: claude-fable-5, fallback: opus-5, account: work }'));
    expect(engine.orchestrator.modelForWake()).toMatchObject({ model: 'claude-fable-5', account: 'work' });
    await (engine.orchestrator as any).runWake([{ type: 'user_message', data: { text: 'hello' } }]);
    expect(used.at(-1)).toMatchObject({ account: 'work' });
    store.updateLocal({ model_unavailable: { 'fable-5': { until: RESET, reason: 'default is out' } } });
    expect((engine.orchestrator as any).unavailable()).toBe(false);
    store.updateLocal({ model_unavailable: { 'fable-5@work': { until: RESET, reason: 'work is out' } } });
    expect((engine.orchestrator as any).unavailable()).toBe(true);
  });
});

describe('Claude credentials per account', () => {
  it('a login folder replaces any API key; a key comes from the named variable', () => {
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'from-env', PLANESTRO_TEST_KEY_2: 'second' };
    expect(claudeEnv(base, 'local-key')).toMatchObject({ ANTHROPIC_API_KEY: 'local-key' });
    const work = claudeEnv(base, 'local-key', { name: 'work', home: '/h/claude-work' });
    expect(work.CLAUDE_CONFIG_DIR).toBe('/h/claude-work');
    expect(work.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeEnv(base, 'local-key', { name: 'api', apiKeyEnv: 'PLANESTRO_TEST_KEY_2' })).toMatchObject({ ANTHROPIC_API_KEY: 'second' });
    expect(claudeEnv(base, undefined, { name: 'w', home: '~/x' }, '/home/me').CLAUDE_CONFIG_DIR).toBe('/home/me/x');
  });
  it("a Codex account runs exec with its own CODEX_HOME, and the accounts' folders are secrets to workers", () => {
    expect(codexHomeOf({ name: 'c2', home: '/h/codex-2' })).toBe('/h/codex-2');
    expect(codexHomeOf(undefined)).toBe(process.env.CODEX_HOME);
    expect(secretPath('/h/claude-work/.credentials.json', '/repo', { home: '/home/me', dirs: ['/h/claude-work'], exists: () => false })).toBe("another account's config folder");
    expect(secretPath('~/.codex-2/auth.json', '/repo', { home: '/home/me', dirs: ['~/.codex-2'], exists: () => false })).toBe("another account's config folder");
    expect(secretPath('/repo/src/a.ts', '/repo', { home: '/home/me', dirs: ['/h/claude-work'], exists: () => false })).toBeNull();
  });
});
