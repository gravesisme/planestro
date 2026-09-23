import { describe, it, expect } from 'vitest';
import { ModelDef } from '../src/schema.ts';
import { unavailableUntil, resolveTurnModel, fallbackChain, findModel, markUnavailable, unavailableEntry, isUsageLimitText, resetTime, fallbackProblems } from '../src/models.ts';

const m = (o: Record<string, unknown>) => ModelDef.parse(o);
const cfg = {
  models: [
    m({ id: 'big', label: 'Big', claude_model: 'claude-big', fallback: 'mid' }),
    m({ id: 'mid', label: 'Mid', claude_model: 'claude-mid', fallback: 'small' }),
    m({ id: 'small', label: 'Small', claude_model: 'claude-small' }),
    m({ id: 'art', label: 'Art', runner: 'codex' }),
    m({ id: 'odd', label: 'Odd', claude_model: 'claude-odd', fallback: 'art' }),
  ],
};
const now = new Date('2026-09-22T12:00:00Z');
const out = (id: string, until = '2026-09-23T09:00:00Z') => ({ [id]: { until, reason: 'limit' } });
const big = cfg.models[0];

describe('model fallback', () => {
  it('without allow, always the requested model — a remembered outage is only information', () => {
    const p = resolveTurnModel(cfg, big, { allow: false, unavailable: out('big'), now });
    expect(p.def.id).toBe('big'); expect(p.model).toBe('claude-big');
    expect(p.fellBackFrom).toBeUndefined(); expect(p.sdkFallback).toBeUndefined();
  });

  it('with allow and nothing out, the requested model, with the next one as the SDK fallback', () => {
    const p = resolveTurnModel(cfg, big, { allow: true, now });
    expect(p.def.id).toBe('big'); expect(p.sdkFallback).toBe('claude-mid'); expect(p.fellBackFrom).toBeUndefined();
  });

  it('skips unavailable models down the chain and says why', () => {
    const p = resolveTurnModel(cfg, big, { allow: true, unavailable: out('big'), now });
    expect(p.def.id).toBe('mid'); expect(p.fellBackFrom?.id).toBe('big'); expect(p.skipped?.until).toBe('2026-09-23T09:00:00Z'); expect(p.sdkFallback).toBe('claude-small');
    const q = resolveTurnModel(cfg, big, { allow: true, unavailable: { ...out('big'), ...out('mid') }, now });
    expect(q.def.id).toBe('small'); expect(q.sdkFallback).toBeUndefined();
  });

  it('an expired outage no longer counts: the primary is tried first again', () => {
    const p = resolveTurnModel(cfg, big, { allow: true, unavailable: out('big', '2026-09-22T11:59:00Z'), now });
    expect(p.def.id).toBe('big');
  });

  it('every model out: the requested one, and the earliest return', () => {
    const p = resolveTurnModel(cfg, big, { allow: true, unavailable: { ...out('big', '2026-09-23T09:00:00Z'), ...out('mid', '2026-09-22T18:00:00Z'), ...out('small', '2026-09-24T00:00:00Z') }, now });
    expect(p.def.id).toBe('big'); expect(p.exhaustedUntil).toBe('2026-09-22T18:00:00.000Z');
  });

  it('never crosses runners, and stops at a cycle', () => {
    expect(fallbackChain(cfg, cfg.models[4]).map((x) => x.id)).toEqual(['odd']);
    const loop = { models: [m({ id: 'a', label: 'A', claude_model: 'x', fallback: 'b' }), m({ id: 'b', label: 'B', claude_model: 'y', fallback: 'a' })] };
    expect(fallbackChain(loop, loop.models[0]).map((x) => x.id)).toEqual(['a', 'b']);
    expect(fallbackProblems(loop)).toEqual(expect.arrayContaining([expect.stringContaining('loops back')]));
    expect(fallbackProblems(cfg)).toEqual(['model odd: fallback art runs on codex, not claude']);
    expect(fallbackProblems({ models: [m({ id: 'a', label: 'A', claude_model: 'x', fallback: 'nope' })] })).toEqual(['model a: fallback nope is not a model id']);
  });

  it('finds a model by id or by its model string (the orchestrator setting accepts both)', () => {
    expect(findModel(cfg, 'mid')?.id).toBe('mid');
    expect(findModel(cfg, 'claude-small')?.id).toBe('small');
    expect(findModel(cfg, 'claude-unknown')).toBeUndefined();
  });

  it('marking replaces the entry and drops expired ones', () => {
    const map = { ...out('small', '2026-09-22T10:00:00Z'), ...out('mid') };
    const next = markUnavailable(map, 'big', { until: new Date('2026-09-23T01:00:00Z'), reason: 'Fable 5 requires usage credits', manual: true }, now);
    expect(Object.keys(next).sort()).toEqual(['big', 'mid']);
    expect(next.big).toMatchObject({ until: '2026-09-23T01:00:00.000Z', manual: true, since: now.toISOString() });
    expect(unavailableEntry(next, 'big', now)).toBeDefined();
    expect(unavailableEntry(next, 'big', new Date('2026-09-23T02:00:00Z'))).toBeUndefined();
  });

  it('recognises usage-limit messages and nothing else', () => {
    for (const t of ["You've hit your limit · resets 9am", 'Fable 5 requires usage credits. Buy more…', "You're out of extra usage", 'Your org is out of usage · add funds to continue', 'Some Future Model requires usage credits']) expect(isUsageLimitText(t), t).toBe(true);
    for (const t of ['', 'The plan is ready.', 'API Error: 500', 'I hit your limit of patience', undefined]) expect(isUsageLimitText(t as string), String(t)).toBe(false);
    expect(isUsageLimitText('Brand new wording', ['Brand new'])).toBe(true);
  });

  it('a reset that is missing or already past falls back to the default window, so a retry never loops', () => {
    expect(unavailableUntil('2026-09-23T09:00:00Z', now).toISOString()).toBe('2026-09-23T09:00:00.000Z');
    for (const r of [undefined, 'garbage', '2026-09-22T11:00:00Z', '2026-09-22T12:00:30Z']) expect(unavailableUntil(r, now).toISOString(), String(r)).toBe('2026-09-22T13:00:00.000Z');
  });

  it('reads reset times in seconds or milliseconds', () => {
    expect(resetTime(1790000000)?.toISOString()).toBe(new Date(1790000000 * 1000).toISOString());
    expect(resetTime(1790000000000)?.toISOString()).toBe(new Date(1790000000000).toISOString());
    expect(resetTime(undefined)).toBeUndefined(); expect(resetTime('x')).toBeUndefined(); expect(resetTime(0)).toBeUndefined();
  });
});
