// ---- loop until green (#171) ----

/** The loop's last reported iteration, as persisted in `loop_state`. */
export interface LoopState { iteration: number; passing: number; total: number; line?: string; at: string }

/** Every check of the last iteration passed (and there was at least one check to pass). */
export function loopGreen(state: LoopState | undefined): boolean {
  return Boolean(state && state.total > 0 && state.passing >= state.total);
}

/** The progress line for the Activity log and the item page: `iteration 3/8: 5/7 passing — note`. */
export function loopLine(state: Pick<LoopState, 'iteration' | 'passing' | 'total' | 'line'>, maxIterations: number): string {
  return `iteration ${state.iteration}/${maxIterations}: ${state.passing}/${state.total} passing${state.line ? ` — ${state.line}` : ''}`;
}

/** Whether a worker's tally is well formed; the reason in words when it is not. */
export function loopTallyProblem(passing: unknown, total: unknown): string | undefined {
  if (!Number.isInteger(passing) || !Number.isInteger(total)) return 'passing and total must be whole numbers';
  if ((total as number) < 1) return 'total must be at least 1: the number of checks this loop runs';
  if ((passing as number) < 0 || (passing as number) > (total as number)) return `passing must be between 0 and total (${total})`;
  return undefined;
}
