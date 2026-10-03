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
  /** Answering with this option has planestro do this as the user (#73): the answer is the authorization, with no second round in the chat. */
  action?: DecisionAction;
}

export interface CreateItemArgs { title: string; description: string; kind?: 'item' | 'epic'; planner?: string; implementer?: string; category?: string; priority?: 'high' | 'medium' | 'low'; parent?: string; depends_on?: string[]; submit?: boolean }
/**
 * What an option can carry: only what the user could do on the page themselves. `submit_item` on an
 * epic plans its breakdown (an epic is never queued), so planning one needs no tool of its own.
 */
export type DecisionAction = { tool: 'create_item'; args: CreateItemArgs } | { tool: 'submit_item'; args: { id: string } } | { tool: 'discard_item'; args: DiscardItemArgs } | { tool: 'close_as_done'; args: { id: string; reason: string } } | { tool: 'rerun_ci'; args: { id: string } };
/** Discard (#135): close the PR, take the item off its epic, put it in the icebox; with delete_branch, its branch on GitHub goes too. */
export interface DiscardItemArgs { id: string; reason: string; delete_branch?: boolean }
/** close_as_done (#126): the work landed some other way, or was never needed (a verify-only item that changed nothing). */
/** rerun_ci (#162): a re-run past the orchestrator's one per head, on the user's tap, when something changed (a full disk freed). */
export const DECISION_ACTION_TOOLS = ['create_item', 'submit_item', 'discard_item', 'close_as_done', 'rerun_ci'] as const;
export interface Decision {
  question: string;
  why: string;
  options: DecisionOption[];
  allow_free_text: boolean;
  requested_at: string;
  /** What stopped the item when the card was made (a block reason, or `question`), for the card's details. */
  reason?: string;
}

export const DECISION_LIMITS = { question: 200, why: 400, label: 60, description: 300, minOptions: 2, maxOptions: 4, maxRaiseUsd: 1000, actionTitle: 200, actionDescription: 8000 } as const;

export interface DecisionInput { question: string; why: string; options: DecisionOption[]; allow_free_text?: boolean }

/** An option's action as the orchestrator passed it (a tool argument: anything), checked for shape; whether it can be carried out is the engine's to say. */
function parseAction(raw: unknown): { value: DecisionAction } | { error: string } {
  const L = DECISION_LIMITS;
  const a = raw as { tool?: unknown; args?: unknown };
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { error: 'its action must be { tool, args }' };
  const args = (a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
  if (a.tool === 'submit_item') return str('id') ? { value: { tool: 'submit_item', args: { id: str('id') } } } : { error: 'action submit_item needs args.id, the item to submit' };
  if (a.tool === 'rerun_ci') return str('id') ? { value: { tool: 'rerun_ci', args: { id: str('id') } } } : { error: 'action rerun_ci needs args.id, the item whose red CI run to re-run' };
  if (a.tool === 'close_as_done') {
    if (!str('id')) return { error: 'action close_as_done needs args.id, the item to close' };
    if (!str('reason')) return { error: 'action close_as_done needs args.reason: why nothing is left to merge, in a sentence (it goes in the Activity log)' };
    return { value: { tool: 'close_as_done', args: { id: str('id'), reason: str('reason').slice(0, 500) } } };
  }
  if (a.tool === 'discard_item') {
    if (!str('id')) return { error: 'action discard_item needs args.id, the item to discard' };
    if (!str('reason')) return { error: 'action discard_item needs args.reason: why it is dropped, in a sentence (it goes on the closed pull request)' };
    if (args.delete_branch !== undefined && typeof args.delete_branch !== 'boolean') return { error: 'action discard_item: delete_branch is true or false' };
    return { value: { tool: 'discard_item', args: { id: str('id'), reason: str('reason').slice(0, 500), ...(args.delete_branch === true ? { delete_branch: true } : {}) } } };
  }
  if (a.tool !== 'create_item') return { error: `its action's tool "${String(a.tool)}" is not one an option can carry: ${DECISION_ACTION_TOOLS.join(', ')}` };
  const title = str('title'); const description = str('description');
  if (!title) return { error: 'action create_item needs args.title' };
  if (title.length > L.actionTitle) return { error: `action create_item: the title is ${title.length} characters; keep it under ${L.actionTitle}` };
  if (!description) return { error: 'action create_item needs args.description, a complete brief: the worker sees only the title and description' };
  if (description.length > L.actionDescription) return { error: `action create_item: the description is ${description.length} characters; keep it under ${L.actionDescription}` };
  if (args.kind !== undefined && args.kind !== 'item' && args.kind !== 'epic') return { error: 'action create_item: kind is "item" or "epic"' };
  const named = ['planner', 'implementer', 'category', 'parent'] as const;
  const bad = named.find((k) => args[k] !== undefined && !str(k));
  if (bad) return { error: `action create_item: ${bad} must be a name (leave it out for the default)` };
  if (args.depends_on !== undefined && !(Array.isArray(args.depends_on) && args.depends_on.every((d) => typeof d === 'string' && d.trim()))) return { error: 'action create_item: depends_on is a list of item ids' };
  if (args.submit !== undefined && typeof args.submit !== 'boolean') return { error: 'action create_item: submit is true or false' };
  if (args.priority !== undefined && args.priority !== 'high' && args.priority !== 'medium' && args.priority !== 'low') return { error: 'action create_item: priority is "high", "medium" or "low" (leave it out for none)' };
  return { value: { tool: 'create_item', args: {
    title, description, ...(args.kind === 'epic' ? { kind: 'epic' as const } : {}),
    ...Object.fromEntries(named.filter((k) => str(k)).map((k) => [k, str(k)])),
    ...(Array.isArray(args.depends_on) && args.depends_on.length ? { depends_on: (args.depends_on as string[]).map((d) => d.trim()) } : {}),
    ...(args.priority !== undefined ? { priority: args.priority as 'high' | 'medium' | 'low' } : {}),
    ...(args.submit === true ? { submit: true } : {}),
  } } };
}

/**
 * What picking an option with this action does, as the rest of a sentence ("Tapping this …"). Said by
 * code from the action itself: the orchestrator writes both the label and the action, and the user
 * must be able to see what the tap really does. `lookup` names the item a submit is for.
 */
export function describeAction(action: DecisionAction, lookup?: (id: string) => { title: string; kind?: 'item' | 'epic' } | undefined): string {
  if (action.tool === 'rerun_ci') {
    const it = lookup?.(action.args.id);
    return `re-runs the failed jobs of ${action.args.id}${it ? ` "${it.title}"` : ''}'s red CI run (its new attempt decides)`;
  }
  if (action.tool === 'close_as_done') {
    const it = lookup?.(action.args.id);
    return `closes ${action.args.id}${it ? ` "${it.title}"` : ''} as done without a pull request (its worktree and branch go only if they hold no changes)`;
  }
  if (action.tool === 'discard_item') {
    const it = lookup?.(action.args.id);
    return `discards ${action.args.id}${it ? ` "${it.title}"` : ''}: closes its pull request, takes it off its epic and puts it in the icebox, ${action.args.delete_branch ? 'and deletes its branch on GitHub' : 'keeping its branch on GitHub'}`;
  }
  if (action.tool === 'submit_item') {
    const it = lookup?.(action.args.id);
    const name = `${action.args.id}${it ? ` "${it.title}"` : ''}`;
    return it?.kind === 'epic' ? `has the breakdown of epic ${name} planned (you approve its children)` : `queues ${name} for planning`;
  }
  const a = action.args; const epic = a.kind === 'epic';
  const what = `creates the ${a.priority ? `${a.priority}-priority ` : ''}${epic ? 'epic' : 'item'} "${a.title}"${a.parent ? ` in epic ${a.parent}` : ''}${a.implementer ? `, implemented by ${a.implementer}` : ''}${a.depends_on?.length ? `, after ${a.depends_on.join(', ')}` : ''}`;
  return `${what}${a.submit ? (epic ? ' and has its breakdown planned (you approve its children)' : ' and queues it for planning') : ', not submitted yet'}`;
}

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
  const raw = input.options ?? [];
  const options: DecisionOption[] = raw.map((o) => ({ label: String(o.label ?? '').trim(), description: String(o.description ?? '').trim(), ...(o.recommended ? { recommended: true } : {}), ...(o.raise_budget_usd !== undefined ? { raise_budget_usd: Number(o.raise_budget_usd) } : {}), ...(o.fresh ? { fresh: true } : {}) }));
  if (options.length < L.minOptions || options.length > L.maxOptions) return { ok: false, error: `give ${L.minOptions}–${L.maxOptions} options (you gave ${options.length})` };
  if (options.some((o) => !o.label)) return { ok: false, error: 'every option needs a label' };
  const raise = options.find((o) => o.raise_budget_usd !== undefined && !(Number.isFinite(o.raise_budget_usd) && o.raise_budget_usd! > 0 && o.raise_budget_usd! <= L.maxRaiseUsd));
  if (raise) return { ok: false, error: `option "${raise.label.slice(0, 30)}": raise_budget_usd must be a number of dollars between 0 and ${L.maxRaiseUsd}` };
  const long = options.find((o) => o.label.length > L.label || o.description.length > L.description);
  if (long) return { ok: false, error: `option "${long.label.slice(0, 30)}" is too long: a label under ${L.label} characters, a description under ${L.description}` };
  if (new Set(options.map((o) => o.label.toLowerCase())).size !== options.length) return { ok: false, error: 'option labels must differ' };
  const recommended = options.filter((o) => o.recommended);
  if (recommended.length !== 1) return { ok: false, error: `mark exactly one option recommended (you marked ${recommended.length}): always recommend` };
  // Actions last, so a card that is wrong in a plainer way hears about that first.
  for (const [i, o] of options.entries()) {
    const given = (raw[i] as { action?: unknown }).action;
    if (given === undefined || given === null) continue;
    if (o.raise_budget_usd !== undefined || o.fresh) return { ok: false, error: `option "${o.label.slice(0, 30)}" has both ${o.raise_budget_usd !== undefined ? 'raise_budget_usd' : 'fresh'} and an action: an option does one thing` };
    const action = parseAction(given);
    if ('error' in action) return { ok: false, error: `option "${o.label.slice(0, 30)}": ${action.error}` };
    o.action = action.value;
  }
  return { ok: true, value: { question, why, options: [...recommended, ...options.filter((o) => !o.recommended)], allow_free_text: input.allow_free_text !== false } };
}

/** The decision card waiting on an item, if there is one. */
export function decisionOf(fm: { awaiting_data?: Record<string, unknown> }): Decision | undefined {
  const d = fm.awaiting_data?.decision as Decision | undefined;
  return d && typeof d.question === 'string' && Array.isArray(d.options) ? d : undefined;
}
