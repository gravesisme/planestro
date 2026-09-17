import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ClaudePort, TurnOptions, TurnResult, CustomTurnOptions } from '../ports.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const PARK_MSG = 'Permission requires user approval; the request has been recorded by planestro — end this turn now.';

/**
 * One `query()` per turn (invariant 2): the process lives only while the model is working.
 * planestro's tools are an in-process MCP server; `canUseTool` routes ExitPlanMode,
 * AskUserQuestion and every other prompt to the engine's policy (see docs/sdk-notes.md).
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
        tool('report_done', 'Report that the requested work is complete and committed on your worker branch. Then end your turn.', { summary: z.string().describe('One paragraph suitable for a pull request description') },
          async ({ summary }) => { result.done = summary; return text(await o.tools.report_done(summary)); }),
        tool('report_blocked', 'Report that you cannot proceed without a human decision. Then end your turn.', { reason: z.string() },
          async ({ reason }) => { result.blocked = reason; return text(await o.tools.report_blocked(reason)); }),
        tool('get_item', 'Read the backlog item file (frontmatter + sections).', {}, async () => text(await o.tools.get_item())),
      ],
    });
    const abortController = new AbortController();
    o.signal?.addEventListener('abort', () => abortController.abort(), { once: true });
    const q = query({
      prompt: o.prompt,
      options: {
        cwd: o.cwd, model: o.model, permissionMode: o.permissionMode, resume: o.resume,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemAppend },
        mcpServers: { planestro }, strictMcpConfig: true, settingSources: ['project'],
        allowedTools: [...o.allowedTools, 'mcp__planestro__submit_plan', 'mcp__planestro__submit_breakdown', 'mcp__planestro__add_note', 'mcp__planestro__append_activity', 'mcp__planestro__report_done', 'mcp__planestro__report_blocked', 'mcp__planestro__get_item'],
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

/** Drain a query into a TurnResult. Completion is "the iterator finished": a torn session's resume emits a zero-turn result first. */
async function consume(q: AsyncIterable<unknown>, result: TurnResult, onOutput: (t: string) => void, abortController: AbortController): Promise<void> {
  let sawResult = false;
  try {
    for await (const m of q as AsyncIterable<any>) {
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
  }
}
