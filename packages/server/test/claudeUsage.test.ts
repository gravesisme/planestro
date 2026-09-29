import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteUsage, classifyUsage, rateLimitSnapshot, type UsageSignals, noteToolFailures, noteContext, resumeQuoteOf, settleCost, lastCostState, resumeWatch, type ContextSeen } from '../src/engine/sessions/LiveClaudePort.ts';
import type { TurnResult } from '../src/engine/ports.ts';

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
    expect(c).toEqual({ tokens: 17_524, ttlS: 3600 });
    noteContext(assistant({ input_tokens: 8, cache_read_input_tokens: 19_795, cache_creation_input_tokens: 367, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 367 } }), c);
    expect(c).toEqual({ tokens: 20_171, ttlS: 300 });
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
