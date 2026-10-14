import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { writeFileSync } from 'node:fs';
import { SETTINGS, settingDefault, looksOneOff, suggestedAllowRules, shownNumber, storedNumber, settingChanged, settingDef } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { stateView } from '../src/routes/views.ts';
import { readLocalConfig } from '../src/config.ts';
import { makeFixture, git } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

async function setup() {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir);
  const app = apiRoutes(store, new MockEngine(store, () => {}));
  const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const yml = () => YAML.parse(readFileSync(join(dataDir, 'planestro.yml'), 'utf8'));
  const lastCommit = () => git(dataDir, 'log', '-1', '--format=%s').trim();
  return { store, dataDir, send, yml, lastCommit };
}

describe('Settings writes (#83)', () => {
  it('a list edit and a number edit round-trip to planestro.yml, each as a semantic commit', async () => {
    const { send, yml, lastCommit } = await setup();
    let r = await send('PUT', '/config', { permissions: { allow: ['Bash(npm test*)'] } });
    expect(r.status).toBe(200);
    expect(yml().permissions.allow).toEqual(['Bash(npm test*)']);
    expect(lastCommit()).toBe('config: permissions.allow +"Bash(npm test*)"');
    r = await send('PUT', '/config', { ci: { timeout_min: 30 }, usage_guard: { threshold: 0.8 } });
    expect(r.status).toBe(200);
    expect(yml().ci.timeout_min).toBe(30);
    expect(yml().usage_guard.threshold).toBe(0.8);
    expect(lastCommit()).toBe('config: ci.timeout_min 30; usage_guard.threshold 0.8');
    // Sections the file never had are created; records and lists of objects are written whole.
    r = await send('PUT', '/config', { worktrees: { byproducts: ['*.import'] }, review: { max_file_bytes_by_ext: { '.ogg': 20_000_000 } }, concurrency: { runner_limits: { codex: 2 } } });
    expect(r.status).toBe(200);
    expect(yml().review.max_file_bytes_by_ext).toEqual({ '.ogg': 20_000_000 });
    expect(yml().concurrency.runner_limits).toEqual({ codex: 2 });
    r = await send('PUT', '/config', { releases: { sections: [{ title: 'Store copy', max_chars: 4000, carry: true, hint: '' }, { title: 'Notes', carry: false }] } });
    expect(r.status).toBe(200);
    expect(yml().releases.sections).toEqual([{ title: 'Store copy', max_chars: 4000, carry: true }, { title: 'Notes' }]);
  });

  it('a category gets a suggested color when added; its color changes only to a #rrggbb, only for a category that exists', async () => {
    const { send, yml, lastCommit } = await setup();
    const used = Object.values(yml().category_colors as Record<string, string>);
    expect(used).toHaveLength(yml().categories.length);
    let r = await send('POST', '/config/categories', { op: 'add', name: 'Audio' });
    expect(r.status).toBe(200);
    expect(yml().category_colors.Audio).toMatch(/^#[0-9a-f]{6}$/);
    expect(used).not.toContain(yml().category_colors.Audio);
    r = await send('POST', '/config/categories', { op: 'color', name: 'Audio', color: '#FFEE00' });
    expect(r.status).toBe(200);
    expect(yml().category_colors.Audio).toBe('#ffee00');
    expect(lastCommit()).toBe('config: category Audio color #ffee00');
    expect((await send('POST', '/config/categories', { op: 'color', name: 'Audio', color: 'red' })).status).toBe(400);
    expect((await send('POST', '/config/categories', { op: 'color', name: 'Nope', color: '#000000' })).status).toBe(400);
    r = await send('POST', '/config/categories', { op: 'add', name: 'Video', color: '#123456' });
    expect(yml().category_colors.Video).toBe('#123456');
  });

  it('null or an empty string clears a key back to its default', async () => {
    const { send, yml, lastCommit } = await setup();
    await send('PUT', '/config', { ci: { local_check_command: 'npm run build' } });
    expect(yml().ci.local_check_command).toBe('npm run build');
    expect((await send('PUT', '/config', { ci: { local_check_command: '' } })).status).toBe(200);
    expect(yml().ci).not.toHaveProperty('local_check_command');
    expect(lastCommit()).toBe('config: ci.local_check_command cleared');
    expect((await send('PUT', '/config', { notifications: { on_merge: null } })).status).toBe(200); // never set: nothing to delete, no error
  });

  it('refuses what is not an editable setting, and anything the schema or the relations reject', async () => {
    const { store, send, yml } = await setup();
    const before = readFileSync(join(store.dataDir, 'planestro.yml'), 'utf8');
    const refused = async (body: unknown, msg: RegExp) => { const r = await send('PUT', '/config', body); expect(r.status).toBe(400); expect((await r.json()).error).toMatch(msg); };
    await refused({ schema_version: 9 }, /schema_version: not a setting/);
    await refused({ ci: { nope: 1 } }, /ci\.nope: not a setting/);
    await refused({ models: [] }, /models: not changed from here/);
    await refused({ categories: ['A'] }, /categories: not changed from here/);
    await refused({ category_colors: { Game: '#000000' } }, /category_colors: not/);
    await refused({ permissions: { allow: ['Bash(ls*)', ' '] } }, /an entry is empty/);
    await refused({ permissions: { deny: ['Bash(rm*)', 'Bash(rm*)'] } }, /listed twice/);
    await refused({ permissions: { allow: 'Bash(ls*)' } }, /expected a list/);
    await refused({ concurrency: { max_sessions: 0 } }, /concurrency\.max_sessions/);
    await refused({ ci: { mode: 'jenkins' } }, /ci\.mode/);
    await refused({ code_repo: { github: 'not a repo' } }, /code_repo\.github/);
    await refused({ project: { name: '' } }, /project\.name/);
    await refused({ releases: { sections: [{ title: 'A' }, { title: 'A' }] } }, /two sections are called "A"/);
    await refused({ orchestrator: { model: 'gpt-9' } }, /orchestration capability/);
    await refused({ defaults: { implementer: 'nobody' } }, /defaults\.implementer: nobody is not a model/);
    expect(readFileSync(join(store.dataDir, 'planestro.yml'), 'utf8')).toBe(before);
    // The id prefix is free until the first item exists.
    expect((await send('PUT', '/config', { project: { id_prefix: 'NEW' } })).status).toBe(200);
    expect(yml().project.id_prefix).toBe('NEW');
    store.createItem({ title: 'first' });
    await refused({ project: { id_prefix: 'OTHER' } }, /fixed once the project has items/);
  });

  it('the orchestrator model is written as a model id', async () => {
    const { send, yml } = await setup();
    expect((await send('PUT', '/config', { orchestrator: { model: 'claude-opus-5' } })).status).toBe(200);
    expect(yml().orchestrator.model).toBe('opus-5');
  });

  it('model rows: add, edit, and refuse what would break items or planners', async () => {
    const { store, send, yml, lastCommit } = await setup();
    const refused = async (method: string, path: string, body: unknown, msg: RegExp) => { const r = await send(method, path, body); expect(r.status).toBe(400); expect((await r.json()).error).toMatch(msg); };
    let r = await send('PUT', '/config/models/codex-art', { label: 'Codex Art', runner: 'codex', hold_for_review: true, description: 'All raster art', claude_model: '' });
    expect(r.status).toBe(200);
    expect(yml().models.at(-1)).toEqual({ id: 'codex-art', label: 'Codex Art', runner: 'codex', description: 'All raster art', hold_for_review: true });
    expect(lastCommit()).toBe('config: add model codex-art');
    await refused('PUT', '/config/models/opus-5', { label: 'Opus 5', claude_model: 'claude-opus-5', fallback: 'fable-5' }, /loops back/); // fable-5 already falls back to opus-5
    r = await send('PUT', '/config/models/opus-5', { id: 'opus-5', label: 'Opus 5 (big)', claude_model: 'claude-opus-5', mcp: ['elevenlabs'], mcp_calls_per_item: 5 });
    expect(r.status).toBe(200);
    expect(yml().models.find((m: { id: string }) => m.id === 'opus-5')).toEqual({ id: 'opus-5', label: 'Opus 5 (big)', claude_model: 'claude-opus-5', mcp: ['elevenlabs'], mcp_calls_per_item: 5 });
    expect(lastCommit()).toBe('config: edit model opus-5');
    expect(store.config.models.find((m) => m.id === 'opus-5')?.label).toBe('Opus 5 (big)');

    // Reasoning effort and service tier (#245): Codex rows only, from the values Codex offers.
    r = await send('PUT', '/config/models/codex-fast', { label: 'Codex fast', runner: 'codex', codex_model: 'gpt-x', codex_transport: 'app-server', codex_effort: 'low', codex_tier: 'priority' });
    expect(r.status).toBe(200);
    expect(yml().models.find((m: { id: string }) => m.id === 'codex-fast')).toMatchObject({ codex_effort: 'low', codex_tier: 'priority' });
    await refused('PUT', '/config/models/codex-fast', { label: 'Codex fast', runner: 'codex', codex_tier: 'flex' }, /codex_tier: .*default or priority/);
    await refused('PUT', '/config/models/codex-fast', { label: 'Codex fast', runner: 'codex', codex_effort: 'turbo' }, /codex_effort: .*low, medium, high or xhigh/);
    await refused('PUT', '/config/models/opus-5', { label: 'Opus 5', claude_model: 'claude-opus-5', codex_tier: 'priority' }, /only a Codex model/);
    // Project skills (#238): a Codex row's switch; Claude sessions already load them.
    r = await send('PUT', '/config/models/codex-fast', { label: 'Codex fast', runner: 'codex', codex_model: 'gpt-x', skills: true });
    expect(r.status).toBe(200);
    expect(yml().models.find((m: { id: string }) => m.id === 'codex-fast')).toMatchObject({ skills: true });
    await refused('PUT', '/config/models/opus-5', { label: 'Opus 5', claude_model: 'claude-opus-5', skills: true }, /only a Codex model.*skills/);
    // The image tool on app-server (HH-540): an app-server row's switch; exec always has it, Claude never.
    r = await send('PUT', '/config/models/codex-fast', { label: 'Codex fast', runner: 'codex', codex_model: 'gpt-x', codex_transport: 'app-server', native_images: true });
    expect(r.status).toBe(200);
    expect(yml().models.find((m: { id: string }) => m.id === 'codex-fast')).toMatchObject({ codex_transport: 'app-server', native_images: true });
    await refused('PUT', '/config/models/codex-fast', { label: 'Codex fast', runner: 'codex', codex_model: 'gpt-x', native_images: true }, /native_images is for a Codex app-server row/);
    await refused('PUT', '/config/models/opus-5', { label: 'Opus 5', claude_model: 'claude-opus-5', native_images: true }, /native_images is for a Codex app-server row/);
    expect((await send('DELETE', '/config/models/codex-fast')).status).toBe(200);
    await refused('PUT', '/config/models/opus-5', { id: 'opus-6', label: 'x', claude_model: 'c' }, /id cannot change/);
    await refused('PUT', '/config/models/bad id', { label: 'x', claude_model: 'c' }, /letters, digits/);
    await refused('PUT', '/config/models/new-one', { label: 'New' }, /needs its Claude model id/);
    await refused('PUT', '/config/models/new-one', { label: 'New', claude_model: 'c', fallback: 'codex-art' }, /runs on codex, not claude/);
    await refused('PUT', '/config/models/new-one', { label: 'New', claude_model: 'c', surprise: true }, /surprise|Unrecognized/i);
    await refused('PUT', '/config/models/fable-5', { label: 'Fable', runner: 'codex' }, /defaults\.planner: Fable cannot plan/);
    await refused('DELETE', '/config/models/fable-5', undefined, /the default planner/);
    await refused('DELETE', '/config/models/nobody', undefined, /unknown model/);
    const item = store.createItem({ title: 'art', implementer: 'codex-art' });
    await refused('DELETE', '/config/models/codex-art', undefined, new RegExp(item.id));
    store.deleteItem(item.id);
    expect((await send('DELETE', '/config/models/codex-art')).status).toBe(200);
    expect(yml().models.map((m: { id: string }) => m.id)).toEqual(['fable-5', 'opus-5']);
    expect(lastCommit()).toBe('config: remove model codex-art');
  });
});

describe('no model API key (sessions run on the CLIs\' logins)', () => {
  it('Settings has no key to set, and the state says nothing about billing', async () => {
    const { store, send } = await setup();
    const r = await send('PUT', '/config/local', { anthropic_api_key: 'sk-ant-test-0123456789' });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/anthropic_api_key: not a setting/);
    const v = stateView(store, new MockEngine(store, () => {}), {});
    expect(v).not.toHaveProperty('billing');
    expect(v).not.toHaveProperty('api_key');
  });

  it('a planestro.local.yml from before loses its key and key-only accounts at load, and says so once', async () => {
    const { dataDir } = makeFixture();
    const secret = 'sk-ant-test-0123456789';
    writeFileSync(join(dataDir, 'planestro.local.yml'), YAML.stringify({
      anthropic_api_key: secret, allowed_hosts: ['mac.tailnet.ts.net'],
      accounts: { api: { runner: 'claude', api_key_env: 'ANTHROPIC_KEY_2' }, work: { runner: 'claude', home: '~/.claude-work', api_key_env: 'K' } },
    }));
    const said: string[] = [];
    const log = console.log; console.log = (m: string) => { said.push(m); };
    try { readLocalConfig(dataDir); readLocalConfig(dataDir); } finally { console.log = log; }
    const file = readFileSync(join(dataDir, 'planestro.local.yml'), 'utf8');
    expect(file).not.toContain(secret);
    expect(file).not.toContain('api_key_env');
    const local = YAML.parse(file);
    expect(local.allowed_hosts).toEqual(['mac.tailnet.ts.net']);
    expect(local.accounts).toEqual({ work: { runner: 'claude', home: '~/.claude-work' } }); // an item on "api" now blocks account_missing
    expect(said).toEqual([
      expect.stringMatching(/removed anthropic_api_key/),
      expect.stringMatching(/removed account api/),
      expect.stringMatching(/removed accounts\.work\.api_key_env/),
    ]); // the file is rewritten, so the second load is silent
  });

  it('MCP server keys are masked', async () => {
    const { store } = await setup();
    store.updateLocal({ mcp_servers: { eleven: { command: 'uvx', args: [], env: { ELEVENLABS_API_KEY: 'el-secret' }, headers: {} } } });
    const v = stateView(store, new MockEngine(store, () => {}), {});
    expect(v.local.mcp_servers.eleven.env).toEqual({ ELEVENLABS_API_KEY: '(set)' });
    expect(JSON.stringify(v)).not.toContain('el-secret');
  });
});

describe('the settings registry', () => {
  it('reads defaults from the schema and compares values to them', () => {
    expect(settingDefault('config', 'budget_usd_per_item')).toEqual({ value: 25 });
    expect(settingDefault('config', 'worktrees.byproducts')).toEqual({ value: [] });
    expect(settingDefault('config', 'code_repo.release_branch')).toEqual({ none: true });
    expect(settingDefault('config', 'project.name')).toBeUndefined();
    const threshold = settingDef('config', 'usage_guard.threshold')!;
    expect(shownNumber(threshold, 0.85)).toBe(85);
    expect(storedNumber(threshold, 85)).toBe(0.85);
    expect(settingChanged(threshold, 0.85)).toBe(false);
    expect(settingChanged(threshold, 0.8)).toBe(true);
    expect(settingChanged(settingDef('config', 'ci.local_check_command')!, 'npm test')).toBe(true);
    expect(settingChanged(settingDef('config', 'project.name')!, 'Anything')).toBe(false);
  });

  it('every row has a summary, a unique key per file, and options where it needs them', () => {
    const ids = SETTINGS.map((s) => `${s.file}:${s.key}`);
    expect(ids.filter((k, i) => ids.indexOf(k) !== i)).toEqual([]);
    expect(SETTINGS.filter((s) => !s.label || !s.summary).map((s) => s.key)).toEqual([]);
    expect(SETTINGS.filter((s) => s.control === 'select' && !s.options?.length).map((s) => s.key)).toEqual([]);
  });

  it('offers worktree-scoped rules for the toolchains the repository has, less what the list covers (#96)', async () => {
    expect(suggestedAllowRules([])).toEqual([]);
    expect(suggestedAllowRules(['Makefile', 'go.mod'])).toEqual(['Bash(go build *)@worktree', 'Bash(go test *)@worktree', 'Bash(go vet *)@worktree', 'Bash(make *)@worktree']);
    // Two markers of one toolchain offer each rule once; a rule the list holds, scoped or not, is not offered again.
    expect(suggestedAllowRules(['pyproject.toml', 'requirements.txt'], ['Bash(pytest *)'])).toEqual(['Bash(python3 *)@worktree']);
    expect(suggestedAllowRules(['package.json'], ['Bash(npm run *)', 'Bash(node *)@worktree', ' Bash(npx tsx *) '])).toEqual(['Bash(npm test *)@worktree', 'Bash(npx tsc *)@worktree', 'Bash(npx vitest *)@worktree']);
    expect(looksOneOff('Bash(npm run *)@worktree')).toBe(false);

    const { store, send } = await setup();
    const codeRepo = store.codeRepoPath();
    expect(stateView(store, new MockEngine(store, () => {}), {}).toolchain).toEqual([]);
    writeFileSync(join(codeRepo, 'package.json'), '{}');
    writeFileSync(join(codeRepo, 'Makefile'), 'all:\n');
    expect(stateView(store, new MockEngine(store, () => {}), {}).toolchain).toEqual(['package.json', 'Makefile']);
    // A scoped rule is saved as written.
    const res = await send('PUT', '/config', { permissions: { allow: ['Bash(npm run *)@worktree'] } });
    expect(res.status).toBe(200);
    expect(store.config.permissions.allow).toEqual(['Bash(npm run *)@worktree']);
  });

  it('marks allow-list entries that look like one-off commands', () => {
    expect(looksOneOff('Bash(npm run *)')).toBe(false);
    expect(looksOneOff('Bash(git grep *)')).toBe(false);
    expect(looksOneOff('Bash(npm install --save-exact n8ao@2.0.1 2>&1 | tail -5)')).toBe(true);
    expect(looksOneOff('Bash(ls tmp && rm tmp/a.png)')).toBe(true);
    expect(looksOneOff('Read(./src/**)')).toBe(false);
  });
});
