import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { getSection, epicFlagOf, holdShapeOf, heldReasonOf, type HoldFlag, partsSummary, serializeItemFile, serializeQuestionFile, parseThread, isoLocal, renormalize, laneOf, findModel, resolveTurnModel, fallbackChain, unavailableEntry, markUnavailable, unavailableUntil, type ServerEvent, parseActivity } from '@planestro/shared';
import { parkHint } from './parks.ts';
import { hostNote, keptPathsNote } from './hostNote.ts';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Ports, CustomToolDef, TurnResult } from './ports.ts';
import type { DecisionInput, DecisionAction, RateLimitSnapshot } from '@planestro/shared';

/**
 * What submit_item does with an epic, said wherever the user is talking to it (#73): the tool list
 * promised a submit that the engine refused, and the user had already been told it was queued.
 */
const EPIC_SUBMIT_POLICY = 'submit_item on an epic does not queue it: it has the epic\'s breakdown planned, as the user\'s own action, and the user approves the children. Do that only when they ask you to start the epic. Say what a tool returned, never what you expected it to: a result that starts "not permitted", "refused" or "failed" means it did not happen.';

/**
 * What a user_message wake is for, said in the packet rather than the prompt library: a data dir's
 * copy of orchestrator-system predates the chat.
 */
const CHAT_POLICY = [
  'The user is talking to you in the planestro chat. They see only what you send with reply_to_user, so always answer with it before done_with_wake.',
  'In this wake you may act on what they ask: create_item for new backlog work (submit it only if they say to; kind epic for several separately shippable pieces), convert_item to make an item an epic or back before it runs, submit_item, unblock_item or retry_op to get a stopped item moving (unblock_item with fresh: true starts a new conversation with a brief instead of reloading a long one), commit_paths to commit finished work in a worktree without a session turn, sync_with_base to bring a branch up to date with its base, message_session, annotate_item, and the ordering tools.',
  'For a blocked item, read_item first: the Activity log says why it stopped. Explain the cause in plain words; resolve it when the fix is an instruction you can give, and say plainly when the decision is theirs.',
  'Ask one short question with reply_to_user when the request is ambiguous rather than guessing; their answer arrives as the next wake.',
  EPIC_SUBMIT_POLICY,
].join('\n');

/**
 * The user wrote in one question's thread (#75): the same authority as the chat, but the answer
 * belongs on that question's page, and the discussion can settle or change the question itself.
 */
const QUESTION_CHAT_POLICY = [
  'The user is discussing one of your questions on its own page. They read only that page\'s thread: answer with reply_on_question (not reply_to_user) before done_with_wake.',
  'You have the same authority as in the chat: act on what they ask with your tools (create_item for new backlog work, submit_item, unblock_item, retry_op, commit_paths, sync_with_base, message_session, annotate_item, the ordering tools), and say in the thread what you did.',
  EPIC_SUBMIT_POLICY,
  'When their answer settles the question, carry it out, then resolve_question with status resolved and the answer in a sentence. When it changes what you would recommend or what the question is, update_question so the page says it. Ask one short follow-up with reply_on_question when their answer is ambiguous; it arrives as the next wake.',
].join('\n');

/** The "Still relevant?" button (#75): judge the question against the item as it is now, and leave it better or gone. */
const QUESTION_REVIEW_POLICY = [
  'Relevance check: the user asked whether this question still stands. Compare it with the current state below (and read_item or pr_status if you need more). End with exactly one of:',
  '- resolve_question with status withdrawn and the reason, when it is moot: answered elsewhere, overtaken by events, its item finished or went another way. Use status resolved when you can see how it was answered.',
  '- update_question, when it still stands but the situation moved on: rewrite the summary (plain terms, 1–3 sentences, for someone who has not read the logs), the details and the recommendation to fit today.',
  'If it still stands exactly as written, do neither: planestro notes "reviewed, no change" in its thread. Do not reply in the thread for this check; the change you make is the answer.',
].join('\n');

/** How much of the chat a fresh conversation is given (#59). */
const RECENT_CHAT_DAYS = 7;
const RECENT_CHAT_ENTRIES = 30;

export interface WakeEvent { type: string; item?: string; data?: Record<string, unknown> }
/** The question a wake is about: `question_message` and `question_review` carry its id in `data.question`. */
const questionOf = (e: WakeEvent): string | undefined => (e.type.startsWith('question_') && typeof e.data?.question === 'string' ? e.data.question : undefined);

/**
 * The tools that change an item, refused on one a person has taken over (dogfood p28): the
 * orchestrator may read it, check its PR and annotate it, never act on it, until it is handed back.
 */
const HANDS_OFF = new Set([
  'skip_merge', 'unskip_merge', 'message_session', 'submit_item', 'mark_blocked', 'approve_plan', 'amend_plan', 'request_plan_changes',
  'hand_plan_to_user', 'decide_permission', 'hand_off_files', 'unblock_item', 'answer_question', 'set_item_fields', 'recreate_worktree',
  'retry_op', 'ask_user_decision', 'withdraw_decision', 'finish_from_worktree', 'resume_after', 'set_merge_order', 'set_queue_order',
  'sync_with_base', 'convert_item', 'resolve_epic_conflict', 'commit_paths',
]);

export interface OrchestratorHooks {
  message(id: string, text: string): Promise<void>;
  /** `hold`: the pull request it opens stays out of the merge queue, for this reason (#97). */
  approvePlan(id: string, notes?: string, hold?: string): Promise<void>;
  /** Hold an item out of the merge queue, with the reason on the item. Returns what happened. */
  holdMerge(id: string, reason: string): string;
  /** Make an item an epic or back while nothing has run for implementation (LiveEngine.convertKind). Returns what happened, or why not. */
  convertKind(id: string, to: 'item' | 'epic', why: string): Promise<string>;
  /** Have an epic's planner propose its children (LiveEngine.planEpic). */
  planEpic(id: string, why?: string): Promise<void>;
  /** Why planestro could not do this for the user, or null (LiveEngine.actionRefusal): a card option's action, or the chat's create_item. */
  actionRefusal(action: DecisionAction): string | null;
  /** Submit an item as the user's own action: a worker item is queued, an epic has its breakdown planned. Throws the refusal. */
  submitForUser(id: string, why: string): 'queued' | 'planning';
  /** Send a plan back for fixes, within the item's round limit. Returns what happened, for the tool result. */
  requestPlanChanges(id: string, message: string): Promise<string>;
  /** Approve WITH stipulations: they go to the planner as amendments (not a fix round) and the revised plan comes back for review. */
  amendPlan(id: string, amendments: string): Promise<string>;
  /** Whether this item's plan is the orchestrator's to approve (the item opted in and the project allows it). */
  planDelegated(id: string): boolean;
  /** Give a delegated plan's approval back to the user, with the reason. */
  handPlanToUser(id: string, reason: string): void;
  /** A wake that carried this item's plan review is over, however it ended. */
  planReviewEnded(id: string): void;
  /** Whether workers' permission requests come to the orchestrator before the user. */
  permissionsDelegated(): boolean;
  /** Decide a worker's parked permission request: allow it once, deny it with a reason, or leave it to the user. */
  decidePermission(id: string, decision: 'allow' | 'deny' | 'ask_user', reason: string): Promise<string>;
  /** A wake that carried this item's permission request is over, however it ended. */
  permissionReviewEnded(id: string): void;
  /** Copy files from one item's worktree to another item that waits on it (see LiveEngine.handOff). */
  handOff(from: string, to: string, paths: string[], note: string): Promise<string>;
  // ---- triage: resolve a stopped item, or turn it into one plain decision for the user ----
  /** Clear a block (or an `awaiting: user`) and, with a message, resume the session with it. */
  unblock(id: string, message?: string, syncFirst?: boolean, fresh?: boolean): Promise<string>;
  /** Commit named files in an item's worktree with no model turn; returns what happened, in words. */
  commitPaths(id: string, paths: string[], message: string): Promise<string>;
  /** What an item has left and what resuming it costs before any work, for the packet. */
  budgetLine?(id: string): string | undefined;
  /** Bring a stopped or idle item's branch up to date with its base between turns (LiveEngine.syncWithBase). */
  syncWithBase(id: string): Promise<string>;
  /** Retry an epic's sync conflict with a one-shot conflict session, carrying a hint (LiveEngine.retryEpicConflict, #71). */
  resolveEpicConflict(id: string, hint?: string): Promise<string>;
  /** Answer a worker's parked questions, as the user would. */
  answerQuestion(id: string, answers: Record<string, string>): Promise<string>;
  /** Set a whitelisted handful of an item's own fields (parent, dependencies, base override, …). */
  setItemFields(id: string, fields: Record<string, unknown>): string;
  /** Replace a worktree that holds no work with a fresh one from the item's current base, then unblock. */
  recreateWorktree(id: string, message?: string): Promise<string>;
  /** Re-run the step a transient failure stopped (a GitHub 5xx, a network hiccup). */
  retryOp(id: string): Promise<string>;
  /** Open the pull request for work already committed on a clean worktree ahead of its base, clearing any stop (LiveEngine.finishFromWorktree). */
  finishFromWorktree(id: string): Promise<string>;
  /** Park a structured decision card on a stopped item for the user. */
  askUserDecision(id: string, input: DecisionInput): string;
  /** Take a decision card off an item that no longer needs one (the stop is being handled another way). */
  withdrawDecision(id: string, reason: string): string;
  /** A wake that carried this item's triage is over; if it is still in triage, it goes to the user. */
  triageEnded(id: string): void;
  /** Park a stopped item until other items merge, then resume it with the message (LiveEngine.resumeAfter). */
  resumeAfter(id: string, items: string[], message: string): Promise<string>;
  poke(): void;
  /** Every wake's rate-limit reading, for the usage guard (a wake spends the same subscription as a worker turn). */
  usageSeen?(rateLimit: RateLimitSnapshot | undefined): void;
}

/** `total_usd`: the running total the conversation last reported; a resumed wake's cost is what it rose by (#64). */
interface OrchState { session_id?: string; started_at?: string; wakes_served: number; total_usd?: number }

/**
 * The judgment layer: one resumable Fable session, woken with a compact structured
 * context packet per event, never polled, rotated freely (invariant 3 — the files are
 * its memory). It proposes state changes through tools; the engine and user stay in
 * charge of everything mechanical.
 */
export class Orchestrator {
  private queue: WakeEvent[] = [];
  private running = false;
  /** A wake is being served now. */
  get busy(): boolean { return this.running; }
  private stopped = false;
  /** Items whose events are in the wake running now (the queue holds the ones still to come). */
  private inFlight = new Set<string>();
  /** Questions in the wake running now, and those it changed (resolved or updated) or answered in their thread. */
  private questionsInFlight = new Set<string>();
  private reviewsInFlight = new Set<string>();
  private questionsChanged = new Set<string>();
  private questionsAnswered = new Set<string>();
  /** How the last wake ended, for a question it did not answer. */
  private lastOutcome = '';
  constructor(
    private readonly store: DataStore,
    private readonly ports: Ports,
    private readonly hooks: OrchestratorHooks,
    private readonly emit: (e: ServerEvent) => void,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void,
    private readonly pausedRef: () => boolean,
  ) {}

  get enabled(): boolean { return typeof this.ports.agents.claude.runCustomTurn === 'function'; }

  private get stateFile(): string { return join(this.store.dataDir, '.planestro', 'orchestrator.yml'); }
  private readState(): OrchState {
    try { return { wakes_served: 0, ...(YAML.parse(readFileSync(this.stateFile, 'utf8')) ?? {}) }; } catch { return { wakes_served: 0 }; }
  }
  private writeState(s: OrchState): void { mkdirSync(join(this.store.dataDir, '.planestro'), { recursive: true }); writeFileSync(this.stateFile, YAML.stringify(s)); }

  stop(): void { this.stopped = true; }

  /** Queue an event; coalesced into one turn if more arrive while a wake is running. */
  wake(event: WakeEvent): void {
    if (!this.enabled || this.stopped) return;
    // A second "Still relevant?" while the first is queued or running asks nothing new.
    const q = questionOf(event);
    if (q && event.type === 'question_review' && (this.queue.some((e) => e.type === 'question_review' && questionOf(e) === q) || this.reviewsInFlight.has(q))) return;
    this.queue.push(event);
    if (q) this.emit({ type: 'question.updated', id: q });
    this.store.journal.append({ type: 'orchestrator.wake', item: event.item, actor: 'engine', data: { event: event.type } });
    void this.drain();
  }

  /** Whether a wake about this item is queued or running — so the engine re-wakes only what a restart dropped. */
  reviewing(id: string): boolean { return this.inFlight.has(id) || this.queue.some((e) => e.item === id); }
  /** Whether a wake about this question is queued or running: its page shows it is being looked at. */
  questionPending(id: string): boolean { return this.questionsInFlight.has(id) || this.queue.some((e) => questionOf(e) === id); }

  /**
   * A message posted in a question's thread whose wake a restart dropped (the queue is memory) is
   * answered now: its thread ends with the user's words and nothing after them (invariant 3).
   */
  resumeQuestions(): string[] {
    const woken: string[] = [];
    for (const q of this.store.listQuestions()) {
      const last = parseThread(q.file).at(-1);
      if (last?.actor !== 'user' || this.questionPending(q.id)) continue;
      this.wake({ type: 'question_message', data: { question: q.id, message: last.text } });
      woken.push(q.id);
    }
    return woken;
  }
  /** Serve what queued up while automation was paused. */
  kick(): void { void this.drain(); }

  private async drain(): Promise<void> {
    if (this.running || this.stopped || this.pausedRef()) return;
    if (!this.queue.length) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped && !this.pausedRef()) {
        const batch = this.queue.splice(0, this.queue.length);
        this.inFlight = new Set(batch.flatMap((e) => (e.item ? [e.item] : [])));
        this.questionsInFlight = new Set(batch.flatMap((e) => questionOf(e) ?? []));
        this.reviewsInFlight = new Set(batch.flatMap((e) => (e.type === 'question_review' ? questionOf(e) ?? [] : [])));
        this.questionsChanged = new Set(); this.questionsAnswered = new Set(); this.lastOutcome = '';
        try { await this.runWake(batch).catch((e) => { this.lastOutcome = `the wake failed: ${(e as Error).message}`; this.log('error', `orchestrator wake failed: ${(e as Error).message}`); }); }
        finally {
          this.inFlight = new Set();
          const asked = this.questionsInFlight; this.questionsInFlight = new Set(); this.reviewsInFlight = new Set();
          this.questionEnded(batch, asked);
          // A delegated plan never waits on a wake that failed or decided nothing: the engine hands it to the user.
          // (Unless a revised plan already queued its own review: that one is still to come.)
          for (const e of batch) if (e.type === 'plan_review' && e.item && !this.queue.some((q) => q.type === 'plan_review' && q.item === e.item)) this.hooks.planReviewEnded(e.item);
          for (const e of batch) if (e.type === 'permission_request' && e.item && !this.queue.some((q) => q.type === 'permission_request' && q.item === e.item)) this.hooks.permissionReviewEnded(e.item);
          // Triage never outlives the wake that carried it: resolved, escalated, or it goes to the user as it is.
          for (const id of new Set(batch.flatMap((e) => (e.item ? [e.item] : [])))) if (!this.queue.some((q) => q.item === id)) this.hooks.triageEnded(id);
        }
      }
    } finally { this.running = false; }
  }

  /**
   * A question's wake always leaves a trace in its thread, so the page never waits on nothing: a
   * relevance check that changed nothing says so, and a message nobody answered says how the wake ended.
   */
  private questionEnded(batch: WakeEvent[], asked: Set<string>): void {
    for (const id of asked) {
      if (this.queue.some((e) => questionOf(e) === id)) continue; // another wake about it is still to come
      const q = this.store.getQuestion(id);
      if (!q) continue;
      const events = batch.filter((e) => questionOf(e) === id);
      try {
        if (events.some((e) => e.type === 'question_message') && !this.questionsAnswered.has(id)) this.store.postToQuestion(id, 'app', `the orchestrator did not answer here${this.lastOutcome ? ` (${this.lastOutcome.slice(0, 300)})` : ''}`);
        else if (events.some((e) => e.type === 'question_review') && !this.questionsChanged.has(id)) this.store.postToQuestion(id, 'app', `reviewed, no change${this.lastOutcome.startsWith('the wake failed') ? ` (${this.lastOutcome.slice(0, 300)})` : ''}`);
        else this.emit({ type: 'question.updated', id }); // no longer pending
      } catch (e) { this.log('warn', `question ${id}: ${(e as Error).message}`); }
    }
  }

  /**
   * The orchestrator's model for this wake. `orchestrator.model` names a model row (by id or by its
   * Claude model string) or is a raw model string; with `allow_model_fallback`, a row that is out of
   * usage on this machine yields to its fallback chain, as a worker's turn does.
   */
  modelForWake(now = new Date(Date.now())): { model: string; label: string; fellBackFrom?: string; sdkFallback?: string; exhaustedUntil?: string } {
    const cfg = this.store.config.orchestrator;
    const def = findModel(this.store.config, cfg.model);
    if (!def || (def.runner ?? 'claude') !== 'claude') return { model: def?.claude_model ?? cfg.model, label: def?.label ?? cfg.model };
    const pick = resolveTurnModel(this.store.config, def, { allow: cfg.allow_model_fallback, unavailable: this.store.local.model_unavailable, now });
    return {
      model: pick.model ?? cfg.model, label: pick.def.label,
      ...(pick.fellBackFrom ? { fellBackFrom: pick.fellBackFrom.label } : {}),
      ...(pick.sdkFallback ? { sdkFallback: pick.sdkFallback } : {}),
      ...(pick.exhaustedUntil ? { exhaustedUntil: pick.exhaustedUntil } : {}),
    };
  }

  private async runWake(events: WakeEvent[], retried = false): Promise<void> {
    const cfg = this.store.config.orchestrator;
    let state = this.readState();
    const tooOld = state.started_at && (Date.now() - Date.parse(state.started_at)) / 86_400_000 > cfg.rotate_after_days;
    if (state.session_id && (state.wakes_served >= cfg.rotate_after_wakes || tooOld)) {
      this.log('info', `orchestrator: rotating session after ${state.wakes_served} wakes (the files are its memory)`);
      state = { wakes_served: 0 };
    }
    const packet = [...events.map((e) => this.renderPacket(e)), ...(await this.inFlightSection(events))].join('\n\n---\n\n');
    const carried = state.session_id ? '' : this.recentChat();
    const prompt = `${state.session_id ? '' : this.systemIntro() + '\n\n'}${carried ? carried + '\n\n' : ''}# Wake: ${events.map((e) => e.type).join(', ')} — ${isoLocal()}\n\n${packet}\n\nHandle what needs judgment using the planestro tools, then call done_with_wake with a one-line summary. Everything mechanical is already handled by the app; do not attempt git or gh operations.`;
    let doneSummary = '';
    const pick = this.modelForWake();
    if (pick.fellBackFrom) this.log('info', `orchestrator: ${pick.fellBackFrom} is out of usage; waking on ${pick.label}`);
    if (pick.exhaustedUntil) this.log('warn', `orchestrator: every model in its fallback chain is out of usage until ${pick.exhaustedUntil}; trying ${pick.label} anyway`);
    const model = pick.model;
    const result: TurnResult = await this.ports.agents.claude.runCustomTurn!({
      label: events.map((e) => e.type).join(','), cwd: this.store.codeRepoPath(), model,
      ...(pick.sdkFallback ? { fallbackModel: pick.sdkFallback } : {}),
      permissionMode: 'dontAsk', prompt, resume: state.session_id, maxTurns: 30,
      ...(state.session_id && state.total_usd !== undefined ? { resumeTotalUsd: state.total_usd } : {}),
      systemAppend: this.systemIntro(),
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git log*)', 'Bash(git diff*)', 'Bash(git show*)', 'Bash(gh pr view*)', 'Bash(gh pr diff*)', 'Bash(gh run view*)'],
      mcpTools: this.tools((s) => { doneSummary = s; }, events.some((e) => e.type === 'user_message' || e.type === 'question_message')),
      onOutput: (t) => this.emit({ type: 'engine.log', level: 'info', message: `[orchestrator] ${t.slice(0, 300)}` }),
    });
    this.hooks.usageSeen?.(result.rateLimit);
    if (result.subtype === 'usage_exhausted') {
      const def = findModel(this.store.config, model);
      const now = new Date(Date.now());
      const until = unavailableUntil(result.usageLimit?.resetsAt, now);
      if (def) {
        this.store.updateLocal({ model_unavailable: markUnavailable(this.store.local.model_unavailable, def.id, { until, reason: result.usageLimit?.message ?? 'usage limit' }, now) });
        this.store.journal.append({ type: 'model.unavailable', actor: 'orchestrator', data: { model: def.id, until: until.toISOString(), reason: result.usageLimit?.message ?? '' } });
      }
      const root = findModel(this.store.config, cfg.model);
      const another = root && cfg.allow_model_fallback && fallbackChain(this.store.config, root).some((m) => m.id !== def?.id && !unavailableEntry(this.store.local.model_unavailable, m.id, now));
      this.log('warn', `orchestrator: ${def?.label ?? model} is out of usage until ${until.toISOString()}${another && !retried ? '; retrying the wake on its fallback' : ''}`);
      if (another && !retried) return this.runWake(events, true);
    }
    // An API error the CLI returned as text is a failed wake, not a summary: retry it once, then say so loudly.
    if ((result.subtype === 'api_error' || result.subtype === 'cli_too_old') && !doneSummary) {
      this.log('warn', `orchestrator: the wake failed with ${result.subtype}: ${result.error ?? ''}${result.subtype === 'api_error' && !retried ? '; retrying once' : ''}`);
      if (result.subtype === 'api_error' && !retried) return this.runWake(events, true);
    }
    this.lastOutcome = doneSummary ? `it ended with: ${doneSummary}` : result.isError ? `the wake failed: ${result.subtype}${result.error ? ` ${result.error}` : ''}` : '';
    const session = result.sessionId ?? state.session_id;
    const total = result.sessionTotalUsd ?? (session === state.session_id ? state.total_usd : undefined);
    this.writeState({ session_id: session, started_at: state.started_at ?? isoLocal(), wakes_served: state.wakes_served + 1, ...(total !== undefined ? { total_usd: total } : {}) });
    // What the Console's spend panel reads (#49): which items, which conversation (it resets on rotation), how big it has grown.
    const items = [...new Set(events.map((e) => e.item).filter((i): i is string => Boolean(i)))];
    this.store.journal.append({ type: 'orchestrator.done', actor: 'orchestrator', data: {
      events: events.map((e) => e.type), summary: doneSummary || (result.isError ? `(failed: ${result.subtype}) ${result.error ?? ''}` : result.text.slice(-300)), cost: result.costUsd, subtype: result.subtype,
      ...(items.length ? { items } : {}), ...(session ? { session } : {}), wake: state.wakes_served + 1, ...(state.session_id ? {} : { fresh: true }), model: pick.label,
      ...(result.contextTokens !== undefined ? { context_tokens: result.contextTokens } : {}),
    } });
    this.log('info', `orchestrator: ${doneSummary || result.subtype}`);
  }

  /**
   * What the user said in the chat lately, for a fresh conversation (#59): an instruction given to the
   * conversation that was rotated away ("as each child's dependencies merge, submit it") lived only there,
   * and HH-172's children sat idle. The journal holds it (invariant 3), so it is carried, not remembered.
   */
  private recentChat(now = Date.now()): string {
    const since = now - RECENT_CHAT_DAYS * 86_400_000;
    const chat = this.store.journal.read().filter((j) => (j.type === 'orchestrator.user_message' || j.type === 'orchestrator.reply') && Date.parse(j.ts) >= since).slice(-RECENT_CHAT_ENTRIES);
    if (!chat.some((j) => j.type === 'orchestrator.user_message')) return '';
    const line = (j: (typeof chat)[number]) => {
      const who = j.type === 'orchestrator.user_message' ? 'user' : 'you';
      const text = String(j.data?.text ?? '').replace(/\s+/g, ' ').trim();
      const max = who === 'user' ? 1000 : 300;
      return `- ${j.ts.slice(0, 16).replace('T', ' ')} ${who}${j.item ? ` (on ${j.item})` : ''}: ${text.length > max ? `${text.slice(0, max)}…` : text}`;
    };
    return [
      `# What the user said to you lately\nThis is a fresh conversation: the one before it was rotated away, and with it what the user told you in the chat (the last ${RECENT_CHAT_DAYS} days, from the journal). An instruction there that is not yet carried out, done or withdrawn still stands: act on it when its moment comes, as if they had just said it.`,
      ...chat.map(line),
    ].join('\n');
  }

  private readonly host = hostNote();
  private systemIntro(): string {
    // The host note goes with the standing rules: the orchestrator writes instructions for workers on this machine.
    const host = `${this.host}${keptPathsNote(this.store.config.worktrees.copy_to_checkout, this.store.codeRepoPath(), true)}`;
    try { return `${this.store.renderPrompt('orchestrator-system', undefined)}\n\n${host}`; }
    catch { return `You are the planestro orchestrator: the judgment layer over a deterministic pipeline. Decide, instruct and annotate through the planestro tools; never perform git/gh operations yourself.\n\n${host}`; }
  }

  /**
   * Work in flight outside planestro (dogfood p38 part 2): the repository's open pull requests, so a
   * stop is not escalated while a person is already fixing it (HH-149's card asked the designer to
   * fix ci.yml twenty minutes after game PR #338, the fix, was opened from a supervising session).
   * Read once per wake, only for wakes about an item; never for a wake that is only a message.
   */
  private async inFlightSection(events: WakeEvent[]): Promise<string[]> {
    const github = this.store.config.code_repo.github;
    if (!github || !events.some((e) => e.item)) return [];
    let prs: Awaited<ReturnType<Ports['gh']['prList']>>;
    try { prs = await this.ports.gh.prList(github, { state: 'open' }); } catch (e) { return [`Open pull requests in the repository: could not be read (${(e as Error).message.slice(0, 120)}).`]; }
    if (!prs.length) return ['Open pull requests in the repository: none.'];
    const byBranch = new Map(this.store.listItems().map((i) => [i.file.frontmatter.branch, i.id] as const));
    const age = (iso?: string) => { if (!iso) return ''; const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000); return h < 1 ? 'updated just now' : h < 48 ? `updated ${h} h ago` : `updated ${Math.round(h / 24)} d ago`; };
    const lines = [...prs].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 20)
      .map((p) => `- #${p.number} "${(p.title ?? '').slice(0, 100)}" — ${p.headRefName} → ${p.baseRefName}${p.author ? `, by ${p.author}` : ''}${age(p.updatedAt) ? `, ${age(p.updatedAt)}` : ''}${byBranch.has(p.headRefName) ? ` (item ${byBranch.get(p.headRefName)})` : ' (not a planestro item: a person opened it)'}`);
    return [[
      `Open pull requests in the repository (${prs.length}${prs.length > 20 ? ', newest 20 shown' : ''}). Before escalating a failure, look here: a pull request by a person that touches the same area is a fix already in flight. Note it on the stopped item (annotate_item) and let it wait for that pull request, rather than filing a card or a maintainer item for what is already being done.`,
      ...lines,
    ].join('\n')];
  }

  private renderPacket(e: WakeEvent): string {
    const lines = [`Event: ${e.type}`];
    if (e.item) {
      const item = this.store.getItem(e.item);
      if (item) {
        const fm = item.file.frontmatter;
        lines.push(`Item: ${fm.id} — "${fm.title}" (${fm.kind}, ${fm.category})`);
        lines.push(`Status: ${fm.status}${fm.blocked ? ` · BLOCKED: ${fm.blocked_reason}` : ''}${fm.awaiting ? ` · awaiting ${fm.awaiting}` : ''}${fm.op ? ` · op ${fm.op}` : ''}${fm.taken_over ? ' · TAKEN OVER by the user' : ''}`);
        if (fm.taken_over) lines.push(`Taken over: the user is finishing this item by hand (since ${fm.taken_over.since}${fm.taken_over.note ? `: ${fm.taken_over.note}` : ''}). Do not act on it (no messages, unblocks, retries, cards or merge order; those tools refuse it) until they hand it back. You may read it and annotate it.`);
        if (fm.pr) lines.push(`PR: #${fm.pr} · CI ${fm.ci_result ?? '—'} · red count ${fm.ci_failed_count ?? 0}`);
        if (fm.skip_merge) lines.push(`Held out of the merge queue${heldReasonOf(fm) ? `: ${heldReasonOf(fm)}` : ''}. Its commits are pushed and its CI is read, but it does not merge until the hold is released (the user's Release hold, or unskip_merge once what it waits for has happened).`);
        // Facts the state machine knows (#64): what is left, and what a resume costs before it does anything.
        const budget = this.hooks.budgetLine?.(fm.id); if (budget) lines.push(budget);
        // A fact the state machine knows (p29): what it depends on merged after its worktree was cut, so its branch lacks it until synced.
        const since = fm.worktree && fm.started_at && ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'].includes(fm.status) ? fm.depends_on.map((d) => this.store.getItem(d)?.file.frontmatter).filter((d) => d?.merged_at && Date.parse(d.merged_at) > Date.parse(fm.started_at!)) : [];
        if (since.length) lines.push(`Merged since its worktree was cut: ${since.map((d) => `${d!.id} (${d!.merged_at!.slice(0, 16).replace('T', ' ')})`).join(', ')}. Its branch does not have that work yet: sync it (sync_with_base, or unblock_item with sync_first: true) before it resumes.`);
        const desc = getSection(item.file, 'Description'); if (desc) lines.push(`Description:\n${desc.slice(0, 1200)}`);
        const plan = getSection(item.file, 'Plan'); if (plan) lines.push(`Approved/submitted plan:\n${plan.slice(0, 2000)}`);
        const activity = getSection(item.file, 'Activity').split('\n').slice(-8).join('\n'); if (activity) lines.push(`Recent activity:\n${activity}`);
        if (fm.parts?.length) lines.push(`Parts, as the worker itself reports them (${partsSummary(fm.parts)}). Quote this; never summarise the state of the work from memory or prose:\n${fm.parts.map((p) => `- ${p.name}: ${p.state}${p.reason ? ` — ${p.reason}` : ''}`).join('\n')}`);
        if (e.type === 'plan_review') {
          if (fm.op_data?.plan_amended) lines.push(`Amended: you sent this plan back to be amended with: ${String(fm.op_data.plan_amended).slice(0, 1500)}\nThis is the revision. Check that it carries the amendment before deciding.`);
          const epic = epicFlagOf(fm);
          lines.push(epic ? this.epicPlanPolicy(fm.id, epic.reason) : this.planPolicy(fm.id, fm.plan_revisions ?? 0, this.priorReview(item.file, fm.plan_ready_at)));
          const stated = epic ? null : holdShapeOf(plan);
          if (stated) lines.push(this.holdPlanPolicy(fm.id, stated));
        }
        if (e.type === 'permission_request') lines.push(this.permissionPacket(fm));
        if (fm.triage) lines.push(e.type === 'decision_answered' ? this.decisionAnsweredPacket() : this.triagePacket(fm));
      }
    }
    if (e.type === 'user_message') lines.push(CHAT_POLICY);
    const q = questionOf(e);
    if (q) { lines.push(this.questionPacket(e, q)); return lines.join('\n'); }
    for (const [k, v] of Object.entries(e.data ?? {})) lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 2000));
    return lines.join('\n');
  }

  /**
   * The whole question file (the files are the memory: the thread holds everything said so far),
   * and for a relevance check its item as it is now. The item goes in the text, not as the event's
   * item, so a question never ends a plan review or a triage that happens to be running.
   */
  private questionPacket(e: WakeEvent, id: string): string {
    const q = this.store.getQuestion(id);
    if (!q) return `Question ${id}: it no longer exists (nothing to do).`;
    const fm = q.file.frontmatter;
    const lines = [`Question ${id} (${fm.status}${fm.resolution ? `: ${fm.resolution}` : ''}), asked ${fm.asked_at}${fm.item ? ` about ${fm.item}` : ''}. The file in full:\n\`\`\`markdown\n${serializeQuestionFile(q.file).slice(-12_000)}\n\`\`\``];
    if (e.type === 'question_message') lines.push(`The user just wrote in its thread:\n${String(e.data?.message ?? '').slice(0, 4000)}`, QUESTION_CHAT_POLICY);
    if (e.type === 'question_review') {
      const it = fm.item ? this.store.getItem(fm.item) : undefined;
      if (it) {
        const f = it.file.frontmatter;
        lines.push(`Its item now: ${f.id} — "${f.title}" · ${f.status}${f.blocked ? ` · BLOCKED: ${f.blocked_reason}` : ''}${f.awaiting ? ` · awaiting ${f.awaiting}` : ''}${f.op ? ` · op ${f.op}` : ''}${f.pr ? ` · PR #${f.pr} (CI ${f.ci_result ?? '—'})` : ''}${f.taken_over ? ' · taken over by the user' : ''}`);
        const activity = getSection(it.file, 'Activity').split('\n').slice(-12).join('\n'); if (activity) lines.push(`Its recent activity:\n${activity}`);
      } else if (fm.item) lines.push(`Its item ${fm.item} no longer exists.`);
      else lines.push('It is not about one item: judge it against the backlog (list_items) if you need to.');
      lines.push(QUESTION_REVIEW_POLICY);
    }
    return lines.join('\n');
  }

  /**
   * Who approves this plan, said in the packet rather than the prompt library: a data dir's copy
   * of orchestrator-system predates the rule, and the limit is the engine's to state, not the model's to remember.
   */
  /**
   * What the orchestrator already wrote about this version of the plan (its notes since the plan was
   * handed in). When approval is delegated after an advisory review, the decision wake gets that
   * review back instead of reviewing the plan from scratch (HH-114, HH-115: reviewed twice, dogfood p8).
   */
  private priorReview(file: Parameters<typeof parseActivity>[0], since?: string): string[] {
    if (!since) return [];
    return parseActivity(file).filter((a) => a.actor === 'orchestrator' && a.at >= since).map((a) => a.text);
  }

  /**
   * A plan that reads as an epic breakdown (epicFlagOf: code decided it, invariant 4) is never approved as
   * one item: approve_plan refuses it. HH-198 and HH-199 were, and each went to one implementer (#69).
   */
  private epicPlanPolicy(id: string, reason: string): string {
    const head = `THIS IS AN EPIC, NOT ONE ITEM: ${reason}. approve_plan refuses it, whoever approves.`;
    if (!this.hooks.planDelegated(id)) return `${head}\nPlan approval: the user's. Do not recommend approving it. Record with annotate_item whether it should become an epic (the item page offers the user **Convert to epic**: the plan becomes the breakdown request) or, if it truly is one piece of work, what the plan should say instead.`;
    return [
      `${head}\nPlan approval: DELEGATED TO YOU. Decide it in this wake, with exactly one of:`,
      '- convert_item with to: "epic" — the usual answer. The plan moves into the epic\'s Notes, its breakdown is planned at once, and the user approves the children.',
      '- request_plan_changes — only if it truly is one piece of work that one implementer finishes in one pull request, and only the plan\'s layout misled the check: ask for a plan without a child breakdown.',
      '- hand_plan_to_user — you are not sure which it is.',
      'Record your reasoning with annotate_item either way.',
    ].join('\n');
  }

  /**
   * A plan that says its pull request must wait (#97): planestro found the sentence, so nobody has to
   * remember to hold it. Stated in the packet for the same reason as the rest of the policy.
   */
  private holdPlanPolicy(id: string, stated: HoldFlag): string {
    const head = `THIS PLAN STATES A MERGE HOLD: "${stated.quote}"`;
    if (!this.hooks.planDelegated(id)) return `${head}\nIts approval is the user's: the item page offers them "Approve and hold the PR". Nothing for you to set.`;
    return `${head}\nIf you approve it, planestro holds its pull request out of the merge queue (${stated.reason}) until the user releases the hold; pass \`hold\` to approve_plan only to word the reason better. If that sentence is not about this item's own pull request, do not approve it: hand_plan_to_user, and say so.`;
  }

  private planPolicy(id: string, used: number, prior: string[] = []): string {
    if (!this.hooks.planDelegated(id)) return 'Plan approval: the user\'s. Review it and record what is risky, missing or out of scope with annotate_item; approve_plan is not permitted for this item. If you would approve it WITH a stipulation, do not write the stipulation in a note (the user misses it and the planner never sees it): amend_plan sends it to the planner, who folds it in, and the user then approves a complete plan.';
    const max = this.store.config.orchestrator.max_plan_revisions;
    const left = Math.max(0, max - used);
    return [
      'Plan approval: DELEGATED TO YOU. The user trusts your judgment on this item; decide it in this wake, with exactly one of:',
      ...(prior.length ? [`You already reviewed this version of the plan, before its approval was delegated to you. Your notes then:\n${prior.map((t) => `- ${t.slice(0, 600)}`).join('\n')}\nDecide from that review; re-read the plan only for what it leaves open, and do not annotate it again.`] : []),
      '- approve_plan — the plan is sound and matches the request. Implementation starts at once. Put anything the implementer should watch in `notes`.',
      '- amend_plan — you would approve it WITH stipulations: send them to the planner as amendments (not one of the fix rounds); the revised plan comes back to you. Never approve with a stipulation written only in notes.',
      left > 0
        ? `- request_plan_changes — small, specific fixes would make it approvable. Say exactly what to change; the planner revises and you review the result. ${used} of ${max} fix rounds used, so ${left} left.`
        : `- (request_plan_changes is spent: all ${max} fix rounds are used. Approve it or hand it over.)`,
      '- hand_plan_to_user — it needs the user: a product or scope decision, real risk, a large rework, or you are simply not confident. Give the reason; they approve it themselves.',
      'Record your reasoning with annotate_item either way. If you decide nothing, the plan goes to the user.',
    ].join('\n');
  }

  /** The request itself and the rule for deciding it. The hard denials (pushes, pull requests, protected branches, force flags) never get this far. */
  private permissionPacket(fm: { awaiting?: string; awaiting_data?: Record<string, unknown>; worktree?: string }): string {
    const data = fm.awaiting_data ?? {};
    if (fm.awaiting !== 'orchestrator' || data.kind !== 'permission') return 'Permission request: already decided (nothing to do for this one).';
    const input = (data.input ?? {}) as Record<string, unknown>;
    const what = data.tool === 'Bash' ? String(input.command ?? '') : JSON.stringify(input, null, 2);
    return [
      `Permission request: DELEGATED TO YOU. The worker on this item wants to use ${String(data.tool)}, which its allow-list does not cover, and its session is parked until someone answers.`,
      fm.worktree ? `Its worktree (the only place it should write, besides scratch files under /tmp or $TMPDIR): ${isAbsolute(fm.worktree) ? fm.worktree : join(this.store.codeRepoPath(), fm.worktree)}` : '',
      fm.worktree ? 'Every command of this worker starts in that worktree: its shell goes back there after each command, and planestro refuses a cd out of it. A relative path in the request is a path in the worktree.' : '',
      input.description ? `What the worker says it is for: ${String(input.description)}` : '',
      ...(() => {
        // #108: the second park on one kind of command is a pattern, and each park costs a resume.
        const id = (fm as { id?: string }).id;
        const hint = id && data.tool === 'Bash' ? parkHint(this.store.journal.read({ item: id, type: 'permission.parked' }), what, this.store.config.permissions.allow) : undefined;
        return hint ? [`This item has parked ${hint.parks} times on \`${hint.shape} …\`. The allow rule ${hint.rule} would let such commands run inside the worktree without a park. Only the user adds allow rules: if it fits this project, say so in your decision's reason (the user's card offers it).`] : [];
      })(),
      `The request, in full:\n\`\`\`\n${what.slice(0, 6000)}\n\`\`\``,
      'planestro has already refused the things no worker may do (git push, gh pr, touching protected branches, force flags, rm -rf of / or ~). Read the whole request, then call decide_permission with exactly one of:',
      '- allow — ordinary development work for this item: reading and searching, building, running the project\'s tests and checks, generating or editing files inside its worktree, scratch files under a temp dir, git on its own branch. It is allowed this once and the session resumes.',
      '- deny — not needed for this item or plainly the wrong way to do it. Say why and what to do instead; the worker continues without it.',
      '- ask_user — anything that writes or deletes outside the worktree and temp dirs, installs or downloads software, talks to the network beyond the project\'s own tooling, reads or writes credentials, keys or env files, uses sudo, changes git config or history, or that you cannot fully read and understand. When in doubt, ask_user: the user sees the request exactly as you did.',
      'Judge the command, not the worker\'s description of it. If you decide nothing, it goes to the user.',
    ].filter(Boolean).join('\n');
  }

  /**
   * The triage rule, said in the packet rather than only in the prompt library (a data dir's copy of
   * orchestrator-system can predate it): what stopped, what is within the orchestrator's authority,
   * and what a decision card must look like.
   */
  private triagePacket(fm: { id: string; blocked?: boolean; blocked_reason?: string; awaiting?: string; awaiting_data?: Record<string, unknown>; status: string }): string {
    const what = fm.blocked ? `it is BLOCKED (${fm.blocked_reason})` : fm.awaiting === 'question' ? 'its worker asked a question and is parked' : `it is waiting (${fm.awaiting})`;
    const questions = fm.awaiting === 'question' ? `\nThe worker's questions:\n${JSON.stringify(fm.awaiting_data?.questions ?? [], null, 2).slice(0, 3000)}` : '';
    return [
      `Triage: DELEGATED TO YOU. ${fm.id} stopped — ${what} — and would land on the user's NEEDS YOU list. Look first: resolve it yourself if it is within your authority, and bring the user only a genuine decision. Read the item (read_item) and its recent activity before you act.${questions}`,
      'Resolve (preferred) with one of:',
      '- unblock_item — the fix is an instruction to the session: resubmit a plan it already wrote (an MCP "Stream closed" ate submit_plan), carry on after a hiccup, use what the brief already says. Pass the message it should act on. With fresh: true (work in progress or in review) the message goes to a NEW conversation that gets a brief from the item and git instead of the old conversation: use it when the Budget line says a resume does not fit, or when the job is small and the conversation long. Write the message as the whole task; the new conversation knows only the brief and what you say.',
      '- commit_paths — the work is in the worktree but not committed (a dirty tree at a budget stop, a commit the session was approved to make and never made): name the files that belong to the change and give the commit message; planestro commits them with no session turn and no cost. Generated files and byproducts do not belong. Then finish_from_worktree (retry_op in review).',
      '- sync_with_base, or unblock_item with sync_first: true — something the item needs has merged since its worktree was cut (a dependency, a fix on its base): planestro rebases its branch before the session resumes, since the session cannot use what its branch does not have. A conflict goes to the session.',
      '- answer_question — the worker asked something the brief, plan, notes or project rules already answer.',
      '- finish_from_worktree — the work is committed on a clean worktree ahead of its base but the item stopped before its pull request (over budget after committing, a size gate, a commit made for a runner that could not): open the pull request from there.',
      '- retry_op — a transient failure: a GitHub 5xx, an SSH or network hiccup, a timeout. Not for anything that failed the same way twice.',
      '- set_item_fields — a wrong parent/base/dependency/implementer/fallback setting (e.g. an epic child created without its parent, so it was cut from the wrong base). Then recreate_worktree if the worktree was cut from the wrong base.',
      '- recreate_worktree — a missing worktree (worktree_missing after a fetch race) or one cut from the wrong base. It refuses if the worktree or branch holds any work, re-runs setup, then unblocks with your message.',
      'Escalate only a decision that is genuinely the user\'s — spending (budget caps, usage limits), scope, taste, or anything irreversible — with ask_user_decision: ONE plain one-line question, one sentence of why, 2–4 options with exactly one marked recommended (always recommend), each a thing you can carry out with your tools or that the user does themselves (say which). No jargon, no log excerpts: the card is read on a phone.',
      'A spending stop is yours to resolve before it is the user\'s: the Budget line above says what is left and which step fits it. Work already in the worktree costs nothing to land (commit_paths, finish_from_worktree); a job that fits a fresh session goes to one (unblock_item with fresh: true). Only when money is what is missing is it a card.',
      'A card never asks the user to do something somewhere else (raise a setting, edit a file, run a command): the option must do it. For a spending stop (over_budget, token_budget, turn_budget), give an option with raise_budget_usd, labelled like "+$40 and resume"; answering it raises the item\'s own budget and you are woken to resume it. The raise must pay for the reload and the work: planestro refuses one that would be spent reloading the conversation, and tells you the least that will do. An option with fresh: true promises a fresh session, which needs only a few dollars ("+$5 and finish in a fresh session").',
      'When the answer you recommend is new work, or starting work that waits, give that option an action and the user\'s tap does it, with no second round: action { tool: "create_item", args: { title, description, kind, parent, implementer, planner, category, depends_on, submit } } adds the item (submit: true also queues it; an epic has its breakdown planned), action { tool: "submit_item", args: { id } } submits one that is not submitted yet. create_item is not yours to call in this wake, so this is how a card offers it. The card shows the user what the tap does; an action that could not be carried out is refused when you file the card.',
      'Record what you did with annotate_item. A suggestion about planestro itself (its UX, a missing tool, a rule that misfired) goes in note_planestro, never in annotate_item, a card or a triage note: the user reads those in a list of their own. If you do none of these in this wake, the item goes to the user exactly as it is.',
      'A card is a product call a non-engineer answers in one tap, in player and product terms: which look, which scope, whether to spend more. It never asks the user to edit code or config, run a command, or fix a pipeline; engineering is yours, a worker\'s, or the maintainer\'s. When the fix needs a capability no tool here has (a workflow file, SSH, a secret), file_for_maintainer files a backlog item for the person who runs planestro, and the stopped item waits on it (say so with annotate_item) rather than on a card.',
    ].join('\n');
  }

  private decisionAnsweredPacket(): string {
    return [
      'Decision answered: the user answered the decision card you left on this item (question and answer below). Carry it out now with your tools — unblock_item with a message, answer_question, set_item_fields, recreate_worktree, retry_op — and note what you did with annotate_item.',
      'If the packet says the budget was raised, that is already done: unblock_item resumes the item, and nothing needs changing elsewhere. If the option promised a fresh session, pass fresh: true and the instruction as the message.',
      'If the packet has an action line, planestro did that as the user when they tapped the option (the new item\'s id is in it): never do it again. What is left is this item\'s own stop. create_item is not available in this wake; an answer in their own words that asks for new work gets a new card whose option carries the action.',
      'If the answer asks for something no tool can do, say exactly what the user must do in one more ask_user_decision, or leave it: when this wake ends without action the item goes back to the user.',
      'A card you no longer stand behind must go: withdraw_decision, or a new card (ask_user_decision) or a block (mark_blocked), each of which replaces it. Never leave a card asking for something that is moot.',
    ].join('\n');
  }

  /**
   * The wake's tools. `chat` is set when the user is talking to it in this wake: only then may it
   * create items, because only then has someone asked it to add work.
   */
  private tools(onDone: (summary: string) => void, chat = false): CustomToolDef[] {
    const tools = this.allTools(onDone, chat);
    // Every item a call names, whichever argument names it; the first one a person has taken over refuses the call.
    const owned = (a: Record<string, unknown>) => [a.id, a.item, a.from, a.to, ...(Array.isArray(a.ids) ? a.ids : [])]
      .filter((x): x is string => typeof x === 'string').find((x) => this.store.getItem(x)?.file.frontmatter.taken_over);
    return tools.map((t) => !HANDS_OFF.has(t.name) ? t : { ...t, handler: async (a) => {
      const x = owned(a);
      return x ? `not permitted: the user has taken ${x} over and is finishing it by hand. Leave it alone until they hand it back (you may read and annotate it).` : t.handler(a);
    } });
  }

  private allTools(onDone: (summary: string) => void, chat: boolean): CustomToolDef[] {
    const store = this.store;
    const idArg = { id: z.string() };
    return [
      { name: 'list_items', description: 'List backlog items (id, status, flags), optionally filtered by status.', schema: { status: z.string().optional() }, handler: async (a) => store.listItems().filter((i) => !a.status || i.file.frontmatter.status === a.status).map((i) => { const f = i.file.frontmatter; return `${f.id} [${f.status}${f.blocked ? ' BLOCKED:' + f.blocked_reason : ''}${f.awaiting ? ' awaiting:' + f.awaiting : ''}${f.taken_over ? ' TAKEN_OVER' : ''}${f.skip_merge ? ` HELD${heldReasonOf(f) ? ':' + heldReasonOf(f) : ''}` : ''}] rank=${f.rank ?? '—'} pr=${f.pr ?? '—'} ${f.kind === 'epic' ? 'EPIC ' : ''}${f.title}`; }).join('\n') || '(no items)' },
      { name: 'read_item', description: 'Read one item file in full.', schema: idArg, handler: async (a) => serializeItemFile(store.requireItem(String(a.id)).file) },
      { name: 'pr_status', description: 'Pull request + CI status for an item.', schema: idArg, handler: async (a) => { const fm = store.requireItem(String(a.id)).file.frontmatter; if (!fm.pr) return 'no PR'; const gh = store.config.code_repo.github; if (!gh) return 'no github remote configured'; const pr = await this.ports.gh.prView(gh, fm.pr); return `#${pr.number} ${pr.state} base=${pr.baseRefName} head=${pr.headRefName}@${pr.headRefOid.slice(0, 7)} ci=${fm.ci_result ?? '—'} (${fm.ci_failed_count ?? 0} red)`; } },
      { name: 'set_merge_order', description: 'Override the merge order of the given IN_REVIEW items (first merges first). Items not listed keep rank order after these.', schema: { ids: z.array(z.string()) }, handler: async (a) => { (a.ids as string[]).forEach((id, i) => store.mutateItem(id, [{ set: { merge_order: i + 1 } }, { activity: { actor: 'orchestrator', text: `merge order ${i + 1}` } }], 'orchestrator', { commit: `${id}: merge order ${i + 1}` })); this.hooks.poke(); return 'merge order set'; } },
      { name: 'set_queue_order', description: 'Reorder the QUEUED items (first is admitted first).', schema: { ids: z.array(z.string()) }, handler: async (a) => { const ids = a.ids as string[]; const ranks = renormalize(ids); for (const id of ids) { const it = store.requireItem(id); if (laneOf(it.file.frontmatter.status) !== 'board') throw new Error(`${id} is not on the board`); store.mutateItem(id, [{ rank: ranks.get(id)! }], 'orchestrator'); } this.hooks.poke(); return 'queue order set'; } },
      { name: 'skip_merge', description: 'Hold an item\'s pull request out of the merge queue, with a reason: what it waits for. The reason is shown on the item. Its commits are still pushed and its CI is still read; it does not merge until the hold is released. Before the pull request exists, it is opened held.', schema: { ...idArg, reason: z.string() }, handler: async (a) => this.hooks.holdMerge(String(a.id), String(a.reason)) },
      { name: 'unskip_merge', description: 'Return a held item to the merge queue.', schema: idArg, handler: async (a) => { store.mutateItem(String(a.id), [{ unset: ['skip_merge'] }, { set: { ci_result: 'pending', op_data: { ...(store.requireItem(String(a.id)).file.frontmatter.op_data ?? {}), hold_waived: true } } }, { activity: { actor: 'orchestrator', text: 'returned to the merge queue' } }], 'orchestrator', { commit: `${a.id}: unskip merge` }); this.hooks.poke(); return 'returned'; } },
      { name: 'message_session', description: "Send guidance to an item's worker session (queued for its next turn).", schema: { ...idArg, text: z.string() }, handler: async (a) => { await this.hooks.message(String(a.id), String(a.text)); return 'queued for the session'; } },
      { name: 'annotate_item', description: "Append an orchestrator note to an item's activity log.", schema: { ...idArg, text: z.string() }, handler: async (a) => { store.mutateItem(String(a.id), [{ activity: { actor: 'orchestrator', text: String(a.text) } }], 'orchestrator'); return 'noted'; } },
      { name: 'submit_item', description: 'Submit a NOT_YET_SUBMITTED item. A worker item is queued for planning. An epic is never queued: its breakdown is planned, as the user\'s own action, so only in a wake where the user is talking to you (the chat, or a question\'s thread) and asked for it; in any other wake an epic is refused. To offer it outside the chat, give a decision card option the action { tool: "submit_item", args: { id } } when an item is stopped, or ask with ask_user.', schema: idArg, handler: async (a) => {
        const id = String(a.id);
        try {
          if (store.requireItem(id).file.frontmatter.kind !== 'epic') { store.transition(id, 'QUEUED', 'orchestrator'); this.hooks.poke(); return 'queued'; }
          if (!chat) return `not permitted: ${id} is an epic, and planning an epic's breakdown is the user's call: it spends on a planner and leads to children. Nothing was submitted. They can ask you in the chat, or press "plan the breakdown" on its page; to put it to them, ask with ask_user, or on a stopped item's card give an option the action { tool: "submit_item", args: { id: "${id}" } }.`;
          this.hooks.submitForUser(id, 'submitted from the chat');
          return `planning the breakdown of epic ${id} (it is not queued: the user approves the children it proposes)`;
        } catch (e) { return `refused: ${(e as Error).message}. Nothing was submitted.`; }
      } },
      { name: 'mark_blocked', description: 'Block an item for the user with a reason.', schema: { ...idArg, reason: z.string() }, handler: async (a) => { const { decision: stale, ...rest } = store.requireItem(String(a.id)).file.frontmatter.awaiting_data ?? {}; store.mutateItem(String(a.id), [{ set: { blocked: true, blocked_reason: 'orchestrator', awaiting: 'user' } }, { unset: ['triage'] }, ...(stale ? [(Object.keys(rest).length ? { set: { awaiting_data: rest } } : { unset: ['awaiting_data'] }) as ItemOp] : []), { activity: { actor: 'orchestrator', text: `blocked for the user: ${a.reason}${stale ? ' (the decision card it had is withdrawn: this block replaces it)' : ''}` } }], 'orchestrator', { commit: `${a.id}: blocked (orchestrator)` }); return 'blocked'; } },
      { name: 'approve_plan', description: 'Approve a PLAN_READY item (only allowed when the item opted into auto-approval and config permits). Refused for a plan that reads as an epic breakdown (the packet says THIS IS AN EPIC): convert it with convert_item instead. With `hold`, its pull request stays out of the merge queue until the user releases it; a plan that states a merge hold (the packet says so) is held whether or not you pass it.', schema: { ...idArg, notes: z.string().optional(), hold: z.string().optional().describe('What the pull request waits for before it may merge ("until HH-12 has merged"). Only when it must wait.') }, handler: async (a) => {
        if (!this.hooks.planDelegated(String(a.id))) return 'not permitted: the user approves this plan (add review notes with annotate_item instead)';
        try { await this.hooks.approvePlan(String(a.id), a.notes ? String(a.notes) : undefined, a.hold ? String(a.hold) : undefined); } catch (e) { return `refused: ${(e as Error).message}`; }
        const held = heldReasonOf(store.requireItem(String(a.id)).file.frontmatter);
        return held ? `approved; its pull request will be held out of the merge queue: ${held}` : 'approved';
      } },
      { name: 'convert_item', description: 'Make a plain item an epic (to: "epic") or an epic back into an item (to: "item"), while nothing has run for implementation: not submitted yet, or planning with no approved plan. The description stays; its plan (or breakdown) moves into Notes for the new planner; its planning worktree is removed only if it holds no work (otherwise it is refused). A submitted item carries on as the new kind: an epic has its breakdown planned at once, an item is queued. An epic with children stays an epic. Use it when a plan reads as an epic (THIS IS AN EPIC in the packet) and the plan is yours to decide, or when the user asks in the chat.', schema: { ...idArg, to: z.enum(['item', 'epic']), reason: z.string().describe('Why, in a sentence: it goes in the Activity log') }, handler: async (a) => {
        const id = String(a.id);
        if (!chat && !this.hooks.planDelegated(id)) return 'not permitted: this item\'s plan is the user\'s to decide. Recommend the conversion with annotate_item; the item page offers them Convert to epic.';
        return this.hooks.convertKind(id, a.to as 'item' | 'epic', String(a.reason));
      } },
      { name: 'amend_plan', description: "Approve a PLAN_READY item's plan WITH stipulations: they go to the planner as amendments to fold in, the plan comes back for review, and whoever approves it approves a complete plan. Not one of the fix rounds. Use it instead of approving (or annotating) with a stipulation.", schema: { ...idArg, amendments: z.string() }, handler: async (a) => this.hooks.amendPlan(String(a.id), String(a.amendments)) },
      { name: 'request_plan_changes', description: 'Send a PLAN_READY item back to planning with specific fixes. Limited to a few rounds per item; past the limit the plan goes to the user instead.', schema: { ...idArg, message: z.string() }, handler: async (a) => this.hooks.requestPlanChanges(String(a.id), String(a.message)) },
      { name: 'hand_plan_to_user', description: 'Leave the approval of a plan that was delegated to you to the user, with the reason (a decision that is theirs, real risk, a large rework, low confidence).', schema: { ...idArg, reason: z.string() }, handler: async (a) => { this.hooks.handPlanToUser(String(a.id), String(a.reason)); return 'handed to the user'; } },
      { name: 'decide_permission', description: "Decide a worker's parked permission request that was delegated to you: allow (once), deny (with what to do instead), or ask_user (leave it to the user).", schema: { ...idArg, decision: z.enum(['allow', 'deny', 'ask_user']), reason: z.string() }, handler: async (a) => this.hooks.decidePermission(String(a.id), a.decision as 'allow' | 'deny' | 'ask_user', String(a.reason)) },
      { name: 'hand_off_files', description: "Give files from one item's worktree to another item that waits on it (depends_on, or the same epic): they become the receiver's attachments and its session is told. For when a worker's output is needed elsewhere before its branch merges. Paths are relative to the giver's worktree.", schema: { from: z.string(), to: z.string(), paths: z.array(z.string()).min(1), note: z.string() }, handler: async (a) => this.hooks.handOff(String(a.from), String(a.to), a.paths as string[], String(a.note)) },
      { name: 'unblock_item', description: "Resolve a stopped item: clear its block and, with a message, resume its session with that message (what to do next). Without a message the pipeline simply retries from where it stopped. With sync_first: true, planestro first brings its branch up to date with its base (as sync_with_base); use that when something it needs has merged since its worktree was cut. If the sync is refused the item stays blocked.", schema: { ...idArg, message: z.string().optional(), sync_first: z.boolean().optional(), fresh: z.boolean().optional().describe('Start a new conversation with a brief (the item, its plan, what is committed and what is not) and your message as its task, instead of resuming the old one. For work in progress or in review; needs a message') }, handler: async (a) => this.hooks.unblock(String(a.id), a.message ? String(a.message) : undefined, a.sync_first === true, a.fresh === true) },
      { name: 'commit_paths', description: "Commit named files in an item's worktree on its branch, with no session turn and at no cost: for work that is done but uncommitted when the item cannot pay for a turn, or when a turn would only run `git add` and `git commit`. Name each file exactly as the item's dirty list gives it (relative to the worktree); every one must be uncommitted there now. Only files that belong to the change: never generated files or byproducts. Nothing is pushed and the item stays as it is: follow with finish_from_worktree (in progress) or retry_op (in review). Refused while a step runs, during an unfinished rebase or merge, and on a taken-over item.", schema: { ...idArg, paths: z.array(z.string()).min(1).describe('Files to commit, relative to the worktree'), message: z.string().describe('The commit message: a subject line, then an optional body') }, handler: async (a) => this.hooks.commitPaths(String(a.id), a.paths as string[], String(a.message)) },
      { name: 'resolve_epic_conflict', description: "An epic blocked on sync_conflict: merge its base into its integration branch again and, if it still conflicts, have a one-shot session resolve it in the merge worktree (its implementer, capped by epics.conflict_budget_usd). planestro checks the merge and pushes it; the pipeline carries on. Give a hint when you know how the conflict should go (\"LICENSES.md and docs/biome_enemies/README.md are append-only: keep both sides' rows\"). A conflict that needs a product decision comes back blocked with that decision.", schema: { ...idArg, hint: z.string().optional() }, handler: async (a) => this.hooks.resolveEpicConflict(String(a.id), a.hint ? String(a.hint) : undefined) },
      { name: 'sync_with_base', description: "Bring an item's branch up to date with its base between turns: a worker branch is rebased (and pushed with a lease only if it is already pushed), an epic's integration branch has the base merged in. Nothing happens if it is already on the base tip. Use it before resuming an item whose dependency has merged, since its branch does not have that work until it is synced. Refused while a turn or step runs, while it awaits an answer, or with uncommitted changes. A conflict goes to the item's session to resolve (a blocked item stays blocked: use unblock_item with sync_first instead).", schema: idArg, handler: async (a) => this.hooks.syncWithBase(String(a.id)) },
      { name: 'answer_question', description: "Answer a worker's parked questions (awaiting question), as the user would. `answers` maps each question's text to its answer.", schema: { ...idArg, answers: z.record(z.string(), z.string()) }, handler: async (a) => this.hooks.answerQuestion(String(a.id), a.answers as Record<string, string>) },
      { name: 'set_item_fields', description: 'Set some of an item\'s own fields: parent (an epic id, or null), depends_on (item ids), base_branch_override (or null), skip_merge, implementer (a model id), allow_model_fallback. Anything else is refused. A new parent or base does not move an existing worktree: follow with recreate_worktree.', schema: { ...idArg, fields: z.record(z.string(), z.unknown()) }, handler: async (a) => this.hooks.setItemFields(String(a.id), a.fields as Record<string, unknown>) },
      { name: 'recreate_worktree', description: "Remove an item's worktree and branch and create them again from the item's current base, running the setup hooks, then unblock it (with `message` for the session, or a default one). Refused if the worktree has uncommitted changes or the branch has commits that are not on a base: nothing with work in it is ever removed. For worktree_missing and wrong-base mistakes before any work.", schema: { ...idArg, message: z.string().optional() }, handler: async (a) => this.hooks.recreateWorktree(String(a.id), a.message ? String(a.message) : undefined) },
      { name: 'retry_op', description: 'Retry the step a transient failure stopped (engine_error from a GitHub 5xx or a network hiccup, a CI timeout, a failed turn): an item in review re-enters the merge pipeline, a merged one re-runs cleanup, one with finished work re-opens its pull request, a session is resumed.', schema: idArg, handler: async (a) => this.hooks.retryOp(String(a.id)) },
      { name: 'ask_user_decision', description: 'Escalate a stopped item to the user as ONE plain decision: a one-line question, one sentence of why, 2–4 options (label + description) with exactly one recommended, which is shown first. The user answers by tapping an option or writing their own; you are woken with the answer to carry it out. An option may carry an `action` that planestro performs as the user when they pick it (add an item, submit one), so their answer is the authorization and nothing is asked twice. Only for calls that are genuinely theirs: spend, scope, taste, irreversible actions.', schema: { item: z.string(), question: z.string(), why: z.string(), options: z.array(z.object({ label: z.string(), description: z.string(), recommended: z.boolean().optional(), raise_budget_usd: z.number().positive().optional().describe('Answering with this option raises the item budget by this many dollars above its spend, then it resumes: use it for every spending stop (label it like "+$40 and resume"). It must cover the reload the Budget line names, plus the work'), fresh: z.boolean().optional().describe('This option is carried out in a fresh session with a brief, not the old conversation: a small raise is then enough'), action: z.object({ tool: z.enum(['create_item', 'submit_item']), args: z.record(z.string(), z.unknown()) }).optional().describe('What picking this option does, performed by planestro as the user: { tool: "create_item", args: { title, description, kind?, parent?, implementer?, planner?, category?, depends_on?, submit? } } (the same arguments as create_item) or { tool: "submit_item", args: { id } } (an epic has its breakdown planned). Checked when the card is filed. Not together with raise_budget_usd.') })), allow_free_text: z.boolean().optional() }, handler: async (a) => this.hooks.askUserDecision(String(a.item), { question: String(a.question), why: String(a.why), options: a.options as DecisionInput['options'], allow_free_text: a.allow_free_text === undefined ? true : Boolean(a.allow_free_text) }) },
      { name: 'withdraw_decision', description: 'Take back a decision card you left on an item, when the stop is being handled another way (the user answered elsewhere, the situation changed, you are resolving it yourself). The item stays as it is otherwise; say why.', schema: { ...idArg, reason: z.string() }, handler: async (a) => this.hooks.withdrawDecision(String(a.id), String(a.reason)) },
      { name: 'note_planestro', description: 'A suggestion about planestro itself (its UX, a tool you lacked, a rule that misfired), for the person who maintains it. It goes to a list of its own on the Console, never into an item. Say what happened and what would have helped.', schema: { text: z.string(), item: z.string().optional() }, handler: async (a) => { const entry = store.journal.append({ type: 'orchestrator.planestro_note', item: a.item ? String(a.item) : undefined, actor: 'orchestrator', data: { text: String(a.text) } }); this.emit({ type: 'engine.log', level: 'info', message: `[orchestrator notes about planestro] ${String(a.text).slice(0, 200)}` }); return `noted at ${entry.ts}; the user sees it under planestro feedback on the Console`; } },
      { name: 'file_for_maintainer', description: "File a backlog item for the person who runs planestro, for a fix that needs a capability no tool here has (a CI workflow file, SSH, a secret, a config that lives outside planestro). It is created NOT_YET_SUBMITTED, never queued, with a note that you filed it and why; the item you were triaging stays stopped until they act. Not for product decisions (those are a card) and not for work a worker could do.", schema: { title: z.string(), description: z.string().describe('What is broken, what a person must do, and how to tell it is done'), from_item: z.string().optional().describe('The stopped item this came from') }, handler: async (a) => {
        try {
          const from = a.from_item ? String(a.from_item) : undefined;
          const it = store.createItem({ title: String(a.title), description: String(a.description), notes: `Filed by the orchestrator${from ? ` while triaging ${from}` : ''}: it needs a person with a capability no worker or tool here has. Not queued for a worker.` }, 'orchestrator');
          store.mutateItem(it.id, [{ activity: { actor: 'orchestrator', text: `filed for the maintainer${from ? ` from ${from}` : ''}` } }], 'orchestrator');
          if (from && store.getItem(from)) store.mutateItem(from, [{ activity: { actor: 'orchestrator', text: `filed ${it.id} for the maintainer: ${String(a.title)}` } }], 'orchestrator');
          return `filed ${it.id} (NOT_YET_SUBMITTED, for the maintainer). Note on the stopped item what it waits for; do not put this on a card.`;
        } catch (e) { return `failed: ${(e as Error).message}`; }
      } },
      { name: 'finish_from_worktree', description: "The work is committed on the item's branch but the item could not reach a pull request (over budget, a size gate cleared, a runner that could not commit and a person committed for it): open the pull request from the worktree as planestro would have. Refuses a dirty tree, naming the files (untracked files worktrees.byproducts names do not count; except for a model whose commits are planestro's, engine_commits: its tree is committed first) or a branch with nothing ahead of its base.", schema: idArg, handler: async (a) => this.hooks.finishFromWorktree(String(a.id)) },
      { name: 'ask_user', description: "Ask the user something that is theirs to decide and not tied to a stopped item's card: it becomes a question with its own page (Console → Its questions for you), where they read your summary and recommendation and discuss it with you. Returns its id (Q-<n>) at once; their answer arrives as a later wake (question_message). Before asking, check list_questions: refresh an open question with update_question rather than asking it again.", schema: { question: z.string().describe('The question in one line: its headline'), summary: z.string().describe('Required. The question in plain terms, 1–3 sentences, for someone who has not read the logs: what is being decided and why it matters. No ids, jargon or log excerpts.'), details: z.string().optional().describe('What you know that bears on it: the item, what happened, the options you see. Markdown.'), recommendation: z.string().optional().describe('What you would do and why, in a sentence or two. Always give one when you have a view; the user can accept it in one tap.'), item: z.string().optional().describe('The item it is about, if any: the question resolves by itself when that item is finished') }, handler: async (a) => {
        const item = a.item && store.getItem(String(a.item)) ? String(a.item) : undefined;
        const q = store.askQuestion({ headline: String(a.question), summary: String(a.summary ?? '').trim() || String(a.question), details: a.details ? String(a.details) : undefined, recommendation: a.recommendation ? String(a.recommendation) : undefined, item }, 'orchestrator');
        // The chat and the journal keep showing questions as they always did, now with the id that opens the page.
        const entry = store.journal.append({ type: 'orchestrator.question', item, actor: 'orchestrator', data: { question: String(a.question), id: q.id } });
        if (item) store.mutateItem(item, [{ activity: { actor: 'orchestrator', text: `question for you (${q.id}): ${a.question}` } }], 'orchestrator');
        this.emit({ type: 'engine.log', level: 'warn', message: `[orchestrator asks] ${q.id}: ${a.question}` });
        return `asked as ${q.id} at ${entry.ts}; the user sees it in the console with its own page. Their answer arrives as a question_message wake.${a.item && !item ? ` (${a.item} is not an item here, so it is not linked to one.)` : ''}`;
      } },
      { name: 'list_questions', description: 'Your questions to the user: id, status, item, headline, when asked and how many messages its thread has. Open ones by default.', schema: { status: z.enum(['open', 'resolved', 'withdrawn', 'all']).optional() }, handler: async (a) => store.listQuestions(a.status === 'all' ? {} : { status: (a.status as 'open' | 'resolved' | 'withdrawn' | undefined) ?? 'open' }).map((q) => { const f = q.file.frontmatter; return `${f.id} [${f.status}] ${f.item ?? '—'} asked ${f.asked_at.slice(0, 16)} · ${parseThread(q.file).length} message(s) · ${f.headline}${f.resolution ? ` → ${f.resolution}` : ''}`; }).join('\n') || '(none)' },
      { name: 'read_question', description: 'Read one question file in full: summary, details, recommendation and the whole thread.', schema: idArg, handler: async (a) => serializeQuestionFile(store.requireQuestion(String(a.id)).file) },
      { name: 'reply_on_question', description: "Answer the user in one question's thread (its page). In a question_message wake this is the only thing they read: what you found, what you did, briefly.", schema: { ...idArg, text: z.string() }, handler: async (a) => { store.postToQuestion(String(a.id), 'orchestrator', String(a.text)); this.questionsAnswered.add(String(a.id)); return 'posted in the thread'; } },
      { name: 'update_question', description: "Refresh a question that still stands but whose situation moved on: a new plain-language summary (1–3 sentences), details, recommendation, or headline. Only what you pass changes; the thread notes the update.", schema: { ...idArg, summary: z.string().optional(), details: z.string().optional(), recommendation: z.string().optional(), headline: z.string().optional() }, handler: async (a) => { store.updateQuestion(String(a.id), { summary: a.summary as string | undefined, details: a.details as string | undefined, recommendation: a.recommendation as string | undefined, headline: a.headline as string | undefined }, 'orchestrator'); this.questionsChanged.add(String(a.id)); return 'updated'; } },
      { name: 'resolve_question', description: 'Close a question: resolved (it was answered: say the answer in a sentence) or withdrawn (it is moot: say why). The user can reopen it.', schema: { ...idArg, status: z.enum(['resolved', 'withdrawn']), resolution: z.string() }, handler: async (a) => { const q = store.requireQuestion(String(a.id)); if (q.file.frontmatter.status !== 'open') return `${a.id} is already ${q.file.frontmatter.status}`; store.resolveQuestion(String(a.id), a.status as 'resolved' | 'withdrawn', String(a.resolution), 'orchestrator'); this.questionsChanged.add(String(a.id)); this.questionsAnswered.add(String(a.id)); return a.status === 'resolved' ? 'resolved' : 'withdrawn'; } },
      { name: 'resume_after', description: "Park a stopped item until other items merge, then resume its session with `message`: for a worker that needs what another item delivers (a flag, an asset) before it can go on. It stops needing the user; planestro rebases its branch onto the base first. Use it instead of unblocking into a wait.", schema: { ...idArg, items: z.array(z.string()).min(1), message: z.string() }, handler: async (a) => this.hooks.resumeAfter(String(a.id), a.items as string[], String(a.message)) },
      { name: 'reply_to_user', description: 'Answer the user in the planestro chat. In a user_message wake this is the only thing they read: say what you found and what you did, briefly. Call it once, near the end of the wake.', schema: { text: z.string(), item: z.string().optional() }, handler: async (a) => { store.journal.append({ type: 'orchestrator.reply', item: a.item ? String(a.item) : undefined, actor: 'orchestrator', data: { text: String(a.text) } }); return 'sent to the chat'; } },
      { name: 'create_item', description: 'CHAT ONLY (outside the chat, offer it as a decision card option\'s action instead): create a backlog item the user asked for, as NOT_YET_SUBMITTED unless `submit` is true (then it is queued for planning at once; an epic has its breakdown planned). Write a complete brief: its worker sees only the title and description. Choose `kind` deliberately: "item" (the default) is one piece of work that one implementer finishes in one pull request; "epic" is several separately shippable pieces (art an image model makes plus the code that uses it, or parts that each deserve their own worker and pull request): its planner breaks it into child items, each with its own worker and pull request, merged through an integration branch. Never write "EPIC" into an item\'s description instead; if you are unsure which it is, ask.', schema: { title: z.string(), description: z.string(), kind: z.enum(['item', 'epic']).optional().describe('item (default) or epic'), planner: z.string().optional().describe('A Claude model id that plans it (for an epic, the breakdown and, by default, its children); the project default if omitted'), implementer: z.string().optional().describe('The model id that implements it; the project default if omitted'), parent: z.string().optional().describe('The epic it belongs to, when it is one more piece of that epic: it is cut from the epic\'s branch and merges into it'), category: z.string().optional().describe('One of the project categories; default if omitted'), depends_on: z.array(z.string()).optional(), submit: z.boolean().optional().describe('Queue it for planning now (only if the user said so)') }, handler: async (a) => {
        if (!chat) return 'not permitted: only when the user asks you to in the chat (a user_message wake). On a stopped item, offer it on its decision card instead: an option with the action { tool: "create_item", args: { … } } creates the item when the user picks it.';
        try {
          const epic = a.kind === 'epic';
          const planner = a.planner ? findModel(store.config, String(a.planner)) : undefined;
          const implementer = a.implementer ? findModel(store.config, String(a.implementer)) : undefined;
          // Held to what a card's action is held to: nothing is created that could never start.
          const refusal = this.hooks.actionRefusal({ tool: 'create_item', args: { title: String(a.title), description: String(a.description), ...(epic ? { kind: 'epic' as const } : {}), ...(a.planner ? { planner: String(a.planner) } : {}), ...(a.implementer ? { implementer: String(a.implementer) } : {}), ...(a.parent ? { parent: String(a.parent) } : {}), ...(a.category ? { category: String(a.category) } : {}), ...(a.depends_on ? { depends_on: a.depends_on as string[] } : {}), ...(a.submit ? { submit: true } : {}) } });
          if (refusal) return `failed: ${refusal}`;
          const it = store.createItem({ title: String(a.title), description: String(a.description), kind: epic ? 'epic' : 'item', ...(planner ? { planner: planner.id } : {}), ...(implementer ? { implementer: implementer.id } : {}), ...(a.parent ? { parent: String(a.parent) } : {}), ...(a.category ? { category: String(a.category) } : {}), ...(a.depends_on ? { depends_on: a.depends_on as string[] } : {}) }, 'orchestrator');
          store.mutateItem(it.id, [{ activity: { actor: 'orchestrator', text: `created from the chat${epic ? ' as an epic' : ''}` } }], 'orchestrator');
          if (a.submit && epic) await this.hooks.planEpic(it.id, 'created from the chat and submitted');
          else if (a.submit) { store.transition(it.id, 'QUEUED', 'orchestrator'); this.hooks.poke(); }
          return `created ${epic ? 'epic ' : ''}${it.id}${a.submit ? (epic ? ' and started planning its breakdown (the user approves the children)' : ' and queued it for planning') : (epic ? ' (not submitted; submit_item has its breakdown planned when the user asks, or they press "plan the breakdown" on its page)' : ' (not submitted; the user or submit_item queues it)')}`;
        } catch (e) { return `failed: ${(e as Error).message}`; }
      } },
      { name: 'done_with_wake', description: 'Finish this wake with a one-line summary of what you decided.', schema: { summary: z.string() }, handler: async (a) => { onDone(String(a.summary)); return 'Recorded. End your turn now.'; } },
    ];
  }
}
