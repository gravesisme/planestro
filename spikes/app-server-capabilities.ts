/** Manual, authenticated, disposable app-server capability probe; never run by CI. */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection, isolatedCodexHome } from '../packages/server/src/engine/sessions/CodexAppServerPort.ts';
const root = mkdtempSync(join(tmpdir(), 'planestro-capability-'));
const cwd = join(root, 'workspace'); mkdirSync(cwd);
const home = isolatedCodexHome(join(root, 'home'));
const canary = join(root, 'mcp-started');
mkdirSync(join(cwd, '.codex'));
writeFileSync(join(cwd, '.codex/config.toml'), '[mcp_servers.canary]\ncommand = "sh"\nargs = ["-c", "touch ' + canary + '; cat"]\n');
const outside = join(root, 'outside.txt');
writeFileSync(outside, 'unchanged');
const source = join(cwd, 'source.png');
writeFileSync(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64'));
let resume: string | undefined;
async function run(label: string, prompt: string, image = false) {
  const rpc = new Connection(process.env.PLANESTRO_CODEX_BIN ?? 'codex', home, home);
  const approvals: string[] = [], types = new Set<string>(), outputs: string[] = [];
  let finish!: () => void, thread = '', turn = '', error: unknown;
  const done = new Promise<void>((r) => { finish = r; });
  let calls = 0;
  rpc.handler = (m) => {
    const p = m.params ?? {};
    if (m.method === 'turn/started') turn = p.turn.id;
    if (m.method === 'item/completed') { types.add(p.item.type); if (p.item.type === 'imageGeneration') outputs.push(p.item.status ?? 'image'); }
    if (m.method === 'turn/completed') { error = p.turn.error; finish(); }
    if (m.method === 'item/tool/call') { calls++; void rpc.send({ id: m.id, result: { contentItems: [{ type: 'inputText', text: 'Validated' }], success: true } }); }
    else if (m.id !== undefined && m.method?.endsWith('/requestApproval')) {
      approvals.push(m.method);
      void rpc.send({ id: m.id, result: m.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' } });
    } else if (m.id !== undefined && m.method) void rpc.send({ id: m.id, error: { message: 'Unsupported probe request' } });
  };
  const timer = setTimeout(() => { void rpc.request('turn/interrupt', { threadId: thread, turnId: turn }).catch(() => {}); finish(); }, 90_000);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'planestro-validation', version: '1' }, capabilities: { experimentalApi: true } });
    await rpc.send({ method: 'initialized', params: {} });
    const effective = await rpc.request('config/read', { cwd, includeLayers: true });
    const names = new Set([effective.config, ...effective.layers.map((l: any) => l.config)].flatMap((c) => Object.keys(c?.mcp_servers ?? {})));
    const disabled = Object.fromEntries([...names].map((name) => [name, { enabled: false, command: process.execPath, args: ['-e', 'process.exit(1)'] }]));
    const r = await rpc.request(resume ? 'thread/resume' : 'thread/start', { model: process.env.PLANESTRO_CODEX_MODEL ?? 'gpt-6-astra', cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', config: { mcp_servers: disabled },
      ...(resume ? { threadId: resume } : { dynamicTools: [{ type: 'function', name: 'validation_ping', description: 'Confirm the parent stdio connection is still alive', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }) });
    thread = r.thread.id; resume = thread;
    await rpc.request('turn/start', { threadId: thread, cwd, approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      input: [{ type: 'text', text: prompt, text_elements: [] }, ...(image ? [{ type: 'localImage', path: source }] : [])] });
    await Promise.race([done, rpc.closed]);
    console.log(JSON.stringify({ label, types: [...types], approvals, dynamicCalls: calls, imageOutputs: outputs, error, inheritedMcpStarted: existsSync(canary) }));
  } finally { clearTimeout(timer); await rpc.stop(); }
}
try {
  await run('workspace and open stream', 'Run a shell command which sleeps for 1 second then writes inside.txt containing ok in the working directory. After it finishes, call validation_ping and end. Do not use any MCP server.');
  await run('resumed sandbox', 'Run a shell command that writes resumed.txt inside the working directory, then call validation_ping and finish.');
  const { readFileSync } = await import('node:fs');
  console.log(JSON.stringify({ label: 'sandbox evidence', inside: existsSync(join(cwd, 'inside.txt')), resumedWrite: existsSync(join(cwd, 'resumed.txt')), outsideUnchanged: readFileSync(outside, 'utf8') === 'unchanged' }));
  if (process.argv.includes('--images')) await run('image generation', 'If a native image generation tool is available, generate one simple 64 pixel blue circle on white and save it in this working directory. Do not create an image with code or shell. If that tool is unavailable, say unavailable and stop.');
  if (process.argv.includes('--images')) await run('image-to-image', 'If a native image editing tool is available, use the attached image as input and turn it into a small red square. Do not create an image with code or shell. If unavailable, say unavailable and stop.', true);
} finally { rmSync(root, { recursive: true, force: true }); }
