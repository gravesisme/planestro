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
