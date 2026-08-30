import { join, relative, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { serializeItemFile, getSection, idNumber, slugify, isoLocal, renderPrompt, type ServerEvent, type Status } from '@planestro/shared';
import type { DataStore, StoredItem, ItemOp } from '../store/DataStore.ts';
import type { Engine, SessionView } from './Engine.ts';
import type { Ports, TurnPhase, TurnResult, TurnTools, PermissionRequest } from './ports.ts';
import { makePolicy, ruleFor, allowedByRules, BASE_ALLOWED } from './policy.ts';

export interface EngineOptions { sleep?: (ms: number) => Promise<void>; tickMs?: number; now?: () => string; ciWorkflow?: string }

const RESUMABLE_TURN_OPS = new Set(['planning_turn', 'implement_turn']);
const ACTIVE_FOR_SLOTS: Status[] = ['PLAN_IN_PROGRESS', 'IN_PROGRESS'];

/**
 * The Phase 3 lifecycle: one worker item at a time through
 * QUEUED → worktree → plan → (approval) → implement → PR → rebase → CI → merge → cleanup → FINISHED.
 * Deterministic; every step persists `op` before acting and journals begin/end.
 */
export class LiveEngine implements Engine {
  readonly mode: 'live' | 'dry-run';
  log: ServerEvent[] = [];
  private _paused: boolean;
  private jobs = new Map<string, Promise<void>>();
  private turns = new Map<string, { model: string; phase: TurnPhase; startedAt: string; lastOutput: string; abort: AbortController }>();
  private mergeChain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;
  private readonly ciWorkflow: string;
  private godotLock: Promise<void> = Promise.resolve();

  constructor(private readonly store: DataStore, private readonly ports: Ports, private readonly emit: (e: ServerEvent) => void, private readonly opts: EngineOptions = {}) {
    this.mode = ports.mode;
    this._paused = store.local.engine.paused;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? isoLocal;
    this.ciWorkflow = opts.ciWorkflow ?? 'CI';
  }

  get paused(): boolean { return this._paused; }
  private get repo(): string { return this.store.codeRepoPath(); }
  private get github(): string { const g = this.store.config.code_repo.github; if (!g) throw new Error('code_repo.github is not configured'); return g; }

  // ---- lifecycle ----
  async start(): Promise<void> {
    this.note('info', `engine ${this.mode} starting${this._paused ? ' (paused)' : ''}`);
    await this.resumeInterrupted();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 10_000);
    this.timer.unref?.();
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const t of this.turns.values()) t.abort.abort();
    await Promise.allSettled([...this.jobs.values()]);
  }
  pause(): void { this._paused = true; this.store.updateLocal({ engine: { ...this.store.local.engine, paused: true } }); this.emit({ type: 'engine.paused', paused: true }); this.note('warn', 'AUTOMATION PAUSED — running steps finish, nothing new starts'); }
  resume(): void { this._paused = false; this.store.updateLocal({ engine: { ...this.store.local.engine, paused: false } }); this.emit({ type: 'engine.paused', paused: false }); this.note('info', 'automation resumed'); void this.tick(); }
  poke(): void { void this.tick(); }
  sessions(): SessionView[] {
    return [...this.turns.entries()].map(([item, t]) => ({ item, session_id: this.store.getItem(item)?.file.frontmatter.session_id, model: t.model, op: t.phase, started_at: t.startedAt, busy: true, last_output: t.lastOutput }));
  }

  /** Run one scheduling pass. Idempotent; safe to call often. */
  async tick(): Promise<void> {
    if (this._paused || this.stopping) return;
    try {
      this.admit();
      this.driveInReview();
    } catch (e) { this.note('error', `tick: ${(e as Error).message}`); }
  }

  private admit(): void {
    const items = this.store.listItems();
    const active = items.filter((i) => (ACTIVE_FOR_SLOTS.includes(i.file.frontmatter.status) && !i.file.frontmatter.awaiting && !i.file.frontmatter.blocked) || this.turns.has(i.id)).length;
    let free = this.store.config.concurrency.max_sessions - active;
    for (const item of items) {
      if (free <= 0) break;
      const fm = item.file.frontmatter;
      if (fm.status !== 'QUEUED' || this.jobs.has(item.id)) continue;
      const d = this.store.derived(item);
      if (d.flavor !== 'worker' || !d.deps_satisfied || !d.base_branch) continue;
      free -= 1;
      this.runJob(item.id, () => this.startItem(item.id));
    }
  }

  private driveInReview(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.status !== 'IN_REVIEW' || fm.blocked || fm.awaiting || this.jobs.has(item.id) || this.turns.has(item.id)) continue;
      if (fm.ci_result === 'green' || fm.ci_result === 'red' || fm.op_data?.needs_session_rebase) continue;
      if (this.store.derived(item).flavor !== 'worker') continue;
      this.runJob(item.id, () => this.mergeJob(item.id));
    }
  }

  private followUps = new Map<string, () => Promise<unknown>>();

  private runJob(id: string, fn: () => Promise<unknown>): void {
    if (this.jobs.has(id)) return;
    const p = fn().then(() => undefined, (e) => { this.block(id, 'engine_error', (e as Error).message); }).finally(() => {
      this.jobs.delete(id);
      const next = this.followUps.get(id);
      if (next) { this.followUps.delete(id); this.runJob(id, next); }
    });
    this.jobs.set(id, p);
  }

  /** Run `fn` as the item's next job — immediately if idle, otherwise right after the current job (never dropped). */
  private queueFollowUp(id: string, fn: () => Promise<unknown>): void {
    if (this.jobs.has(id)) this.followUps.set(id, fn); else this.runJob(id, fn);
  }

  // ---- item lifecycle ----
  private async startItem(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    const base = d.base_branch!;
    const ctx = { prefix_lower: this.store.config.project.id_prefix.toLowerCase(), number: String(idNumber(id)), slug: slugify(fm.title) };
    const branch = renderPrompt(this.store.config.worktrees.branch_pattern, ctx);
    const dir = join(this.store.worktreesRoot(), renderPrompt(this.store.config.worktrees.dir_pattern, ctx));
    const worktreeRel = isAbsolute(dir) ? relative(this.repo, dir) : dir;
    const opId = this.store.journal.begin('creating_worktree', id, { branch, dir, base });
    this.store.mutateItem(id, [
      { transition: { to: 'PLAN_IN_PROGRESS', actor: 'engine' } },
      { set: { branch, worktree: worktreeRel, op: 'creating_worktree', op_started_at: this.now(), ci_failed_count: 0 } },
      { activity: { actor: 'app', text: `creating worktree ${worktreeRel} on ${branch} from origin/${base}` } },
    ], 'engine', { commit: `${id}: begin planning` });
    await this.ports.git.fetch(this.repo);
    await this.ports.git.worktreeAdd(this.repo, dir, branch, `origin/${base}`);
    this.store.mutateItem(id, [{ set: { op: 'importing', op_started_at: this.now() } }], 'engine');
    for (const hook of this.store.config.hooks.after_worktree_create) {
      const r = await this.withGodotLock(() => this.ports.proc.run(hook, { cwd: dir, timeoutMs: 20 * 60_000 }));
      if (r.code !== 0) { this.store.journal.end(opId, id, 'failed', { hook, code: r.code }); this.block(id, 'hook_failed', `${hook} exited ${r.code}: ${r.stderr.slice(-400)}`); return; }
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `hook ok: ${hook}` } }], 'engine');
    }
    this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
    this.store.journal.end(opId, id, 'ok');
    await this.runTurnFor(id, 'plan', this.store.renderPrompt('plan-item', this.store.requireItem(id)));
  }

  async approvePlan(id: string, notes?: string): Promise<void> {
    const item = this.store.requireItem(id);
    if (item.file.frontmatter.status !== 'PLAN_READY') throw new Error(`${id} is ${item.file.frontmatter.status}, not PLAN_READY`);
    this.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: 'user' } },
      { set: { op_data: { ...(item.file.frontmatter.op_data ?? {}), approval_notes: notes ?? '' } } },
      ...(notes ? [{ activity: { actor: 'user' as const, text: `approval notes: ${notes}` } }] : []),
    ], 'user', { commit: `${id}: approve plan` });
    this.runJob(id, () => this.runTurnFor(id, 'implement', this.store.renderPrompt('implement-plan', this.store.requireItem(id), { approval_notes: notes?.trim() || '(none)' })));
  }

  async rejectPlan(id: string, message: string): Promise<void> {
    const item = this.store.requireItem(id);
    if (item.file.frontmatter.status !== 'PLAN_READY') throw new Error(`${id} is ${item.file.frontmatter.status}, not PLAN_READY`);
    this.store.mutateItem(id, [{ transition: { to: 'PLAN_IN_PROGRESS', actor: 'user' } }, { activity: { actor: 'user', text: `plan changes requested: ${message}` } }], 'user', { commit: `${id}: request plan changes` });
    this.runJob(id, () => this.runTurnFor(id, 'plan', `${this.resumeNote(id, 'your plan review')}\n\nChanges requested on your plan:\n\n${message}\n\nRevise the plan accordingly and submit it again with the submit_plan tool, then end your turn.`));
  }

  async message(id: string, text: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) throw new Error(`${id} has no session to message in status ${fm.status}`);
    if (this.turns.has(id) || this.jobs.has(id)) {
      const pending = [...((fm.op_data?.pending_messages as string[] | undefined) ?? []), text];
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: pending } } }, { activity: { actor: 'user', text: `message queued: ${text}` } }], 'user');
      return;
    }
    if (fm.awaiting && fm.awaiting !== 'user') throw new Error(`${id} is awaiting ${fm.awaiting}; answer that first`);
    this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: 'user', text: `message: ${text}` } }], 'user');
    this.runJob(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'a message from the user')}\n\nMessage from the user:\n\n${text}`));
  }

  async respond(id: string, payload: Record<string, unknown>): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) throw new Error(`${id} is not in a session phase`);
    if (payload.kind === 'question') {
      if (fm.awaiting !== 'question') throw new Error(`${id} is not awaiting a question`);
      const answers = payload.answers as Record<string, string>;
      const text = Object.entries(answers).map(([q, a]) => `- Q: ${q}\n  A: ${a}`).join('\n');
      this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: 'user', text: `answered: ${Object.values(answers).join(' / ')}` } }], 'user', { commit: `${id}: answer questions` });
      this.runJob(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'your questions')}\n\nAnswers to your questions:\n\n${text}\n\nContinue.`));
      return;
    }
    if (payload.kind === 'permission') {
      if (fm.awaiting !== 'permission') throw new Error(`${id} is not awaiting a permission decision`);
      const req = fm.awaiting_data as unknown as PermissionRequest;
      const decision = payload.decision as 'allow' | 'always' | 'deny';
      const rule = ruleFor(req);
      const ops: ItemOp[] = [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: 'user', text: `permission ${decision}: ${rule}` } }];
      if (decision === 'always' && !this.store.config.permissions.allow.includes(rule)) this.store.updateConfig((doc) => { doc.setIn(['permissions', 'allow'], [...this.store.config.permissions.allow, rule]); }, `config: always allow ${rule.slice(0, 60)}`);
      this.store.mutateItem(id, ops, 'user', { commit: `${id}: permission ${decision}` });
      const desc = req.tool === 'Bash' ? `\`${String(req.input.command)}\`` : `${req.tool} ${JSON.stringify(req.input).slice(0, 200)}`;
      const msg = decision === 'deny'
        ? `${this.resumeNote(id, 'a permission decision')}\n\nThe user denied ${desc}${payload.reason ? `: ${payload.reason}` : ''}. Continue without it, or call report_blocked if you cannot.`
        : `${this.resumeNote(id, 'a permission decision')}\n\nThe user approved ${desc}. It is now allowed; continue.`;
      this.runJob(id, () => this.runTurnFor(id, phase, msg, decision === 'deny' ? [] : [rule]));
      return;
    }
    throw new Error(`unknown response kind ${String(payload.kind)}`);
  }

  private phaseFor(status: Status): TurnPhase | null {
    if (status === 'PLAN_IN_PROGRESS' || status === 'PLAN_READY') return 'plan';
    if (status === 'IN_PROGRESS') return 'implement';
    if (status === 'IN_REVIEW') return 'fix';
    return null;
  }

  private resumeNote(id: string, reason: string): string {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const parkedAt = (fm.awaiting_data?.requested_at as string | undefined) ?? fm.updated_at;
    const mins = Math.max(0, Math.round((Date.parse(this.now()) - Date.parse(parkedAt)) / 60_000));
    try { return this.store.renderPrompt('resume-context', item, { resume_reason: reason, parked_for: `${mins} min` }); }
    catch { return `[planestro] Your session was parked while waiting on ${reason} and has now been resumed.`; }
  }

  // ---- turns ----
  private async runTurnFor(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[] = []): Promise<TurnResult | undefined> {
    if (this.stopping) return undefined;
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    const cwd = this.absWorktree(fm.worktree!);
    const modelId = phase === 'plan' ? fm.planner : fm.implementer;
    const model = this.store.config.models.find((m) => m.id === modelId)?.claude_model;
    if (!model) throw new Error(`model ${modelId} has no claude_model`);
    const policy = makePolicy(this.store.config, d.base_branch!, cwd);
    const op = phase === 'plan' ? 'planning_turn' : 'implement_turn';
    const abort = new AbortController();
    const opId = this.store.journal.begin(op, id, { phase, model });
    this.store.mutateItem(id, [{ set: { op, op_started_at: this.now() } }], 'engine');
    this.turns.set(id, { model, phase, startedAt: this.now(), lastOutput: '', abort });
    this.emit({ type: 'session.started', id, session_id: fm.session_id });
    const budgetLeft = Math.max(0.5, (this.store.config as any).budget_usd_per_item ?? 25) - (fm.cost_usd ?? 0);
    let result: TurnResult;
    try {
      result = await this.ports.claude.runTurn({
        itemId: id, phase, cwd, model, permissionMode: phase === 'plan' ? 'plan' : 'acceptEdits', prompt, resume: fm.session_id,
        systemAppend: this.store.renderPrompt('worker-system', item),
        allowedTools: [...BASE_ALLOWED[phase], ...this.store.config.permissions.allow, ...extraAllowed],
        extraDirs: [this.store.dataDir], maxBudgetUsd: budgetLeft,
        tools: this.makeTools(id),
        onPermission: async (req) => {
          const why = policy.deny(req);
          if (why) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `denied ${req.tool}: ${why}` } }], 'engine'); return { action: 'deny', message: `Not allowed: ${why}` }; }
          if (allowedByRules(req, [...BASE_ALLOWED[phase], ...this.store.config.permissions.allow, ...extraAllowed])) return { action: 'allow' };
          this.store.mutateItem(id, [{ set: { awaiting: 'permission', awaiting_data: { tool: req.tool, input: req.input, requested_at: this.now() } } }, { activity: { actor: 'app', text: `parked: permission for ${req.tool} ${String(req.input.command ?? req.input.file_path ?? '').slice(0, 80)}` } }], 'engine', { commit: `${id}: awaiting permission` });
          return { action: 'park' };
        },
        onQuestion: async (questions) => {
          this.store.mutateItem(id, [{ set: { awaiting: 'question', awaiting_data: { questions, requested_at: this.now() } } }, { activity: { actor: 'app', text: `parked: agent asked ${questions.length} question(s)` } }], 'engine', { commit: `${id}: awaiting answers` });
        },
        onOutput: (text) => { const t = this.turns.get(id); if (t) t.lastOutput = text.slice(-400); this.emit({ type: 'session.output', id, text }); },
        signal: abort.signal,
      });
    } finally {
      this.turns.delete(id);
    }
    const after = this.store.requireItem(id).file.frontmatter;
    this.store.mutateItem(id, [
      { set: { session_id: result.sessionId ?? after.session_id, cost_usd: Math.round(((after.cost_usd ?? 0) + result.costUsd) * 10000) / 10000, turns: (after.turns ?? 0) + result.numTurns } },
      ...(after.op === op ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
    ], 'engine');
    this.store.journal.end(opId, id, result.isError ? 'failed' : 'ok', { subtype: result.subtype, cost: result.costUsd, parked: result.parked });
    this.emit({ type: 'session.ended', id, subtype: result.subtype });
    if (result.subtype === 'killed') { this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'turn interrupted (engine stopping); resumable' } }], 'engine'); return result; }
    if (result.isError) { this.block(id, 'turn_error', `${result.subtype}: ${result.error ?? result.text.slice(-300)}`); return result; }
    await this.afterTurn(id, phase, result);
    return result;
  }

  private async afterTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.awaiting || fm.blocked) return;                       // parked or agent-blocked: nothing to drive
    const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
    if (pending.length) {
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: [] } } }], 'engine');
      await this.runTurnFor(id, phase, `Messages from the user while you were working:\n\n${pending.map((m) => `- ${m}`).join('\n')}`);
      return;
    }
    if (phase === 'plan') {
      if (fm.status === 'PLAN_IN_PROGRESS' && !result.planSubmitted) this.block(id, 'no_plan', 'the planner ended its turn without submitting a plan');
      return;
    }
    await this.afterWorkTurn(id, phase, result);
  }

  /** Deterministic "is it really done": clean tree + commits ahead of the base. */
  private async afterWorkTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    const { clean, dirty } = await this.ports.git.status(cwd);
    if (!clean) {
      const tries = Number(fm.op_data?.dirty_tree_turns ?? 0) + 1;
      if (tries > 2) { this.block(id, 'dirty_tree', `the worktree still has uncommitted changes after ${tries - 1} reminders: ${dirty.slice(0, 5).join(', ')}`); return; }
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), dirty_tree_turns: tries } } }, { activity: { actor: 'app', text: `worktree dirty after turn (${dirty.length} files); asking the session to commit` } }], 'engine');
      await this.runTurnFor(id, phase, this.store.renderPrompt('commit-dirty-tree', item, { dirty_files: dirty.join('\n') }));
      return;
    }
    await this.ports.git.fetch(this.repo);
    const { ahead } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    if (fm.status === 'IN_PROGRESS') {
      if (ahead === 0) { this.block(id, 'no_commits', 'the session reported done but the branch has no commits ahead of its base'); return; }
      if (!result.done) this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'turn ended with commits but without report_done; proceeding to a pull request' } }], 'engine');
      await this.openPr(id, result.done);
      return;
    }
    if (fm.status === 'IN_REVIEW') {
      const head = await this.ports.git.revParse(cwd, 'HEAD');
      const moved = head !== fm.ci_head_sha;
      this.store.mutateItem(id, [
        { set: { ci_result: 'pending', op_data: { ...(fm.op_data ?? {}), needs_session_rebase: false } } },
        { activity: { actor: 'app', text: moved ? `session updated the branch (${head.slice(0, 7)}); re-entering the merge pipeline` : 'session finished without changing the branch; re-checking' } },
      ], 'engine');
      void this.tick();
    }
  }

  private async openPr(id: string, summary?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    const opId = this.store.journal.begin('creating_pr', id, { branch: fm.branch, base });
    this.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.now() } }], 'engine');
    await this.ports.git.pushSetUpstream(cwd, fm.branch!);
    this.store.mutateItem(id, [{ set: { op: 'creating_pr', op_started_at: this.now() } }], 'engine');
    const existing = (await this.ports.gh.prList(this.github, { head: fm.branch!, state: 'open' }))[0];
    const pr = existing ? { number: existing.number, url: existing.url } : await this.ports.gh.createPr(this.github, {
      base, head: fm.branch!, title: `${fm.title} (${id})`,
      body: `${summary ?? getSection(item.file, 'Description').slice(0, 1500)}\n\n---\nplanestro item **${id}** · plan:\n\n${getSection(item.file, 'Plan').slice(0, 3000)}\n\n🤖 Opened by planestro`,
    });
    this.store.mutateItem(id, [
      { transition: { to: 'IN_REVIEW', actor: 'engine' } },
      { set: { pr: pr.number, ci_result: 'pending' } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `opened PR #${pr.number} → ${base} (${pr.url})` } },
    ], 'engine', { commit: `${id}: open PR #${pr.number}` });
    this.store.journal.end(opId, id, 'ok', { pr: pr.number });
    this.note('info', `${id}: PR #${pr.number} opened against ${base}`);
    void this.tick();
  }

  // ---- merge pipeline (serial) ----
  private mergeJob(id: string): Promise<void> {
    const run = this.mergeChain.then(() => this.mergeStep(id));
    this.mergeChain = run.catch(() => undefined);
    return run;
  }

  private async mergeStep(id: string): Promise<void> {
    if (this._paused || this.stopping) return;
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.status !== 'IN_REVIEW' || fm.blocked || fm.awaiting) return;
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    const cfg = this.store.config.ci;
    const opId = this.store.journal.begin('merge', id, { pr: fm.pr, base });

    if (cfg.require_green_base) {
      const health = await this.ports.gh.branchCi(this.github, base, this.ciWorkflow);
      if (health.state === 'failure') { this.store.journal.end(opId, id, 'aborted', { reason: 'base_red' }); this.block(id, 'base_red', `the base branch ${base} is red (${health.url ?? 'no run url'}); fix the base or disable ci.require_green_base`); return; }
    }

    // 1. rebase
    this.store.mutateItem(id, [{ set: { op: 'rebasing', op_started_at: this.now(), op_data: { ...(fm.op_data ?? {}), base_sha: null } } }], 'engine');
    await this.ports.git.fetch(this.repo);
    const { clean } = await this.ports.git.status(cwd);
    if (!clean) { this.store.journal.end(opId, id, 'aborted', { reason: 'dirty' }); this.block(id, 'dirty_tree', 'the worktree has uncommitted changes; it cannot be rebased'); return; }
    const baseSha = await this.ports.git.revParse(this.repo, `origin/${base}`);
    const expected = await this.ports.git.remoteBranchSha(this.repo, fm.branch!);
    const rebase = await this.ports.git.rebase(cwd, `origin/${base}`);
    if (!rebase.ok) {
      this.store.mutateItem(id, [
        { unset: ['op', 'op_started_at'] },
        { set: { ci_result: 'unknown', op_data: { ...(fm.op_data ?? {}), needs_session_rebase: true } } },
        { activity: { actor: 'app', text: `rebase onto origin/${base} (${baseSha.slice(0, 7)}) conflicted in ${rebase.conflicts.join(', ')}; handing to the session` } },
      ], 'engine', { commit: `${id}: rebase conflict` });
      this.store.journal.end(opId, id, 'aborted', { reason: 'conflict', files: rebase.conflicts });
      this.queueFollowUp(id, () => this.runTurnFor(id, 'fix', this.store.renderPrompt('rebase-conflict', this.store.requireItem(id), { conflict_files: rebase.conflicts.join('\n'), base_sha: baseSha.slice(0, 12) })));
      return;
    }

    // 2. push
    this.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.now() } }], 'engine');
    await this.ports.git.pushForceWithLease(cwd, fm.branch!, expected);
    const headSha = rebase.head;
    this.store.mutateItem(id, [{ set: { op: 'awaiting_ci', op_started_at: this.now(), ci_head_sha: headSha, ci_result: 'pending' } }, { activity: { actor: 'app', text: `rebased onto ${base}@${baseSha.slice(0, 7)} and pushed ${headSha.slice(0, 7)}; waiting for CI` } }], 'engine');

    // 3. wait for CI
    const verdict = await this.waitForCi(id, fm.branch!, headSha, fm.pr!);
    if (verdict === 'moved') { this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }], 'engine'); this.store.journal.end(opId, id, 'aborted', { reason: 'head_moved' }); void this.tick(); return; }
    if (verdict === 'timeout') { this.store.journal.end(opId, id, 'aborted', { reason: 'ci_timeout' }); this.block(id, 'ci_timeout', `CI for ${headSha.slice(0, 7)} did not finish within ${cfg.timeout_min} min`); return; }
    if (verdict === 'blocked') {
      if (cfg.mode === 'github-or-local' && cfg.local_check_command) {
        this.store.mutateItem(id, [{ set: { op: 'running_local_checks', op_started_at: this.now() } }, { activity: { actor: 'app', text: `GitHub Actions is blocked; running local gate: ${cfg.local_check_command}` } }], 'engine');
        const r = await this.withGodotLock(() => this.ports.proc.run(cfg.local_check_command!, { cwd, timeoutMs: cfg.timeout_min * 60_000 }));
        if (r.code !== 0) { await this.onCiRed(id, opId, headSha, `local checks exited ${r.code}\n${(r.stdout + r.stderr).split('\n').filter((l) => /FAIL|Error/i.test(l)).slice(-40).join('\n')}`, 'local'); return; }
        this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'local checks passed (used as the CI gate)' } }], 'engine');
      } else { this.store.journal.end(opId, id, 'aborted', { reason: 'ci_blocked' }); this.block(id, 'ci_blocked', 'GitHub Actions did not run (billing blocked or workflow missing); set ci.mode to github-or-local with a local_check_command, or re-run by hand'); return; }
    }
    if (verdict === 'red') { await this.onCiRed(id, opId, headSha, undefined, 'github'); return; }

    // 4. merge
    this.store.mutateItem(id, [{ set: { op: 'merging', op_started_at: this.now(), ci_result: 'green' } }], 'engine');
    await this.ports.gh.mergePr(this.github, fm.pr!, { deleteBranch: true });
    const view = await this.ports.gh.prView(this.github, fm.pr!);
    if (view.state !== 'MERGED') { this.store.journal.end(opId, id, 'failed', { state: view.state }); this.block(id, 'merge_unverified', `gh reported the merge but PR #${fm.pr} is ${view.state}`); return; }
    this.store.mutateItem(id, [
      { transition: { to: 'MERGED', actor: 'engine' } },
      { set: { merged_at: view.mergedAt ? isoLocal(new Date(view.mergedAt)) : this.now(), op_data: { ...(fm.op_data ?? {}), merge_commit: view.mergeCommit } } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `merged PR #${fm.pr} into ${base}${view.mergeCommit ? ` (${view.mergeCommit.slice(0, 7)})` : ''}` } },
    ], 'engine', { commit: `${id}: merge` });
    this.store.journal.end(opId, id, 'ok', { merged: true });
    this.note('info', `${id}: PR #${fm.pr} merged into ${base}`);
    const notify = this.store.config.notifications.on_merge;
    if (notify) void this.ports.proc.run(notify, { cwd: this.repo, timeoutMs: 30_000 });
    await this.cleanup(id);
  }

  private async onCiRed(id: string, opId: string, headSha: string, logText: string | undefined, source: 'github' | 'local'): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const count = (fm.ci_failed_count ?? 0) + 1;
    const ci = fm.op_data?.ci as { runId?: number; url?: string } | undefined;
    const log = logText ?? (ci?.runId ? await this.ports.gh.runFailedLog(this.github, ci.runId, 120) : '(no run id)');
    this.store.mutateItem(id, [
      { unset: ['op', 'op_started_at'] },
      { set: { ci_result: 'red', ci_failed_count: count } },
      { activity: { actor: 'app', text: `CI red (${source}, attempt ${count}) for ${headSha.slice(0, 7)}${ci?.url ? ` ${ci.url}` : ''}` } },
    ], 'engine', { commit: `${id}: CI red (${count})` });
    this.store.journal.end(opId, id, 'failed', { reason: 'ci_red', count });
    if (count >= 2) { this.block(id, 'ci_red_twice', `CI failed ${count} times; a human (or, later, the orchestrator) decides what happens next`); return; }
    this.queueFollowUp(id, () => this.runTurnFor(id, 'fix', this.store.renderPrompt('ci-failed', this.store.requireItem(id), { ci: { attempt: String(count), run_url: ci?.url ?? '(local run)', failed_log: log } })));
  }

  /** Poll the named workflow for `sha`. 10 s cadence for the first 2 min, then 30 s. */
  private async waitForCi(id: string, branch: string, sha: string, pr: number): Promise<'green' | 'red' | 'blocked' | 'moved' | 'timeout'> {
    const cfg = this.store.config.ci;
    const started = Date.now();
    let sawRun = false;
    while (true) {
      if (this.stopping) return 'timeout';
      const view = await this.ports.gh.prView(this.github, pr);
      if (view.state === 'MERGED') return 'green';
      if (view.headRefOid !== sha) return 'moved';
      const ci = await this.ports.gh.ciForSha(this.github, branch, sha, this.ciWorkflow);
      const elapsedMin = (Date.now() - started) / 60_000;
      if (ci.runId) { sawRun = true; const cur = this.store.requireItem(id).file.frontmatter; if ((cur.op_data?.ci as any)?.runId !== ci.runId) this.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci: { runId: ci.runId, url: ci.url } } } }], 'engine'); }
      if (ci.state === 'success') return 'green';
      if (ci.state === 'failure') return (ci.runId && await this.ports.gh.isBillingBlocked(this.github, ci.runId)) ? 'blocked' : 'red';
      if (ci.state === 'cancelled') { /* superseded; keep polling for the new run */ }
      if (ci.state === 'none' && !sawRun && elapsedMin > cfg.start_timeout_min) return 'blocked';
      if (elapsedMin > cfg.timeout_min) return 'timeout';
      await this.sleep(elapsedMin < 2 ? 10_000 : 30_000);
    }
  }

  private async cleanup(id: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const base = this.store.derived(item).base_branch!;
    const cwd = this.absWorktree(fm.worktree!);
    const opId = this.store.journal.begin('cleaning_up', id, { branch: fm.branch });
    this.store.mutateItem(id, [{ set: { op: 'cleaning_up', op_started_at: this.now() } }], 'engine');
    // invariant 7: positive evidence before anything is deleted
    await this.ports.git.fetch(this.repo);
    const view = await this.ports.gh.prView(this.github, fm.pr!);
    const tip = fm.ci_head_sha ?? await this.ports.git.revParse(cwd, 'HEAD');
    const reachable = await this.ports.git.isAncestor(this.repo, tip, `origin/${base}`);
    if (view.state !== 'MERGED' || !reachable) { this.store.journal.end(opId, id, 'aborted', { reason: 'unverifiable' }); this.block(id, 'cleanup_unverifiable', `cannot prove ${tip.slice(0, 7)} is reachable from origin/${base} (PR ${view.state}); nothing was deleted`); return; }
    const { clean } = await this.ports.git.status(cwd).catch(() => ({ clean: true }));
    if (!clean) { this.store.journal.end(opId, id, 'aborted', { reason: 'dirty' }); this.block(id, 'cleanup_dirty', 'the worktree has uncommitted changes after the merge; remove it by hand or discard them'); return; }
    await this.ports.git.worktreeRemove(this.repo, cwd, false);
    await this.ports.git.worktreePrune(this.repo);
    await this.ports.git.deleteLocalBranch(this.repo, fm.branch!);
    if (await this.ports.git.remoteBranchSha(this.repo, fm.branch!)) await this.ports.git.deleteRemoteBranch(this.repo, fm.branch!);
    this.store.mutateItem(id, [
      { transition: { to: 'FINISHED', actor: 'engine' } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `removed worktree and branch ${fm.branch} (local + remote)` } },
    ], 'engine', { commit: `${id}: finish` });
    this.store.journal.end(opId, id, 'ok');
    this.note('info', `${id}: finished`);
  }

  // ---- restart recovery (Phase 3 subset; Phase 5 adds the full reconciler) ----
  private async resumeInterrupted(): Promise<void> {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (!fm.op) continue;
      if (RESUMABLE_TURN_OPS.has(fm.op)) {
        const phase = this.phaseFor(fm.status);
        this.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }, { activity: { actor: 'app', text: `turn (${fm.op}) was interrupted by a restart; resuming` } }], 'engine');
        if (phase && !fm.awaiting && !fm.blocked) this.runJob(item.id, () => this.runTurnFor(item.id, phase, `${this.resumeNote(item.id, 'a planestro restart')}\n\nYour previous turn was interrupted before it finished. Check the state of your worktree and continue where you left off.`));
      } else if (fm.op === 'awaiting_ci') {
        this.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }, { set: { ci_result: 'pending' } }, { activity: { actor: 'app', text: 'restart while waiting for CI; re-entering the merge pipeline' } }], 'engine');
      } else {
        this.store.mutateItem(item.id, [{ unset: ['op', 'op_started_at'] }], 'engine');
        this.block(item.id, `interrupted_${fm.op}`, `planestro restarted during ${fm.op}; verify the repo state and unblock (the Phase 5 reconciler will do this automatically)`);
      }
    }
  }

  // ---- helpers ----
  private makeTools(id: string): TurnTools {
    const s = this.store;
    return {
      submit_plan: async (plan) => {
        const cur = s.requireItem(id).file.frontmatter;
        const ops: ItemOp[] = [{ section: 'Plan', body: plan }];
        if (cur.status === 'PLAN_IN_PROGRESS') ops.push({ transition: { to: 'PLAN_READY', actor: 'engine' } });
        s.mutateItem(id, ops, 'engine', { commit: `${id}: submit plan` });
        this.note('info', `${id}: plan submitted — needs your approval`);
        return 'Plan recorded by planestro. End your turn now; you will be resumed once it is approved.';
      },
      add_note: async (markdown) => { const cur = getSection(s.requireItem(id).file, 'Notes'); s.mutateItem(id, [{ section: 'Notes', body: cur ? `${cur}\n\n${markdown}` : markdown }], 'engine', { commit: `${id}: worker note` }); return 'Note recorded.'; },
      append_activity: async (text) => { s.mutateItem(id, [{ activity: { actor: 'worker', text } }], 'engine'); return 'Recorded.'; },
      report_done: async (summary) => { const cur = s.requireItem(id).file.frontmatter; s.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), done_summary: summary } } }, { activity: { actor: 'worker', text: `done: ${summary.slice(0, 300)}` } }], 'engine'); return 'Recorded. End your turn now.'; },
      report_blocked: async (reason) => { this.block(id, 'agent_blocked', reason, 'user'); return 'Recorded. End your turn now; planestro will resume you with the answer.'; },
      get_item: async () => serializeItemFile(s.requireItem(id).file),
    };
  }

  private block(id: string, reason: string, detail: string, awaiting: 'user' | undefined = 'user'): void {
    try {
      const cur = this.store.requireItem(id).file.frontmatter;
      this.store.mutateItem(id, [
        { set: { blocked: true, blocked_reason: reason, ...(awaiting ? { awaiting } : {}) } },
        ...(cur.op ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
        { activity: { actor: 'app', text: `BLOCKED (${reason}): ${detail.replace(/\s+/g, ' ').slice(0, 500)}` } },
      ], 'engine', { commit: `${id}: blocked (${reason})` });
      this.note('warn', `${id} blocked: ${reason} — ${detail.slice(0, 200)}`);
    } catch (e) { this.note('error', `could not record block on ${id}: ${(e as Error).message}`); }
  }

  /** User-driven unblock: clears the flag and, if the item is in a session phase, resumes with a message. */
  async unblock(id: string, message?: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }, { activity: { actor: 'user', text: `unblocked${message ? `: ${message}` : ''}` } }], 'user', { commit: `${id}: unblock` });
    const phase = this.phaseFor(fm.status);
    if (message && phase) this.runJob(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'a decision from the user')}\n\n${message}`));
    else void this.tick();
  }

  private withGodotLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.godotLock.then(fn);
    this.godotLock = run.then(() => undefined, () => undefined);
    return run;
  }

  private absWorktree(rel: string): string { return isAbsolute(rel) ? rel : join(this.repo, rel); }

  private note(level: 'info' | 'warn' | 'error', message: string): void {
    const e: ServerEvent = { type: 'engine.log', level, message };
    this.log.push(e); if (this.log.length > 500) this.log.shift();
    this.emit(e);
  }
}
