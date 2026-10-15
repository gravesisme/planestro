import { describe, it, expect } from 'vitest';
import { emptySplit } from '@planestro/shared';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteUsage, classifyUsage, rateLimitSnapshot, type UsageSignals, noteToolFailures, InputGate, ReportWatch, DropWatch, noteContext, noteTokens, type TokensSeen, resumeQuoteOf, settleCost, lastCostState, resumeWatch, type ContextSeen } from '../src/engine/sessions/LiveClaudePort.ts';
import type { TurnResult, UndeliveredReport } from '../src/engine/ports.ts';

const result = (over: Partial<TurnResult> = {}): TurnResult => ({ subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', ...over });
const feed = (msgs: unknown[]) => { const u: UsageSignals = {}; for (const m of msgs) noteUsage(m, u); return u; };

describe('Claude usage exhaustion', () => {
  it('a turn that fails on the usage-limit message is usage_exhausted, with the reset from the rate-limit event', () => {
    const u = feed([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000 } },
      { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Fable 5 requires usage credits' }] } },
      { type: 'result', subtype: 'success', is_error: true, result: 'Fable 5 requires usage credits' },
    ]);
    const r = result({ isError: true });
    classifyUsage(r, u);
    expect(r.subtype).toBe('usage_exhausted');
    expect(r.usageLimit).toEqual({ message: 'Fable 5 requires usage credits', resetsAt: new Date(1790000000 * 1000).toISOString() });
  });

  it('an assistant billing error on a failed turn counts even without the message', () => {
    const r = result({ isError: true, subtype: 'error_during_execution' });
    classifyUsage(r, feed([{ type: 'assistant', error: 'billing_error', message: { content: [] } }]));
    expect(r.subtype).toBe('usage_exhausted'); expect(r.usageLimit?.message).toContain('billing_error');
  });

  it('a successful turn that merely saw a rejected event (the SDK recovered) is left alone', () => {
    const r = result();
    classifyUsage(r, feed([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }]));
    expect(r.subtype).toBe('success'); expect(r.isError).toBe(false);
  });

  it('an overloaded blip, a warning event or an ordinary failure is not a usage limit', () => {
    for (const msgs of [[{ type: 'assistant', error: 'overloaded', message: { content: [] } }], [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }], []]) {
      const r = result({ isError: true, subtype: 'error_during_execution' });
      classifyUsage(r, feed(msgs));
      expect(r.subtype).toBe('error_during_execution');
    }
  });

  it('a killed turn stays killed', () => {
    const r = result({ subtype: 'killed' });
    classifyUsage(r, feed([{ type: 'result', result: "You've hit your limit" }]));
    expect(r.subtype).toBe('killed');
  });
});

describe('rate-limit readings for the usage guard', () => {
  it('every rate_limit_event feeds a snapshot; the most pressing one wins', () => {
    const reset = 1790000000;
    const u = feed([
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4, resetsAt: reset } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: reset + 100 } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.6, resetsAt: reset } },
    ]);
    expect(u.rateLimit).toEqual({ status: 'allowed', window: 'seven_day', utilization: 0.9, resetsAt: new Date((reset + 100) * 1000).toISOString() });
    expect(u.rejected).toBeUndefined();
  });

  it('a warning outranks a fuller allowed window, and a rejection outranks both', () => {
    const u = feed([
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.8 } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.3 } },
    ]);
    expect(u.rateLimit).toMatchObject({ status: 'allowed_warning', window: 'seven_day_opus' });
    noteUsage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, u);
    expect(u.rateLimit).toEqual({ status: 'rejected', window: 'unknown' });
    expect(u.rejected).toBe(true);
  });

  it('a reading without a known status is ignored', () => {
    expect(rateLimitSnapshot({})).toBeUndefined();
    expect(rateLimitSnapshot({ status: 'bogus', utilization: 0.9 })).toBeUndefined();
    expect(feed([{ type: 'rate_limit_event' }]).rateLimit).toBeUndefined();
  });
  it('reads a utilization above 1 as a percentage', () => {
    const u: UsageSignals = {};
    noteUsage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 87 } }, u);
    expect(u.rateLimit?.utilization).toBeCloseTo(0.87);
  });
});

describe('planestro tool failures', () => {
  it('records an errored result for a planestro tool, and nothing for other tools or successes', () => {
    const r = result();
    const calls = new Map<string, string>();
    for (const m of [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__planestro__submit_plan', input: {} }, { type: 'tool_use', id: 'b', name: 'Bash', input: {} }, { type: 'tool_use', id: 'c', name: 'mcp__planestro__add_note', input: {} }] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'a', is_error: true, content: [{ type: 'text', text: 'Tool permission request failed: AbortError: Stream closed' }] },
        { type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'exit 1' },
        { type: 'tool_result', tool_use_id: 'c', content: 'Note recorded.' },
      ] } },
    ]) noteToolFailures(m, calls, r);
    expect(r.toolFailures).toEqual([{ tool: 'submit_plan', error: 'Tool permission request failed: AbortError: Stream closed' }]);
  });
});

describe('what a resume costs and reports (#64)', () => {
  const assistant = (usage: Record<string, unknown>, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [], usage } });

  it("the conversation's window is its last response's: input, cache read, cache write and output", () => {
    const c: ContextSeen = {};
    noteContext(assistant({ input_tokens: 10, cache_read_input_tokens: 17_412, cache_creation_input_tokens: 98, output_tokens: 4, cache_creation: { ephemeral_1h_input_tokens: 98, ephemeral_5m_input_tokens: 0 } }), c);
    expect(c).toEqual({ tokens: 17_524, ttlS: 3600, start: 17_520 });
    noteContext(assistant({ input_tokens: 8, cache_read_input_tokens: 19_795, cache_creation_input_tokens: 367, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 367 } }), c);
    // The first response's input stays the turn's start (#346): what it carried before its first tool call.
    expect(c).toEqual({ tokens: 20_171, ttlS: 300, start: 17_520 });
  });

  it('the turn keeps its token split (#345): each response once, subagents included, cache writes with their TTL', () => {
    const t: TokensSeen = { split: emptySplit(), ids: new Set() };
    const msg = (id: string, usage: Record<string, unknown>, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: [], usage } });
    noteTokens(msg('m1', { input_tokens: 10, cache_read_input_tokens: 17_412, cache_creation_input_tokens: 98, output_tokens: 4, cache_creation: { ephemeral_1h_input_tokens: 98 } }), t);
    noteTokens(msg('m1', { input_tokens: 10, cache_read_input_tokens: 17_412, cache_creation_input_tokens: 98, output_tokens: 4 }), t);
    noteTokens(msg('m2', { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 50 }, 'toolu_1'), t);
    noteTokens({ type: 'result', usage: { input_tokens: 9_999_999 } }, t);
    expect(t.split).toEqual({ input: 13, cache_read: 18_412, cache_write: 98, cache_ttl_s: 3600, output: 54 });
  });

  it("a subagent's response never counts: its window is not what a resume sends again", () => {
    const c: ContextSeen = { tokens: 500 };
    noteContext(assistant({ input_tokens: 90_000, output_tokens: 10 }, 'toolu_1'), c);
    noteContext({ type: 'user', message: { content: [] } }, c);
    noteContext(assistant({}), c);
    expect(c).toEqual({ tokens: 500 });
  });

  it('reads the quote from a resume, and nothing from a start or a quote of nothing', () => {
    expect(resumeQuoteOf({ hook_event_name: 'SessionStart', source: 'resume', seconds_since_last_response: 43, context_tokens: 18_162, prompt_cache_likely_expired: false, estimated_cache_write_usd: 0.0363 }))
      .toEqual({ contextTokens: 18_162, cacheWriteUsd: 0.0363, cacheExpired: false, secondsSinceLast: 43 });
    expect(resumeQuoteOf({ source: 'startup', context_tokens: 100, estimated_cache_write_usd: 1 })).toBeUndefined();
    expect(resumeQuoteOf({ source: 'resume', context_tokens: 18_162, estimated_cache_write_usd: 0 })).toBeUndefined();
    expect(resumeQuoteOf({ source: 'resume' })).toBeUndefined();
    expect(resumeQuoteOf(undefined)).toBeUndefined();
  });

  it("a resumed conversation's total is its running total: the turn is what it rose by (HH-181)", () => {
    const r = result();
    settleCost(r, 30.27, { resumed: true, baseline: 29.71 });
    expect(r.costUsd).toBe(0.56);
    expect(r.sessionTotalUsd).toBe(30.27);
  });

  it('a new conversation, or a resume with no baseline to be found, is taken whole', () => {
    const fresh = result(); settleCost(fresh, 1.41, { resumed: false });
    expect(fresh.costUsd).toBe(1.41);
    const unknown = result(); settleCost(unknown, 30.27, { resumed: true });
    expect(unknown.costUsd).toBe(30.27);
    const none = result({ costUsd: 0 }); settleCost(none, undefined, { resumed: true, baseline: 5 });
    expect(none).toMatchObject({ costUsd: 0 });
    expect(none.sessionTotalUsd).toBeUndefined();
    // A total below its baseline (a transcript edited by hand) is never a negative spend.
    const odd = result(); settleCost(odd, 4, { resumed: true, baseline: 5 });
    expect(odd.costUsd).toBe(0);
  });

  it("reads the transcript's newest cost-state from its tail", () => {
    const dir = mkdtempSync(join(tmpdir(), 'planestro-transcript-'));
    const file = join(dir, 's.jsonl');
    const line = (o: unknown) => JSON.stringify(o) + '\n';
    writeFileSync(file, line({ type: 'cost-state', sessionId: 's', totalCostUSD: 13.76 }) + line({ type: 'user', message: { content: 'x'.repeat(4000) } }) + line({ type: 'cost-state', sessionId: 's', totalCostUSD: 23.32 }) + line({ type: 'last-prompt', lastPrompt: 'a "cost-state" in words' }));
    expect(lastCostState(file)).toBe(23.32);
    expect(lastCostState(file, 120)).toBeUndefined();            // the tail holds no whole cost-state line
    expect(lastCostState(join(dir, 'missing.jsonl'))).toBeUndefined();
    expect(lastCostState(undefined)).toBeUndefined();
    writeFileSync(file, line({ type: 'user' }));
    expect(lastCostState(file)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a new conversation is not watched; a resumed one asks the CLI for its quote and may decline', async () => {
    expect(resumeWatch({}).options).toEqual({});
    const w = resumeWatch({ resume: 's', resumeTotalUsd: 12, onResumeQuote: (q) => (q.cacheWriteUsd > 5 ? 'stop' : 'go') });
    const command = (w.options.settings as any).hooks.SessionStart[0].hooks[0].command as string;
    const file = /'(.+)'/.exec(command)![1];
    writeFileSync(file, JSON.stringify({ source: 'resume', context_tokens: 800_000, estimated_cache_write_usd: 32, prompt_cache_likely_expired: true }));
    const ask = (w.options.hooks as any).UserPromptSubmit[0].hooks[0] as (i: unknown) => Promise<Record<string, unknown>>;
    expect(await ask({ transcript_path: undefined })).toMatchObject({ decision: 'block' });
    expect(w).toMatchObject({ declined: true, baseline: 12, quote: { contextTokens: 800_000, cacheWriteUsd: 32, cacheExpired: true } });
    expect(await ask({})).toEqual({ continue: true });            // asked once per turn
    w.cleanup();
    expect(existsSync(file)).toBe(false);
  });
});

describe('the prompt stays open while background work runs (#167)', () => {
  const tasks = (n: number) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: n }, (_, i) => ({ task_id: `t${i}`, task_type: 'local_agent', description: 'x' })) });
  const drain = async (g: InputGate) => { const it = g.open('hi'); expect((await it.next()).value.message.content).toBe('hi'); return it.next(); };

  it('ends at a result with no background task, as a string prompt did', async () => {
    const g = new InputGate(); const end = drain(g);
    g.see({ type: 'assistant', message: { content: [] } }); g.see({ type: 'result' });
    expect((await end).done).toBe(true);
  });

  it('a result while a background agent runs keeps it open; the follow-up turn\'s result ends it', async () => {
    const g = new InputGate(); const end = drain(g);
    g.see(tasks(1)); g.see({ type: 'result' });
    expect(g.closed).toBe(false);
    g.see(tasks(0)); g.see({ type: 'system', subtype: 'init' }); g.see({ type: 'assistant', message: { content: [] } });
    expect(g.closed).toBe(false);
    g.see({ type: 'result' });
    expect((await end).done).toBe(true);
  });

  it('ambient tasks do not count, and a last task that ends with no follow-up turn ends it after the grace', async () => {
    const g = new InputGate(5); const end = drain(g);
    g.see({ ...tasks(0), tasks: [{ task_id: 'w', task_type: 'x', description: 'watcher', ambient: true }] }); g.see({ type: 'result' });
    expect(g.closed).toBe(true);
    const h = new InputGate(5); const end2 = drain(h);
    h.see(tasks(1)); h.see({ type: 'result' }); h.see(tasks(0));
    expect(h.closed).toBe(false);
    expect((await end2).done).toBe(true);
    await end;
  });
});

describe('reports lost in transport (#167)', () => {
  const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const answer = (id: string, text: string, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: [{ type: 'text', text }] }] } });
  const watch = (msgs: unknown[], end = true) => { const seen: (UndeliveredReport | undefined)[] = []; const w = new ReportWatch((r) => seen.push(r)); for (const m of msgs) w.see(m); if (end) w.end(); return seen; };

  it('a report_done whose call errored is kept with its arguments', () => {
    expect(watch([call('a', 'mcp__planestro__report_done', { summary: 'Did it', hold: 'until HH-1' }), answer('a', 'Stream closed', true)]))
      .toEqual([{ tool: 'report_done', args: { summary: 'Did it', hold: 'until HH-1' }, error: 'Stream closed' }]);
  });

  it('a later report that landed clears it; an earlier one answered late does not decide', () => {
    expect(watch([call('a', 'mcp__planestro__report_done', { summary: 'x' }), answer('a', 'Stream closed', true), call('b', 'mcp__planestro__report_done', { summary: 'x' }), answer('b', 'Recorded. End your turn now.')]).at(-1)).toBeUndefined();
    expect(watch([call('a', 'mcp__planestro__report_done', { summary: 'x' }), call('b', 'mcp__planestro__report_blocked', { reason: 'y' }), answer('a', 'Stream closed', true), answer('b', 'Recorded.')])).toEqual([]);
  });

  it("ExitPlanMode is a plan hand-in: planestro's own denial landed, a transport error did not", () => {
    expect(watch([call('a', 'ExitPlanMode', { plan: '# p' }), answer('a', 'Plan recorded by planestro. Do not use ExitPlanMode; end your turn now.', true)])).toEqual([]);
    expect(watch([call('a', 'ExitPlanMode', { plan: '# p' }), answer('a', 'Tool permission request failed: AbortError: Stream closed', true)])).toEqual([{ tool: 'submit_plan', args: { plan: '# p' }, error: 'Tool permission request failed: AbortError: Stream closed' }]);
  });

  it('a last report call with no answer when the stream ended may not have landed', () => {
    expect(watch([call('a', 'mcp__planestro__submit_plan', { plan: '# p' })])).toEqual([{ tool: 'submit_plan', args: { plan: '# p' }, error: 'the session ended before the call was answered' }]);
    expect(watch([call('a', 'mcp__planestro__add_note', { markdown: 'n' })])).toEqual([]);
  });
});

describe('a lost connection to planestro is seen within the turn (#167, HH-377)', () => {
  const call = (id: string, name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  const answer = (id: string, text: string, is_error = true) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: [{ type: 'text', text }] }] } });
  const init = (tools: string[], status = 'connected') => ({ type: 'system', subtype: 'init', tools, mcp_servers: [{ name: 'planestro', status }] });
  const drops = (msgs: unknown[]) => { const seen: unknown[] = []; const w = new DropWatch((d) => seen.push(d), () => 'T'); for (const m of msgs) w.see(m); return seen; };

  it('a planestro call or a permission request that died in transport, the first one only', () => {
    expect(drops([call('a', 'mcp__planestro__add_note'), answer('a', 'Stream closed'), call('b', 'Bash'), answer('b', 'Tool permission request failed: AbortError: Stream closed')]))
      .toEqual([{ error: 'Stream closed', at: 'T', tool: 'add_note' }]);
    expect(drops([call('b', 'Bash'), answer('b', 'Tool permission request failed: AbortError: Stream closed')])).toEqual([{ error: 'Tool permission request failed: AbortError: Stream closed', at: 'T', tool: 'Bash' }]);
    expect(drops([call('b', 'Edit'), answer('b', 'The tool call was interrupted before a result was received')])).toHaveLength(1);
  });

  it("not a command's own failure, a refusal or a bad argument", () => {
    expect(drops([call('b', 'Bash'), answer('b', 'Exit code 1\nnode:internal AbortError: Stream closed by peer')])).toEqual([]);
    expect(drops([call('b', 'Bash'), answer('b', 'Permission recorded by planestro — end this turn')])).toEqual([]);
    expect(drops([call('a', 'mcp__planestro__report_done'), answer('a', 'InputValidationError: summary is required')])).toEqual([]);
    expect(drops([call('a', 'mcp__planestro__report_done'), answer('a', 'Recorded. End your turn now.', false)])).toEqual([]);
  });

  it("planestro's server down or its tools missing when the session starts", () => {
    expect(drops([init(['Bash', 'mcp__planestro__report_done'])])).toEqual([]);
    expect(drops([init(['Bash', 'Read'])])).toEqual([{ error: "planestro's tools were missing from the session's tool list", at: 'T' }]);
    expect(drops([init(['Bash', 'mcp__planestro__report_done'], 'failed')])).toEqual([{ error: "planestro's MCP server status was failed when the session started", at: 'T' }]);
  });
});
