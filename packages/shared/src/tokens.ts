/** Tokens charged against every token budget. Reasoning is already in output. */
export function budgetTokens(u: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }): number {
  return Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)) + (u.output_tokens ?? 0);
}

/** App-server totals include earlier turns. Baseline them before the new turn starts. */
export class TurnTokenCounter {
  private baseline: number;
  private consumed = 0;
  constructor(total = 0) { this.baseline = total; }
  update(u: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): number {
    const total = budgetTokens({ input_tokens: u.inputTokens, cached_input_tokens: u.cachedInputTokens, output_tokens: u.outputTokens });
    this.consumed = Math.max(this.consumed, total - this.baseline);
    return this.consumed;
  }
}

/**
 * A turn's tokens by kind (#345), summed over every request it made: uncached input, cache reads, cache
 * writes (with the longest TTL they were written at) and output. Codex reports no cache writes.
 */
export interface TokenSplit { input: number; cache_read: number; cache_write: number; cache_ttl_s?: number; output: number }
export const emptySplit = (): TokenSplit => ({ input: 0, cache_read: 0, cache_write: 0, output: 0 });
/** The work a turn paid for in full (uncached input, cache writes, output), what `tokens` means for every runner. */
export const splitBudgetTokens = (s: TokenSplit) => s.input + s.cache_write + s.output;
/** Cache reads over all input; undefined with no input at all. */
export function cacheHitRate(s: { input: number; cache_read: number; cache_write: number }): number | undefined {
  const all = s.input + s.cache_read + s.cache_write;
  return all > 0 ? s.cache_read / all : undefined;
}
/** A Codex usage reading (its input includes the cached part) as a split. */
export function codexSplit(u: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }): TokenSplit {
  const cached = u.cachedInputTokens ?? 0;
  return { input: Math.max(0, (u.inputTokens ?? 0) - cached), cache_read: cached, cache_write: 0, output: u.outputTokens ?? 0 };
}
/** `a - b` field by field, never below zero: a turn's share of a running total. */
export function splitMinus(a: TokenSplit, b: TokenSplit): TokenSplit {
  const d = (k: 'input' | 'cache_read' | 'cache_write' | 'output') => Math.max(0, a[k] - b[k]);
  return { input: d('input'), cache_read: d('cache_read'), cache_write: d('cache_write'), output: d('output'), ...(a.cache_ttl_s ? { cache_ttl_s: a.cache_ttl_s } : {}) };
}
export function splitPlus(a: TokenSplit, b: TokenSplit): TokenSplit {
  const ttl = Math.max(a.cache_ttl_s ?? 0, b.cache_ttl_s ?? 0);
  return { input: a.input + b.input, cache_read: a.cache_read + b.cache_read, cache_write: a.cache_write + b.cache_write, output: a.output + b.output, ...(ttl ? { cache_ttl_s: ttl } : {}) };
}
