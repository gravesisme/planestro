import { minRaiseUsd, type DecisionOption, type ItemFrontmatter, findModel, canPlan, fallbackChain, unavailableEntry, validateDecision, decisionOf, isDone, type DecisionInput, type DecisionAction, type Decision, type Status, type ResumeEstimate, type SessionContext, type ModelDef, resolveAccount, accountList, unavailableView, sameSessionStore, DEFAULT_ACCOUNT, type Account } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { TurnPhase } from './ports.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { Guards } from './guards.ts';
import type { Epics } from './epics.ts';

/**
 * Triage (#404, seam 7): a stop goes to the orchestrator first, before the user (triageOps, driveTriage and its timeout,
 * endTriage), and the decision cards it leaves when a stop is the user's call: filing one (askUserDecision), taking it back
 * (withdrawDecision), the user's answer (answerDecision), what an option may raise (raiseTooSmall) and the action it may carry,
 * checked when the card is filed and again at the tap and performed as the user (#73: actionRefusal, performAction,
 * submitAsUser). The usage stop with another account free files its own card (#242: blockExhausted, "Continue on <account>",
 * "Wait for the reset"). block itself, the wake queue and the operations a card's action runs (discard, close as done, re-run
 * CI, reopen a PR, retry at the reset, unblock) stay in LiveEngine. LiveEngine owns one and delegates to it; this is what it
 * needs from the engine, and nothing more.
 */
export interface TriageContext {
  readonly store: DataStore;
  /** Read live: nothing is triaged while the engine stops. */
  readonly stopping: boolean;
  /** Turns this engine started, items with a job in flight and the wakes held for a turn to end: read only (a step running holds triage back). */
  readonly turns: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<string, unknown>;
  readonly pendingWakes: ReadonlyMap<string, unknown>;
  /** Whether there is an orchestrator to triage, and whether it already has the item. */
  readonly orchestrator: Pick<Orchestrator, 'enabled' | 'reviewing'>;
  /** A paused orchestrator is never woken, so nothing triages while paused. */
  readonly guards: Pick<Guards, 'paused'>;
  /** A submitted epic has its breakdown planned. */
  readonly epics: Pick<Epics, 'startEpicPlan'>;
  now(): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  /** `card`: a decision the engine files itself, the user's from the start (#242). */
  block(id: string, reason: string, detail: string, awaiting?: 'user', stall?: undefined, card?: Omit<Decision, 'requested_at' | 'reason'>): void;
  unblock(id: string, message: string | undefined, by: 'user', opts?: { fresh?: boolean }): Promise<void>;
  wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void;
  poke(): void;
  /** Why an item cannot take a step now (a job or a turn running), or undefined. */
  busyWith(id: string): string | undefined;
  /** A runner's usage guard on an account is up. */
  guarded(runner: string, account?: string): boolean;
  phaseFor(status: Status): TurnPhase | null;
  budgetOf(fm: { budget_usd?: number; budget_turns?: number; budget_tokens?: number }): { usd: number; usdKey: string; turns: number; turnsKey: string; tokens: number; tokensKey: string };
  resumeEstimateFor(fm: { session_id?: string; session_context?: SessionContext }, model?: string): ResumeEstimate | undefined;
  freshRefusal(fm: { id: string; status: Status; worktree?: string }, message?: string): string | undefined;
  /** What a card's action runs, as the user: each refusal is asked when the card is filed and again at the tap. */
  discardRefusal(id: string): string | null;
  closeAsDoneRefusal(id: string): string | null;
  rerunRefusal(id: string): string | null;
  reopenRefusal(id: string): string | null;
  discard(id: string, reason: string, opts: { deleteBranch?: boolean; from?: string }): Promise<string>;
  closeAsDone(id: string, reason?: string): Promise<void>;
  rerunCi(id: string, by: 'user'): Promise<string>;
  reopenPr(id: string): Promise<string>;
  retryAtReset(id: string, at: string | undefined, by: 'user'): string;
}

/** How many stops of one item, in one status, the orchestrator triages before the rest go straight to the user (a fix that keeps failing is a conversation for a person). */
const MAX_TRIAGE_ROUNDS = 4;

export class Triage {
  constructor(private readonly ctx: TriageContext) {}

  /** The accounts that could take this item's turn now: same runner, not guarded, and its model (or a fallback it allows) not out there. */
  private accountsFree(fm: ItemFrontmatter, requested: ModelDef, except: string): Account[] {
    const runner = requested.runner ?? 'claude';
    const chain = fm.allow_model_fallback === true ? fallbackChain(this.ctx.store.config, requested) : [requested];
    const now = new Date(Date.now());
    return accountList(this.ctx.store.local, runner).filter((a) => a.name !== except && !this.ctx.guarded(runner, a.name)
      && chain.some((m) => !unavailableEntry(unavailableView(this.ctx.store.local.model_unavailable, a.name), m.id, now)));
  }
  /**
   * Out of usage (#242): with another account that could take the turn, the block comes with a card of its own, "Continue on
   * <account>" for each (up to three) and "Wait for the reset"; spending on another account is the user's call, so it is
   * not triaged. Without one, the plain usage_exhausted stop.
   */
  blockExhausted(id: string, requested: ModelDef, account: Account, detail: string): void {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const others = this.accountsFree(fm, requested, account.name).slice(0, 3);
    if (!others.length || fm.taken_over) { this.ctx.block(id, 'usage_exhausted', detail); return; }
    const saved = fm.agent_sessions?.[requested.runner ?? 'claude']?.account ?? account.name;
    const options: DecisionOption[] = others.map((a, i) => ({
      label: `Continue on ${a.label}`.slice(0, 60),
      description: `${sameSessionStore(this.ctx.store.local, saved, a.name) ? 'Its conversation resumes there' : 'That account cannot see its conversation, so a fresh one starts from a brief'}; usage is billed to ${a.name === DEFAULT_ACCOUNT ? 'the default login' : `account ${a.name}`}.`,
      ...(i === 0 ? { recommended: true } : {}),
      action: { tool: 'continue_on_account', args: { id, account: a.name } },
    }));
    options.push({ label: 'Wait for the reset', description: `It waits until ${requested.label}'s usage resets on ${account.label}, then carries on by itself.`, action: { tool: 'wait_for_reset', args: { id } } });
    this.ctx.block(id, 'usage_exhausted', detail, 'user', undefined, {
      question: `${requested.label} is out of usage on ${account.label}. Carry on with another account?`.slice(0, 200),
      why: `${others.map((a) => a.label).join(', ')} can take this turn now; it spends that account's usage.`.slice(0, 400),
      options, allow_free_text: false,
    });
  }
  /** Why `account` cannot take item `id`'s turn now, or null (checked when the card is filed and again at the tap). */
  private accountRefusal(id: string, name: string): string | null {
    const fm = this.ctx.store.getItem(id)?.file.frontmatter;
    if (!fm) return `there is no item ${id}`;
    if (fm.taken_over) return `${id} is taken over: the user is finishing it by hand`;
    if (fm.blocked_reason !== 'usage_exhausted') return `${id} is not stopped for usage`;
    const requested = findModel(this.ctx.store.config, fm.status === 'PLAN_IN_PROGRESS' ? fm.planner : fm.implementer);
    if (!requested) return `${id} has no model to run`;
    const acct = resolveAccount(this.ctx.store.local, requested.runner ?? 'claude', { item: name });
    if ('missing' in acct) return acct.why;
    if (acct.account.runner !== (requested.runner ?? 'claude')) return `account ${name} is a ${acct.account.runner} account; ${requested.label} runs on ${requested.runner ?? 'claude'}`;
    if (!this.accountsFree(fm, requested, '').some((a) => a.name === name)) return `${requested.label} cannot run on account ${name} now (its usage is out or paused there too)`;
    return this.ctx.busyWith(id) ?? null;
  }
  /** The user's "Continue on <account>": the item runs on it from here, and carries on from where it stopped. */
  private async continueOnAccount(id: string, name: string): Promise<string> {
    const refusal = this.accountRefusal(id, name);
    if (refusal) throw new Error(refusal);
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const runner = findModel(this.ctx.store.config, fm.status === 'PLAN_IN_PROGRESS' ? fm.planner : fm.implementer)?.runner ?? 'claude';
    const label = accountList(this.ctx.store.local, runner).find((a) => a.name === name)?.label ?? name;
    this.ctx.store.mutateItem(id, [{ set: { account: name } }, { activity: { actor: 'user', text: `continues on ${label}: its turns run on that account from here` } }], 'user', { commit: `${id}: continue on account ${name}` });
    await this.ctx.unblock(id, undefined, 'user');
    return `${id} continues on account ${name}`;
  }

  // ---- needs-you triage: the orchestrator looks at a stop before the user does ----
  /** On in config, an orchestrator to ask, and automation running (a paused orchestrator is never woken). */
  private triageAvailable(): boolean { return this.ctx.store.config.orchestrator.triage && this.ctx.orchestrator.enabled && !this.ctx.guards.paused && !this.ctx.stopping; }

  /** The ops that put a stop into triage, or none (with a note why) when it goes straight to the user. */
  triageOps(fm: { status: Status; op_data?: Record<string, unknown> }, reason: string): { on: boolean; ops: ItemOp[] } {
    if (!this.triageAvailable() || reason === 'disk_full') return { on: false, ops: [] };   // a full disk is not the orchestrator's to judge (#161)
    const rounds = fm.op_data?.triage_status === fm.status ? Number(fm.op_data?.triage_rounds ?? 0) : 0;
    if (rounds >= MAX_TRIAGE_ROUNDS) return { on: false, ops: [{ activity: { actor: 'app', text: `not triaged: the orchestrator has already looked at ${rounds} stops of this item in ${fm.status}; it needs you` } }] };
    return { on: true, ops: [
      { set: { triage: { reason, started_at: this.ctx.now() }, op_data: { ...(fm.op_data ?? {}), triage_status: fm.status, triage_rounds: rounds + 1 } } },
      { activity: { actor: 'app', text: `the orchestrator is triaging this (${reason}) before it comes to you` } },
    ] };
  }

  /**
   * Nothing waits in triage on memory (invariant 2/3): a restart drops the wake queue, the switch can
   * be turned off, automation can be paused, and a wake can hang. Each of those ends in today's
   * behaviour — the item needs you — or, for a dropped wake, a new one.
   */
  driveTriage(): void {
    const timeoutMs = this.ctx.store.config.orchestrator.triage_timeout_min * 60_000;
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      if (!fm.triage) continue;
      // A step is running: the stop's own turn still ending (its wake follows), or a repair, which ends by unblocking or by blocking again.
      if (this.ctx.jobs.has(item.id) || this.ctx.turns.has(item.id) || this.ctx.pendingWakes.has(item.id)) continue;
      if (!this.triageAvailable()) this.endTriage(item.id, this.ctx.guards.paused ? 'automation is paused' : 'the orchestrator is not available');
      else if (Date.now() - Date.parse(fm.triage.started_at) > timeoutMs) this.endTriage(item.id, `triage took longer than ${this.ctx.store.config.orchestrator.triage_timeout_min} min (orchestrator.triage_timeout_min)`);
      else if (!this.ctx.orchestrator.reviewing(item.id)) this.ctx.wakeOrchestrator(fm.triage.reason === 'decision' ? 'decision_answered' : fm.triage.reason === 'question' ? 'worker_question' : `blocked_${fm.triage.reason}`, item.id, { note: 'woken again: the earlier wake was lost (a restart)' });
    }
  }

  /** Triage is over without a resolution: the item is the user's, exactly as it stopped. */
  endTriage(id: string, why: string): void {
    const fm = this.ctx.store.getItem(id)?.file.frontmatter;
    if (!fm?.triage || this.ctx.jobs.has(id)) return;
    this.ctx.store.mutateItem(id, [{ unset: ['triage'] }, { activity: { actor: 'app', text: `needs you: ${why}` } }], 'engine', { commit: `${id}: triage ended` });
    this.ctx.note('info', `${id}: needs you — ${why}`);
  }

  /** The orchestrator takes a card back: the item keeps its stop, and stops asking the user this question. */
  withdrawDecision(id: string, reason: string): string {
    const item = this.ctx.store.getItem(id);
    if (!item) return `no item ${id}`;
    const { decision, ...rest } = item.file.frontmatter.awaiting_data ?? {};
    if (!decision) return `nothing to withdraw: ${id} has no decision card`;
    this.ctx.store.mutateItem(id, [Object.keys(rest).length ? { set: { awaiting_data: rest } } : { unset: ['awaiting_data'] }, { activity: { actor: 'orchestrator', text: `withdrew the decision card (${String((decision as { question?: string }).question ?? '').slice(0, 80)}): ${reason}` } }], 'orchestrator', { commit: `${id}: decision withdrawn` });
    this.ctx.store.journal.append({ type: 'orchestrator.decision_withdrawn', item: id, actor: 'orchestrator', data: { question: (decision as { question?: string }).question, reason } });
    return 'withdrawn: the card is gone; the item is otherwise as it was (still stopped, if it was). Resolve it or file a new card in this wake, or it goes to the user as a plain block.';
  }

  /** The first raise option that would not pay for what it promises, as a sentence for the orchestrator; undefined when they all do. */
  private raiseTooSmall(fm: ItemFrontmatter, options: DecisionOption[]): string | undefined {
    // A fresh conversation changes context, not the item's cumulative budget counters.
    const needed = fm.blocked_reason === 'turn_budget' ? 'raise_budget_turns' : fm.blocked_reason === 'token_budget' ? 'raise_budget_tokens' : undefined;
    // An MCP budget is only for an implementer that has MCP servers to spend it on (#371).
    const mcp = findModel(this.ctx.store.config, fm.implementer)?.mcp ?? [];
    const noMcp = options.find((o) => o.set_mcp_budget !== undefined && !mcp.length);
    if (noMcp) return `option "${noMcp.label}" sets an MCP budget, but ${fm.id}'s implementer (${fm.implementer ?? 'none'}) has no MCP servers to spend it on.`;
    for (const o of options) {
      if (needed && (o.raise_budget_usd !== undefined || o.raise_budget_turns !== undefined || o.raise_budget_tokens !== undefined || o.fresh) && o[needed] === undefined) return `option "${o.label}" cannot clear ${fm.blocked_reason}: include ${needed}; dollars and fresh sessions do not extend this limit.`;
      for (const [key, cap, used] of [['raise_budget_turns', this.ctx.budgetOf(fm).turns, fm.agent_turns ?? 0], ['raise_budget_tokens', this.ctx.budgetOf(fm).tokens, fm.tokens ?? 0]] as const) {
        if (o[key] !== undefined && !Number.isSafeInteger(Math.max(cap, used) + o[key]!)) return `option "${o.label}": ${key} would exceed the safe integer limit.`;
      }
    }
    const phase = this.ctx.phaseFor(fm.status);
    const left = this.ctx.budgetOf(fm).usd - (fm.cost_usd ?? 0);
    const def = this.ctx.store.config.models.find((m) => m.id === (phase === 'plan' ? fm.planner : fm.implementer));
    const estimate = fm.session_id && def && (def.runner ?? 'claude') === 'claude' ? this.ctx.resumeEstimateFor(fm, def.claude_model) : undefined;
    for (const o of options) {
      if (o.raise_budget_usd === undefined) continue;
      if (o.fresh && phase !== 'implement' && phase !== 'fix') return `option "${o.label.slice(0, 30)}" asks for a fresh session, which is only for work in progress or in review (${fm.id} is ${fm.status}).`;
      const floor = minRaiseUsd(estimate, left, Boolean(o.fresh));
      if (o.raise_budget_usd >= floor) continue;
      return o.fresh
        ? `option "${o.label.slice(0, 30)}" raises the budget by $${o.raise_budget_usd}, but a fresh session needs about $${floor} to do a small job.`
        : `option "${o.label.slice(0, 30)}" raises the budget by $${o.raise_budget_usd}, but resuming ${fm.id}'s conversation costs about $${estimate!.cold.toFixed(2)} before any work (${Math.round(estimate!.tokens / 1000)}k tokens to reload), so the raise would be spent on the reload. Raise by at least $${floor}, or offer a fresh session instead (fresh: true on the option, from +$${minRaiseUsd(estimate, left, true)}): it gets a brief and your instruction, and needs no reload.`;
    }
    return undefined;
  }

  // ---- what the user authorized: a card option's action, an explicit request in the chat (#73) ----

  /**
   * Why planestro cannot do this for the user, or null when it can: exactly what would make doing it
   * throw, or leave an item that never starts. Asked when a card is made, so the user is never
   * offered an option that fails, and again when it is picked, since the backlog moves in between.
   * The chat's create_item is held to the same answer.
   */
  actionRefusal(action: DecisionAction): string | null {
    const cfg = this.ctx.store.config;
    if (action.tool === 'discard_item') return this.ctx.discardRefusal(action.args.id);
    if (action.tool === 'close_as_done') return this.ctx.closeAsDoneRefusal(action.args.id);
    if (action.tool === 'rerun_ci') return this.ctx.rerunRefusal(action.args.id);
    if (action.tool === 'reopen_pr') return this.ctx.reopenRefusal(action.args.id);
    if (action.tool === 'continue_on_account') return this.accountRefusal(action.args.id, action.args.account);
    if (action.tool === 'wait_for_reset') return this.ctx.store.getItem(action.args.id)?.file.frontmatter.blocked_reason === 'usage_exhausted' ? null : `${action.args.id} is not stopped for usage`;
    if (action.tool === 'submit_item') {
      const item = this.ctx.store.getItem(action.args.id);
      if (!item) return `there is no item ${action.args.id}`;
      const fm = item.file.frontmatter; const d = this.ctx.store.derived(item);
      if (fm.status !== 'NOT_YET_SUBMITTED') return `${fm.id} is ${fm.status}; only an item that is not submitted yet can be submitted`;
      if (fm.taken_over) return `${fm.id} is taken over: the user is finishing it by hand`;
      if (fm.blocked || fm.awaiting) return `${fm.id} is stopped (${fm.blocked ? `blocked: ${fm.blocked_reason}` : `awaiting ${fm.awaiting}`}); that comes first`;
      if (d.flavor === 'external') return `${fm.id} is implemented outside planestro (${fm.implementer}): it is started by hand, not queued`;
      if (d.flavor !== 'epic') return null;
      if (d.children.length) return `epic ${fm.id} already has children (${d.children.join(', ')}): submit those, and the epic opens by itself when one is queued`;
      if (!d.base_branch) return d.base_branch_error ?? `${fm.id} has no base branch`;
      return this.ctx.busyWith(fm.id) ?? null;
    }
    const a = action.args;
    if (a.category && !cfg.categories.includes(a.category)) return `unknown category "${a.category}": ${cfg.categories.join(', ')}`;
    if (a.parent) {
      const parent = this.ctx.store.getItem(a.parent)?.file.frontmatter;
      if (!parent) return `there is no item ${a.parent} to be its parent`;
      if (parent.kind !== 'epic') return `${a.parent} is not an epic, so it cannot be a parent`;
      if (a.kind === 'epic') return `an epic cannot be a child of ${a.parent}: epics do not nest`;
      if (isDone(parent.status)) return `epic ${a.parent} is ${parent.status}: it takes no more children`;
    }
    const planner = findModel(cfg, a.planner);
    if (a.planner && (!planner || !canPlan(planner))) return `planner "${a.planner}" is not a model that can plan: ${cfg.models.filter(canPlan).map((m) => m.id).join(', ')}`;
    if (a.implementer && !findModel(cfg, a.implementer)) return `implementer "${a.implementer}" is not one of the project's models: ${cfg.models.map((m) => m.id).join(', ')}`;
    const missing = (a.depends_on ?? []).filter((d) => !this.ctx.store.getItem(d));
    if (missing.length) return `it would depend on ${missing.join(', ')}, which ${missing.length === 1 ? 'is not an item' : 'are not items'} here: it could never start`;
    if (a.submit && a.kind !== 'epic' && findModel(cfg, a.implementer ?? cfg.defaults.implementer)?.external) return 'its implementer works outside planestro, so it is started by hand, not queued: leave submit out';
    return null;
  }

  /** Submit an item as the user does on its page: a worker item is queued, an epic has its breakdown planned (an epic is never queued). Throws the refusal. */
  submitAsUser(id: string, why: string): 'queued' | 'planning' {
    const refusal = this.actionRefusal({ tool: 'submit_item', args: { id } });
    if (refusal) throw new Error(refusal);
    if (this.ctx.store.requireItem(id).file.frontmatter.kind === 'epic') { this.ctx.epics.startEpicPlan(id, why); return 'planning'; }
    this.ctx.store.mutateItem(id, [{ transition: { to: 'QUEUED', actor: 'user' } }, { activity: { actor: 'app', text: `queued for planning: ${why}` } }], 'user', { commit: `${id}: queued` });
    this.ctx.poke();
    return 'queued';
  }

  /**
   * Do what the picked option says, as the user: their answer on `from`'s card authorized it. Returns
   * what happened, in words. It throws only while nothing is written; once the item exists a submit
   * that fails is part of the result, so a second tap can never create a second item.
   */
  private performAction(action: DecisionAction, from: string): string {
    const why = `you chose it on ${from}'s decision card`;
    if (action.tool === 'discard_item' || action.tool === 'close_as_done' || action.tool === 'rerun_ci' || action.tool === 'reopen_pr' || action.tool === 'continue_on_account' || action.tool === 'wait_for_reset') throw new Error(`${action.tool} is carried out by answerDecision`);
    if (action.tool === 'submit_item') return this.submitAsUser(action.args.id, why) === 'planning' ? `epic ${action.args.id} is having its breakdown planned` : `${action.args.id} is queued for planning`;
    const a = action.args; const epic = a.kind === 'epic';
    const planner = findModel(this.ctx.store.config, a.planner)?.id; const implementer = findModel(this.ctx.store.config, a.implementer)?.id;
    const it = this.ctx.store.createItem({ title: a.title, description: a.description, kind: epic ? 'epic' : 'item', ...(planner ? { planner } : {}), ...(implementer ? { implementer } : {}), ...(a.category ? { category: a.category } : {}), ...(a.priority ? { priority: a.priority } : {}), ...(a.parent ? { parent: a.parent } : {}), ...(a.depends_on ? { depends_on: a.depends_on } : {}) }, 'user');
    this.ctx.store.mutateItem(it.id, [{ activity: { actor: 'user', text: `created by your answer on ${from}'s decision card, as the orchestrator proposed it there` } }], 'user');
    const made = `created ${epic ? 'epic ' : ''}${it.id} ("${a.title}")`;
    if (!a.submit) return `${made}, not submitted yet`;
    try { return `${made} and ${this.submitAsUser(it.id, why) === 'planning' ? 'started planning its breakdown' : 'queued it for planning'}`; }
    catch (e) { return `${made}, but it could not be submitted: ${(e as Error).message}`; }
  }

  /** The orchestrator's escalation: one plain decision, parked on an item that is already stopped. */
  askUserDecision(id: string, input: DecisionInput): string {
    const item = this.ctx.store.getItem(id);
    if (!item) return `no item ${id}`;
    const fm = item.file.frontmatter;
    if (!fm.blocked && fm.awaiting !== 'question' && fm.awaiting !== 'user') return `not possible: ${id} is not stopped (not blocked, no question). A decision card belongs on an item that waits; use ask_user for anything else.`;
    const v = validateDecision(input);
    if (!v.ok) return `not recorded: ${v.error}. Fix that and call ask_user_decision again.`;
    // A raise the item would spend reloading its conversation is not an option (HH-184's +$15 met a $32 reload):
    // the card is answered by someone who cannot know that, so every raise on it must be enough to finish.
    const small = this.raiseTooSmall(fm, v.value.options);
    if (small) return `not recorded: ${small} Fix that and call ask_user_decision again.`;
    // An option that does something is checked now: the user is never offered one that would fail (#73).
    for (const o of v.value.options) {
      const refusal = o.action ? this.actionRefusal(o.action) : null;
      if (refusal) return `not recorded: option "${o.label}" cannot be carried out: ${refusal}. Fix its action (or leave the action out) and call ask_user_decision again.`;
    }
    const decision: Decision = { ...v.value, requested_at: this.ctx.now(), reason: fm.blocked ? fm.blocked_reason : fm.awaiting === 'question' ? 'question' : fm.awaiting };
    this.ctx.store.mutateItem(id, [
      { set: { awaiting: fm.awaiting ?? 'user', awaiting_data: { ...(fm.awaiting_data ?? {}), decision } } },
      { unset: ['triage'] },
      { activity: { actor: 'orchestrator', text: `decision needed: ${decision.question} (recommended: ${decision.options[0].label})` } },
    ], 'orchestrator', { commit: `${id}: decision for the user` });
    this.ctx.store.journal.append({ type: 'orchestrator.decision_requested', item: id, actor: 'orchestrator', data: { question: decision.question, why: decision.why, options: decision.options.map((o) => o.label) } });
    this.ctx.note('warn', `${id}: needs your decision — ${decision.question}`);
    return 'recorded: the user sees the card; you will be woken with the answer. End this wake with done_with_wake.';
  }

  /**
   * The user answered a decision card. The answer is the orchestrator's to carry out, so the item
   * goes back into triage and the orchestrator is woken with the question and the answer; without
   * an orchestrator, a blocked session is resumed with them directly.
   */
  async answerDecision(id: string, answer: { choice?: string; text?: string }): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const decision = decisionOf(fm);
    if (!decision) throw new Error(`${id} has no decision waiting for you`);
    const choice = answer.choice?.trim(); const text = answer.text?.trim();
    if (!choice && !text) throw new Error('pick an option or write your answer');
    if (choice && !decision.options.some((o) => o.label === choice)) throw new Error(`"${choice}" is not one of the options`);
    if (!choice && !decision.allow_free_text) throw new Error('pick one of the options');
    const said = [choice, text].filter(Boolean).join(' — ');
    const { decision: _answered, ...rest } = fm.awaiting_data ?? {};
    const carry = this.triageAvailable();
    // The option carries the change it names (p43): answering IS raising the budget, not a promise to go raise it elsewhere.
    const chosen = decision.options.find((o) => o.label === choice);
    const invalidRaise = chosen ? this.raiseTooSmall(fm, [chosen]) : undefined;
    if (invalidRaise) throw new Error(invalidRaise);
    const raise = chosen?.raise_budget_usd;
    const fresh = Boolean(chosen?.fresh) && !this.ctx.freshRefusal(fm, said);
    // Or it carries an action (#73): the answer is the authorization, so planestro does it as the user, here. Checked
    // again first, since the backlog may have moved since the card was made; a refusal leaves the card as it was.
    const refusal = chosen?.action ? this.actionRefusal(chosen.action) : null;
    if (refusal) throw new Error(`"${choice}" cannot be carried out any more: ${refusal}. Pick another option, or answer in your own words.`);
    // A discard closes a pull request and may delete a branch: async, and it can leave this card's own item in the icebox.
    // So does closing one as done (#126): both are async, and both can end this card's own item (icebox, FINISHED).
    const act = chosen?.action;
    // A re-run clears the block and the card with it (#162): the same ending as the two that move the item.
    const ends = act?.tool === 'discard_item' || act?.tool === 'close_as_done' || act?.tool === 'rerun_ci' || act?.tool === 'reopen_pr' || act?.tool === 'continue_on_account' || act?.tool === 'wait_for_reset';
    const done = act?.tool === 'discard_item' ? await this.ctx.discard(act.args.id, act.args.reason, { deleteBranch: act.args.delete_branch === true, from: `your answer on ${id}'s decision card` })
      : act?.tool === 'close_as_done' ? (await this.ctx.closeAsDone(act.args.id, `${act.args.reason} (your answer on ${id}'s decision card)`), `${act.args.id} closed as done`)
      : act?.tool === 'rerun_ci' ? await (async () => { const r = await this.ctx.rerunCi(act.args.id, 'user'); if (/^not (possible|now)/.test(r)) throw new Error(r); return r; })()
      : act?.tool === 'reopen_pr' ? await (async () => { const r = await this.ctx.reopenPr(act.args.id); if (/^not (possible|now)/.test(r)) throw new Error(r); return r; })()
      : act?.tool === 'continue_on_account' ? await this.continueOnAccount(act.args.id, act.args.account)
      : act?.tool === 'wait_for_reset' ? (this.ctx.store.mutateItem(id, [Object.keys(rest).length ? { set: { awaiting_data: rest } } : { unset: ['awaiting_data'] }], 'user'), this.ctx.retryAtReset(act.args.id, undefined, 'user'))
      : act ? this.performAction(act, id) : undefined;
    if (ends && !decisionOf(this.ctx.store.requireItem(id).file.frontmatter)) {
      this.ctx.store.mutateItem(id, [{ activity: { actor: 'user', text: `decided: ${decision.question} → ${said} (done for you: ${done})` } }], 'user', { commit: `${id}: decision answered` });
      this.ctx.store.journal.append({ type: 'orchestrator.decision_answered', item: id, actor: 'user', data: { question: decision.question, choice: choice ?? null, text: text ?? null, action: act!.tool, action_result: done } });
      return;
    }
    const raisedTurns = chosen?.raise_budget_turns !== undefined ? Math.max(this.ctx.budgetOf(fm).turns, fm.agent_turns ?? 0) + chosen.raise_budget_turns : undefined;
    const raisedTokens = chosen?.raise_budget_tokens !== undefined ? Math.max(this.ctx.budgetOf(fm).tokens, fm.tokens ?? 0) + chosen.raise_budget_tokens : undefined;
    // The user's tap is the spend's authorization (#371): the plan's MCP calls, set on the item as they read it on the card.
    const mcpBudget = chosen?.set_mcp_budget;
    const mcpTo = mcpBudget !== undefined ? `MCP budget set to ${mcpBudget} call${mcpBudget === 1 ? '' : 's'} to ${findModel(this.ctx.store.config, fm.implementer)?.mcp.join(', ') || 'its MCP servers'} (mcp_budget)` : '';
    const raisedUnits = [raisedTurns !== undefined ? `turn budget raised to ${raisedTurns}` : '', raisedTokens !== undefined ? `token budget raised to ${raisedTokens}` : '', mcpTo].filter(Boolean).join('; ');
    const raisedTo = raise ? Math.round((Math.max(this.ctx.budgetOf(fm).usd, fm.cost_usd ?? 0) + raise) * 100) / 100 : undefined;
    this.ctx.store.mutateItem(id, [
      Object.keys(rest).length ? { set: { awaiting_data: rest } } : { unset: ['awaiting_data'] },
      ...(carry ? [{ set: { triage: { reason: 'decision', started_at: this.ctx.now() } } } as ItemOp] : []),
      ...(raisedTo !== undefined ? [{ set: { budget_usd: raisedTo } } as ItemOp] : []),
      ...(raisedTurns !== undefined ? [{ set: { budget_turns: raisedTurns } } as ItemOp] : []),
      ...(raisedTokens !== undefined ? [{ set: { budget_tokens: raisedTokens } } as ItemOp] : []),
      ...(mcpBudget !== undefined ? [{ set: { mcp_budget: mcpBudget } } as ItemOp] : []),
      { activity: { actor: 'user', text: `decided: ${decision.question} → ${said}${raisedTo !== undefined ? ` (budget raised to $${raisedTo})` : ''}${raisedUnits ? ` (${raisedUnits})` : ''}${done ? ` (done for you: ${done})` : ''}` } },
    ], 'user', { commit: `${id}: decision answered` });
    this.ctx.store.journal.append({ type: 'orchestrator.decision_answered', item: id, actor: 'user', data: { question: decision.question, choice: choice ?? null, text: text ?? null, ...(raisedTo !== undefined ? { budget_raised_to: raisedTo } : {}), ...(raisedTurns !== undefined ? { budget_turns_raised_to: raisedTurns } : {}), ...(raisedTokens !== undefined ? { budget_tokens_raised_to: raisedTokens } : {}), ...(mcpBudget !== undefined ? { mcp_budget: mcpBudget } : {}), ...(done ? { action: chosen!.action!.tool, action_result: done } : {}) } });
    const doneNote = done ? `Already done by planestro, as the user: ${done}. Do not do it again. ` : '';
    const raisedNote = (raisedTo !== undefined ? `The item's budget is already raised to $${raisedTo} (budget_usd); nothing else needs changing. ` : '') + (raisedUnits ? `Already applied: ${raisedUnits}. ` : '');
    if (carry) { this.ctx.wakeOrchestrator('decision_answered', id, { question: decision.question, answer: said, options: decision.options.map((o) => `${o.label}: ${o.description}`).join(' | '), ...(raisedNote ? { budget: `${raisedNote}Resume it with unblock_item${fresh ? ' and fresh: true, as the option promised' : ''}.` } : fresh ? { budget: 'The option promised a fresh session: unblock_item with fresh: true and the instruction as its message.' } : {}), ...(done ? { action: `${doneNote}What is left is this item's own stop.` } : {}) }); return; }
    // No orchestrator to carry it out: a blocked session hears the answer itself; a worker's question stays for you to answer.
    const cur = this.ctx.store.requireItem(id).file.frontmatter;
    if (cur.blocked || cur.awaiting === 'user') await this.ctx.unblock(id, `The user was asked: ${decision.question}\nTheir answer: ${said}${raisedNote ? `\n${raisedNote}` : ''}${doneNote ? `\n${doneNote}` : ''}`, 'user', { fresh });
  }
}
