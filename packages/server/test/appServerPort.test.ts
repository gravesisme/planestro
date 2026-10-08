import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitWritableRoots } from '../src/engine/sessions/gitWritableRoots.ts';
import { CodexAppServerPort, ScopedTools, isolatedCodexHome } from '../src/engine/sessions/CodexAppServerPort.ts';
import type { TurnOptions } from '../src/engine/ports.ts';
import { quietTransientFailure } from '../src/engine/transient.ts';
import { writeSkillsFixture } from './skillsFixture.ts';

const roots: string[] = [];
it('seeds private credentials once and preserves refresh rotation across later turns', () => {
  const root = mkdtempSync(join(tmpdir(), 'planestro-auth-fixture-')); roots.push(root);
  const source = join(root, 'source'), home = join(root, 'isolated'); mkdirSync(source);
  vi.stubEnv('CODEX_HOME', source);
  writeFileSync(join(source, 'auth.json'), '{"token":"original-fixture"}');
  isolatedCodexHome(home);
  expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
  writeFileSync(join(home, 'auth.json'), '{"token":"rotated-fixture"}');
  isolatedCodexHome(home); isolatedCodexHome(home);
  expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')).token).toBe('rotated-fixture');
  expect(JSON.parse(readFileSync(join(source, 'auth.json'), 'utf8')).token).toBe('original-fixture');
});
it('publishes a complete credential file atomically when multiple processes initialize the same home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'planestro-auth-race-')); roots.push(root);
  const source = join(root, 'source'), home = join(root, 'isolated'); mkdirSync(source);
  const token = 'fixture-only-'.repeat(100000);
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ token }));
  const module = new URL('../src/engine/sessions/CodexAppServerPort.ts', import.meta.url).href;
  const script = `import { isolatedCodexHome } from ${JSON.stringify(module)}; import { readFileSync } from 'node:fs'; isolatedCodexHome(${JSON.stringify(home)}); JSON.parse(readFileSync(${JSON.stringify(join(home, 'auth.json'))}, 'utf8'));`;
  await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, CODEX_HOME: source } })));
  expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')).token).toBe(token);
  expect(readdirSync(home)).toEqual(['auth.json']);
});
afterEach(() => { vi.unstubAllEnvs(); roots.forEach((p) => rmSync(p, { recursive: true, force: true })); roots.length = 0; });
function fixture(mode: string, passthrough?: () => readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'planestro-fake-appserver-')); roots.push(root);
  const log = join(root, 'protocol.jsonl'); const bin = join(root, 'codex');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const mode = ${JSON.stringify(mode)};
const send = (m) => process.stdout.write(JSON.stringify(m)+'\\n');
fs.writeFileSync(log+'.env', require('node:child_process').execSync('echo "secret=\${PLANTED_SECRET:-unset} gh=\${GH_TOKEN:-unset} allowed=\${PROJECT_NEEDS:-unset}"', { encoding: 'utf8' }));
process.stdin.on('end', () => fs.writeFileSync(log+'.stdin-ended','yes'));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
 const m=JSON.parse(line); fs.appendFileSync(log,JSON.stringify(m)+'\\n');
 if (m.id===100 && m.result?.decision==='accept') { send({id:101,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'after-approval',tool:'report_done',arguments:{summary:'Approved command completed'}}}); return; }
 if (m.id===100 || m.id===101) { send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn'}}}); return; }
 if (m.method==='initialize') send({id:m.id,result:{}});
 if (m.method==='config/read') send({id:m.id,result:{config:{mcp_servers:{}},layers:[{config:{mcp_servers:{unrelated:{command:'never-run'}}},disabledReason:'untrusted'}]}});
 if (m.method==='thread/start'||m.method==='thread/resume') {
  if(m.method==='thread/resume') send({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'old',tokenUsage:{total:{inputTokens:100,cachedInputTokens:50,outputTokens:10},last:{totalTokens:60}}}});
  send({id:m.id,result:{thread:{id:'thread'},model:m.params.model,reasoningEffort:m.params.config?.model_reasoning_effort??null,serviceTier:mode==='tier-dropped'?null:m.params.serviceTier??null}});
 }
 if (m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
  if(mode.endsWith('overloaded')) { if(mode==='command-overloaded') send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{type:'commandExecution',id:'cmd',command:'ls'}}}); send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',error:{message:'serverOverloaded',codexErrorInfo:'serverOverloaded'}}}}); return; }
  if(mode==='cap') { send({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{total:{inputTokens:200,cachedInputTokens:100,outputTokens:20},last:{totalTokens:120}}}}); return; }
  if(mode.startsWith('approval')) send({id:100,method:'item/commandExecution/requestApproval',params:{threadId:mode==='approval-foreign'?'other':'thread',turnId:'turn',command:'network command',cwd:${JSON.stringify(root)},environmentId:'local',...(mode==='approval-scope'?{additionalPermissions:{network:{enabled:true}}}:{})}});
  else send({id:100,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'call',tool:mode==='plan'?'submit_plan':mode==='skill'?'read_skill':'report_done',arguments:mode==='plan'?{plan:'A synthetic plan'}:mode==='skill'?{name:'release-notes'}:{summary:'Done',attach:['capture.png'],review:'Loop review'}}});
 }
 if(m.method==='turn/interrupt') { send({id:m.id,result:{}}); send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn'}}}); }
});
`;
  writeFileSync(bin, script, { mode: 0o755 });
  return { root, log, port: new CodexAppServerPort(bin, join(root, 'home'), false, passthrough) };
}
function options(root: string, overrides: Partial<TurnOptions> = {}): TurnOptions {
  const noop = async () => 'recorded';
  return { itemId: 'TEST-1', cwd: root, phase: 'implement', model: 'test-model', permissionMode: 'acceptEdits', prompt: 'Test', systemAppend: 'Test', allowedTools: [], extraDirs: [], onOutput: () => {}, onQuestion: async () => {}, onPermission: async () => ({ action: 'park' }), tools: {
    submit_plan: noop, submit_breakdown: noop, report_done: noop, report_blocked: noop, get_item: noop, hand_off: noop, add_note: noop, append_activity: noop, report_iteration: noop, report_progress: noop, request_audition: noop,
  }, ...overrides };
}
it("a worker's commands cannot read planestro's credentials; a project's codex_env_passthrough names get through (#228)", async () => {
  vi.stubEnv('PLANTED_SECRET', 'hunter2'); vi.stubEnv('GH_TOKEN', 'ghp_planted'); vi.stubEnv('PROJECT_NEEDS', 'yes');
  const plain = fixture('done');
  await plain.port.runTurn(options(plain.root));
  expect(readFileSync(plain.log + '.env', 'utf8').trim()).toBe('secret=unset gh=unset allowed=unset');
  const passing = fixture('done', () => ['PROJECT_NEEDS']);
  await passing.port.runTurn(options(passing.root));
  expect(readFileSync(passing.log + '.env', 'utf8').trim()).toBe('secret=unset gh=unset allowed=yes');
});
it('binds calls to a role, item handler, thread and turn; rejects forged arguments and stale calls', async () => {
  let calls = 0;
  const scope = new ScopedTools('thread', 'turn', [{ name: 'report_done', description: 'bound report', schema: { summary: z.string() }, handler: async () => { calls++; return 'TEST-1'; } }]);
  const p = { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'report_done', arguments: { summary: 'done' } };
  expect(await scope.call(p)).toBe('TEST-1'); expect(await scope.call(p)).toBe('TEST-1'); expect(calls).toBe(1);
  await expect(scope.call({ ...p, namespace: 'foreign' })).rejects.toThrow('namespace');
  await expect(scope.call({ ...p, arguments: { summary: 'different' } })).rejects.toThrow('reused call id');
  await expect(scope.call({ ...p, threadId: 'other' })).rejects.toThrow('foreign');
  await expect(scope.call({ ...p, tool: 'approve_plan' })).rejects.toThrow('role');
  await expect(scope.call({ ...p, arguments: { summary: 'done', id: 'TEST-2' } })).rejects.toThrow('invalid');
  scope.close(); await expect(scope.call(p)).rejects.toThrow('stale');
});
it('plans through scoped tools and keeps stdin open, with explicit read-only policy and inherited MCP disabled', async () => {
  const { root, log, port } = fixture('plan');
  const result = await port.runTurn(options(root, { phase: 'plan', permissionMode: 'plan', images: [join(root, 'reference.png')] }));
  expect(result.planSubmitted).toBe('A synthetic plan');
  expect(existsSync(log+'.stdin-ended')).toBe(false);
  const records = readFileSync(log,'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(records.find((r) => r.method==='thread/start').params).toMatchObject({ sandbox: 'read-only', config: { mcp_servers: { unrelated: { enabled: false } }, 'features.image_generation': false } });
  expect(records.find((r) => r.method==='turn/start').params.input).toContainEqual({ type: 'localImage', path: join(root, 'reference.png') });
  expect(records.find((r) => r.method==='turn/start').params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
  expect(records.find((r) => r.method==='thread/start').params.dynamicTools.map((t: any) => t.name)).not.toContain('report_done');
});
it('records approvals then declines them in the same cycle and exits without a human', async () => {
  const { root, log, port } = fixture('approval'); let persisted = false;
  const result = await port.runTurn(options(root, { onApproval: async () => {
    expect(readFileSync(log,'utf8')).not.toContain('"decision":"decline"'); persisted = true;
  } }));
  expect(persisted).toBe(true); expect(result.parked).toBe('permission');
  expect(readFileSync(log,'utf8')).toContain('"decision":"decline"');
});
it('accepts a consumed saved command grant and continues, without changing the turn sandbox', async () => {
  const { root, log, port } = fixture('approval');
  const result = await port.runTurn(options(root, { onApproval: async () => 'allow' }));
  expect(result.done).toBe('Approved command completed');
  expect(result.parked).toBeUndefined();
  const records = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(records.find((r) => r.id === 100).result).toEqual({ decision: 'accept' });
  expect(records.some((r) => r.method === 'turn/interrupt')).toBe(false);
  expect(records.find((r) => r.method === 'turn/start').params.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', networkAccess: false });
});
it.each(['approval-foreign', 'approval-scope', 'approval-throws'])('never accepts %s, even if a caller attempts a grant', async (mode) => {
  const { root, log, port } = fixture(mode);
  const approval = vi.fn(async () => { if (mode === 'approval-throws') throw new Error('persistence failed'); return 'allow' as const; });
  await port.runTurn(options(root, { onApproval: approval }));
  const records = readFileSync(log, 'utf8');
  expect(records).toContain('"decision":"decline"');
  expect(records).not.toContain('"decision":"accept"');
  if (mode === 'approval-foreign') expect(approval).not.toHaveBeenCalled();
});
it('declines if the turn is stopped while its saved approval is being consumed', async () => {
  const { root, log, port } = fixture('approval');
  const controller = new AbortController();
  await port.runTurn(options(root, { signal: controller.signal, onApproval: async () => { controller.abort(); return 'allow'; } }));
  expect(readFileSync(log, 'utf8')).not.toContain('"decision":"accept"');
});
it('retains complete lost-report arguments and exposes a connection drop', async () => {
  const { root, port } = fixture('lost'); let saved: unknown; let dropped = false;
  const o = options(root, { onUndelivered: (r) => { saved = r; }, onConnectionDrop: () => { dropped = true; } });
  o.tools.report_done = async () => { throw new Error('transport dropped'); };
  const result = await port.runTurn(o);
  expect(saved).toMatchObject({ tool: 'report_done', args: { summary: 'Done', attach: ['capture.png'], review: 'Loop review' } });
  expect(result.undelivered).toEqual(saved); expect(dropped).toBe(true);
});
it('subtracts resumed totals, interrupts at its token cap, and restates the sandbox', async () => {
  const { root, log, port } = fixture('cap');
  const result = await port.runTurn(options(root, { resume: 'thread', maxTokens: 50 }));
  expect(result.tokens).toBe(60); expect(result.subtype).toBe('token_cap');
  const records = readFileSync(log,'utf8');
  expect(records).toContain('"method":"thread/resume"'); expect(records).toContain('"sandbox":"workspace-write"');
});
it('restates narrow linked-worktree Git roots on both a start and a resume', async () => {
  const { root, log, port } = fixture('worker');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'init');
  const cwd = join(root, 'linked'); git('worktree', 'add', '-b', 'worker', cwd);
  for (const resume of [undefined, 'thread']) await port.runTurn(options(cwd, { resume }));
  const records = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const expected = [cwd, ...gitWritableRoots(cwd)];
  expect(expected.length).toBe(5);
  for (const r of records.filter((r) => ['thread/start', 'thread/resume'].includes(r.method)))
    expect(r.params.config['sandbox_workspace_write.writable_roots']).toEqual(expected);
  for (const r of records.filter((r) => r.method === 'turn/start'))
    expect(r.params.sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: expected, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
});
it('reports whether a failed turn did anything, which decides the automatic retry (#241)', async () => {
  const o = fixture('overloaded');
  const quiet = await o.port.runTurn(options(o.root));
  expect(quiet).toMatchObject({ subtype: 'runner_error', isError: true, error: 'serverOverloaded' });
  expect(quiet.acted).toBeFalsy();
  expect(quietTransientFailure(quiet)).toBe(true);
  const f = fixture('command-overloaded');
  const busy = await f.port.runTurn(options(f.root));
  expect(busy).toMatchObject({ subtype: 'runner_error', acted: true });
  expect(quietTransientFailure(busy)).toBe(false);
});
it('sends the model row\'s reasoning effort and service tier on every start, resume and turn (#245)', async () => {
  const { root, log, port } = fixture('worker');
  for (const resume of [undefined, 'thread']) {
    const result = await port.runTurn(options(root, { resume, effort: 'xhigh', serviceTier: 'priority' }));
    expect(result.isError).toBe(false);
  }
  const records = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const threads = records.filter((r) => ['thread/start', 'thread/resume'].includes(r.method));
  expect(threads.map((r) => r.method)).toEqual(['thread/start', 'thread/resume']);
  for (const r of threads) { expect(r.params.serviceTier).toBe('priority'); expect(r.params.config.model_reasoning_effort).toBe('xhigh'); }
  const turns = records.filter((r) => r.method === 'turn/start');
  expect(turns).toHaveLength(2);
  for (const r of turns) expect(r.params).toMatchObject({ effort: 'xhigh', serviceTier: 'priority' });
});
it('leaves effort and tier to Codex when the row sets neither (#245)', async () => {
  const { root, log, port } = fixture('worker');
  await port.runCustomTurn({ label: 'wake', cwd: root, model: 'test-model', permissionMode: 'dontAsk', prompt: 'Test', systemAppend: 'Test', allowedTools: [], mcpTools: [], onOutput: () => {} });
  const records = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const start = records.find((r) => r.method === 'thread/start').params; const turn = records.find((r) => r.method === 'turn/start').params;
  expect(start).not.toHaveProperty('serviceTier'); expect(start.config).not.toHaveProperty('model_reasoning_effort');
  expect(turn).not.toHaveProperty('effort'); expect(turn).not.toHaveProperty('serviceTier');
});
it('refuses the turn when the thread does not report the requested tier, as for a replaced model (#245)', async () => {
  const { root, log, port } = fixture('tier-dropped');
  const result = await port.runCustomTurn({ label: 'wake', cwd: root, model: 'test-model', effort: 'low', serviceTier: 'priority', permissionMode: 'dontAsk', prompt: 'Test', systemAppend: 'Test', allowedTools: [], mcpTools: [], onOutput: () => {} });
  expect(result).toMatchObject({ isError: true, subtype: 'runner_error' });
  expect(result.error).toMatch(/service tier priority .*not applied/i);
  expect(readFileSync(log, 'utf8')).not.toContain('"method":"turn/start"');
});

it('an orchestrator wake hands the chat\'s images to Codex as local images (#288)', async () => {
  const { root, log, port } = fixture('worker');
  await port.runCustomTurn({ label: 'user_message', cwd: root, model: 'test-model', permissionMode: 'dontAsk', prompt: 'Test', systemAppend: 'Test', allowedTools: [], mcpTools: [], onOutput: () => {}, images: [join(root, 'shot.png')] });
  const records = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(records.find((r) => r.method === 'turn/start').params.input).toContainEqual({ type: 'localImage', path: join(root, 'shot.png') });
});
it("a row with skills gets the worktree's skills by index and read_skill, writing nothing into the shared home or the worktree (#238)", async () => {
  const { root, log, port } = fixture('skill');
  const cwd = join(root, 'wt'); writeSkillsFixture(cwd);
  const result = await port.runTurn(options(cwd, { skills: true }));
  expect(result.isError).toBe(false);
  const records = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const start = records.find((r) => r.method === 'thread/start').params;
  expect(start.dynamicTools.map((t: any) => t.name)).toContain('read_skill');
  expect(start.developerInstructions).toContain('## Project skills');
  expect(start.developerInstructions).toContain('release-notes: Write the release notes section');
  expect(start.developerInstructions).not.toContain('Steps for the notes');       // bodies come on request
  expect(start.developerInstructions).toMatch(/deploy[^\n]*cannot use/);
  const answer = records.find((r) => r.id === 100).result;
  expect(answer.success).toBe(true);
  const text = answer.contentItems[0].text as string;
  expect(text).toContain('Steps for the notes');
  expect(text).toContain(join(cwd, '.claude', 'skills', 'release-notes', 'template.md'));
  expect(text).not.toMatch(/allowed-tools|^model:/m);
  expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).toBe('');
  expect(readdirSync(join(root, 'home'))).toEqual([]);
});
it('a row without skills gets neither the index nor read_skill (#238)', async () => {
  const { root, log, port } = fixture('worker');
  const cwd = join(root, 'wt'); writeSkillsFixture(cwd);
  await port.runTurn(options(cwd));
  const start = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.method === 'thread/start').params;
  expect(start.dynamicTools.map((t: any) => t.name)).not.toContain('read_skill');
  expect(start.developerInstructions).not.toContain('Project skills');
});
