import { describe, it, expect } from 'vitest';
import { noteUsage, classifyUsage, rateLimitSnapshot, type UsageSignals } from '../src/engine/sessions/LiveClaudePort.ts';
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
});
