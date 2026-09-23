import { describe, it, expect } from 'vitest';
import { noteUsage, classifyUsage, type UsageSignals } from '../src/engine/sessions/LiveClaudePort.ts';
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
