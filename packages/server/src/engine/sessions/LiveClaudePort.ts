import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_USAGE_LIMIT_PREFIXES, USAGE_ERROR_CODES, isUsageLimitText, resetTime, worseRateLimit, type RateLimitSnapshot } from '@planestro/shared';
import type { ClaudePort, TurnOptions, TurnResult, CustomTurnOptions, ResumeQuote, UndeliveredReport } from '../ports.ts';
import { PARKED_REFUSAL } from '../parks.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const PARTS = z.array(z.object({ name: z.string(), state: z.enum(['accepted', 'pending', 'rejected']), reason: z.string().optional() }));
/**
 * A worker's shell goes back to its worktree after every command (#96): without this a `cd` carries
 * over to the next call, and neither the policy nor the orchestrator can say where a command runs.
 */
const PINNED = { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' };
const PARK_MSG = 'Permission requires a decision; the request has been recorded by planestro. This is NOT a denial: do not retry it, work around it or call report_blocked — end this turn now, and you will be resumed with the decision.';
/** The SDK's list of usage-limit messages (alpha export) merged with our copy, so a rename cannot switch detection off. */
const USAGE_PREFIXES: readonly string[] = [...new Set([...(((sdk as Record<string, unknown>).USAGE_LIMIT_ERROR_PREFIXES as readonly string[] | undefined) ?? []), ...KNOWN_USAGE_LIMIT_PREFIXES])];

/**
 * One `query()` per turn (invariant 2): the process lives only while the model is working.
 * planestro's tools are an in-process MCP server; `canUseTool` routes ExitPlanMode,
 * AskUserQuestion and every other prompt to the engine's policy (see docs/notes/sdk-notes.md).
 */
export class LiveClaudePort implements ClaudePort {
  constructor(private readonly claudeBin?: string, private readonly apiKey?: string) {}

  async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
    const result: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '' };
    const server = createSdkMcpServer({
      name: 'planestro', version: '1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: o.mcpTools.map((t) => (tool as any)(t.name, t.description, t.schema, async (args: Record<string, unknown>) => text(await t.handler(args)))),
    });
    const abortController = new AbortController();
    o.signal?.addEventListener('abort', () => abortController.abort(), { once: true });
    const resumed = resumeWatch(o);
    const allow = splitAllowed(o.allowedTools);
    const input = new InputGate();
    const q = query({
      prompt: input.open(o.prompt),
      options: {
        cwd: o.cwd, model: o.model, permissionMode: o.permissionMode, resume: o.resume,
        ...(o.fallbackModel && o.fallbackModel !== o.model ? { fallbackModel: o.fallbackModel } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemAppend },
        ...resumed.options,
        mcpServers: { planestro: server }, strictMcpConfig: true, settingSources: ['project'],
        // dontAsk (the orchestrator) never consults canUseTool: a tool not listed here is refused outright, so its
        // bare names and its own MCP tools are listed whole (#153; #58's split left it unable to call anything).
        // The SDK's CAN_USE_TOOL_SHADOWED warning is accepted for this role: the callback is unused in this mode.
        allowedTools: customAllowedTools(o),
        maxTurns: o.maxTurns, abortController,
        ...(this.claudeBin ? { pathToClaudeCodeExecutable: this.claudeBin } : {}),
        ...(this.apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: this.apiKey } } : {}),
        canUseTool: async (toolName, input) => {
          if (toolName.startsWith('mcp__planestro__') || allow.whole.has(toolName)) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: `${toolName} is not available in this role; use the planestro tools.` };
        },
      },
    });
    await consume(q, result, o.onOutput, abortController, resumed, input);
    return result;
  }

  async runTurn(o: TurnOptions): Promise<TurnResult> {
    const result: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '' };
    const planestro = createSdkMcpServer({
      name: 'planestro', version: '1',
      tools: [
        tool('submit_plan', 'Submit your implementation plan to planestro (planning turns only). Call once, then end your turn.', { plan: z.string().describe('The plan in markdown') },
          async ({ plan }) => { result.planSubmitted = plan; return text(await o.tools.submit_plan(plan)); }),
        tool('submit_breakdown', 'For an epic: submit the epic-level plan and the proposed child items. For a plain item only when the request is really an epic (several separately shippable pieces): the breakdown you would propose instead of a plan, which planestro records and flags for conversion to an epic. planestro checks the list and may answer with a rejection to fix. Call until accepted, then end your turn.',
          { plan: z.string().describe('The epic-level plan in markdown'), children: z.array(z.object({ title: z.string(), description: z.string().describe('A complete brief: the child\'s worker sees only this'), implementer: z.string().describe('A model id from the list you were given'), category: z.string().optional(), depends_on: z.array(z.number().int()).optional().describe('Indexes of children in this list that must merge first'), planner: z.string().optional().describe('A Claude model id to plan this child; omit to use the epic\'s planner'), hold_for_review: z.boolean().optional().describe('true: its pull request waits for the user\'s review before merging (a designer look at art, a UX pass)') })) },
          async ({ plan, children }) => { const answer = await o.tools.submit_breakdown(plan, children); if (!answer.startsWith('Rejected')) result.planSubmitted = plan; return text(answer); }),
        tool('add_note', 'Record a note on the backlog item (markdown). `attach` puts images or videos from your worktree on the item for the user.', { markdown: z.string(), attach: z.array(z.string()).optional().describe('Worktree-relative paths of images or videos for the user to see on the item (verification screenshots, a capture): planestro copies them onto the item, including files in ignored folders. Not for files that belong in the change.') }, async ({ markdown, attach }) => text(await o.tools.add_note(markdown, attach))),
        tool('append_activity', 'Append a one-line progress entry to the item activity log.', { text: z.string() }, async (a) => text(await o.tools.append_activity(a.text))),
        tool('report_done', 'Report that the requested work is complete and committed on your worker branch. Then end your turn.', { summary: z.string().describe('One paragraph suitable for a pull request description'), parts: PARTS.optional().describe('Multi-part work: the final state of each part'), hold: z.string().optional().describe('Only when the pull request must NOT merge yet (the plan or the request says it waits for something): what it waits for, e.g. "until HH-12 has merged". planestro opens it and keeps it out of the merge queue until the user releases the hold. Leave it out otherwise.'), attach: z.array(z.string()).optional().describe('Worktree-relative paths of images or videos for the user to see on the item (verification screenshots, a capture): planestro copies them onto the item, including files in ignored folders. Not for files that belong in the change.'), review: z.string().optional().describe('Loop-until-green items only: the markdown of your REVIEW.md (each finding or check, before/after, the captures by path). planestro files it on the item for review.') },
          async ({ summary, parts, hold, attach, review }) => { const answer = await o.tools.report_done(summary, parts, hold, attach, review); if (!answer.startsWith('Rejected')) result.done = summary; return text(answer); }),
        tool('report_iteration', 'Loop-until-green items only: report one iteration of the loop (change, regenerate, run the checks): how many checks pass now, of how many, and one line on what you changed. planestro logs it and counts it against the item\'s iteration budget.', { passing: z.number().int().describe('Checks passing after this iteration'), total: z.number().int().describe('Checks this loop runs'), note: z.string().describe('One line: what this iteration changed, and what still fails') },
          async ({ passing, total, note }) => text(await o.tools.report_iteration(passing, total, note))),
        tool('report_progress', 'Multi-part work (an atlas of rows, a set of icons, a pack of sounds): the state of every part so far, accepted | pending | rejected, each rejection with the gate it failed. Replaces your last report; the user and the orchestrator read it instead of your prose.', { parts: PARTS },
          async ({ parts }) => text(await o.tools.report_progress(parts))),
        tool('report_blocked', 'Report that you cannot proceed without a human decision. Then end your turn.', { reason: z.string(), parts: PARTS.optional().describe('Multi-part work: the state of each part when you stopped') },
          async ({ reason, parts }) => { const answer = await o.tools.report_blocked(reason, parts); if (!answer.startsWith(PARKED_REFUSAL)) result.blocked = reason; return text(answer); }),
        tool('hand_off', 'Give files you made to another backlog item that waits on this one (its depends_on names your item, or you share an epic): planestro copies them into that item\'s attachments and tells its session. Use it when your output is needed by another item before your branch merges. Paths are relative to your worktree.',
          { to: z.string().describe('The receiving item id'), paths: z.array(z.string()).min(1).describe('Files in your worktree, relative paths'), note: z.string().describe('What they are and how to use them') },
          async ({ to, paths, note }) => text(await o.tools.hand_off(to, paths, note))),
        tool('get_item', 'Read the backlog item file (frontmatter + sections).', {}, async () => text(await o.tools.get_item())),
      ],
    });
    const abortController = new AbortController();
    o.signal?.addEventListener('abort', () => abortController.abort(), { once: true });
    const resumed = resumeWatch(o);
    const allow = splitAllowed(o.allowedTools);
    const input = new InputGate();
    const reports = new ReportWatch((r) => { result.undelivered = r; o.onUndelivered?.(r); });
    const q = query({
      prompt: input.open(o.prompt),
      options: {
        cwd: o.cwd, model: o.model, permissionMode: o.permissionMode, resume: o.resume,
        ...(o.fallbackModel && o.fallbackModel !== o.model ? { fallbackModel: o.fallbackModel } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemAppend },
        ...resumed.options,
        // The model's own servers ride along; their tools are not allow-listed, so every call reaches canUseTool and the engine's count.
        mcpServers: { planestro, ...(o.mcpServers ?? {}) } as any, strictMcpConfig: true, settingSources: ['project'],
        allowedTools: allow.rules,
        additionalDirectories: o.extraDirs, maxBudgetUsd: o.maxBudgetUsd, abortController,
        ...(this.claudeBin ? { pathToClaudeCodeExecutable: this.claudeBin } : {}),
        env: { ...process.env, ...PINNED, ...(this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : {}) },
        canUseTool: async (toolName, input) => {
          // planestro's own tools, and a whole tool a rule names bare, are always fine (plan mode routes even allow-listed tools here).
          if (toolName.startsWith('mcp__planestro__') || allow.whole.has(toolName)) return { behavior: 'allow', updatedInput: input };
          if (toolName === 'ExitPlanMode') {
            const plan = String((input as any).plan ?? '');
            if (plan) { result.planSubmitted = plan; await o.tools.submit_plan(plan); }
            return { behavior: 'deny', message: 'Plan recorded by planestro. Do not use ExitPlanMode; end your turn now.' };
          }
          if (toolName === 'AskUserQuestion') {
            await o.onQuestion(((input as any).questions ?? []) as unknown[]);
            result.parked = 'question';
            return { behavior: 'deny', message: 'Questions recorded by planestro. End your turn now; you will be resumed with the answers.' };
          }
          const decision = await o.onPermission({ tool: toolName, input });
          if (decision.action === 'allow') return { behavior: 'allow', updatedInput: input };
          if (decision.action === 'deny') return { behavior: 'deny', message: decision.message };
          result.parked = 'permission';
          return { behavior: 'deny', message: PARK_MSG };
        },
      },
    });
    await consume(q, result, o.onOutput, abortController, resumed, input, reports);
    return result;
  }
}

/**
 * The prompt as a stream that stays open until the session is really over (#167, sdk-notes gotcha 11). Given a
 * string, the SDK closes the CLI's stdin at the first `result`; a background agent or task that is still running
 * then has no channel left for its in-process MCP calls and permission requests ("Stream closed", "interrupted
 * before a result was received"; the handler never runs), and a background Bash's follow-up turn never happens.
 * Here the input ends at a `result` only when no background task is live (`background_tasks_changed`), or once the
 * last one has ended and no follow-up turn began within `graceMs`. A CLI that reports no tasks ends where it always did.
 */
export class InputGate {
  private live = 0;
  private between = false;
  private grace?: NodeJS.Timeout;
  private release!: () => void;
  private readonly ended = new Promise<void>((r) => { this.release = r; });
  closed = false;
  constructor(private readonly graceMs = 30_000) {}

  async *open(prompt: string): AsyncGenerator<any> {
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' };
    await this.ended;
  }

  /** Feed one SDK message. */
  see(m: any): void {
    if (this.closed) return;
    if (m?.type === 'system' && m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
      this.live = m.tasks.filter((t: any) => !t?.ambient).length;
      if (this.live === 0 && this.between) this.arm();
    } else if (m?.type === 'result') {
      this.between = true;
      if (this.live === 0) this.close(); else this.disarm();
    } else if (m?.type === 'assistant' || (m?.type === 'system' && m.subtype === 'init')) { this.between = false; this.disarm(); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    this.release();
  }

  private arm(): void { this.disarm(); this.grace = setTimeout(() => this.close(), this.graceMs); this.grace.unref?.(); }
  private disarm(): void { if (this.grace) clearTimeout(this.grace); this.grace = undefined; }
}

const REPORTS: Record<string, UndeliveredReport['tool']> = { mcp__planestro__submit_plan: 'submit_plan', mcp__planestro__report_done: 'report_done', mcp__planestro__report_blocked: 'report_blocked', ExitPlanMode: 'submit_plan' };

/**
 * The session's reports as they stream (#167): a report call whose result is an error never reached its handler (a
 * planestro handler always answers with text), and one with no result at all when the stream ended may not have. The
 * last report call decides: one that landed clears an earlier loss. ExitPlanMode is planestro's plan hand-in too, and
 * is always answered with an error; only one without planestro's answer was lost. Exported for tests.
 */
export class ReportWatch {
  private readonly calls = new Map<string, { tool: UndeliveredReport['tool']; args: Record<string, unknown> }>();
  private lastId?: string;
  private lost?: UndeliveredReport;
  constructor(private readonly onChange: (r: UndeliveredReport | undefined) => void) {}

  see(m: any): void {
    if (m?.type === 'assistant') {
      for (const c of (m.message?.content ?? []) as any[]) {
        const tool = c?.type === 'tool_use' ? REPORTS[String(c.name)] : undefined;
        if (!tool) continue;
        const args = { ...(c.input ?? {}) } as Record<string, unknown>;
        if (tool === 'submit_plan' && typeof args.plan !== 'string') continue;
        this.calls.set(c.id, { tool, args }); this.lastId = c.id;
      }
    } else if (m?.type === 'user' && Array.isArray(m.message?.content)) {
      for (const c of m.message.content as any[]) {
        const call = c?.type === 'tool_result' ? this.calls.get(c.tool_use_id) : undefined;
        if (!call) continue;
        this.calls.delete(c.tool_use_id);
        if (c.tool_use_id !== this.lastId) continue;          // an earlier call answered late: the last one decides
        const body = typeof c.content === 'string' ? c.content : (Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? '').join(' ') : '');
        const landed = !c.is_error || /recorded by planestro/i.test(body);
        this.set(landed ? undefined : { ...call, error: body.trim().slice(0, 300) || 'error' });
      }
    }
  }

  /** The stream is over: a last report call that never got its answer may not have landed. */
  end(): void {
    const open = this.lastId ? this.calls.get(this.lastId) : undefined;
    if (open) this.set({ ...open, error: 'the session ended before the call was answered' });
  }

  private set(r: UndeliveredReport | undefined): void {
    if (r === undefined && this.lost === undefined) return;
    this.lost = r;
    this.onChange(r);
  }
}

/**
 * allowedTools as the SDK should see it (#58). A bare entry (`Read`, `mcp__planestro__report_done`) approves the
 * whole tool before canUseTool is consulted, and the SDK warns of it on every start
 * (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). Only rules with a pattern (`Bash(git log*)`) go to the SDK; bare names are
 * approved by the callback, first thing, so what is allowed is unchanged and every call is visible to it.
 */
/** allowedTools for a custom turn: in dontAsk mode (canUseTool is never called) every tool it may use, by name (#153). */
export function customAllowedTools(o: Pick<CustomTurnOptions, 'permissionMode' | 'allowedTools' | 'mcpTools'>): string[] {
  const allow = splitAllowed(o.allowedTools);
  return o.permissionMode === 'dontAsk' ? [...new Set([...allow.rules, ...allow.whole, ...o.mcpTools.map((t) => `mcp__planestro__${t.name}`)])] : allow.rules;
}

export function splitAllowed(list: readonly string[]): { rules: string[]; whole: Set<string> } {
  const rules: string[] = []; const whole = new Set<string>();
  for (const r of list.map((x) => x.trim()).filter(Boolean)) { if (r.includes('(')) rules.push(r); else whole.add(r); }
  return { rules, whole };
}

/**
 * What a resumed conversation is measured against (#64). The CLI restores a conversation's cost when
 * it resumes it, so `total_cost_usd` is the conversation's running total, not the turn's: HH-181's
 * turns read 1.41, 3.10, 4.35 … 30.27 and every one was added to the item. The baseline is what the
 * total stood at when this turn began.
 */
export interface ResumeWatch {
  resumed: boolean;
  /** The running total before this turn: the transcript's own record, else what the caller recorded. */
  baseline?: number;
  quote?: ResumeQuote;
  declined?: boolean;
  /** SDK options that make the CLI hand over its quote and ask before the first request. */
  options: Record<string, unknown>;
  cleanup(): void;
}

const DECLINED = 'planestro: this resume was declined before it started';

/**
 * The SDK's own SessionStart callback never fires on a resume (sdk-notes (k)), but a command hook
 * does, and its input carries the quote: it is written to a file that the UserPromptSubmit callback,
 * which does fire and runs before the first request, reads. Blocking the prompt there ends the turn
 * with nothing spent (sdk-notes (l)).
 */
export function resumeWatch(o: { resume?: string; resumeTotalUsd?: number; onResumeQuote?(q: ResumeQuote): 'go' | 'stop' }): ResumeWatch {
  const w: ResumeWatch = { resumed: Boolean(o.resume), baseline: o.resumeTotalUsd, options: {}, cleanup: () => {} };
  if (!o.resume) return w;
  const file = join(tmpdir(), `planestro-quote-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
  w.cleanup = () => { try { rmSync(file, { force: true }); } catch { /* a temp file */ } };
  let asked = false;
  w.options = {
    settings: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `cat > '${file}'` }] }] } },
    hooks: { UserPromptSubmit: [{ hooks: [async (input: { transcript_path?: string }) => {
      if (asked) return { continue: true };
      asked = true;
      w.baseline = lastCostState(input?.transcript_path) ?? w.baseline;
      try { w.quote = existsSync(file) ? resumeQuoteOf(JSON.parse(readFileSync(file, 'utf8'))) : undefined; } catch { w.quote = undefined; }
      if (w.quote && o.onResumeQuote?.(w.quote) === 'stop') { w.declined = true; return { decision: 'block', reason: DECLINED }; }
      return { continue: true };
    }] }] },
  };
  return w;
}

/** The quote in a SessionStart hook's input, when it is a resume's and says what it costs. Exported for tests. */
export function resumeQuoteOf(input: any): ResumeQuote | undefined {
  if (input?.source !== 'resume' && input?.source !== 'fork') return undefined;
  const tokens = Number(input.context_tokens), usd = Number(input.estimated_cache_write_usd);
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(usd) || usd <= 0) return undefined;
  return {
    contextTokens: tokens, cacheWriteUsd: usd,
    ...(typeof input.prompt_cache_likely_expired === 'boolean' ? { cacheExpired: input.prompt_cache_likely_expired } : {}),
    ...(Number.isFinite(Number(input.seconds_since_last_response)) ? { secondsSinceLast: Number(input.seconds_since_last_response) } : {}),
  };
}

/**
 * The running total a conversation's transcript last recorded (its newest `cost-state` line): what
 * the CLI restores when it resumes it. Read from the file's tail; undefined when there is none, or
 * the format has moved on, and the caller's own record stands in. Exported for tests.
 */
export function lastCostState(path: string | undefined, tailBytes = 512 * 1024): number | undefined {
  if (!path) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"cost-state"')) continue;
      try { const e = JSON.parse(lines[i]); if (e?.type === 'cost-state' && Number.isFinite(Number(e.totalCostUSD))) return Number(e.totalCostUSD); } catch { /* a line cut by the tail */ }
    }
  } catch { /* no transcript to read */ } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
  return undefined;
}

/** What the next resume of this conversation reloads, from the responses as they stream. */
export interface ContextSeen { tokens?: number; ttlS?: number }

/**
 * Feed one SDK message to the context reading. Exported for tests. Only the conversation's own
 * responses count: a subagent's window is not what a resume sends again.
 */
export function noteContext(m: any, c: ContextSeen): void {
  if (m?.type !== 'assistant' || m.parent_tool_use_id) return;
  const u = m.message?.usage;
  if (!u) return;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const tokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens);
  if (tokens > 0) c.tokens = tokens;
  if (n(u.cache_creation?.ephemeral_1h_input_tokens) > 0) c.ttlS = 3600;
  else if (n(u.cache_creation?.ephemeral_5m_input_tokens) > 0) c.ttlS = 300;
}

/** Human-readable one-liner for a tool call — the console is read by a person, not a parser. */
function describeToolUse(name: string, input: Record<string, unknown>): string {
  const first = (v: unknown) => String(v ?? '').split('\n')[0].slice(0, 160);
  switch (name) {
    case 'Bash': return `Bash: ${first(input.command)}${String(input.command ?? '').includes('\n') ? ' …' : ''}`;
    case 'Read': return `Read ${first(input.file_path)}`;
    case 'Write': return `Write ${first(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Edit ${first(input.file_path)}`;
    case 'Grep': return `Grep /${first(input.pattern)}/ ${first(input.path ?? '')}`;
    case 'Glob': return `Glob ${first(input.pattern)}`;
    default: {
      if (name.startsWith('mcp__planestro__')) {
        const arg = first(input.plan ?? input.summary ?? input.reason ?? input.text ?? input.markdown ?? '');
        return `${name.replace('mcp__planestro__', 'planestro.')}${arg ? `: ${arg}` : ''}`;
      }
      return `${name} ${JSON.stringify(input).slice(0, 120)}`;
    }
  }
}

/** A turn's whole answer is an API error the CLI printed instead of failing ("API Error: 400 …"). */
const API_ERROR_TEXT = /^API Error: \d{3}\b/;
/** The CLI is too old for the requested model; a newer `claude` (or claude_bin) fixes it, a retry does not. */
const CLI_TOO_OLD = /does not support this model|or newer is required/i;

/**
 * A result the SDK calls a success whose only text is an API error is a failure (dogfood p5): the
 * orchestrator logged "API Error: 400 …" as its summary and moved on, and a worker turn in that state
 * would have looked finished. Exported for tests.
 */
export function noteApiErrorText(m: any, result: TurnResult): void {
  if (m?.type !== 'result' || m.is_error || typeof m.result !== 'string') return;
  const text = m.result.trim();
  if (!API_ERROR_TEXT.test(text)) return;
  result.isError = true;
  result.subtype = CLI_TOO_OLD.test(text) ? 'cli_too_old' : 'api_error';
  result.error = text.slice(0, 400);
}

/**
 * Feed one SDK message to the planestro-tool failure detector. Exported for tests. A planestro
 * tool's handler always answers with text, so an errored result for one means the call never
 * reached it (the SDK's in-process transport, docs/notes/sdk-notes.md gotcha 11). The engine
 * reads these instead of trusting the model to notice and retry.
 */
export function noteToolFailures(m: any, calls: Map<string, string>, result: TurnResult): void {
  if (m?.type === 'assistant') {
    for (const c of (m.message?.content ?? []) as any[]) if (c?.type === 'tool_use' && String(c.name).startsWith('mcp__planestro__')) calls.set(c.id, c.name.slice('mcp__planestro__'.length));
  } else if (m?.type === 'user' && Array.isArray(m.message?.content)) {
    for (const c of m.message.content as any[]) {
      if (c?.type !== 'tool_result' || !c.is_error || !calls.has(c.tool_use_id)) continue;
      const body = typeof c.content === 'string' ? c.content : (Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? '').join(' ') : '');
      (result.toolFailures ??= []).push({ tool: calls.get(c.tool_use_id)!, error: body.trim().slice(0, 300) });
    }
  }
}

/**
 * Signs, collected while a turn streams, that its model is out of usage: a rejected rate-limit
 * event (with the reset time), an assistant error code, or the CLI's usage-limit message. Every
 * rate-limit event also feeds `rateLimit`, the most pressing reading, for the usage guard.
 */
export interface UsageSignals { rejected?: boolean; resetsAt?: Date; code?: string; message?: string; rateLimit?: RateLimitSnapshot }

const RATE_LIMIT_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);
/** One `rate_limit_info` as a snapshot, or undefined when it carries no status. Exported for tests. */
export function rateLimitSnapshot(info: any): RateLimitSnapshot | undefined {
  if (!RATE_LIMIT_STATUSES.has(info?.status)) return undefined;
  // The SDK does not document the unit: a reading above 1 is taken as a percentage, so 87 and 0.87 both mean 87%.
  const raw = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : undefined;
  const utilization = raw === undefined ? undefined : raw > 1 ? raw / 100 : raw;
  const resets = resetTime(info.resetsAt);
  return { status: info.status, window: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown', ...(utilization !== undefined ? { utilization } : {}), ...(resets ? { resetsAt: resets.toISOString() } : {}) };
}

/** Feed one SDK message to the usage detector. Exported for tests. */
export function noteUsage(m: any, u: UsageSignals): void {
  if (m?.type === 'rate_limit_event') {
    const info = m.rate_limit_info ?? {};
    if (info.status === 'rejected') { u.rejected = true; u.resetsAt = resetTime(info.resetsAt) ?? u.resetsAt; }
    const snap = rateLimitSnapshot(info);
    if (snap) u.rateLimit = worseRateLimit(u.rateLimit, snap);
  } else if (m?.type === 'assistant') {
    if (m.error && USAGE_ERROR_CODES.includes(m.error)) u.code = m.error;
    for (const c of (m.message?.content ?? []) as any[]) if (c?.type === 'text' && isUsageLimitText(c.text, USAGE_PREFIXES)) u.message = String(c.text).trim().slice(0, 300);
  } else if (m?.type === 'result') {
    for (const t of [m.result, ...(Array.isArray(m.errors) ? m.errors : [m.errors])]) if (typeof t === 'string' && isUsageLimitText(t, USAGE_PREFIXES)) u.message = t.trim().slice(0, 300);
  }
}

/**
 * A failed turn whose model ran out of usage becomes `usage_exhausted`, so the engine can move to a
 * fallback. A rejected rate-limit event alone is not enough (the SDK may have recovered on its own
 * fallback): the turn must have failed, or ended on the usage message.
 */
export function classifyUsage(result: TurnResult, u: UsageSignals): void {
  const signal = u.message || u.code || u.rejected;
  if (!signal || result.subtype === 'killed') return;
  if (!(result.isError || u.message)) return;
  result.subtype = 'usage_exhausted';
  result.isError = true;
  result.usageLimit = { message: u.message ?? (u.code ? `assistant error: ${u.code}` : 'usage limit reached (rate limit rejected)'), ...(u.resetsAt ? { resetsAt: u.resetsAt.toISOString() } : {}) };
  result.error = result.usageLimit.message;
}

/** Drain a query into a TurnResult. Completion is "the iterator finished": a torn session's resume emits a zero-turn result first. */
async function consume(q: AsyncIterable<unknown>, result: TurnResult, onOutput: (t: string) => void, abortController: AbortController, resumed?: ResumeWatch, input?: InputGate, reports?: ReportWatch): Promise<void> {
  let sawResult = false;
  let total: number | undefined;
  const usage: UsageSignals = {};
  const context: ContextSeen = {};
  const calls = new Map<string, string>();
  try {
    for await (const m of q as AsyncIterable<any>) {
      input?.see(m);
      reports?.see(m);
      noteUsage(m, usage);
      noteToolFailures(m, calls, result);
      noteContext(m, context);
      if (m.type === 'system' && m.subtype === 'init') result.sessionId = m.session_id;
      else if (m.type === 'assistant') {
        for (const c of (m.message?.content ?? []) as any[]) {
          if (c.type === 'text' && c.text) { result.text += c.text + '\n'; onOutput(c.text); }
          else if (c.type === 'tool_use') onOutput(`→ ${describeToolUse(c.name, c.input ?? {})}`);
        }
      } else if (m.type === 'result') {
        sawResult = true;
        result.sessionId = m.session_id ?? result.sessionId;
        result.subtype = m.subtype ?? 'success';
        result.isError = Boolean(m.is_error);
        // A running total, so the last one stands: a torn session's zero-turn result carries what was restored, and adding the two counted it twice.
        if (Number.isFinite(Number(m.total_cost_usd))) total = Number(m.total_cost_usd);
        result.numTurns += Number(m.num_turns ?? 0);
        if (m.is_error && m.errors) result.error = String(m.errors).slice(0, 400);
        noteApiErrorText(m, result);
      }
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (abortController.signal.aborted || /exited with code 143/.test(msg)) { result.subtype = 'killed'; result.isError = false; }
    else if (sawResult && result.isError) { result.error = result.error ?? msg; }   // the SDK throws after an error result
    else { result.subtype = 'error_during_execution'; result.isError = true; result.error = msg; }
    if (isUsageLimitText(msg, USAGE_PREFIXES)) usage.message = usage.message ?? msg.trim().slice(0, 300);
  } finally { input?.close(); resumed?.cleanup(); }
  reports?.end();
  settleCost(result, total, resumed);
  if (context.tokens) result.contextTokens = context.tokens;
  if (context.ttlS) result.cacheTtlS = context.ttlS;
  if (resumed?.quote) result.resumeQuote = resumed.quote;
  if (resumed?.declined) { result.subtype = 'resume_declined'; result.isError = false; result.error = undefined; result.costUsd = 0; result.text = ''; return; }
  if (usage.rateLimit) result.rateLimit = usage.rateLimit;
  classifyUsage(result, usage);
}

/**
 * This turn's share of what the runner reported. Exported for tests. A resumed conversation reports
 * its running total, so the turn is what that rose by; with no baseline to be found it is taken whole,
 * as it always was, rather than guessed at.
 */
export function settleCost(result: TurnResult, total: number | undefined, resumed?: Pick<ResumeWatch, 'resumed' | 'baseline'>): void {
  if (total === undefined) return;
  result.sessionTotalUsd = total;
  const spent = resumed?.resumed && resumed.baseline !== undefined ? Math.max(0, total - resumed.baseline) : total;
  result.costUsd = Math.round(spent * 1e6) / 1e6;
}
