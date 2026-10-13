import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, existsSync, copyFileSync, chmodSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { budgetTokens, TurnTokenCounter, codexSplit, emptySplit, splitMinus } from '@planestro/shared';
import type { AgentPort, TurnOptions, CustomTurnOptions, CustomToolDef, TurnResult, UndeliveredReport } from '../ports.ts';
import { workerTools } from './workerTools.ts';
import { externalTools } from './externalTools.ts';
import { gitWritableRoots } from './gitWritableRoots.ts';
import { commandGrant } from './nativeApproval.ts';
import { projectSkills, skillIndex, readSkillTool } from './projectSkills.ts';

export const CODEX_TOOL_CONTRACT = 'app-server-v1';
const REPORTS = new Set(['submit_plan', 'submit_breakdown', 'report_done', 'report_blocked']);
type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string } };

/** One process owns one role and one turn. Never an HTTP/operator MCP connection. */
export class ScopedTools {
  private active = true;
  private calls = new Map<string, { fingerprint: string; answer: Promise<string> }>();
  constructor(readonly thread: string, readonly turn: string, private readonly tools: CustomToolDef[]) {}
  close() { this.active = false; }
  validate(p: { threadId: string; turnId: string; namespace?: string | null; tool: string; arguments: unknown }): Record<string, unknown> {
    if (!this.active || p.threadId !== this.thread || p.turnId !== this.turn) throw new Error('Rejected: stale or foreign turn');
    if (p.namespace != null) throw new Error('Rejected: foreign tool namespace');
    const def = this.tools.find((d) => d.name === p.tool);
    if (!def) throw new Error('Rejected: tool unavailable to this role');
    try { return (def.inputSchema ? z.fromJSONSchema(def.inputSchema as any) : z.strictObject(def.schema as z.ZodRawShape)).parse(p.arguments) as Record<string, unknown>; }
    catch { throw new Error('Rejected: invalid tool arguments'); }
  }
  async call(p: { threadId: string; turnId: string; callId: string; namespace?: string | null; tool: string; arguments: unknown }): Promise<string> {
    if (!this.active || p.threadId !== this.thread || p.turnId !== this.turn) throw new Error('Rejected: stale or foreign turn');
    const def = this.tools.find((d) => d.name === p.tool);
    if (!def) throw new Error('Rejected: tool unavailable to this role');
    const args = this.validate(p);
    // Retransmission must never repeat a mutation or spend an external call.
    const fingerprint = JSON.stringify([p.tool, args]);
    const previous = this.calls.get(p.callId);
    if (previous && previous.fingerprint !== fingerprint) throw new Error('Rejected: reused call id with different arguments');
    if (!previous) this.calls.set(p.callId, { fingerprint, answer: def.handler(args) });
    return this.calls.get(p.callId)!.answer;
  }
}

/** Dedicated Codex home preserves threads while excluding personal settings and MCP servers. `authFrom`: the login it is seeded from (a named account's home, #242). */
export function isolatedCodexHome(path: string, inheritAuth = true, authFrom = process.env.CODEX_HOME ?? join(homedir(), '.codex')): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const auth = join(authFrom, 'auth.json');
  const destination = join(path, 'auth.json');
  if (inheritAuth && !existsSync(destination) && existsSync(auth)) {
    // Seed once: Codex owns refresh-token rotation in this home thereafter. Publish
    // a complete private file atomically; another process may win initialization.
    const temporary = join(path, `.auth-${randomUUID()}`);
    try {
      copyFileSync(auth, temporary); chmodSync(temporary, 0o600);
      try { linkSync(temporary, destination); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  return path;
}
/**
 * How to sign in again where an app-server turn reads its login: its own home, not ~/.codex, which it copied once
 * and never reads again, so a plain `codex login` does not reach it.
 */
export function loginHint(home: string): string {
  const shown = home.startsWith(homedir() + '/') ? `~/${home.slice(homedir().length + 1)}` : home;
  return `Sign in for planestro with \`CODEX_HOME=${shown} codex login\` (a plain \`codex login\` signs in ~/.codex, which planestro does not read).`;
}
/**
 * The only environment a Codex process gets, on either transport: its commands inherit it, so planestro's
 * GH_TOKEN, *_API_KEY, AWS_* never reach a worker (#228). `passthrough` is the project's codex_env_passthrough;
 * the home is set last, so a listed CODEX_HOME cannot point an app-server back at the shared login.
 */
export function codexEnv(passthrough: readonly string[] = [], home = process.env.CODEX_HOME): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'SYSTEMROOT', ...passthrough]) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (home) env.CODEX_HOME = home;
  return env;
}

export class Connection {
  private next = 0;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  handler: (message: Rpc) => void = () => {};
  stderr = '';
  constructor(bin: string, home: string, cwd: string, passthrough: readonly string[] = []) {
    this.child = spawn(bin, ['app-server', '--stdio', '-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.multi_agent=false', '-c', 'features.plugins=false', '-c', 'features.skill_mcp_dependency_install=false', '-c', 'features.skip_host_skill_discovery=true'], { cwd, env: codexEnv(passthrough, home), stdio: 'pipe' });
    // Deliberately keep stdin open. It carries replies until the turn and tool work are over.
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let m: Rpc; try { m = JSON.parse(line); } catch { return; }
      if (m.method) this.handler(m);
      else if (typeof m.id === 'number') {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message)); else p?.resolve(m.result);
      }
    });
    this.child.stderr.on('data', (b) => { this.stderr = (this.stderr + String(b)).slice(-4000); });
    this.child.stdin.on('error', () => {});
    this.closed = new Promise((resolve) => {
      const finish = () => { for (const p of this.pending.values()) p.reject(new Error('app-server connection closed')); this.pending.clear(); resolve(); };
      this.child.once('error', finish); this.child.once('close', finish);
    });
  }
  send(m: Rpc): Promise<void> { return new Promise((resolve, reject) => this.child.stdin.write(JSON.stringify(m) + '\n', (e) => e ? reject(e) : resolve())); }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`app-server ${method} timed out`)); }, 60_000); timer.unref();
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      void this.send({ id, method, params }).catch((e) => { this.pending.get(id)?.reject(e); this.pending.delete(id); });
    });
  }
  async stop() {
    this.child.kill('SIGTERM');
    const force = setTimeout(() => this.child.kill('SIGKILL'), 2000); force.unref();
    await this.closed; clearTimeout(force);
  }
}

export class CodexAppServerPort implements AgentPort {
  constructor(private readonly bin = 'codex', private readonly home = join(homedir(), '.planestro', 'codex'), private readonly inheritAuth = true, private readonly passthrough: () => readonly string[] = () => []) {}
  /**
   * The isolated home a turn's account gets (#242): the default login's, or one per named account beside it, seeded from
   * that account's own CODEX_HOME. Each keeps its own threads, so a thread does not follow an item onto another account.
   */
  private homeFor(o: TurnOptions | CustomTurnOptions): { home: string; authFrom?: string } {
    if (!o.account?.home) return { home: this.home };
    const from = o.account.home.startsWith('~/') ? join(homedir(), o.account.home.slice(2)) : o.account.home;
    return { home: `${this.home}-${o.account.name}`, authFrom: from };
  }
  async runTurn(o: TurnOptions): Promise<TurnResult> {
    const result: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', tokens: 0 };
    // Reference reading passed the read-only live probe (2026-10-07). This does not
    // enable image creation/editing: features.image_generation is always false below.
    const bridge = await externalTools(o, () => { result.parked = 'permission'; });
    try {
      // The project's skills (#238): an index now, each one's text read from the worktree when asked.
      const skills = o.skills ? projectSkills(o.cwd) : [];
      const tools = [...workerTools(o, result), ...bridge.tools, ...(skills.length ? [readSkillTool(o.cwd)] : []), {
        name: 'ask_question', description: 'Persist a question for the user, then end this turn.',
        schema: { question: z.string() }, handler: async (a: Record<string, unknown>) => {
          await o.onQuestion([{ question: a.question, header: 'Codex asks', options: [] }]); result.parked = 'question';
          return 'Recorded by planestro — end this turn';
        },
      }];
      return await this.run(o, tools, result, skillIndex(skills));
    } finally { await bridge.close(); }
  }
  async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
    return this.run(o, o.mcpTools, { subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', tokens: 0 });
  }
  private async run(o: TurnOptions | CustomTurnOptions, tools: CustomToolDef[], result: TurnResult, skills = ''): Promise<TurnResult> {
    const worker = 'itemId' in o;
    const readOnly = !worker || o.phase === 'plan';
    const at = this.homeFor(o);
    const home = isolatedCodexHome(at.home, this.inheritAuth, at.authFrom);
    const rpc = new Connection(this.bin, home, home, this.passthrough());
    let scope: ScopedTools | undefined, thread: string | undefined, turn: string | undefined;
    let finish!: () => void;
    const ended = new Promise<void>((r) => { finish = r; });
    let completed = false, stopped = false, serial = Promise.resolve();
    let counter = new TurnTokenCounter();
    let baseline = 0;
    let splitBase = emptySplit();
    const drop = (error: string, tool?: string) => {
      result.connectionDrop ??= { error, at: new Date().toISOString(), ...(tool ? { tool } : {}) };
      if (worker) o.onConnectionDrop?.(result.connectionDrop);
    };
    const interrupt = () => {
      if (stopped) return;
      stopped = true;
      if (!thread || !turn) { void rpc.stop(); finish(); return; }
      // Let the peer consume the preceding decline/tool reply before terminating it.
      const timeout = setTimeout(finish, 2000);
      void rpc.request('turn/interrupt', { threadId: thread, turnId: turn }).catch(() => {}).finally(() => { clearTimeout(timeout); finish(); });
    };
    const aborted = () => { result.subtype = 'killed'; interrupt(); };
    const respond = (m: Rpc, value: unknown) => rpc.send({ id: m.id, result: value });
    rpc.handler = (m) => {
      const p = m.params ?? {};
      // Token/turn notifications are handled immediately, even while a tool is working.
      if (m.method === 'thread/tokenUsage/updated' && (p.threadId === thread || (!thread && p.threadId === o.resume))) {
        const u = p.tokenUsage;
        if (!turn) { baseline = budgetTokens({ input_tokens: u.total.inputTokens, cached_input_tokens: u.total.cachedInputTokens, output_tokens: u.total.outputTokens }); counter = new TurnTokenCounter(baseline); splitBase = codexSplit(u.total); }
        else if (p.turnId === turn) {
          result.tokens = counter.update(u.total);
          result.usage = splitMinus(codexSplit(u.total), splitBase);
          result.contextTokens = u.last?.totalTokens;
          if (o.maxTokens !== undefined && result.tokens >= o.maxTokens && !stopped) { result.subtype = 'token_cap'; result.isError = true; result.error = 'Token limit reached'; interrupt(); }
        }
        return;
      }
      if (m.method === 'turn/started' && p.threadId === thread && !turn) { turn = p.turn.id; scope = new ScopedTools(thread!, turn!, tools); return; }
      if (m.method === 'turn/completed' && p.threadId === thread && p.turn.id === turn) {
        completed = true;
        if (p.turn.error && result.subtype === 'success') {
          // Unauthorized was verified with an isolated, unauthenticated live fixture. Quota
          // error variants are not yet verified: do not turn unknown failures into usage data.
          result.subtype = p.turn.error.codexErrorInfo === 'unauthorized' || /401 Unauthorized/.test(p.turn.error.message ?? '') ? 'auth_required' : 'runner_error';
          result.isError = true; result.error = result.subtype === 'auth_required' ? `${p.turn.error.message} ${loginHint(home)}` : p.turn.error.message;
        }
        finish(); return;
      }
      if (m.method === 'item/agentMessage/delta' && p.threadId === thread && p.turnId === turn) { result.text += p.delta ?? ''; result.acted = true; o.onOutput(String(p.delta ?? '')); return; }
      // A command, a file change or a tool call is the turn doing something, whether or not it reaches planestro (#241).
      if (m.method === 'item/started' && p.threadId === thread && p.turnId === turn && !['userMessage', 'reasoning'].includes(p.item?.type)) { result.acted = true; return; }
      if (m.method === 'item/tool/call' || m.method?.endsWith('/requestApproval') || m.method === 'item/tool/requestUserInput') result.acted = true;
      if (m.id === undefined) return;
      serial = serial.then(async () => {
        if (m.method === 'item/tool/call') {
          const valid = scope && p.threadId === thread && p.turnId === turn && !stopped;
          const isReport = valid && REPORTS.has(p.tool);
          let report: UndeliveredReport | undefined;
          if (isReport) report = { tool: p.tool, args: p.arguments, error: 'tool dispatch interrupted' };
          try {
            if (!valid) throw new Error('Rejected: stale or foreign turn');
            scope!.validate(p);
            // Persist the report intent before dispatch; idempotent handlers make restart ingestion safe.
            if (report && worker) { result.undelivered = report; o.onUndelivered?.(report); }
            const answer = await scope!.call(p);
            if (report && worker) { result.undelivered = undefined; o.onUndelivered?.(undefined); }
            await respond(m, { contentItems: [{ type: 'inputText', text: answer }], success: !/^(Rejected|Not allowed)/i.test(answer) });
            if (result.parked) interrupt();
          } catch (e) {
            const message = (e as Error).message;
            if (!/^Rejected|ZodError/.test(message) && report) drop(message, p.tool);
            await respond(m, { contentItems: [{ type: 'inputText', text: message }], success: false }).catch(() => drop(message, p.tool));
          }
        } else if (m.method?.endsWith('/requestApproval')) {
          let allowed = false;
          try {
            if (stopped || p.threadId !== thread || p.turnId !== turn) throw new Error('Rejected: stale or foreign approval');
            const req = { tool: 'CodexApproval', input: { ...p, method: m.method } };
            if (o.onApproval) {
              const decision = await o.onApproval(req);
              allowed = worker && decision === 'allow' && !!commandGrant(req) && !stopped && !o.signal?.aborted;
            }
            else if (worker) await o.onPermission(req);
            else throw new Error('Approval could not be recorded');
            if (!allowed) result.parked = 'permission';
          } finally {
            // No promise is held for a human. Only a previously persisted exact grant accepts;
            // everything else is recorded, declined in this cycle, and ends the process.
            await respond(m, m.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: allowed ? 'accept' : 'decline' });
            if (!allowed) interrupt();
          }
        } else if (m.method === 'item/tool/requestUserInput') {
          if (!stopped && p.threadId === thread && p.turnId === turn) {
            if (worker) { await o.onQuestion(p.questions ?? []); result.parked = 'question'; }
            else await o.onApproval?.({ tool: 'CodexQuestion', input: { questions: p.questions ?? [] } });
          }
          await respond(m, { answers: {} }); interrupt();
        } else { await rpc.send({ id: m.id, error: { message: 'Unsupported app-server request' } }); }
      }).catch((e) => { result.isError = true; result.error = (e as Error).message; result.subtype = 'runner_error'; interrupt(); });
    };
    o.signal?.addEventListener('abort', aborted, { once: true });
    try {
      if (o.signal?.aborted) { aborted(); return result; }
      await rpc.request('initialize', { clientInfo: { name: 'planestro', version: '1' }, capabilities: { experimentalApi: true } });
      await rpc.send({ method: 'initialized', params: {} });
      // Read effective project layers before opening a thread. Explicitly disable every inherited
      // server; an empty TOML table alone may merge with a project table instead of replacing it.
      const effective = await rpc.request('config/read', { cwd: o.cwd, includeLayers: true });
      if (!Array.isArray(effective.layers)) throw new Error('App-server did not expose config layers; MCP isolation cannot be verified');
      // Effective config hides project servers behind the CLI empty table. Thread start can
      // reload those layers: enumerate ALL layers, even ones marked untrusted/disabled.
      const names = new Set<string>([effective.config, ...effective.layers.map((l: any) => l.config)].flatMap((c) => Object.keys(c?.mcp_servers ?? {})));
      const disabled = Object.fromEntries([...names].map((name) => [name, { enabled: false, command: process.execPath, args: ['-e', 'process.exit(1)'] }]));
      const writableRoots = readOnly ? [] : [o.cwd, ...gitWritableRoots(o.cwd)];
      // Effort has no thread/start or thread/resume field: the config key carries it there, `effort` on the turn (#245).
      const tier = o.serviceTier ? { serviceTier: o.serviceTier } : {};
      const params = { model: o.model, allowProviderModelFallback: false, cwd: o.cwd, sandbox: readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'on-request', ...tier,
        config: { web_search: 'disabled', ...(o.effort ? { model_reasoning_effort: o.effort } : {}), 'sandbox_workspace_write.writable_roots': writableRoots, mcp_servers: disabled, 'features.apps': false, 'features.multi_agent': false, 'features.plugins': false, 'features.image_generation': false, 'features.skill_mcp_dependency_install': false, 'features.skip_host_skill_discovery': true }, developerInstructions: `${o.systemAppend}\n\nApp-server tool contract: use the provided dynamic tools to report; a final text message does not submit a report. Use ask_question for a worker question. During planning do not edit or commit. During implementation use apply_patch for file edits. Keep scratch files inside the worktree. Native image work is not enabled for this transport.${skills ? `\n\n${skills}` : ''}`,
        ...(o.resume ? { threadId: o.resume } : { dynamicTools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema ?? z.toJSONSchema(z.strictObject(t.schema as z.ZodRawShape)) })) }) };
      const started = await rpc.request(o.resume ? 'thread/resume' : 'thread/start', params);
      if (o.model && started.model !== o.model) throw new Error(`Requested model ${o.model} was replaced with ${started.model}`);
      // A tier the model does not offer is dropped silently (validated live, 0.154.0): refuse rather than run at another speed.
      if (o.serviceTier && started.serviceTier !== o.serviceTier) throw new Error(`Requested service tier ${o.serviceTier} was not applied (the thread reports ${started.serviceTier ?? 'none'}); the model may not offer it`);
      if (o.effort && started.reasoningEffort !== o.effort) throw new Error(`Requested reasoning effort ${o.effort} was not applied (the thread reports ${started.reasoningEffort ?? 'none'})`);
      thread = started.thread.id; result.sessionId = thread;
      // Resumes emit the previous total before the new turn; read it explicitly as well.
      const usage = started.thread.tokenUsage?.total;
      if (usage) { counter = new TurnTokenCounter(budgetTokens({ input_tokens: usage.inputTokens, cached_input_tokens: usage.cachedInputTokens, output_tokens: usage.outputTokens })); splitBase = codexSplit(usage); }
      const t = await rpc.request('turn/start', { threadId: thread, model: o.model, cwd: o.cwd, approvalPolicy: 'on-request', ...(o.effort ? { effort: o.effort } : {}), ...tier,
        sandboxPolicy: readOnly ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        input: [{ type: 'text', text: o.prompt, text_elements: [] }, ...(o.images ?? []).map((path) => ({ type: 'localImage', path }))] });
      turn ??= t.turn.id; scope ??= new ScopedTools(thread!, turn!, tools);
      await Promise.race([ended, rpc.closed]);
      await serial;
      if (!completed && !stopped) { drop('app-server connection closed before turn completion'); result.subtype = 'connection_lost'; result.isError = true; }
      result.lastMessage = result.text;
      return result;
    } catch (e) {
      result.subtype = o.signal?.aborted ? 'killed' : o.resume && /thread.*(not found|resume)|no rollout/i.test(String(e)) ? 'session_lost' : 'runner_error';
      result.isError = true; result.error = (e as Error).message;
      return result;
    } finally { scope?.close(); o.signal?.removeEventListener('abort', aborted); await rpc.stop(); }
  }
}
