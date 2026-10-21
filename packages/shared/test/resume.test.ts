import { describe, it, expect } from 'vitest';
import { resumeEstimate, resumeRates, chooseTurnPath, minRaiseUsd, budgetUsdOf, validateDecision, FRESH_FLOOR_USD, WORK_ROOM_USD, type SessionContext } from '../src/index.ts';

const at = '2026-09-25T12:00:00-04:00';
const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({ session: 's1', model: 'opus', tokens: 800_000, at, ttl_s: 3600, write_usd_per_mtok: 40, ...over });
const later = (min: number) => new Date(Date.parse(at) + min * 60_000);

describe('resumeEstimate (#64)', () => {
  it('prices the reload at the quoted write rate once the cache has expired', () => {
    const e = resumeEstimate({ session_id: 's1', session_context: ctx() }, { now: later(90) })!;
    expect(e).toMatchObject({ tokens: 800_000, cold: 32, usd: 32, isWarm: false, basis: 'quoted' });
  });

  it('prices a read while the cache is warm, and takes a cache about to expire as expired', () => {
    const warm = resumeEstimate({ session_id: 's1', session_context: ctx() }, { now: later(10) })!;
    expect(warm.isWarm).toBe(true);
    expect(warm.usd).toBe(2.56);
    expect(warm.cold).toBe(32);
    expect(resumeEstimate({ session_id: 's1', session_context: ctx() }, { now: later(59.5) })!.isWarm).toBe(false);
    // A turn that did not say how long its writes live is taken at the short lifetime.
    expect(resumeEstimate({ session_id: 's1', session_context: ctx({ ttl_s: undefined }) }, { now: later(10) })!.isWarm).toBe(false);
  });

  it('knows nothing without a record, or with a record for another conversation', () => {
    expect(resumeEstimate({ session_id: 's1' }, { now: later(1) })).toBeUndefined();
    expect(resumeEstimate({ session_id: 's2', session_context: ctx() }, { now: later(1) })).toBeUndefined();
    expect(resumeEstimate({ session_context: ctx() }, { now: later(1) })).toBeUndefined();
  });

  it('on another model the cache is cold and the price is that model\'s, borrowed from where it was last quoted', () => {
    const e = resumeEstimate({ session_id: 's1', session_context: ctx() }, { now: later(1), model: 'fable', rates: { fable: 100 } })!;
    expect(e).toMatchObject({ cold: 80, usd: 80, isWarm: false, basis: 'borrowed' });
    expect(resumeEstimate({ session_id: 's1', session_context: ctx() }, { now: later(1), model: 'fable' })).toBeUndefined();
  });

  it('a conversation never quoted borrows the newest rate quoted for its model', () => {
    const rates = resumeRates([ctx({ at: '2026-09-24T12:00:00-04:00', write_usd_per_mtok: 30 }), ctx({ write_usd_per_mtok: 40 }), ctx({ model: 'haiku', write_usd_per_mtok: 2 }), ctx({ write_usd_per_mtok: undefined }), undefined]);
    expect(rates).toEqual({ opus: 40, haiku: 2 });
    const e = resumeEstimate({ session_id: 's1', session_context: ctx({ write_usd_per_mtok: undefined }) }, { now: later(90), rates })!;
    expect(e).toMatchObject({ cold: 32, basis: 'borrowed' });
  });
});

describe('chooseTurnPath (#64)', () => {
  const cold = resumeEstimate({ session_id: 's1', session_context: ctx() }, { now: later(90) })!;   // $32
  const small = resumeEstimate({ session_id: 's1', session_context: ctx({ tokens: 100_000 }) }, { now: later(90) })!;   // $4
  const base = { hasSession: true, freshAboveUsd: 10 };

  it('resumes what the item can pay for, below the threshold', () => {
    expect(chooseTurnPath({ ...base, left: 20, estimate: small, fresh: 'auto' })).toEqual({ path: 'resume' });
    expect(chooseTurnPath({ ...base, left: 20, estimate: undefined, fresh: 'auto' })).toEqual({ path: 'resume' });
    expect(chooseTurnPath({ ...base, hasSession: false, left: 20 })).toEqual({ path: 'resume' });
  });

  it('HH-184: +$15 against a $32 reload is a fresh conversation when the turn may have one, a stop when it may not', () => {
    expect(chooseTurnPath({ ...base, left: 15, estimate: cold, fresh: 'auto' }).path).toBe('fresh');
    const stop = chooseTurnPath({ ...base, left: 15, estimate: cold });
    expect(stop.path).toBe('stop');
    expect((stop as { why: string }).why).toContain('costs about $32.00 before any work');
    expect((stop as { why: string }).why).toContain('$15.00 is left');
  });

  it('above the threshold a turn whose prompt stands on its own goes fresh even when the resume could be paid for', () => {
    expect(chooseTurnPath({ ...base, left: 100, estimate: cold, fresh: 'auto' }).path).toBe('fresh');
    expect(chooseTurnPath({ ...base, left: 100, estimate: cold }).path).toBe('resume');                       // an answer to its own question
    expect(chooseTurnPath({ ...base, freshAboveUsd: 0, left: 100, estimate: cold, fresh: 'auto' }).path).toBe('resume');   // turned off
  });

  it('#464: past fresh_above_context_tokens a turn that stands on its own goes fresh, even when the reload is cheap', () => {
    const warmBig = { ...small, tokens: 875_000, usd: 1, isWarm: true };
    const big = { ...base, freshAboveTokens: 300_000, left: 100 };
    const fresh = chooseTurnPath({ ...big, estimate: warmBig, fresh: 'auto' });
    expect(fresh.path).toBe('fresh');
    expect((fresh as { why: string }).why).toContain('875k tokens, above fresh_above_context_tokens (300k)');
    expect(chooseTurnPath({ ...big, contextTokens: 400_000, fresh: 'auto' }).path).toBe('fresh');                // unpriced (a token-metered runner)
    expect(chooseTurnPath({ ...big, estimate: warmBig }).path).toBe('resume');                                    // an answer to its own question
    expect(chooseTurnPath({ ...big, estimate: { ...warmBig, tokens: 250_000 }, fresh: 'auto' }).path).toBe('resume');
    expect(chooseTurnPath({ ...big, freshAboveTokens: 0, estimate: warmBig, fresh: 'auto' }).path).toBe('resume');   // turned off
    expect(chooseTurnPath({ ...big, hasSession: false, contextTokens: 900_000, fresh: 'auto' }).path).toBe('resume');
  });

  it('a fresh conversation needs its floor; with less, the engine does not choose one', () => {
    expect(chooseTurnPath({ ...base, left: FRESH_FLOOR_USD - 0.5, estimate: cold, fresh: 'auto' }).path).toBe('stop');
    expect(chooseTurnPath({ ...base, left: FRESH_FLOOR_USD - 0.5, estimate: cold, fresh: true }).path).toBe('fresh');   // asked for: a dollar is enough to try
  });

  it('under a dollar nothing starts, whatever was asked', () => {
    expect(chooseTurnPath({ ...base, left: 0.5, estimate: small, fresh: true }).path).toBe('stop');
    expect(chooseTurnPath({ ...base, hasSession: false, left: 0.5 }).path).toBe('stop');
  });
});

describe('minRaiseUsd (#64)', () => {
  const cold = resumeEstimate({ session_id: 's1', session_context: ctx() }, { now: later(90) })!;
  it('covers the reload with the cache expired and room for the work, less what is left', () => {
    expect(minRaiseUsd(cold, 0, false)).toBe(32 + WORK_ROOM_USD);
    expect(minRaiseUsd(cold, 5, false)).toBe(30);
    expect(minRaiseUsd(cold, -4, false)).toBe(35);   // overspent: the raise is counted from the spend
  });
  it('a fresh session needs only its floor, and a raise is never under a dollar', () => {
    expect(minRaiseUsd(cold, 0, true)).toBe(FRESH_FLOOR_USD);
    expect(minRaiseUsd(undefined, 50, false)).toBe(1);
  });
});

describe('decision options (#64)', () => {
  it('an option keeps its fresh flag through validation', () => {
    const v = validateDecision({ question: 'Spend more?', why: 'It is out of budget.', options: [{ label: '+$5 fresh', description: 'finish it', recommended: true, raise_budget_usd: 5, fresh: true }, { label: 'Stop', description: 'leave it' }] });
    expect(v.ok && v.value.options[0]).toMatchObject({ raise_budget_usd: 5, fresh: true });
    expect(v.ok && 'fresh' in v.value.options[1]).toBe(false);
  });
  it("an item's own budget replaces the project's", () => {
    expect(budgetUsdOf({}, { budget_usd_per_item: 25 })).toBe(25);
    expect(budgetUsdOf({ budget_usd: 60 }, { budget_usd_per_item: 25 })).toBe(60);
  });
});
