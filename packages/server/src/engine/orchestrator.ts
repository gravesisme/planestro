import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { getSection, partsSummary, serializeItemFile, isoLocal, renormalize, laneOf, findModel, resolveTurnModel, fallbackChain, unavailableEntry, markUnavailable, unavailableUntil, type ServerEvent } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Ports, CustomToolDef, TurnResult } from './ports.ts';
import type { DecisionInput } from '@planestro/shared';

export interface WakeEvent { type: string; item?: string; data?: Record<string, unknown> }

export interface OrchestratorHooks {
  message(id: string, text: string): Promise<void>;
  approvePlan(id: string, notes?: string): Promise<void>;
  /** Send a plan back for fixes, within the item's round limit. Returns what happened, for the tool result. */
  requestPlanChanges(id: string, message: string): Promise<string>;
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
  unblock(id: string, message?: string): Promise<string>;
  /** Answer a worker's parked questions, as the user would. */
  answerQuestion(id: string, answers: Record<string, string>): Promise<string>;
  /** Set a whitelisted handful of an item's own fields (parent, dependencies, base override, …). */
  setItemFields(id: string, fields: Record<string, unknown>): string;
  /** Replace a worktree that holds no work with a fresh one from the item's current base, then unblock. */
  recreateWorktree(id: string, message?: string): Promise<string>;
  /** Re-run the step a transient failure stopped (a GitHub 5xx, a network hiccup). */
  retryOp(id: string): Promise<string>;
  /** Park a structured decision card on a stopped item for the user. */
  askUserDecision(id: string, input: DecisionInput): string;
  /** A wake that carried this item's triage is over; if it is still in triage, it goes to the user. */
  triageEnded(id: string): void;
  poke(): void;
}

interface OrchState { session_id?: string; started_at?: string; wakes_served: number }

/**
 * The judgment layer: one resumable Fable session, woken with a compact structured
 * context packet per event, never polled, rotated freely (invariant 3 — the files are
 * its memory). It proposes state changes through tools; the engine and user stay in
 * charge of everything mechanical.
 */
export class Orchestrator {
  private queue: WakeEvent[] = [];
  private running = false;
  private stopped = false;
  /** Items whose events are in the wake running now (the queue holds the ones still to come). */
  private inFlight = new Set<string>();
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
    this.queue.push(event);
    this.store.journal.append({ type: 'orchestrator.wake', item: event.item, actor: 'engine', data: { event: event.type } });
    void this.drain();
  }

  /** Whether a wake about this item is queued or running — so the engine re-wakes only what a restart dropped. */
  reviewing(id: string): boolean { return this.inFlight.has(id) || this.queue.some((e) => e.item === id); }
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
        try { await this.runWake(batch).catch((e) => this.log('error', `orchestrator wake failed: ${(e as Error).message}`)); }
        finally {
          this.inFlight = new Set();
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
    const packet = events.map((e) => this.renderPacket(e)).join('\n\n---\n\n');
    const prompt = `${state.session_id ? '' : this.systemIntro() + '\n\n'}# Wake: ${events.map((e) => e.type).join(', ')} — ${isoLocal()}\n\n${packet}\n\nHandle what needs judgment using the planestro tools, then call done_with_wake with a one-line summary. Everything mechanical is already handled by the app; do not attempt git or gh operations.`;
    let doneSummary = '';
    const pick = this.modelForWake();
    if (pick.fellBackFrom) this.log('info', `orchestrator: ${pick.fellBackFrom} is out of usage; waking on ${pick.label}`);
    if (pick.exhaustedUntil) this.log('warn', `orchestrator: every model in its fallback chain is out of usage until ${pick.exhaustedUntil}; trying ${pick.label} anyway`);
    const model = pick.model;
    const result: TurnResult = await this.ports.agents.claude.runCustomTurn!({
      label: events.map((e) => e.type).join(','), cwd: this.store.codeRepoPath(), model,
      ...(pick.sdkFallback ? { fallbackModel: pick.sdkFallback } : {}),
      permissionMode: 'dontAsk', prompt, resume: state.session_id, maxTurns: 30,
      systemAppend: this.systemIntro(),
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git log*)', 'Bash(git diff*)', 'Bash(git show*)', 'Bash(gh pr view*)', 'Bash(gh pr diff*)', 'Bash(gh run view*)'],
      mcpTools: this.tools((s) => { doneSummary = s; }),
      onOutput: (t) => this.emit({ type: 'engine.log', level: 'info', message: `[orchestrator] ${t.slice(0, 300)}` }),
    });
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
    this.writeState({ session_id: result.sessionId ?? state.session_id, started_at: state.started_at ?? isoLocal(), wakes_served: state.wakes_served + 1 });
    this.store.journal.append({ type: 'orchestrator.done', actor: 'orchestrator', data: { events: events.map((e) => e.type), summary: doneSummary || result.text.slice(-300), cost: result.costUsd, subtype: result.subtype } });
    this.log('info', `orchestrator: ${doneSummary || result.subtype}`);
  }

  private systemIntro(): string {
    try { return this.store.renderPrompt('orchestrator-system', undefined); }
    catch { return 'You are the planestro orchestrator: the judgment layer over a deterministic pipeline. Decide, instruct and annotate through the planestro tools; never perform git/gh operations yourself.'; }
  }

  private renderPacket(e: WakeEvent): string {
    const lines = [`Event: ${e.type}`];
    if (e.item) {
      const item = this.store.getItem(e.item);
      if (item) {
        const fm = item.file.frontmatter;
        lines.push(`Item: ${fm.id} — "${fm.title}" (${fm.kind}, ${fm.category})`);
        lines.push(`Status: ${fm.status}${fm.blocked ? ` · BLOCKED: ${fm.blocked_reason}` : ''}${fm.awaiting ? ` · awaiting ${fm.awaiting}` : ''}${fm.op ? ` · op ${fm.op}` : ''}`);
        if (fm.pr) lines.push(`PR: #${fm.pr} · CI ${fm.ci_result ?? '—'} · red count ${fm.ci_failed_count ?? 0}`);
        const desc = getSection(item.file, 'Description'); if (desc) lines.push(`Description:\n${desc.slice(0, 1200)}`);
        const plan = getSection(item.file, 'Plan'); if (plan) lines.push(`Approved/submitted plan:\n${plan.slice(0, 2000)}`);
        const activity = getSection(item.file, 'Activity').split('\n').slice(-8).join('\n'); if (activity) lines.push(`Recent activity:\n${activity}`);
        if (fm.parts?.length) lines.push(`Parts, as the worker itself reports them (${partsSummary(fm.parts)}). Quote this; never summarise the state of the work from memory or prose:\n${fm.parts.map((p) => `- ${p.name}: ${p.state}${p.reason ? ` — ${p.reason}` : ''}`).join('\n')}`);
        if (e.type === 'plan_review') lines.push(this.planPolicy(fm.id, fm.plan_revisions ?? 0));
        if (e.type === 'permission_request') lines.push(this.permissionPacket(fm));
        if (fm.triage) lines.push(e.type === 'decision_answered' ? this.decisionAnsweredPacket() : this.triagePacket(fm));
      }
    }
    for (const [k, v] of Object.entries(e.data ?? {})) lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 2000));
    return lines.join('\n');
  }

  /**
   * Who approves this plan, said in the packet rather than the prompt library: a data dir's copy
   * of orchestrator-system predates the rule, and the limit is the engine's to state, not the model's to remember.
   */
  private planPolicy(id: string, used: number): string {
    if (!this.hooks.planDelegated(id)) return 'Plan approval: the user\'s. Review it and record what is risky, missing or out of scope with annotate_item; approve_plan is not permitted for this item.';
    const max = this.store.config.orchestrator.max_plan_revisions;
    const left = Math.max(0, max - used);
    return [
      'Plan approval: DELEGATED TO YOU. The user trusts your judgment on this item; decide it in this wake, with exactly one of:',
      '- approve_plan — the plan is sound and matches the request. Implementation starts at once. Put anything the implementer should watch in `notes`.',
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
      fm.worktree ? `Its worktree (the only place it should write, besides scratch files under /tmp or $TMPDIR): ${fm.worktree}` : '',
      input.description ? `What the worker says it is for: ${String(input.description)}` : '',
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
      '- unblock_item — the fix is an instruction to the session: resubmit a plan it already wrote (an MCP "Stream closed" ate submit_plan), carry on after a hiccup, use what the brief already says. Pass the message it should act on.',
      '- answer_question — the worker asked something the brief, plan, notes or project rules already answer.',
      '- retry_op — a transient failure: a GitHub 5xx, an SSH or network hiccup, a timeout. Not for anything that failed the same way twice.',
      '- set_item_fields — a wrong parent/base/dependency/implementer/fallback setting (e.g. an epic child created without its parent, so it was cut from the wrong base). Then recreate_worktree if the worktree was cut from the wrong base.',
      '- recreate_worktree — a missing worktree (worktree_missing after a fetch race) or one cut from the wrong base. It refuses if the worktree or branch holds any work, re-runs setup, then unblocks with your message.',
      'Escalate only a decision that is genuinely the user\'s — spending (budget caps, usage limits), scope, taste, or anything irreversible — with ask_user_decision: ONE plain one-line question, one sentence of why, 2–4 options with exactly one marked recommended (always recommend), each a thing you can carry out with your tools or that the user does themselves (say which). No jargon, no log excerpts: the card is read on a phone.',
      'A card never asks the user to do something somewhere else (raise a setting, edit a file, run a command): the option must do it. For a spending stop (over_budget, token_budget, turn_budget), give an option with raise_budget_usd, labelled like "+$40 and resume"; answering it raises the item\'s own budget and you are woken to resume it.',
      'Record what you did with annotate_item. If you do none of these in this wake, the item goes to the user exactly as it is.',
    ].join('\n');
  }

  private decisionAnsweredPacket(): string {
    return [
      'Decision answered: the user answered the decision card you left on this item (question and answer below). Carry it out now with your tools — unblock_item with a message, answer_question, set_item_fields, recreate_worktree, retry_op — and note what you did with annotate_item.',
      'If the packet says the budget was raised, that is already done: unblock_item resumes the item, and nothing needs changing elsewhere.',
      'If the answer asks for something no tool can do, say exactly what the user must do in one more ask_user_decision, or leave it: when this wake ends without action the item goes back to the user.',
    ].join('\n');
  }

  private tools(onDone: (summary: string) => void): CustomToolDef[] {
    const store = this.store;
    const idArg = { id: z.string() };
    return [
      { name: 'list_items', description: 'List backlog items (id, status, flags), optionally filtered by status.', schema: { status: z.string().optional() }, handler: async (a) => store.listItems().filter((i) => !a.status || i.file.frontmatter.status === a.status).map((i) => { const f = i.file.frontmatter; return `${f.id} [${f.status}${f.blocked ? ' BLOCKED:' + f.blocked_reason : ''}${f.awaiting ? ' awaiting:' + f.awaiting : ''}] rank=${f.rank ?? '—'} pr=${f.pr ?? '—'} ${f.kind === 'epic' ? 'EPIC ' : ''}${f.title}`; }).join('\n') || '(no items)' },
      { name: 'read_item', description: 'Read one item file in full.', schema: idArg, handler: async (a) => serializeItemFile(store.requireItem(String(a.id)).file) },
      { name: 'pr_status', description: 'Pull request + CI status for an item.', schema: idArg, handler: async (a) => { const fm = store.requireItem(String(a.id)).file.frontmatter; if (!fm.pr) return 'no PR'; const gh = store.config.code_repo.github; if (!gh) return 'no github remote configured'; const pr = await this.ports.gh.prView(gh, fm.pr); return `#${pr.number} ${pr.state} base=${pr.baseRefName} head=${pr.headRefName}@${pr.headRefOid.slice(0, 7)} ci=${fm.ci_result ?? '—'} (${fm.ci_failed_count ?? 0} red)`; } },
      { name: 'set_merge_order', description: 'Override the merge order of the given IN_REVIEW items (first merges first). Items not listed keep rank order after these.', schema: { ids: z.array(z.string()) }, handler: async (a) => { (a.ids as string[]).forEach((id, i) => store.mutateItem(id, [{ set: { merge_order: i + 1 } }, { activity: { actor: 'orchestrator', text: `merge order ${i + 1}` } }], 'orchestrator', { commit: `${id}: merge order ${i + 1}` })); this.hooks.poke(); return 'merge order set'; } },
      { name: 'set_queue_order', description: 'Reorder the QUEUED items (first is admitted first).', schema: { ids: z.array(z.string()) }, handler: async (a) => { const ids = a.ids as string[]; const ranks = renormalize(ids); for (const id of ids) { const it = store.requireItem(id); if (laneOf(it.file.frontmatter.status) !== 'board') throw new Error(`${id} is not on the board`); store.mutateItem(id, [{ rank: ranks.get(id)! }], 'orchestrator'); } this.hooks.poke(); return 'queue order set'; } },
      { name: 'skip_merge', description: 'Hold an IN_REVIEW item out of the merge queue, with a reason.', schema: { ...idArg, reason: z.string() }, handler: async (a) => { store.mutateItem(String(a.id), [{ set: { skip_merge: true } }, { activity: { actor: 'orchestrator', text: `held out of the merge queue: ${a.reason}` } }], 'orchestrator', { commit: `${a.id}: skip merge` }); return 'held'; } },
      { name: 'unskip_merge', description: 'Return a held item to the merge queue.', schema: idArg, handler: async (a) => { store.mutateItem(String(a.id), [{ unset: ['skip_merge'] }, { set: { ci_result: 'pending' } }, { activity: { actor: 'orchestrator', text: 'returned to the merge queue' } }], 'orchestrator', { commit: `${a.id}: unskip merge` }); this.hooks.poke(); return 'returned'; } },
      { name: 'message_session', description: "Send guidance to an item's worker session (queued for its next turn).", schema: { ...idArg, text: z.string() }, handler: async (a) => { await this.hooks.message(String(a.id), String(a.text)); return 'queued for the session'; } },
      { name: 'annotate_item', description: "Append an orchestrator note to an item's activity log.", schema: { ...idArg, text: z.string() }, handler: async (a) => { store.mutateItem(String(a.id), [{ activity: { actor: 'orchestrator', text: String(a.text) } }], 'orchestrator'); return 'noted'; } },
      { name: 'submit_item', description: 'Queue a NOT_YET_SUBMITTED worker item for planning.', schema: idArg, handler: async (a) => { store.transition(String(a.id), 'QUEUED', 'orchestrator'); this.hooks.poke(); return 'queued'; } },
      { name: 'mark_blocked', description: 'Block an item for the user with a reason.', schema: { ...idArg, reason: z.string() }, handler: async (a) => { store.mutateItem(String(a.id), [{ set: { blocked: true, blocked_reason: 'orchestrator', awaiting: 'user' } }, { unset: ['triage'] }, { activity: { actor: 'orchestrator', text: `blocked for the user: ${a.reason}` } }], 'orchestrator', { commit: `${a.id}: blocked (orchestrator)` }); return 'blocked'; } },
      { name: 'approve_plan', description: 'Approve a PLAN_READY item (only allowed when the item opted into auto-approval and config permits).', schema: { ...idArg, notes: z.string().optional() }, handler: async (a) => { if (!this.hooks.planDelegated(String(a.id))) return 'not permitted: the user approves this plan (add review notes with annotate_item instead)'; await this.hooks.approvePlan(String(a.id), a.notes ? String(a.notes) : undefined); return 'approved'; } },
      { name: 'request_plan_changes', description: 'Send a PLAN_READY item back to planning with specific fixes. Limited to a few rounds per item; past the limit the plan goes to the user instead.', schema: { ...idArg, message: z.string() }, handler: async (a) => this.hooks.requestPlanChanges(String(a.id), String(a.message)) },
      { name: 'hand_plan_to_user', description: 'Leave the approval of a plan that was delegated to you to the user, with the reason (a decision that is theirs, real risk, a large rework, low confidence).', schema: { ...idArg, reason: z.string() }, handler: async (a) => { this.hooks.handPlanToUser(String(a.id), String(a.reason)); return 'handed to the user'; } },
      { name: 'decide_permission', description: "Decide a worker's parked permission request that was delegated to you: allow (once), deny (with what to do instead), or ask_user (leave it to the user).", schema: { ...idArg, decision: z.enum(['allow', 'deny', 'ask_user']), reason: z.string() }, handler: async (a) => this.hooks.decidePermission(String(a.id), a.decision as 'allow' | 'deny' | 'ask_user', String(a.reason)) },
      { name: 'hand_off_files', description: "Give files from one item's worktree to another item that waits on it (depends_on, or the same epic): they become the receiver's attachments and its session is told. For when a worker's output is needed elsewhere before its branch merges. Paths are relative to the giver's worktree.", schema: { from: z.string(), to: z.string(), paths: z.array(z.string()).min(1), note: z.string() }, handler: async (a) => this.hooks.handOff(String(a.from), String(a.to), a.paths as string[], String(a.note)) },
      { name: 'unblock_item', description: "Resolve a stopped item: clear its block and, with a message, resume its session with that message (what to do next). Without a message the pipeline simply retries from where it stopped.", schema: { ...idArg, message: z.string().optional() }, handler: async (a) => this.hooks.unblock(String(a.id), a.message ? String(a.message) : undefined) },
      { name: 'answer_question', description: "Answer a worker's parked questions (awaiting question), as the user would. `answers` maps each question's text to its answer.", schema: { ...idArg, answers: z.record(z.string(), z.string()) }, handler: async (a) => this.hooks.answerQuestion(String(a.id), a.answers as Record<string, string>) },
      { name: 'set_item_fields', description: 'Set some of an item\'s own fields: parent (an epic id, or null), depends_on (item ids), base_branch_override (or null), skip_merge, implementer (a model id), allow_model_fallback. Anything else is refused. A new parent or base does not move an existing worktree: follow with recreate_worktree.', schema: { ...idArg, fields: z.record(z.string(), z.unknown()) }, handler: async (a) => this.hooks.setItemFields(String(a.id), a.fields as Record<string, unknown>) },
      { name: 'recreate_worktree', description: "Remove an item's worktree and branch and create them again from the item's current base, running the setup hooks, then unblock it (with `message` for the session, or a default one). Refused if the worktree has uncommitted changes or the branch has commits that are not on a base: nothing with work in it is ever removed. For worktree_missing and wrong-base mistakes before any work.", schema: { ...idArg, message: z.string().optional() }, handler: async (a) => this.hooks.recreateWorktree(String(a.id), a.message ? String(a.message) : undefined) },
      { name: 'retry_op', description: 'Retry the step a transient failure stopped (engine_error from a GitHub 5xx or a network hiccup, a CI timeout, a failed turn): an item in review re-enters the merge pipeline, a merged one re-runs cleanup, one with finished work re-opens its pull request, a session is resumed.', schema: idArg, handler: async (a) => this.hooks.retryOp(String(a.id)) },
      { name: 'ask_user_decision', description: 'Escalate a stopped item to the user as ONE plain decision: a one-line question, one sentence of why, 2–4 options (label + description) with exactly one recommended, which is shown first. The user answers by tapping an option or writing their own; you are woken with the answer to carry it out. Only for calls that are genuinely theirs: spend, scope, taste, irreversible actions.', schema: { item: z.string(), question: z.string(), why: z.string(), options: z.array(z.object({ label: z.string(), description: z.string(), recommended: z.boolean().optional(), raise_budget_usd: z.number().positive().optional().describe('Answering with this option raises the item budget by this many dollars above its spend, then it resumes: use it for every spending stop (label it like "+$40 and resume")') })), allow_free_text: z.boolean().optional() }, handler: async (a) => this.hooks.askUserDecision(String(a.item), { question: String(a.question), why: String(a.why), options: a.options as DecisionInput['options'], allow_free_text: a.allow_free_text === undefined ? true : Boolean(a.allow_free_text) }) },
      { name: 'ask_user', description: 'Ask the user something; the answer arrives as a later wake. Returns immediately.', schema: { question: z.string(), item: z.string().optional() }, handler: async (a) => { const entry = store.journal.append({ type: 'orchestrator.question', item: a.item ? String(a.item) : undefined, actor: 'orchestrator', data: { question: String(a.question) } }); if (a.item) store.mutateItem(String(a.item), [{ activity: { actor: 'orchestrator', text: `question for you: ${a.question}` } }], 'orchestrator'); this.emit({ type: 'engine.log', level: 'warn', message: `[orchestrator asks] ${a.question}` }); return `recorded at ${entry.ts}; the user will see it in the console`; } },
      { name: 'done_with_wake', description: 'Finish this wake with a one-line summary of what you decided.', schema: { summary: z.string() }, handler: async (a) => { onDone(String(a.summary)); return 'Recorded. End your turn now.'; } },
    ];
  }
}
