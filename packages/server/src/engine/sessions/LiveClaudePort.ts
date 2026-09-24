import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { KNOWN_USAGE_LIMIT_PREFIXES, USAGE_ERROR_CODES, isUsageLimitText, resetTime } from '@planestro/shared';
import type { ClaudePort, TurnOptions, TurnResult, CustomTurnOptions } from '../ports.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const PARTS = z.array(z.object({ name: z.string(), state: z.enum(['accepted', 'pending', 'rejected']), reason: z.string().optional() }));
const PARK_MSG = 'Permission requires user approval; the request has been recorded by planestro — end this turn now.';
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
    const q = query({
      prompt: o.prompt,
      options: {
        cwd: o.cwd, model: o.model, permissionMode: o.permissionMode, resume: o.resume,
        ...(o.fallbackModel && o.fallbackModel !== o.model ? { fallbackModel: o.fallbackModel } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemAppend },
        mcpServers: { planestro: server }, strictMcpConfig: true, settingSources: ['project'],
        allowedTools: [...o.allowedTools, ...o.mcpTools.map((t) => `mcp__planestro__${t.name}`)],
        maxTurns: o.maxTurns, abortController,
        ...(this.claudeBin ? { pathToClaudeCodeExecutable: this.claudeBin } : {}),
        ...(this.apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: this.apiKey } } : {}),
        canUseTool: async (toolName, input) => {
          if (toolName.startsWith('mcp__planestro__')) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: `${toolName} is not available in this role; use the planestro tools.` };
        },
      },
    });
    await consume(q, result, o.onOutput, abortController);
    return result;
  }

  async runTurn(o: TurnOptions): Promise<TurnResult> {
    const result: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '' };
    const planestro = createSdkMcpServer({
      name: 'planestro', version: '1',
      tools: [
        tool('submit_plan', 'Submit your implementation plan to planestro (planning turns only). Call once, then end your turn.', { plan: z.string().describe('The plan in markdown') },
          async ({ plan }) => { result.planSubmitted = plan; return text(await o.tools.submit_plan(plan)); }),
        tool('submit_breakdown', 'EPICS ONLY: submit the epic-level plan and the proposed child items. planestro validates the list and may answer with a rejection to fix. Call until accepted, then end your turn.',
          { plan: z.string().describe('The epic-level plan in markdown'), children: z.array(z.object({ title: z.string(), description: z.string().describe('A complete brief: the child\'s worker sees only this'), implementer: z.string().describe('A model id from the list you were given'), category: z.string().optional(), depends_on: z.array(z.number().int()).optional().describe('Indexes of children in this list that must merge first') })) },
          async ({ plan, children }) => { const answer = await o.tools.submit_breakdown(plan, children); if (!answer.startsWith('Rejected')) result.planSubmitted = plan; return text(answer); }),
        tool('add_note', 'Record a note on the backlog item (markdown).', { markdown: z.string() }, async ({ markdown }) => text(await o.tools.add_note(markdown))),
        tool('append_activity', 'Append a one-line progress entry to the item activity log.', { text: z.string() }, async (a) => text(await o.tools.append_activity(a.text))),
        tool('report_done', 'Report that the requested work is complete and committed on your worker branch. Then end your turn.', { summary: z.string().describe('One paragraph suitable for a pull request description'), parts: PARTS.optional().describe('Multi-part work: the final state of each part') },
          async ({ summary, parts }) => { result.done = summary; return text(await o.tools.report_done(summary, parts)); }),
        tool('report_progress', 'Multi-part work (an atlas of rows, a set of icons, a pack of sounds): the state of every part so far, accepted | pending | rejected, each rejection with the gate it failed. Replaces your last report; the user and the orchestrator read it instead of your prose.', { parts: PARTS },
          async ({ parts }) => text(await o.tools.report_progress(parts))),
        tool('report_blocked', 'Report that you cannot proceed without a human decision. Then end your turn.', { reason: z.string(), parts: PARTS.optional().describe('Multi-part work: the state of each part when you stopped') },
          async ({ reason, parts }) => { result.blocked = reason; return text(await o.tools.report_blocked(reason, parts)); }),
        tool('hand_off', 'Give files you made to another backlog item that waits on this one (its depends_on names your item, or you share an epic): planestro copies them into that item\'s attachments and tells its session. Use it when your output is needed by another item before your branch merges. Paths are relative to your worktree.',
          { to: z.string().describe('The receiving item id'), paths: z.array(z.string()).min(1).describe('Files in your worktree, relative paths'), note: z.string().describe('What they are and how to use them') },
          async ({ to, paths, note }) => text(await o.tools.hand_off(to, paths, note))),
        tool('get_item', 'Read the backlog item file (frontmatter + sections).', {}, async () => text(await o.tools.get_item())),
      ],
    });
    const abortController = new AbortController();
    o.signal?.addEventListener('abort', () => abortController.abort(), { once: true });
    const q = query({
      prompt: o.prompt,
      options: {
        cwd: o.cwd, model: o.model, permissionMode: o.permissionMode, resume: o.resume,
        ...(o.fallbackModel && o.fallbackModel !== o.model ? { fallbackModel: o.fallbackModel } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemAppend },
        mcpServers: { planestro }, strictMcpConfig: true, settingSources: ['project'],
        allowedTools: [...o.allowedTools, 'mcp__planestro__submit_plan', 'mcp__planestro__submit_breakdown', 'mcp__planestro__add_note', 'mcp__planestro__append_activity', 'mcp__planestro__report_done', 'mcp__planestro__report_progress', 'mcp__planestro__report_blocked', 'mcp__planestro__hand_off', 'mcp__planestro__get_item'],
        additionalDirectories: o.extraDirs, maxBudgetUsd: o.maxBudgetUsd, abortController,
        ...(this.claudeBin ? { pathToClaudeCodeExecutable: this.claudeBin } : {}),
        ...(this.apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: this.apiKey } } : {}),
        canUseTool: async (toolName, input) => {
          // Plan mode routes even allow-listed tools through this callback; planestro's own tools are always fine.
          if (toolName.startsWith('mcp__planestro__')) return { behavior: 'allow', updatedInput: input };
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
    await consume(q, result, o.onOutput, abortController);
    return result;
  }
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

/**
 * Signs, collected while a turn streams, that its model is out of usage: a rejected rate-limit
 * event (with the reset time), an assistant error code, or the CLI's usage-limit message.
 */
export interface UsageSignals { rejected?: boolean; resetsAt?: Date; code?: string; message?: string }

/** Feed one SDK message to the usage detector. Exported for tests. */
export function noteUsage(m: any, u: UsageSignals): void {
  if (m?.type === 'rate_limit_event') {
    const info = m.rate_limit_info ?? {};
    if (info.status === 'rejected') { u.rejected = true; u.resetsAt = resetTime(info.resetsAt) ?? u.resetsAt; }
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
async function consume(q: AsyncIterable<unknown>, result: TurnResult, onOutput: (t: string) => void, abortController: AbortController): Promise<void> {
  let sawResult = false;
  const usage: UsageSignals = {};
  try {
    for await (const m of q as AsyncIterable<any>) {
      noteUsage(m, usage);
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
        result.costUsd += Number(m.total_cost_usd ?? 0);
        result.numTurns += Number(m.num_turns ?? 0);
        if (m.is_error && m.errors) result.error = String(m.errors).slice(0, 400);
      }
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (abortController.signal.aborted || /exited with code 143/.test(msg)) { result.subtype = 'killed'; result.isError = false; }
    else if (sawResult && result.isError) { result.error = result.error ?? msg; }   // the SDK throws after an error result
    else { result.subtype = 'error_during_execution'; result.isError = true; result.error = msg; }
    if (isUsageLimitText(msg, USAGE_PREFIXES)) usage.message = usage.message ?? msg.trim().slice(0, 300);
  }
  classifyUsage(result, usage);
}
