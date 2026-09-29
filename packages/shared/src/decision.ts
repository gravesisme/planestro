/**
 * A decision card: what the orchestrator asks the user when a stopped item needs a call that is
 * really theirs (spend, scope, taste, something irreversible). Stored on the item as
 * `awaiting_data.decision`; the user answers with one of the options or in their own words, and
 * the orchestrator carries the answer out. Plain words, one question, a recommendation first.
 */
export interface DecisionOption {
  label: string; description: string; recommended?: boolean;
  /** Answering with this option first raises the item's dollar budget by this much above what it has spent (dogfood p43): the card does the thing, instead of asking the user to do it elsewhere. */
  raise_budget_usd?: number;
  /** Carrying this option out resumes the item in a fresh conversation with a brief, not its old one (#64): a small raise is then enough. */
  fresh?: boolean;
}
export interface Decision {
  question: string;
  why: string;
  options: DecisionOption[];
  allow_free_text: boolean;
  requested_at: string;
  /** What stopped the item when the card was made (a block reason, or `question`), for the card's details. */
  reason?: string;
}

export const DECISION_LIMITS = { question: 200, why: 400, label: 60, description: 300, minOptions: 2, maxOptions: 4, maxRaiseUsd: 1000 } as const;

export interface DecisionInput { question: string; why: string; options: DecisionOption[]; allow_free_text?: boolean }

/**
 * Validate what the orchestrator proposed and put the recommended option first. Returns the error
 * as a sentence the orchestrator can act on, never throws: a tool result is the only way back.
 */
export function validateDecision(input: DecisionInput): { ok: true; value: Omit<Decision, 'requested_at' | 'reason'> } | { ok: false; error: string } {
  const L = DECISION_LIMITS;
  const question = String(input.question ?? '').trim();
  const why = String(input.why ?? '').trim();
  if (!question) return { ok: false, error: 'the question is empty' };
  if (/\n/.test(question)) return { ok: false, error: 'the question must be one line' };
  if (question.length > L.question) return { ok: false, error: `the question is ${question.length} characters; keep it under ${L.question} — one plain question` };
  if (!why) return { ok: false, error: 'say why in one sentence' };
  if (why.length > L.why) return { ok: false, error: `the why is ${why.length} characters; one sentence, under ${L.why}` };
  const options = (input.options ?? []).map((o) => ({ label: String(o.label ?? '').trim(), description: String(o.description ?? '').trim(), ...(o.recommended ? { recommended: true } : {}), ...(o.raise_budget_usd !== undefined ? { raise_budget_usd: Number(o.raise_budget_usd) } : {}), ...(o.fresh ? { fresh: true } : {}) }));
  if (options.length < L.minOptions || options.length > L.maxOptions) return { ok: false, error: `give ${L.minOptions}–${L.maxOptions} options (you gave ${options.length})` };
  if (options.some((o) => !o.label)) return { ok: false, error: 'every option needs a label' };
  const raise = options.find((o) => o.raise_budget_usd !== undefined && !(Number.isFinite(o.raise_budget_usd) && o.raise_budget_usd! > 0 && o.raise_budget_usd! <= L.maxRaiseUsd));
  if (raise) return { ok: false, error: `option "${raise.label.slice(0, 30)}": raise_budget_usd must be a number of dollars between 0 and ${L.maxRaiseUsd}` };
  const long = options.find((o) => o.label.length > L.label || o.description.length > L.description);
  if (long) return { ok: false, error: `option "${long.label.slice(0, 30)}" is too long: a label under ${L.label} characters, a description under ${L.description}` };
  if (new Set(options.map((o) => o.label.toLowerCase())).size !== options.length) return { ok: false, error: 'option labels must differ' };
  const recommended = options.filter((o) => o.recommended);
  if (recommended.length !== 1) return { ok: false, error: `mark exactly one option recommended (you marked ${recommended.length}): always recommend` };
  return { ok: true, value: { question, why, options: [...recommended, ...options.filter((o) => !o.recommended)], allow_free_text: input.allow_free_text !== false } };
}

/** The decision card waiting on an item, if there is one. */
export function decisionOf(fm: { awaiting_data?: Record<string, unknown> }): Decision | undefined {
  const d = fm.awaiting_data?.decision as Decision | undefined;
  return d && typeof d.question === 'string' && Array.isArray(d.options) ? d : undefined;
}
