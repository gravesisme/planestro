import { describe, expect, it } from 'vitest';
import { USAGE_GUARD_RESET_MARGIN_MS, usageGuardTrips, guardNeedsYou, guardsNeedingYou, guardWindowReset, guardSays, guardProviderLabel, type ProviderGuard, type RateLimitSnapshot } from '../src/usage.ts';

const NOW = Date.parse('2026-11-18T20:58:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const cfg = { enabled: true, threshold: 0.85, on_warning: true, auto_resume: false };
const snap = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({ status: 'allowed', window: 'seven_day', utilization: 0.85, resetsAt: at(2 * 60 * MIN), ...over });
const guard = (over: Partial<ProviderGuard> = {}): ProviderGuard => ({ window: 'seven_day', status: 'allowed', utilization: 0.85, resets_at: at(2 * MIN), tripped_at: at(0), ...over });

describe('a reading just before its window resets does not trip the guard (#579)', () => {
  it('the threshold and a warning are ignored inside the margin, and count again outside it', () => {
    expect(usageGuardTrips(cfg, snap({ resetsAt: at(2 * MIN) }), NOW)).toBe(false);
    expect(usageGuardTrips(cfg, snap({ status: 'allowed_warning', utilization: 0.2, resetsAt: at(2 * MIN) }), NOW)).toBe(false);
    expect(usageGuardTrips(cfg, snap({ resetsAt: at(USAGE_GUARD_RESET_MARGIN_MS - 1) }), NOW)).toBe(false);
    expect(usageGuardTrips(cfg, snap({ resetsAt: at(USAGE_GUARD_RESET_MARGIN_MS) }), NOW)).toBe(true);
    expect(usageGuardTrips(cfg, snap({ status: 'allowed_warning', utilization: 0.2, resetsAt: at(USAGE_GUARD_RESET_MARGIN_MS) }), NOW)).toBe(true);
  });
  it('a reading whose reset has already passed is stale and does not trip either', () => {
    expect(usageGuardTrips(cfg, snap({ resetsAt: at(-MIN) }), NOW)).toBe(false);
  });
  it('a used-up window trips however close its reset is, and a reading with no reset time trips as before', () => {
    expect(usageGuardTrips(cfg, snap({ status: 'rejected', resetsAt: at(MIN) }), NOW)).toBe(true);
    expect(usageGuardTrips(cfg, snap({ resetsAt: undefined }), NOW)).toBe(true);
    expect(usageGuardTrips(cfg, snap({ resetsAt: 'not a time' }), NOW)).toBe(true);
  });
});

describe('a provider guard that waits on the user (#579)', () => {
  it('needs you once its window has reset and nothing resumes it by itself', () => {
    const g = guard();
    expect(guardWindowReset(g, NOW)).toBe(false);
    expect(guardNeedsYou(g, cfg, NOW)).toBe(false);
    expect(guardNeedsYou(g, cfg, NOW + 2 * MIN)).toBe(true);
    expect(guardNeedsYou(g, cfg, NOW + 62 * MIN)).toBe(true);
  });
  it('does not while auto_resume is about to lift it, and does when the trip recorded no resume time', () => {
    const auto = { auto_resume: true };
    expect(guardNeedsYou(guard({ resume_at: at(3 * MIN) }), auto, NOW + 2 * MIN)).toBe(false);
    // tripped while auto_resume was off, switched on later: nothing is scheduled for it
    expect(guardNeedsYou(guard(), auto, NOW + 2 * MIN)).toBe(true);
    // a resume time from an earlier setting does not count once auto_resume is off
    expect(guardNeedsYou(guard({ resume_at: at(3 * MIN) }), cfg, NOW + 2 * MIN)).toBe(true);
  });
  it('a guard with no reset time never counts: there is no moment it became the user\'s turn', () => {
    expect(guardNeedsYou(guard({ resets_at: undefined }), cfg, NOW + 24 * 60 * MIN)).toBe(false);
  });
  it('is counted per provider and account', () => {
    const guards = { claude: guard(), 'claude:work': guard({ resets_at: at(60 * MIN) }), codex: guard({ resets_at: at(MIN) }) };
    expect(guardsNeedingYou(guards, cfg, NOW)).toEqual([]);
    expect(guardsNeedingYou(guards, cfg, NOW + 5 * MIN)).toEqual(['claude', 'codex']);
    expect(guardsNeedingYou(undefined, cfg, NOW)).toEqual([]);
  });
});

describe('a provider guard in words (#579)', () => {
  it('names the provider, and a named account', () => {
    expect(guardProviderLabel('claude')).toBe('Claude');
    expect(guardProviderLabel('codex')).toBe('Codex');
    expect(guardProviderLabel('claude:work')).toBe('Claude (work)');
  });
  it('says why it paused and what ends it, then that the window has reset and Retry is waiting', () => {
    const before = guardSays('claude', guard(), cfg, NOW);
    expect(before).toMatch(/^Claude paused for usage \(7-day window at 85%\) · the window resets at .+, then press Retry Claude$/);
    expect(guardSays('claude', guard(), cfg, NOW + 2 * MIN)).toBe('Claude usage window has reset · nothing new starts on Claude until you press Retry Claude');
    expect(guardSays('claude', guard(), cfg, NOW + 2 * MIN)).not.toMatch(/resets/);
  });
  it('says when it resumes by itself, and asks for a retry when no reset is known', () => {
    expect(guardSays('codex', guard({ resume_at: at(3 * MIN) }), { auto_resume: true }, NOW)).toMatch(/^Codex paused for usage \(7-day window at 85%\) · resumes by itself at /);
    expect(guardSays('codex', guard({ resume_at: at(3 * MIN) }), { auto_resume: true }, NOW + 2 * MIN)).toMatch(/^Codex usage window has reset · resumes by itself at /);
    expect(guardSays('claude', guard({ status: 'rejected', utilization: undefined, resets_at: undefined }), cfg, NOW)).toBe('Claude paused for usage (7-day window used up) · nothing new starts on Claude until you press Retry Claude');
  });
});
