import { closesLine } from './issueImport.ts';
import { itemModelSwitchOps } from '../providerSwitch.ts';
import { join, relative, isAbsolute, extname, basename, matchesGlob } from 'node:path';
import { DEBUG_MARKER, debugMarkerRefusal, Audition, AuditionPicks, auditionPicksProblem, auditionPickLines, auditionNote, auditionComplete, resumeEstimate, resumeRates, chooseTurnPath, minRaiseUsd, MIN_TURN_USD, FRESH_FLOOR_USD, type ResumeEstimate, type SessionContext, type ItemFrontmatter, validateParts, partsSummary, serializeItemFile, modelCapabilities, getSection, idNumber, slugify, isoLocal, renderPrompt, findTransition, waitsFor, fallbackChain, unavailableEntry, validateBreakdown, findModel, epicFlagOf, epicShapeOf, holdShapeOf, heldReasonOf, holdWaitsOnPerson, kindConversionRefusal, type EpicFlag, type ProposedChild, type BreakdownChild, type DecisionInput, type Decision, type ServerEvent, type Status, type RateLimitSnapshot, demoteH1, loopGreen, loopLine, loopTallyProblem, testRunShape, TEST_RUN, type HostLoad, type ModelDef, resolveAccount, guardKey, unavailableView, DEFAULT_ACCOUNT, type Account } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Engine, SessionView } from './Engine.ts';
import { matchesPathPattern, type Ports, type TurnPhase, type TurnResult, type TurnTools, type PermissionRequest, type CiQueue, type RunnerReport, type AccountCredentials } from './ports.ts';
import { makePolicy, ruleFor, allowedByRules, BASE_ALLOWED } from './policy.ts';
import { answeredCommand, commandShape, rulingText, parkedRefusal, permissionGrantRefusal } from './parks.ts';
import { commandGrant, commandForms } from './sessions/nativeApproval.ts';
import { workerCommandEnv } from './sessions/commandEnv.ts';
import { Orchestrator } from './orchestrator.ts';
import { NeedsYouWatch, type Wait } from './needsYou.ts';
import { auditSlotDue, runEfficiencyAudit } from './efficiencyAudit.ts';
import { runnerStatusText, type RunnerStall } from './runners.ts';
import { HeavyLock, ciOnSharedHost, heavyAllowRules, took } from './heavyRuns.ts';
import type { ReviewImage, ReviewDiff, UndoTurnPreview } from './Engine.ts';
import { ReviewUndo } from './reviewUndo.ts';
import { WorkerTools, ATTACH_PER_CALL } from './workerTools.ts';
import { Guards, USAGE_RESUME_GRACE_MS } from './guards.ts';
import { CleanupReconcile } from './cleanupReconcile.ts';
import { Epics } from './epics.ts';
import { BaseSync } from './baseSync.ts';
import { Triage } from './triage.ts';
import { CiWatch } from './ciWatch.ts';
import { MergePipeline } from './mergePipeline.ts';
import { TurnRunner, type TurnOpts, type PendingTurn, type RunningTurn } from './turnRunner.ts';
import { TurnQueue } from './turnQueue.ts';
import { MAX_ORCHESTRATOR_DENIALS } from './orchestratorDenials.ts';
import { Slots } from './slots.ts';
import { Scheduler } from './scheduler.ts';

/** `schedule` runs `fn` after `ms` and returns a cancel (tests capture it instead of waiting). */
/** `listenUrl`: where the server answers (`http://127.0.0.1:4300`), the start of notification links unless notifications.base_url says otherwise. */
export interface EngineOptions { sleep?: (ms: number) => Promise<void>; tickMs?: number; now?: () => string; ciWorkflow?: string; schedule?: (fn: () => void, ms: number) => () => void; listenUrl?: string; /** This machine's load, for the concurrency guard (#330); tests pin it. */ hostLoad?: () => HostLoad | undefined; /** The server's log (serve.log): a failed step's stack goes here (#439). */ log?: (level: 'info' | 'warn' | 'error', message: string) => void }

const JUDGMENT_BLOCKS = ['turn_error', 'connection_lost', 'no_plan', 'no_commits', 'dirty_tree', 'sync_conflict', 'ci_red', 'ci_red_parked', 'ci_infra', 'ci_timeout', 'ci_blocked', 'ci_disagree', 'base_red', 'pr_closed_externally', 'merge_unverified', 'agent_blocked', 'engine_error'] as const;
/** What a sandbox says when it refused git's own files (the worktree's index.lock lives outside the worktree). */
const GIT_REFUSAL = /index\.lock|\.git\/worktrees|EPERM|Operation not permitted|Permission denied/i;
/** A block that is about committing ("planestro needs to commit this", "complete but uncommitted", "nothing added to commit"). */
const ASKS_COMMIT = /commit|\bstag(e|ing)\b/i;

/** What `set_item_fields` may touch: the item's own wiring, never its lifecycle, sessions or history. */
const ORCHESTRATOR_FIELDS = ['parent', 'depends_on', 'base_branch_override', 'skip_merge', 'implementer', 'allow_model_fallback'] as const;

/**
 * The Phase 3 lifecycle: one worker item at a time through
 * QUEUED → worktree → plan → (approval) → implement → PR → rebase → CI → merge → cleanup → FINISHED.
 * Deterministic; every step persists `op` before acting and journals begin/end.
 */
/** A hold whose words ask a person to look at pictures (#355). */
const LOOK_AT_PICTURES = /captur|screenshot|render|image|picture|before\/after|contact sheet|art review|frames?\b|sprites?\b/i;

export class LiveEngine implements Engine {
  readonly mode: 'live' | 'dry-run';
  log: ServerEvent[] = [];
  private jobs = new Map<string, Promise<void>>();
  /** Turns this engine started. `waiting` names the slot the turn is still queued for, a runner's (concurrency.runner_limits) or `session` (max_sessions): no process yet. */
  /** `lastOutputAt`: when it last said anything, or was admitted to run (epoch ms), for `concurrency.turn_quiet_min`. */
  private turns = new Map<string, RunningTurn>();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => string;
  private readonly ciWorkflow: string;
  readonly orchestrator: Orchestrator;
  private readonly needsYou: NeedsYouWatch;
  /** Attachments, the review hand-off, auditions and hand-offs between items (#404, seam 1). */
  private readonly workerTools: WorkerTools;
  /** The review panel and Undo last turn with its checkpoints (#404, seam 2). */
  private readonly reviewUndo: ReviewUndo;
  /** The pause, the usage and disk guards, model outages and drain (#404, seam 3). */
  private readonly guards: Guards;
  /** Cleanup after a merge, the reconciler and every move-aside: invariant 7's destructive operations (#404, seam 4). */
  private readonly cleanupReconcile: CleanupReconcile;
  /** Epic planning, breakdown approval, the integration branch and the epic PR (#404, seam 5). */
  private readonly epics: Epics;
  /** Sync with base: syncs, held rebases (HH-532), an epic's conflict retry and its wait on the base (#404, seam 6). */
  private readonly baseSync: BaseSync;
  /** Needs-you triage, decision cards and what a card's option does as the user (#404, seam 7). */
  private readonly triage: Triage;
  /** CI waits, red runs, rerun_ci, runner stalls and the review-stall wake (#404, seam 8). */
  private readonly ciWatch: CiWatch;
  /** The serial merge chain and held items (#404, seam 8). */
  private readonly mergePipeline: MergePipeline;
  /** One turn of an item's session and its accounting, an epic's conflict session and turn prompts (#404, seam 9). */
  private readonly turnRunner: TurnRunner;
  /** Saved instructions, queued messages and restart recovery: when a turn runs (#404, seam 9). */
  private readonly turnQueue: TurnQueue;
  /** One step per item, its follow-ups, and the session, runner and local-job slots: what may run at once (#404, seam 10). */
  private readonly slots: Slots;
  /** The tick, admission and the timing drivers: when things run (#404, seam 10). */
  private readonly scheduler: Scheduler;

  constructor(private readonly store: DataStore, private readonly ports: Ports, private readonly emit: (e: ServerEvent) => void, private readonly opts: EngineOptions = {}) {
    this.mode = ports.mode;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const schedule = opts.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    // A timer's callback runs outside any caller's try: one that throws (a full disk under a journal write) is noted, never the process's end.
    this.schedule = (fn, ms) => schedule(() => { try { fn(); } catch (e) { this.note('error', `timer: ${(e as Error).message}`); } }, ms);
    this.now = opts.now ?? isoLocal;
    this.ciWorkflow = opts.ciWorkflow ?? 'CI';
    const stopping = () => this.stopping;
    const turnQueue = () => this.turnQueue;
    this.slots = new Slots({
      store,
      get stopping() { return stopping(); },
      turns: this.turns,
      jobs: this.jobs,
      opts,
      get turnQueue() { return turnQueue(); },
      note: (level, message) => this.note(level, message),
      block: (id, reason, detail) => this.block(id, reason, detail),
      wakeOrchestrator: (type, item, data) => this.wakeOrchestrator(type, item, data),
    });
    this.workerTools = new WorkerTools({
      store,
      turns: this.turns,
      jobs: this.jobs,
      now: () => this.now(),
      absWorktree: (rel) => this.absWorktree(rel),
      note: (level, message) => this.note(level, message),
      recordPark: (id, kind, what, asked) => this.recordPark(id, kind, what, asked),
      phaseFor: (status) => this.phaseFor(status),
      queueTurn: (id, phase, prompt) => this.queueTurn(id, phase, prompt),
      resumeNote: (id, reason) => this.resumeNote(id, reason),
    });
    const repo = () => this.repo;
    const github = () => this.github;
    this.reviewUndo = new ReviewUndo({
      store,
      ports,
      get repo() { return repo(); },
      get github() { return github(); },
      turns: this.turns,
      jobs: this.jobs,
      now: () => this.now(),
      absWorktree: (rel) => this.absWorktree(rel),
      note: (level, message) => this.note(level, message),
      deliverQueued: (id, when) => this.turnQueue.deliverQueued(id, when),
    });
    const orchestrator = () => this.orchestrator;
    this.guards = new Guards({
      store,
      ports,
      get repo() { return repo(); },
      get stopping() { return stopping(); },
      turns: this.turns,
      jobs: this.jobs,
      get orchestrator() { return orchestrator(); },
      emit,
      note: (level, message) => this.note(level, message),
      announce: (event, title, message) => this.announce(event, title, message),
      schedule: (fn, ms) => this.schedule(fn, ms),
      tick: () => this.tick(),
      accountFor: (fm, def) => this.accountFor(fm, def),
    });
    this.cleanupReconcile = new CleanupReconcile({
      store,
      ports,
      get repo() { return repo(); },
      get github() { return github(); },
      turns: this.turns,
      jobs: this.jobs,
      reviewUndo: this.reviewUndo,
      now: () => this.now(),
      absWorktree: (rel) => this.absWorktree(rel),
      note: (level, message) => this.note(level, message),
      block: (id, reason, detail) => this.block(id, reason, detail),
      runJob: (id, fn) => this.runJob(id, fn),
      blockClosedPr: (id, n) => this.blockClosedPr(id, n),
      wakeOrchestrator: (type, item, data) => this.wakeOrchestrator(type, item, data),
      isByproduct: (path) => this.isByproduct(path),
      worktreeDirt: (cwd) => this.worktreeDirt(cwd),
    });
    this.epics = new Epics({
      store,
      ports,
      get repo() { return repo(); },
      get github() { return github(); },
      turns: this.turns,
      jobs: this.jobs,
      now: () => this.now(),
      absWorktree: (rel) => this.absWorktree(rel),
      note: (level, message) => this.note(level, message),
      runJob: (id, fn) => this.runJob(id, fn),
      tick: () => this.tick(),
      busyWith: (id) => this.busyWith(id),
      runTurnFor: (id, phase, prompt, extraAllowed, oneShotCommands, opts) => this.runTurnFor(id, phase, prompt, extraAllowed, oneShotCommands, opts),
      implementersList: () => this.turnRunner.implementersList(),
      holdIntoReason: (base, alreadyHeld) => this.holdIntoReason(base, alreadyHeld),
      holdOps: (reason, by) => this.holdOps(reason, by),
      wakeOrchestrator: (type, item, data) => this.wakeOrchestrator(type, item, data),
      syncWithBase: (id, opts) => this.syncWithBase(id, opts),
    });
    const baseSync = () => this.baseSync;
    const ciQueue = () => this.ciQueue;
    this.ciWatch = new CiWatch({
      store,
      ports,
      get github() { return github(); },
      ciWorkflow: this.ciWorkflow,
      get stopping() { return stopping(); },
      turns: this.turns,
      jobs: this.jobs,
      followUps: this.followUps,
      get ciQueue() { return ciQueue(); },
      get baseSync() { return baseSync(); },
      now: () => this.now(),
      sleep: (ms) => this.sleep(ms),
      absWorktree: (rel) => this.absWorktree(rel),
      note: (level, message) => this.note(level, message),
      block: (id, reason, detail) => this.block(id, reason, detail),
      tick: () => this.tick(),
      poke: () => this.poke(),
      busyWith: (id) => this.busyWith(id),
      queueTurn: (id, phase, prompt, extraAllowed, oneShotCommands, opts) => this.queueTurn(id, phase, prompt, extraAllowed, oneShotCommands, opts),
      wakeOrchestrator: (type, item, data) => this.wakeOrchestrator(type, item, data),
      retryOp: (id, by, message) => this.retryOp(id, by, message),
      refreshCiQueue: () => this.scheduler.refreshCiQueue(),
      readRunners: (maxAgeMs) => this.readRunners(maxAgeMs),
    });
    this.mergePipeline = new MergePipeline({
      store,
      ports,
      get repo() { return repo(); },
      get github() { return github(); },
      ciWorkflow: this.ciWorkflow,
      get stopping() { return stopping(); },
      turns: this.turns,
      jobs: this.jobs,
      guards: this.guards,
      get baseSync() { return baseSync(); },
      cleanupReconcile: this.cleanupReconcile,
      reviewUndo: this.reviewUndo,
      ciWatch: this.ciWatch,
      now: () => this.now(),
      sleep: (ms) => this.sleep(ms),
      absWorktree: (rel) => this.absWorktree(rel),
      note: (level, message) => this.note(level, message),
      block: (id, reason, detail, awaiting, stall) => this.block(id, reason, detail, awaiting, stall),
      runJob: (id, fn) => this.runJob(id, fn),
      queueFollowUp: (id, fn) => this.queueFollowUp(id, fn),
      queueTurn: (id, phase, prompt, extraAllowed, oneShotCommands, opts) => this.queueTurn(id, phase, prompt, extraAllowed, oneShotCommands, opts),
      tick: () => this.tick(),
      deliverQueued: (id, when) => this.turnQueue.deliverQueued(id, when),
      resolveEpicConflict: (id, cwd, base, baseSha, files, hint) => this.turnRunner.resolveEpicConflict(id, cwd, base, baseSha, files, hint),
      draftsWhileHeld: (id) => this.draftsWhileHeld(id),
      outsideApprovedScope: (id, sha) => this.outsideApprovedScope(id, sha),
      holdOps: (reason, by, waitsOn) => this.holdOps(reason, by, waitsOn),
      wakeOrchestrator: (type, item, data) => this.wakeOrchestrator(type, item, data),
      announce: (event, title, message, item) => this.announce(event, title, message, item),
      withLocalJobSlot: (fn) => this.slots.withLocalJobSlot(fn),
    });
    this.baseSync = new BaseSync({
      store,
      ports,
      get repo() { return repo(); },
      get stopping() { return stopping(); },
      turns: this.turns,
      jobs: this.jobs,
      guards: this.guards,
      cleanupReconcile: this.cleanupReconcile,
      heldPolledAt: this.heldPolledAt,
      now: () => this.now(),
      absWorktree: (rel) => this.absWorktree(rel),
      note: (level, message) => this.note(level, message),
      block: (id, reason, detail) => this.block(id, reason, detail),
      runJob: (id, fn) => this.runJob(id, fn),
      tick: () => this.tick(),
      busyWith: (id) => this.busyWith(id),
      phaseFor: (status) => this.phaseFor(status),
      queueTurn: (id, phase, prompt, extraAllowed, oneShotCommands, opts) => this.queueTurn(id, phase, prompt, extraAllowed, oneShotCommands, opts),
      retryOp: (id, by, message) => this.retryOp(id, by, message),
      unblock: (id, message, by, opts) => this.unblock(id, message, by, opts),
      freshRefusal: (fm, message) => this.freshRefusal(fm, message),
      withLocalJobSlot: (fn) => this.slots.withLocalJobSlot(fn),
      worktreeDirt: (cwd) => this.worktreeDirt(cwd),
      resolveEpicConflict: (id, cwd, base, baseSha, files, hint) => this.turnRunner.resolveEpicConflict(id, cwd, base, baseSha, files, hint),
    });
    this.triage = new Triage({
      store,
      get stopping() { return stopping(); },
      turns: this.turns,
      jobs: this.jobs,
      pendingWakes: this.slots.pendingWakes,
      get orchestrator() { return orchestrator(); },
      guards: this.guards,
      epics: this.epics,
      now: () => this.now(),
      note: (level, message) => this.note(level, message),
      block: (id, reason, detail, awaiting, stall, card) => this.block(id, reason, detail, awaiting, stall, card),
      unblock: (id, message, by, opts) => this.unblock(id, message, by, opts),
      wakeOrchestrator: (type, item, data) => this.wakeOrchestrator(type, item, data),
      poke: () => this.poke(),
      busyWith: (id) => this.busyWith(id),
      guarded: (runner, account) => this.guarded(runner, account),
      phaseFor: (status) => this.phaseFor(status),
      budgetOf: (fm) => this.budgetOf(fm),
      resumeEstimateFor: (fm, model) => this.resumeEstimateFor(fm, model),
      freshRefusal: (fm, message) => this.freshRefusal(fm, message),
      discardRefusal: (id) => this.discardRefusal(id),
      closeAsDoneRefusal: (id) => this.closeAsDoneRefusal(id),
      rerunRefusal: (id) => this.ciWatch.rerunRefusal(id),
      reopenRefusal: (id) => this.reopenRefusal(id),
      discard: (id, reason, opts) => this.discard(id, reason, opts),
      closeAsDone: (id, reason) => this.closeAsDone(id, reason),
      rerunCi: (id, by) => this.rerunCi(id, by),
      reopenPr: (id) => this.reopenPr(id),
      retryAtReset: (id, at, by) => this.retryAtReset(id, at, by),
    });
    const turnRunner = () => this.turnRunner;
    this.scheduler = new Scheduler({
      store,
      ports,
      get github() { return github(); },
      ciWorkflow: this.ciWorkflow,
      get stopping() { return stopping(); },
      turns: this.turns,
      jobs: this.jobs,
      followUps: this.slots.followUps,
      opts,
      guards: this.guards,
      get orchestrator() { return orchestrator(); },
      triage: this.triage,
      epics: this.epics,
      mergePipeline: this.mergePipeline,
      baseSync: this.baseSync,
      ciWatch: this.ciWatch,
      get turnRunner() { return turnRunner(); },
      get turnQueue() { return turnQueue(); },
      now: () => this.now(),
      note: (level, message) => this.note(level, message),
      block: (id, reason, detail) => this.block(id, reason, detail),
      runJob: (id, fn) => this.runJob(id, fn),
      busyWith: (id) => this.busyWith(id),
      phaseFor: (status) => this.phaseFor(status),
      guardedFor: (fm, def) => this.guardedFor(fm, def),
      startItem: (id) => this.startItem(id),
      carryOnStalled: (id) => this.carryOnStalled(id),
      retryOp: (id, by, message) => this.retryOp(id, by, message),
      continueAfterProviderSwitch: (id) => this.continueAfterProviderSwitch(id),
      driveEfficiencyAudit: () => this.driveEfficiencyAudit(),
      drivePendingTurns: () => this.drivePendingTurns(),
      nudgeStaleReviews: () => this.nudgeStaleReviews(),
      driveStaleBlocks: () => this.driveStaleBlocks(),
      drivePlanReviews: () => this.drivePlanReviews(),
      drivePermissionReviews: () => this.drivePermissionReviews(),
      driveExternal: () => this.driveExternal(),
      wakeSlotWaiters: () => this.slots.wakeSlotWaiters(),
    });
    this.turnRunner = new TurnRunner({
      store,
      ports,
      get repo() { return repo(); },
      get stopping() { return stopping(); },
      turns: this.turns,
      testRunWrites: this.testRunWrites,
      stoppedFor: this.scheduler.stoppedFor,
      quietStopped: this.scheduler.quietStopped,
      guards: this.guards,
      triage: this.triage,
      reviewUndo: this.reviewUndo,
      emit,
      now: () => this.now(),
      absWorktree: (rel) => this.absWorktree(rel),
      note: (level, message) => this.note(level, message),
      block: (id, reason, detail) => this.block(id, reason, detail),
      savePendingTurn: (id, turn) => this.savePendingTurn(id, turn),
      queueTurn: (id, phase, prompt, extraAllowed, oneShotCommands, opts) => this.queueTurn(id, phase, prompt, extraAllowed, oneShotCommands, opts),
      afterTurn: (id, phase, result) => this.afterTurn(id, phase, result),
      phaseFor: (status) => this.phaseFor(status),
      resumeNote: (id, reason) => this.resumeNote(id, reason),
      accountFor: (fm, def) => this.accountFor(fm, def),
      guarded: (runner, account) => this.guarded(runner, account),
      accountTurnOptions: (account) => this.accountTurnOptions(account),
      budgetOf: (fm) => this.budgetOf(fm),
      resumeEstimateFor: (fm, model) => this.resumeEstimateFor(fm, model),
      commitsFor: (fm) => this.commitsFor(fm),
      worktreeDirt: (cwd) => this.worktreeDirt(cwd),
      makeTools: (id) => this.makeTools(id),
      recordTestRun: (id, cwd, run, source) => this.recordTestRun(id, cwd, run, source),
      recordPark: (id, kind, what, asked) => this.recordPark(id, kind, what, asked),
      permissionsDelegated: () => this.permissionsDelegated(),
      mayAskOrchestrator: (fm) => this.mayAskOrchestrator(fm),
      wakeOrchestrator: (type, item, data) => this.wakeOrchestrator(type, item, data),
      wakeWhenIdle: (id, type, data) => this.slots.wakeWhenIdle(id, type, data),
      debugMarkersLeft: (id) => this.debugMarkersLeft(id),
      withRunnerSlot: (runner, fn, signal) => this.slots.withRunnerSlot(runner, fn, signal),
      withSessionSlot: (id, fn, signal) => this.withSessionSlot(id, fn, signal),
    });
    this.turnQueue = new TurnQueue({
      store,
      get stopping() { return stopping(); },
      turns: this.turns,
      jobs: this.jobs,
      followUps: this.followUps,
      guards: this.guards,
      baseSync: this.baseSync,
      turnRunner: this.turnRunner,
      block: (id, reason, detail) => this.block(id, reason, detail),
      runJob: (id, fn) => this.runJob(id, fn),
      queueFollowUp: (id, fn) => this.queueFollowUp(id, fn),
      phaseFor: (status) => this.phaseFor(status),
      accountFor: (fm, def) => this.accountFor(fm, def),
      guarded: (runner, account) => this.guarded(runner, account),
      clearSupersededStop: (id) => this.clearSupersededStop(id),
      afterTurn: (id, phase, result) => this.afterTurn(id, phase, result),
    });
    this.orchestrator = new Orchestrator(store, ports, {
      message: (id, text) => this.message(id, text, 'orchestrator'),
      approvePlan: (id, notes, hold, syncFirst) => this.approvePlan(id, notes, 'orchestrator', { hold, syncFirst }),
      holdMerge: (id, reason) => this.orchestratorHolds(id, reason),
      convertKind: (id, to, why) => this.convertKind(id, to, 'orchestrator', why).catch((e) => (e as Error).message),
      planEpic: (id, why) => this.epics.planEpic(id, why),
      actionRefusal: (action) => this.triage.actionRefusal(action),
      submitForUser: (id, why) => this.triage.submitAsUser(id, why),
      requestPlanChanges: (id, m) => this.orchestratorRequestsPlanChanges(id, m),
      amendPlan: (id, m) => this.orchestratorAmendsPlan(id, m),
      planDelegated: (id) => this.planDelegated(this.store.requireItem(id).file.frontmatter),
      handPlanToUser: (id, reason) => this.handPlanToUser(id, `the orchestrator left it to you: ${reason}`),
      planReviewEnded: (id) => this.handPlanToUser(id, 'the orchestrator reviewed it without deciding'),
      permissionsDelegated: () => this.permissionsDelegated(),
      decidePermission: (id, request, decision, reason) => this.orchestratorDecidesPermission(id, request, decision, reason),
      permissionReviewEnded: (id) => this.handPermissionToUser(id, 'the orchestrator looked at it without deciding'),
      handOff: (from, to, paths, note) => this.handOff(from, to, paths, note, 'orchestrator'),
      unblock: (id, message, syncFirst, fresh) => this.orchestratorUnblocks(id, message, syncFirst, fresh),
      commitPaths: (id, paths, message) => this.commitPaths(id, paths, message, 'orchestrator'),
      budgetLine: (id) => this.budgetLine(id),
      syncWithBase: (id) => this.syncWithBase(id, { by: 'orchestrator' }),
      resolveEpicConflict: (id, hint) => this.retryEpicConflict(id, hint, 'orchestrator'),
      answerQuestion: (id, answers) => this.orchestratorAnswers(id, answers),
      setItemFields: (id, fields) => this.orchestratorSetsFields(id, fields),
      recreateWorktree: (id, message) => this.recreateWorktree(id, message),
      retryOp: (id) => this.retryOp(id),
      retryAtReset: (id, at) => this.retryAtReset(id, at, 'orchestrator'),
      rerunCi: (id) => this.rerunCi(id, 'orchestrator'),
      unskipMerge: (id) => this.orchestratorUnskips(id),
      busyWith: (id) => this.busyWith(id),
      resumeAfter: (id, items, message, prs) => this.resumeAfter(id, items, message, 'orchestrator', prs ?? []),
      finishFromWorktree: (id) => this.finishFromWorktree(id, 'orchestrator'),
      ciWorkflow: this.ciWorkflow,
      runnerStatus: () => this.runnerStatus(),
      askUserDecision: (id, input) => this.triage.askUserDecision(id, input),
      withdrawDecision: (id, reason) => this.triage.withdrawDecision(id, reason),
      triageEnded: (id) => this.triage.endTriage(id, 'the orchestrator looked at it without resolving it'),
      poke: () => this.poke(),
      usageSeen: (r, runner) => this.guards.usageSeen(r, runner),
    }, emit, (l, m) => this.note(l, m), () => this.guards.paused || this.guards.draining);
    this.needsYou = new NeedsYouWatch(store, {
      announce: (w) => this.announceWait(w),
      now: () => Date.parse(this.now()),
      schedule: (fn, ms) => this.schedule(fn, ms),
      idleAfterMs: () => this.store.config.notifications.idle_after_min * 60_000,
    });
  }

  /** Fire-and-forget judgment wake (invariant 4: never for anything a state machine can know). */
  private wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void {
    if (item && this.store.getItem(item)?.file.frontmatter.taken_over) return; // a person has it: nothing to judge
    this.orchestrator.wake({ type, item, data });
  }

  get paused(): boolean { return this.guards.paused; }
  private get repo(): string { return this.store.codeRepoPath(); }
  private get github(): string { const g = this.store.config.code_repo.github; if (!g) throw new Error('code_repo.github is not configured'); return g; }

  // ---- lifecycle ----
  private reconcileTimer?: NodeJS.Timeout;

  async start(): Promise<void> {
    this.note('info', `engine ${this.mode} starting${this.guards.paused ? ' (paused)' : ''}`);
    await this.reconcile('startup').catch((e) => this.note('error', `reconcile: ${(e as Error).message}`));
    await this.resumeInterrupted();
    for (const q of this.orchestrator.resumeQuestions()) this.note('info', `${q}: answering the message a restart left unanswered`);
    this.guards.armGuardResume();
    this.guards.armModelResume();
    this.needsYou.start();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 10_000);
    this.timer.unref?.();
    this.reconcileTimer = setInterval(() => void this.reconcile('periodic').catch(() => undefined), 5 * 60_000);
    this.reconcileTimer.unref?.();
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    const orchestratorStopped = this.orchestrator.stop();
    this.guards.stop();
    this.needsYou.stop();
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const t of this.turns.values()) t.abort.abort();
    this.slots.wakeSlotWaiters();   // a turn waiting for a slot sees `stopping` and ends; stop() waits on its job
    this.auditAbort?.abort();
    await Promise.allSettled([...this.jobs.values(), orchestratorStopped, this.auditing]);
  }

  // ---- guards (#404, seam 3): the pause, the usage and disk guards, model outages and drain live in guards.ts ----
  pause(): void { this.guards.pause(); }
  resume(message?: string): void { this.guards.resume(message); }
  retryProvider(runner: string): void { this.guards.retryProvider(runner); }
  recordUnavailable(def: { id: string; label: string }, limit: TurnResult['usageLimit'], manual = false, account?: string): string { return this.guards.recordUnavailable(def, limit, manual, account); }
  checkDisk(force = false): Promise<void> { return this.guards.checkDisk(force); }
  drain(by: 'user' | 'update' = 'user'): void { this.guards.drain(by); }
  undrain(): void { this.guards.undrain(); }
  restartReadiness(): { draining: boolean; by?: 'user' | 'update'; idle: boolean; running: string[] } { return this.guards.restartReadiness(); }
  private usageSeen(r: RateLimitSnapshot | undefined, runner?: string): void { this.guards.usageSeen(r, runner); }
  private guardResume(): void { this.guards.guardResume(); }
  private armModelResume(): void { this.guards.armModelResume(); }

  /**
   * An event worth hearing about away from the browser (#70): journaled as a `notification`, which an open
   * planestro tab shows as a desktop notification if this device opted in (under planestro's own icon once the
   * web app is installed), and the project's notifications.* command run with PLANESTRO_TITLE / PLANESTRO_MESSAGE.
   */
  private announce(event: 'on_merge' | 'on_usage_pause' | 'on_needs_you', title: string, message: string, item?: string, extra: { data?: Record<string, unknown>; env?: Record<string, string> } = {}): void {
    this.store.journal.append({ type: 'notification', ...(item ? { item } : {}), actor: 'engine', data: { event, title, message, ...extra.data } });
    const cmd = this.store.config.notifications[event];
    if (cmd) void this.ports.proc.run(cmd, { cwd: this.repo, timeoutMs: 30_000, env: { PLANESTRO_TITLE: title, PLANESTRO_MESSAGE: message, ...extra.env } }).catch(() => undefined);
  }

  /** An item needs you or the orchestrator asks (#224): announced once per wait by the NeedsYouWatch, with a link to it. */
  private announceWait(w: Wait): void {
    const url = this.linkTo(w.path);
    this.announce('on_needs_you', w.title, w.message, w.item, {
      data: { kind: w.kind, url, wait: w.key, ...(w.question ? { question: w.question } : {}) },
      env: { PLANESTRO_ITEM: w.item ?? '', PLANESTRO_KIND: w.kind, PLANESTRO_URL: url },
    });
  }
  /** An absolute link into planestro: notifications.base_url, else the address the server listens on. */
  private linkTo(path: string): string {
    return `${(this.store.config.notifications.base_url ?? this.opts.listenUrl ?? 'http://127.0.0.1:4300').replace(/\/+$/, '')}${path}`;
  }
  /** A store event: whether an item now needs you, or a question opened (NeedsYouWatch). */
  observe(e: ServerEvent): void { this.needsYou.observe(e); if (e.type === 'config.updated') { this.guards.armModelResume(); this.slots.wakeSlotWaiters(); } }
  /** A client's heartbeat: someone is at a planestro tab, so a wait can be answered there before it is announced. */
  clientActive(): void { this.needsYou.clientActive(); }

  async testNotification(event: 'on_merge' | 'on_usage_pause' | 'on_needs_you'): Promise<{ code: number; output: string }> {
    const cmd = this.store.config.notifications[event];
    if (!cmd) throw new Error(`notifications.${event} is not set`);
    const env = { PLANESTRO_TITLE: 'planestro', PLANESTRO_MESSAGE: `a test of notifications.${event}`, ...(event === 'on_needs_you' ? { PLANESTRO_ITEM: '', PLANESTRO_KIND: 'test', PLANESTRO_URL: this.linkTo('/') } : {}) };
    const r = await this.ports.proc.run(cmd, { cwd: this.repo, timeoutMs: 30_000, env });
    return { code: r.code, output: `${r.stdout}${r.stderr}`.trim().slice(0, 2000) };
  }

  // ---- scheduling (#404, seam 10): the tick, admission and the timing drivers live in scheduler.ts; one step per item
  // and the session, runner and local-job slots in slots.ts ----
  /** A tick soon (Scheduler.poke). */
  poke(): void { this.scheduler.poke(); }
  /** One scheduling pass, or the one already running and one more after it (Scheduler.tick). */
  tick(): Promise<void> { return this.scheduler.tick(); }
  /** The workflow's queue as admission last read it (#170, Scheduler.ciQueue). */
  get ciQueue(): CiQueue | undefined { return this.scheduler.ciQueue; }
  /** When the queue was last read (Scheduler.ciQueueAt); tests reset it to read again. */
  private get ciQueueAt(): number { return this.scheduler.ciQueueAt; }
  private set ciQueueAt(at: number) { this.scheduler.ciQueueAt = at; }
  /** Park an item until other items or pull requests merge (Scheduler.resumeAfter). */
  resumeAfter(id: string, items: string[], message: string, by: 'user' | 'orchestrator' = 'user', prs: number[] = []): Promise<string> { return this.scheduler.resumeAfter(id, items, message, by, prs); }
  /** Stop waiting without resuming (Scheduler.cancelResumeAfter). */
  cancelResumeAfter(id: string): void { this.scheduler.cancelResumeAfter(id); }
  /** Waited-on pull requests' last known states (Scheduler.waitedPrs). */
  private get waitedPrs(): Map<number, { state?: 'OPEN' | 'MERGED' | 'CLOSED'; at: number; reading?: boolean }> { return this.scheduler.waitedPrs; }
  /** What the concurrency control shows (#330, Slots.slotUsage). */
  slotUsage(): { running: number; waiting: number; runners: Record<string, { running: number; waiting: number }> } { return this.slots.slotUsage(); }
  /** Run a step as the item's job, unless one runs (Slots.runJob). */
  private runJob(id: string, fn: () => Promise<unknown>): void { this.slots.runJob(id, fn); }
  /** Run a step as the item's next job (Slots.queueFollowUp). */
  private queueFollowUp(id: string, fn: () => Promise<unknown>): void { this.slots.queueFollowUp(id, fn); }
  /** The steps queued behind an item's job (Slots.followUps). */
  private get followUps(): Map<string, () => Promise<unknown>> { return this.slots.followUps; }
  /** Agent turns holding a session slot (Slots.sessionTurns); tests set it to fill the slots. */
  private get sessionTurns(): number { return this.slots.sessionTurns; }
  private set sessionTurns(n: number) { this.slots.sessionTurns = n; }
  /** Turns queued for a session slot (Slots.sessionWaiters). */
  private get sessionWaiters(): Array<() => void> { return this.slots.sessionWaiters; }
  /** A turn wins a session slot before its agent starts (Slots.withSessionSlot). */
  private withSessionSlot<T>(id: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> { return this.slots.withSessionSlot(id, fn, signal); }

  sessions(): SessionView[] {
    return [...this.turns.entries()].map(([item, t]) => ({ item, session_id: this.store.getItem(item)?.file.frontmatter.session_id, model: t.model, op: t.waiting ? `${t.phase}: waiting for a ${t.waiting} slot` : t.phase, started_at: t.startedAt, busy: !t.waiting, last_output: t.lastOutput }));
  }
  /** A self-hosted runner on this machine (`heavy_runs.shared_labels`, #218) running or about to run a CI job (#330). */
  async localRunners(): Promise<{ state: 'busy' | 'idle' | 'unknown'; labels: string[]; detail: string[] }> {
    const labels = this.store.config.heavy_runs.shared_labels;
    if (!labels.length) return { state: 'unknown', labels, detail: ['which runners share this machine is not set (heavy_runs.shared_labels)'] };
    const r = await this.readRunners(60_000);
    if (!r) return { state: 'unknown', labels, detail: ['this planestro cannot read runners'] };
    const busy = ciOnSharedHost(r.report, labels);
    return { state: busy.length ? 'busy' : 'idle', labels, detail: busy };
  }


  /** A review nobody has looked at for `review.nudge_after_min` wakes the orchestrator once — to remind, never to approve. */
  private nudgeStaleReviews(): void {
    const after = this.store.config.review.nudge_after_min * 60_000;
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.awaiting !== 'review' || fm.taken_over || fm.op_data?.review_nudged || Date.now() - new Date(fm.updated_at).getTime() < after) continue;
      this.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), review_nudged: true } } }], 'engine');
      this.wakeOrchestrator('review_pending', item.id, { waiting_min: Math.round((Date.now() - new Date(fm.updated_at).getTime()) / 60_000) });
    }
  }




  /** Carry an idle item on from where it stands: committed work goes to its pull request, otherwise the session resumes. `from` says who found it idle, and why. */
  private async carryOnStalled(id: string, from: { why: string; who: string; say: string } = { why: 'stalled', who: 'planestro (it found this item idle)', say: 'Nothing was driving this item: your last turn ended without finishing the step. Check your worktree and continue where you left off.' }): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const dir = fm.worktree ? this.absWorktree(fm.worktree) : undefined;
    const exists = dir ? (await this.ports.git.worktreeList(this.repo)).some((w) => w.path === dir && !w.prunable) : false;
    // A missing worktree is triage's to judge (recreate_worktree, or retry_op's requeue), not a stall's.
    if (!exists) { this.block(id, 'worktree_missing', `${from.why} with its worktree ${fm.worktree ?? '(none)'} missing; nothing recreated`); return; }
    if (fm.status === 'IN_PROGRESS') {
      const { clean } = await this.worktreeDirt(dir!);
      const base = this.store.derived(item).base_branch;
      const ahead = clean && base ? (await this.ports.git.aheadBehind(dir!, `origin/${base}`, 'HEAD')).ahead : 0;
      if (ahead > 0) { await this.afterWorkTurn(id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done: String(fm.op_data?.done_summary ?? '') || undefined }); return; }
    }
    const phase = this.phaseFor(fm.status)!;
    await this.runTurnFor(id, phase, from.say, [], [], { fresh: 'auto', note: from.who, carryOn: true });
  }

  /**
   * An IN_PROGRESS worker item that is agent_blocked yet carries a done_summary finished after its
   * block (report_blocked drops any earlier summary), but nothing cleared the flag, so no turn end
   * ever ran the done check. Clear it and run that check: clean tree + commits ahead → pull request.
   */
  private driveStaleBlocks(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.status !== 'IN_PROGRESS' || !fm.blocked || fm.blocked_reason !== 'agent_blocked' || (fm.awaiting && fm.awaiting !== 'user')) continue;
      const done = fm.op_data?.done_summary as string | undefined;
      if (!done || !fm.worktree || fm.taken_over || this.store.derived(item).flavor !== 'worker' || this.jobs.has(item.id) || this.turns.has(item.id)) continue;
      this.store.mutateItem(item.id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: 'app', text: 'cleared a stale agent_blocked flag (the session reported done after it); checking the work' } }], 'engine', { commit: `${item.id}: clear stale block` });
      this.runJob(item.id, () => this.afterWorkTurn(item.id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done }));
    }
  }

  // ---- plan approval delegated to the orchestrator ----
  /** The item opted in, the project allows it, and there is an orchestrator to ask. Never an epic's breakdown. */
  private planDelegated(fm: { kind?: string; auto_approve_plan?: boolean; implementer?: string }): boolean {
    // A paid-tool model's plan carries a budget a person approves (#157): never delegated.
    if (findModel(this.store.config, fm.implementer)?.user_approves_plans) return false;
    return Boolean(fm.auto_approve_plan) && fm.kind !== 'epic' && this.store.config.orchestrator.may_approve_plans && this.orchestrator.enabled;
  }

  /**
   * A delegated plan is parked on the orchestrator (`awaiting: orchestrator`, which is not "needs
   * you"), and nothing about that may depend on memory: the wake queue does not survive a restart,
   * the box can be ticked after the plan arrived, and it can be unticked while the review runs.
   */
  private drivePlanReviews(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.status !== 'PLAN_READY' || fm.blocked || fm.taken_over || fm.awaiting_data?.kind === 'permission') continue;
      if (fm.awaiting === 'orchestrator') {
        if (!this.planDelegated(fm)) this.handPlanToUser(item.id, 'its approval is no longer delegated to the orchestrator');
        else if (!this.orchestrator.reviewing(item.id)) this.wakeOrchestrator('plan_review', item.id);
      } else if (fm.awaiting === 'plan_approval' && this.planDelegated(fm) && !fm.op_data?.plan_handed_back) {
        this.store.mutateItem(item.id, [{ set: { awaiting: 'orchestrator' } }, { activity: { actor: 'app', text: 'plan approval delegated to the orchestrator' } }], 'engine', { commit: `${item.id}: delegate plan approval` });
        this.wakeOrchestrator('plan_review', item.id);
      }
    }
  }

  // ---- permission requests delegated to the orchestrator ----
  /** A project-wide choice: the hard deny rules have already run by the time anything is asked. */
  private permissionsDelegated(): boolean { return this.store.config.orchestrator.may_decide_permissions && this.orchestrator.enabled; }

  /** Same shape as plan reviews: nothing here may depend on a wake queue that a restart empties, or on a setting that can change while a request waits. */
  private drivePermissionReviews(): void {
    for (const item of this.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.blocked || fm.taken_over || !this.phaseFor(fm.status)) continue;
      if (fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission') {
        if (!this.permissionsDelegated()) this.handPermissionToUser(item.id, 'permission requests are no longer delegated to the orchestrator');
        else if (!this.orchestrator.reviewing(item.id)) this.wakeOrchestrator('permission_request', item.id);
      } else if (fm.awaiting === 'permission' && this.permissionsDelegated() && !fm.awaiting_data?.handed_back && this.mayAskOrchestrator(fm)) {
        this.store.mutateItem(item.id, [{ set: { awaiting: 'orchestrator', awaiting_data: { ...(fm.awaiting_data ?? {}), kind: 'permission' } } }, { activity: { actor: 'app', text: 'permission request passed to the orchestrator' } }], 'engine', { commit: `${item.id}: delegate permission` });
        this.wakeOrchestrator('permission_request', item.id);
      }
    }
  }

  /** A worker that keeps asking for what the orchestrator keeps refusing is a conversation for a person. */
  private mayAskOrchestrator(fm: { op_data?: Record<string, unknown> }): boolean { return Number(fm.op_data?.orchestrator_denials ?? 0) < MAX_ORCHESTRATOR_DENIALS; }

  private handPermissionToUser(id: string, why: string): void {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.awaiting !== 'orchestrator' || fm.awaiting_data?.kind !== 'permission') return;
    this.store.mutateItem(id, [{ set: { awaiting: 'permission', awaiting_data: { ...fm.awaiting_data, handed_back: true } } }, { activity: { actor: 'app', text: `permission needs your decision: ${why}` } }], 'engine', { commit: `${id}: permission handed to the user` });
    this.note('info', `${id}: permission needs your decision — ${why}`);
  }

  private async orchestratorDecidesPermission(id: string, request: string, decision: 'allow' | 'deny' | 'ask_user', reason: string): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.awaiting !== 'orchestrator' || fm.awaiting_data?.kind !== 'permission') return `nothing to decide: ${id} is not waiting on you for a permission`;
    // #342: a newer park replaced the one judged; its ruling and reason must not land on a command nobody read.
    const park = fm.awaiting_data.park;
    if (typeof park === 'string' && park !== request.trim()) {
      const input = (fm.awaiting_data.input ?? {}) as Record<string, unknown>;
      const what = fm.awaiting_data.tool === 'Bash' ? `\`${String(input.command ?? '').slice(0, 300)}\`` : String(fm.awaiting_data.tool);
      return `not applied: request ${request} is not the one parked on ${id}. The request parked now is ${park}, for ${what}. Judge that one and decide again with its request id.`;
    }
    if (!this.permissionsDelegated()) { this.handPermissionToUser(id, 'permission requests are no longer delegated to the orchestrator'); return 'not permitted: the user decides permission requests'; }
    if (decision === 'ask_user') { this.handPermissionToUser(id, `the orchestrator left it to you: ${reason}`); return 'handed to the user'; }
    const refusal = decision === 'allow' ? permissionGrantRefusal(fm.awaiting_data as unknown as PermissionRequest) : undefined;
    if (refusal) return `not possible: ${refusal} Decide again with deny (and what to do instead) or ask_user.`;
    await this.respond(id, { kind: 'permission', decision, reason }, 'orchestrator');
    return decision === 'allow' ? 'allowed once; the session resumes' : 'denied; the session resumes with your reason';
  }

  /** The decision goes back to the person, once per submitted plan: the flag stops the tick delegating it again. */
  /**
   * Ask the orchestrator to review a plan that came back to the user (#153): its review could not decide (a wake that
   * failed, as every one did while dontAsk refused its tools), and `plan_handed_back` keeps it from being delegated
   * again. The user's word sends it once more. Returns what happened, or why not.
   */
  reviewPlanAgain(id: string): string {
    const item = this.store.requireItem(id); const fm = item.file.frontmatter;
    if (fm.status !== 'PLAN_READY' || fm.awaiting !== 'plan_approval') return `not possible: ${id} has no plan waiting for your approval`;
    if (fm.kind === 'epic') return `not possible: an epic's breakdown is yours to approve`;
    if (findModel(this.store.config, fm.implementer)?.user_approves_plans) return `not possible: ${fm.implementer}'s plans and their MCP budget are yours to approve`;
    if (!this.store.config.orchestrator.may_approve_plans || !this.orchestrator.enabled) return 'not possible: this project does not let the orchestrator approve plans (orchestrator.may_approve_plans)';
    const { plan_handed_back: _spent, ...od } = fm.op_data ?? {};
    this.store.mutateItem(id, [{ set: { auto_approve_plan: true, awaiting: 'orchestrator', op_data: od } }, { activity: { actor: 'user', text: 'asked the orchestrator to review the plan again' } }], 'user', { commit: `${id}: plan review again` });
    this.wakeOrchestrator('plan_review', id);
    return `the orchestrator is reviewing ${id}'s plan`;
  }

  private handPlanToUser(id: string, why: string): void {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.status !== 'PLAN_READY' || fm.awaiting !== 'orchestrator') return;
    this.store.mutateItem(id, [{ set: { awaiting: 'plan_approval', op_data: { ...(fm.op_data ?? {}), plan_handed_back: true } } }, { activity: { actor: 'app', text: `plan needs your approval: ${why}` } }], 'engine', { commit: `${id}: plan approval handed to the user` });
    this.note('info', `${id}: plan needs your approval — ${why}`);
  }

  /** The orchestrator's fixes are bounded: past the limit it may still approve, but it cannot send the plan round again. */
  private async orchestratorRequestsPlanChanges(id: string, message: string): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const used = fm.plan_revisions ?? 0; const max = this.store.config.orchestrator.max_plan_revisions;
    if (used >= max) {
      if (fm.awaiting === 'orchestrator') this.handPlanToUser(id, `the orchestrator still wanted changes after ${used} fix round${used === 1 ? '' : 's'}: ${message}`);
      else this.store.mutateItem(id, [{ activity: { actor: 'orchestrator', text: `would still change the plan (its ${max} fix round${max === 1 ? ' is' : 's are'} used): ${message}` } }], 'orchestrator');
      return `not sent: all ${max} fix rounds for ${id} are used. The user decides this plan now; your feedback is on the item.`;
    }
    await this.rejectPlan(id, message, 'orchestrator');
    return `sent back to planning (fix round ${used + 1} of ${max}); you will review the revised plan`;
  }

  /**
   * "Approve with amendments" (dogfood f7): the stipulation is not left in a note the user misses and
   * the planner never sees. It goes back to the planner as an amendment, outside the fix-round
   * count, and the revised plan comes back to whoever approves it.
   */
  private async orchestratorAmendsPlan(id: string, amendments: string): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.status !== 'PLAN_READY') return `not possible: ${id} is ${fm.status}, not waiting for plan approval`;
    if (!amendments.trim()) return 'not sent: say what to amend';
    await this.rejectPlan(id, amendments.trim(), 'orchestrator', { amend: true });
    return `sent back to be amended; you will review the revised plan${this.planDelegated(fm) ? '' : ' (its approval stays with the user)'}`;
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
    // An item that went to the icebox (or back to the backlog) and is queued again still owns the
    // worktree it made the first time: `git worktree add` over it fails, so pick it up as it is.
    const kept = (await this.ports.git.worktreeList(this.repo)).find((w) => w.path === dir && !w.prunable);
    if (kept && kept.branch !== branch) { this.store.journal.end(opId, id, 'failed', { reason: 'worktree_taken' }); this.block(id, 'worktree_taken', `${worktreeRel} already exists on ${kept.branch ?? 'a detached HEAD'}, not ${branch}; remove it by hand or move it aside`); return; }
    if (kept) this.store.mutateItem(id, [{ activity: { actor: 'app', text: `reusing the worktree this item already has (${worktreeRel}); setup hooks not re-run` } }], 'engine');
    else await this.ports.git.worktreeAdd(this.repo, dir, branch, `origin/${base}`);
    if (kept) this.store.mutateItem(id, [{ set: { op: 'importing', op_started_at: this.now() } }], 'engine');
    else if (!(await this.runSetupHooks(id, dir, opId))) return;
    this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
    this.store.journal.end(opId, id, 'ok');
    await this.runTurnFor(id, 'plan', this.turnRunner.withEpicCheck(id, this.turnRunner.withImplementer(id, this.turnRunner.withDelivered(id, 'plan-item', this.store.renderPrompt('plan-item', this.store.requireItem(id))))), [], [], { opener: true });
  }

  /**
   * `asItem`: the user read a plan that reads as an epic breakdown (epicFlagOf) and approves it as one
   * item anyway, deliberately. Nobody else can: the orchestrator converts it or leaves it to the user.
   * `hold`: the pull request this opens stays out of the merge queue until it is released, for this
   * reason (#97). A plan that states a hold (holdShapeOf) is held when the orchestrator approves it,
   * with or without the argument; the user chooses, and approving without it is on the record.
   * `syncFirst` (the default, #217): the branch is synced with its base before the implement turn starts.
   */
  async approvePlan(id: string, notes?: string, by: 'user' | 'orchestrator' = 'user', { asItem = false, hold, mcpBudget, syncFirst = true }: { asItem?: boolean; hold?: string; mcpBudget?: number; syncFirst?: boolean } = {}): Promise<void> {
    const item = this.store.requireItem(id);
    const impl = findModel(this.store.config, item.file.frontmatter.implementer);
    if (impl?.user_approves_plans && by !== 'user') throw new Error(`${id} is implemented by ${impl.label}, whose plans and their MCP budget are the user's to approve`);
    if (mcpBudget !== undefined && by !== 'user') throw new Error('an MCP budget is set by the user');
    if (item.file.frontmatter.kind === 'epic') { if (by !== 'user') throw new Error(`${id} is an epic: its breakdown is the user's to approve`); await this.epics.approveBreakdown(id); return; }
    if (item.file.frontmatter.status !== 'PLAN_READY') throw new Error(`${id} is ${item.file.frontmatter.status}, not PLAN_READY`);
    // An epic approved as an item goes to one implementer, who has to stop and ask (#69, HH-198).
    const epicShaped = epicFlagOf(item.file.frontmatter);
    if (epicShaped && !(asItem && by === 'user')) throw new Error(`${id} is not approved: ${epicShaped.reason}, so it is an epic, not one item. Convert it to an epic (its plan becomes the breakdown request)${by === 'user' ? ', request plan changes, or approve it as one item deliberately' : ' or leave it to the user'}.`);
    // LM-22's plan said its PR stays held, and nothing held it (#97). Read from the plan as it stands, not from when it was handed in.
    const stated = holdShapeOf(getSection(item.file, 'Plan'));
    const holdFor = hold?.trim() || (by === 'orchestrator' ? stated?.reason : undefined);
    const waived = Boolean(stated && !holdFor && !item.file.frontmatter.skip_merge);
    const { plan_handed_back: _spent, plan_amended: _folded, looks_like_epic: _overruled, hold_waived: _earlier, ...opData } = item.file.frontmatter.op_data ?? {};
    this.store.mutateItem(id, [
      { transition: { to: 'IN_PROGRESS', actor: by } },
      { set: { op_data: { ...opData, approval_notes: notes ?? '', ...(waived ? { hold_waived: true } : {}) } } },
      ...(mcpBudget !== undefined ? [{ set: { mcp_budget: mcpBudget } } as ItemOp, { activity: { actor: 'user' as const, text: `MCP budget approved: ${mcpBudget} call${mcpBudget === 1 ? '' : 's'} to ${impl?.mcp.join(', ') || 'its MCP servers'}` } }] : []),
      ...(holdFor ? this.holdOps(holdFor, by) : []),
      ...(waived ? [{ activity: { actor: by, text: `approved without the hold its plan states: "${stated!.quote}"` } }] : []),
      ...(epicShaped ? [{ activity: { actor: by, text: `approved as one item although ${epicShaped.reason}` } }] : []),
      ...(by === 'orchestrator' ? [{ activity: { actor: by, text: `approved the plan on your behalf${notes ? `: ${notes}` : ''}` } }] : notes ? [{ activity: { actor: by, text: `approval notes: ${notes}` } }] : []),
    ], by, { commit: `${id}: approve plan${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    // queued, not dropped: the orchestrator can decide while the planner's turn is still ending
    this.queueTurn(id, 'implement', this.turnRunner.withLoopNote(id, this.turnRunner.withHoldNote(id, this.turnRunner.withDelivered(id, 'implement-plan', this.store.renderPrompt('implement-plan', this.store.requireItem(id), { approval_notes: notes?.trim() || '(none)' })))), [], [], { opener: true, ...(syncFirst ? { syncFirst: true } : {}) });
  }

  async rejectPlan(id: string, message: string, by: 'user' | 'orchestrator' = 'user', { amend = false }: { amend?: boolean } = {}): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.status !== 'PLAN_READY') throw new Error(`${id} is ${fm.status}, not PLAN_READY`);
    const round = (fm.plan_revisions ?? 0) + 1;
    const counted = by === 'orchestrator' && !amend;   // an amendment is a stipulation the orchestrator accepts with, not one of its fix rounds
    const { plan_amended: _old, ...opData } = fm.op_data ?? {};
    this.clearSupersededStop(id);
    this.store.mutateItem(id, [
      { transition: { to: 'PLAN_IN_PROGRESS', actor: by } },
      ...(counted ? [{ set: { plan_revisions: round } } as ItemOp] : []),
      { set: { op_data: amend ? { ...opData, plan_amended: message } : opData } },
      { activity: { actor: by, text: amend ? `plan sent back to be amended: ${message}` : counted ? `plan changes requested (fix round ${round} of ${this.store.config.orchestrator.max_plan_revisions}): ${message}` : `plan changes requested: ${message}` } },
    ], by, { commit: `${id}: ${amend ? 'amend plan' : 'request plan changes'}${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    const tool = item.file.frontmatter.kind === 'epic' ? 'submit_breakdown' : 'submit_plan';
    const ask = amend
      ? `The orchestrator approves your plan with these amendments. Fold them into the plan (do not just append them) and submit the whole plan again with the ${tool} tool, then end your turn:\n\n${message}`
      : `Changes requested on your plan:\n\n${message}\n\nRevise it accordingly and submit it again with the ${tool} tool, then end your turn.`;
    this.queueTurn(id, 'plan', `${this.resumeNote(id, 'your plan review')}\n\n${ask}`, [], [], { clearsStop: true });
  }

  /**
   * A plan sent back for revision answers any stop its plan's last turn left (#359, HH-534: a token cap after submit_plan
   * blocked turn_error while the amended turn was queued behind it, and that turn then ran blocked, in triage, with the old
   * turn's wake handing it to the user). The block, its triage and its card go, and so does the wake waiting on the old
   * turn. Done when the plan is sent back and again when its turn starts, since the old turn may end after the first.
   */
  private clearSupersededStop(id: string): void {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (!fm.blocked) return;
    this.slots.pendingWakes.delete(id);
    const stale = ['blocked', 'blocked_reason', ...(fm.triage ? ['triage'] : []), ...(fm.awaiting === 'user' ? ['awaiting', 'awaiting_data'] : [])];
    this.store.mutateItem(id, [{ unset: stale }, { activity: { actor: 'app', text: `the earlier stop (${fm.blocked_reason}) is cleared: the plan's revision turn answers it` } }], 'engine', { commit: `${id}: stop cleared by the plan's revision` });
  }

  async message(id: string, text: string, by: 'user' | 'orchestrator' = 'user'): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) throw new Error(`${id} has no session to message in status ${fm.status}`);
    if (fm.taken_over) throw new Error(`${id} is yours (taken over): hand it back before messaging its session`);
    // Past its breakdown an epic has no session and no worktree: its children do the work. The user's
    // word goes to the orchestrator, which instructs them; resuming a session there blocked the epic
    // with engine_error on every message (HH-256, HH-259).
    if (fm.kind === 'epic' && phase !== 'plan') {
      // Unless a session of its own is running (its merge worktree's, or a one-shot conflict session): the word is
      // queued for that session like any item's, and the orchestrator is told the user's (#210, HH-375: a "stop" was lost).
      const live = this.turns.get(id);
      if (live) {
        const what = live.oneShot ?? 'session';
        const pending = [...((fm.op_data?.pending_messages as string[] | undefined) ?? []), text];
        this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: pending } } }, { activity: { actor: by, text: `message queued for its running ${what}: ${text}` } }], by, { commit: `${id}: message` });
        if (by === 'user') this.wakeOrchestrator('epic_message', id, { message: text, queued_for: `its running ${what}` });
        return;
      }
      if (by === 'orchestrator') throw new Error(`epic ${id} has no session past its breakdown; message its children (${this.store.derived(item).children.join(', ') || 'none yet'}) or annotate_item the epic`);
      this.store.mutateItem(id, [{ activity: { actor: 'user', text: `message: ${text}` } }, { activity: { actor: 'app', text: 'an epic has no session of its own past its breakdown: passed to the orchestrator for its children' } }], 'user', { commit: `${id}: message` });
      this.wakeOrchestrator('epic_message', id, { message: text });
      return;
    }
    if (this.turns.has(id) || this.jobs.has(id) || fm.op_data?.pending_turn) {
      const pending = [...((fm.op_data?.pending_messages as string[] | undefined) ?? []), text];
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: pending } } }, { activity: { actor: 'user', text: `message queued: ${text}` } }], 'user');
      return;
    }
    // A session parked on its question (or a permission) takes the message with the answer (#128, HH-259): a designer
    // decision that changes the brief is not held back until someone answers, and does not wake it a second time.
    const parked = fm.awaiting === 'question' || fm.awaiting === 'permission' || fm.awaiting === 'audition' || (fm.awaiting === 'orchestrator' && ['question', 'permission'].includes(String(fm.awaiting_data?.kind ?? '')));
    if (parked) {
      const pending = [...((fm.op_data?.pending_messages as string[] | undefined) ?? []), text];
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: pending } } }, { activity: { actor: by === 'orchestrator' ? 'orchestrator' : 'user', text: `message queued: ${text} (it reaches the session with the answer to its ${fm.awaiting === 'question' || fm.awaiting_data?.kind === 'question' ? 'question' : fm.awaiting === 'audition' ? 'audition' : 'permission request'})` } }], by === 'orchestrator' ? 'orchestrator' : 'user');
      return;
    }
    if (fm.awaiting && fm.awaiting !== 'user') throw new Error(`${id} is awaiting ${fm.awaiting}; answer that first`);
    // A message that resumes a blocked session is the answer to the block (unblock-with-message
    // by another door). Leaving the flag set made afterTurn skip the finished turn, so a worker
    // that then reported done sat IN_PROGRESS as "blocked" forever and no PR was ever opened.
    this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data', 'triage', ...(fm.blocked ? ['blocked', 'blocked_reason'] : [])] }, { activity: { actor: 'user', text: `message: ${text}` } }], 'user');
    this.runJob(id, () => this.runTurnFor(id, phase, `${this.resumeNote(id, 'a message from the user')}\n\nMessage from the user:\n\n${text}`));
  }

  async respond(id: string, payload: Record<string, unknown>, by: 'user' | 'orchestrator' = 'user'): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const phase = this.phaseFor(fm.status);
    if (!phase) throw new Error(`${id} is not in a session phase`);
    if (fm.taken_over) throw new Error(`${id} is yours (taken over): hand it back first`);
    if (payload.kind === 'question') {
      if (fm.awaiting !== 'question') throw new Error(`${id} is not awaiting a question`);
      const answers = payload.answers as Record<string, string>;
      const text = Object.entries(answers).map(([q, a]) => `- Q: ${q}\n  A: ${a}`).join('\n');
      this.recordAnswer(id, fm, by, 'answered');
      // Messages queued while it waited go with the answer (#128), and leave the queue with it.
      const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
      const also = pending.length ? `\n\nAlso, from the user while you waited (these may change the brief):\n\n${pending.map((m) => `- ${m}`).join('\n')}` : '';
      this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data', 'triage'] }, ...(pending.length ? [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: [] } } } as ItemOp] : []), { activity: { actor: by, text: `answered: ${Object.values(answers).join(' / ')}${pending.length ? ` (with ${pending.length} queued message${pending.length === 1 ? '' : 's'})` : ''}` } }], by, { commit: `${id}: answer questions${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
      this.queueTurn(id, phase, `${this.resumeNote(id, 'your questions')}\n\nAnswers to your questions:\n\n${text}${also}\n\nContinue.`);
      return;
    }
    if (payload.kind === 'audition') {
      // Listening and choosing is the designer's call (#207): nobody answers an audition for them.
      if (by !== 'user') throw new Error('only the user picks the takes of an audition');
      if (fm.awaiting !== 'audition') throw new Error(`${id} is not waiting on an audition`);
      const audition = Audition.parse(fm.awaiting_data?.audition);
      const picks = AuditionPicks.parse(payload.picks ?? {});
      const problem = auditionPicksProblem(audition, picks);
      if (problem) throw new Error(problem);
      const lines = auditionPickLines(audition, picks);
      this.recordAnswer(id, fm, by, 'picked');
      const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
      const also = pending.length ? `\n\nAlso, from the user while you waited (these may change the brief):\n\n${pending.map((m) => `- ${m}`).join('\n')}` : '';
      const cur = this.store.requireItem(id);
      const notes = getSection(cur.file, 'Notes');
      const note = auditionNote(audition, picks);
      this.store.mutateItem(id, [
        { unset: ['awaiting', 'awaiting_data', 'triage'] },
        ...(pending.length ? [{ set: { op_data: { ...(cur.file.frontmatter.op_data ?? {}), pending_messages: [] } } } as ItemOp] : []),
        { section: 'Notes', body: notes ? `${notes}\n\n${note}` : note },
        { activity: { actor: by, text: `audition picked: ${lines.join('; ').slice(0, 600)}${pending.length ? ` (with ${pending.length} queued message${pending.length === 1 ? '' : 's'})` : ''}` } },
      ], by, { commit: `${id}: audition picks` });
      this.queueTurn(id, phase, `${this.resumeNote(id, 'your audition')}\n\nAudition picks from the user (${audition.title}):\n\n${lines.join('\n')}${also}\n\n${auditionComplete(audition, picks) ? 'Every role has its takes: build on the kept ones.' : 'For each role marked regenerate, make new takes from the note, about 2–3× as many as it still needs, and call request_audition again with every role: its kept takes in `kept`, only the new ones in `takes`.'} Continue.`);
      return;
    }
    if (payload.kind === 'permission') {
      // The user may always decide, including while the orchestrator is still looking at it.
      if (fm.awaiting !== 'permission' && !(fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission')) throw new Error(`${id} is not awaiting a permission decision`);
      const req = fm.awaiting_data as unknown as PermissionRequest;
      const decision = payload.decision as 'allow' | 'always' | 'deny';
      if (!['allow', 'always', 'deny'].includes(decision)) throw new Error('unknown permission decision');
      if (by === 'orchestrator' && decision === 'always') throw new Error('only the user adds allow rules');
      const grantRefusal = permissionGrantRefusal(req, decision);
      if (decision !== 'deny' && grantRefusal) throw new Error(grantRefusal);
      const native = decision === 'allow' ? commandGrant(req) : undefined;
      if (native) {
        const model = this.store.config.models.find((m) => m.id === (phase === 'plan' ? fm.planner : fm.implementer));
        if (!fm.worktree || native.cwd !== this.absWorktree(fm.worktree) || !model || modelCapabilities(model).transport !== 'app-server') throw new Error('This command no longer matches the item worktree or app-server runner; request it again in the current session.');
        const policy = makePolicy(this.store.config, this.store.derived(item).base_branch!, native.cwd, {}, this.store.permissionRules());
        for (const command of commandForms(native.command)) {
          const why = policy.deny({ tool: 'Bash', input: { command } });
          if (why) throw new Error(why);
        }
      }
      const rule = ruleFor(req);
      const who = by === 'orchestrator' ? 'The orchestrator' : 'The user';
      const ops: ItemOp[] = [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: by, text: `permission ${decision}${by === 'orchestrator' && payload.reason ? ` (${String(payload.reason).slice(0, 300)})` : ''}: ${(native ? `${rule} ${native.command}` : rule).slice(0, 400)}` } }];
      // Consecutive denials (#95): any approval, the user's included, means the worker adapted, and the item's requests go back to the
      // orchestrator. Counted for the item's life, HH-253's three reasonable denials sent every later request to the designer's phone.
      if (by === 'orchestrator' && decision === 'deny') ops.push({ set: { op_data: { ...(fm.op_data ?? {}), orchestrator_denials: Number(fm.op_data?.orchestrator_denials ?? 0) + 1 } } });
      else if (decision !== 'deny' && Number(fm.op_data?.orchestrator_denials ?? 0) > 0) ops.push({ set: { op_data: { ...(fm.op_data ?? {}), orchestrator_denials: 0 } } });
      if (decision === 'always' && !this.store.config.permissions.allow.includes(rule)) this.store.updateConfig((doc) => { doc.setIn(['permissions', 'allow'], [...this.store.config.permissions.allow, rule]); }, `config: always allow ${rule.slice(0, 60)}`);
      this.store.mutateItem(id, ops, by, { commit: `${id}: permission ${decision}${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
      this.recordAnswer(id, fm, by, decision, { tool: req.tool, ...(req.tool === 'Bash' || native ? answeredCommand(String(req.input.command ?? '')) : {}), ...(payload.reason ? { reason: String(payload.reason).slice(0, 1000) } : {}) });   // after: those ops write op_data from the snapshot, which would drop the resume tag
      const msg = `${this.resumeNote(id, 'a permission decision')}\n\n${rulingText(req, decision, who, payload.reason ? String(payload.reason) : undefined)}`;
      // A chained/heredoc command can't be expressed as a matchable allow rule (the SDK's
      // matcher and segment matching both refuse it), so an approval is also carried into the
      // turn as a one-shot exact-command pass (consumed on first use).
      const oneShot = decision !== 'deny' && req.tool === 'Bash' ? [String(req.input.command ?? '')] : [];
      // queued, not dropped: the orchestrator can answer while the turn that asked is still ending
      this.queueTurn(id, phase, msg, decision === 'deny' || native ? [] : [rule], oneShot, { ruling: true, ...(native ? { commandGrant: native } : {}) });
      return;
    }
    throw new Error(`unknown response kind ${String(payload.kind)}`);
  }

  /** A park begins (#108): journaled with what was asked, its kind of command and who it went to. Returns its id. */
  private recordPark(id: string, kind: 'permission' | 'question' | 'audition', what: string, asked: 'user' | 'orchestrator'): string {
    const park = `park-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const shape = kind === 'permission' ? commandShape(what) : undefined;
    this.store.journal.append({ type: 'permission.parked', item: id, actor: 'engine', data: { park, kind, what: what.slice(0, 300), ...(shape ? { shape } : {}), asked } });
    return park;
  }

  /** A park is answered (#108): who, how, after how long; the turn it resumes is tagged with it (runTurnFor). */
  private recordAnswer(id: string, fm: ItemFrontmatter, by: string, decision: string, request: Record<string, unknown> = {}): void {
    const park = typeof fm.awaiting_data?.park === 'string' ? fm.awaiting_data.park : undefined;
    if (!park) return;
    const since = Date.parse(String(fm.awaiting_data?.requested_at ?? ''));
    this.store.journal.append({ type: 'permission.answered', item: id, actor: by, data: { park, by, decision, waited_ms: Number.isFinite(since) ? Math.max(0, Date.now() - since) : 0, ...request } });
    this.store.mutateItem(id, [{ set: { op_data: { ...(this.store.requireItem(id).file.frontmatter.op_data ?? {}), resume_park: park } } }], 'engine');
  }

  private phaseFor(status: Status): TurnPhase | null {
    if (status === 'PLAN_IN_PROGRESS' || status === 'PLAN_READY') return 'plan';
    if (status === 'IN_PROGRESS') return 'implement';
    if (status === 'IN_REVIEW') return 'fix';
    return null;
  }

  /**
   * The phase a session of this item could be resumed in, or null when it has none. An epic's only session is its
   * planner's, in the read-only planning checkout: once approved it has no worktree and nothing to resume (#439, HH-574).
   */
  private sessionPhaseOf(fm: { kind?: string; status: Status }): TurnPhase | null {
    if (fm.kind === 'epic' && fm.status !== 'PLAN_IN_PROGRESS' && fm.status !== 'PLAN_READY') return null;
    return this.phaseFor(fm.status);
  }

  private resumeNote(id: string, reason: string): string {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const parkedAt = (fm.awaiting_data?.requested_at as string | undefined) ?? fm.updated_at;
    const mins = Math.max(0, Math.round((Date.parse(this.now()) - Date.parse(parkedAt)) / 60_000));
    try { return this.store.renderPrompt('resume-context', item, { resume_reason: reason, parked_for: `${mins} min` }); }
    catch { return `[planestro] Your session was parked while waiting on ${reason} and has now been resumed.`; }
  }

  /** What resuming this item's conversation on `model` costs now; a conversation never quoted borrows the rate last quoted for its model. */
  private resumeEstimateFor(fm: { session_id?: string; session_context?: SessionContext }, model?: string): ResumeEstimate | undefined {
    return resumeEstimate(fm, { now: new Date(Date.parse(this.now())), model, rates: resumeRates(this.store.listItems().map((i) => i.file.frontmatter.session_context)) });
  }

  // ---- turns (#404, seam 9): running one turn and its accounting live in turnRunner.ts; saved instructions, queued
  // messages and restart recovery in turnQueue.ts ----
  /** Save the instruction, then run it as the item's next job (TurnQueue.queueTurn). */
  private queueTurn(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[] = [], oneShotCommands: string[] = [], opts: TurnOpts = {}): void { this.turnQueue.queueTurn(id, phase, prompt, extraAllowed, oneShotCommands, opts); }
  /** The instruction for the item's next turn, persisted (TurnQueue.savePendingTurn). */
  private savePendingTurn(id: string, turn: PendingTurn): void { this.turnQueue.savePendingTurn(id, turn); }
  /** Saved instructions their provider and account now allow (TurnQueue.drivePendingTurns). */
  private drivePendingTurns(): void { this.turnQueue.drivePendingTurns(); }
  /** What a restart interrupted, resumed from persisted state (TurnQueue.resumeInterrupted). */
  private resumeInterrupted(): Promise<void> { return this.turnQueue.resumeInterrupted(); }
  /** One turn of the item's session (TurnRunner.runTurnFor). */
  private runTurnFor(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[] = [], oneShotCommands: string[] = [], opts: TurnOpts = {}, queued?: PendingTurn): Promise<TurnResult | undefined> { return this.turnRunner.runTurnFor(id, phase, prompt, extraAllowed, oneShotCommands, opts, queued); }
  /** A report that never reached planestro, applied from the turn's record (TurnRunner.ingestOutbox). */
  private ingestOutbox(id: string, result: TurnResult): Promise<void> { return this.turnRunner.ingestOutbox(id, result); }


  private async afterTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void> {
    let fm = this.store.requireItem(id).file.frontmatter;
    // A permission request followed by report_done/submit_plan in the same turn is stale:
    // the worker proceeded without it. Clear it instead of stalling on a moot prompt. Not while the
    // tree is dirty and nobody commits for it: then the request (often the `rm` of stray files) is
    // what cleans it, and clearing it judged the tree before it could run (dogfood p54, HH-222).
    const pendingPermission = fm.awaiting === 'permission' || (fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission');
    const neededToClean = pendingPermission && result.done && phase !== 'plan' && fm.worktree && !this.commitsFor(fm) && !(await this.worktreeDirt(this.absWorktree(fm.worktree))).clean;
    if (pendingPermission && (result.done || result.planSubmitted) && !neededToClean) {
      this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { activity: { actor: 'app', text: 'cleared a stale permission request (the turn finished its work without it)' } }], 'engine');
      fm = this.store.requireItem(id).file.frontmatter;
    }
    // Same for an agent_blocked flag the worker outlived: it was resumed, did not block again this
    // turn and reported done. Whatever door resumed it, the block is answered.
    if (fm.blocked && fm.blocked_reason === 'agent_blocked' && result.done && !result.blocked) {
      this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: 'app', text: 'cleared a stale agent_blocked flag (the resumed session reported done)' } }], 'engine');
      fm = this.store.requireItem(id).file.frontmatter;
    }
    // A rebase planestro left stopped for the session (HH-532) is judged before anything reads the tree:
    // mid-rebase, a commit for the session or a dirty-tree reminder would be part of the rebase.
    if (fm.op_data?.rebase_continue && await this.baseSync.continueHeldRebase(id, result)) return;
    // A model whose commits are planestro's (dogfood p11: its sandbox sometimes cannot write git's
    // lock) blocked with work in the tree: planestro commits it, whatever the block says (#55). A
    // block about git or committing is then answered, so it is cleared and the session resumed to
    // say so; any other block stands, and whoever looks at it finds the work committed.
    if (fm.blocked && fm.blocked_reason === 'agent_blocked' && result.blocked && phase !== 'plan' && this.commitsFor(fm) && fm.worktree) {
      const aboutGit = GIT_REFUSAL.test(result.blocked) || ASKS_COMMIT.test(result.blocked);
      const head = await this.commitForWorker(id, aboutGit ? `work committed by planestro: the session could not write git (${result.blocked.slice(0, 120)})` : result.blocked);
      if (head && aboutGit) {
        this.slots.pendingWakes.delete(id);
        this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, { activity: { actor: 'app', text: `the session blocked on committing its work; planestro committed it (${head.slice(0, 7)}) and resumes it` } }], 'engine', { commit: `${id}: committed for the session` });
        await this.runTurnFor(id, phase, `${this.resumeNote(id, 'planestro')}\n\nYour work is committed now (${head.slice(0, 7)}): planestro commits for you when your sandbox cannot write git. Do not try git again. If the work is complete, report done; otherwise carry on and report done when it is.`);
        return;
      }
      if (head) this.store.mutateItem(id, [{ activity: { actor: 'app', text: `committed the session's work (${head.slice(0, 7)}) before its block, so nothing is left only in the tree (engine_commits); the block stands` } }], 'engine', { commit: `${id}: committed for the session` });
    }
    if (fm.awaiting || fm.blocked) return;                       // parked or agent-blocked: nothing to drive
    // This turn parked and was answered before it had finished ending (the orchestrator can be
    // that quick): the answer's turn is queued behind this one, and it, not this, decides what is done.
    if ((result.parked || result.requeued) && !result.done && !result.planSubmitted) return;
    const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
    if (pending.length) {
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), pending_messages: [] } } }], 'engine');
      await this.runTurnFor(id, phase, `Messages from the user while you were working:\n\n${pending.map((m) => `- ${m}`).join('\n')}`);
      return;
    }
    if (phase === 'plan') {
      if (fm.status !== 'PLAN_IN_PROGRESS' || result.planSubmitted) return;
      // A planning turn without a plan is asked for one, once, before anyone is woken (dogfood p18,
      // p35, p41): the hand-in was lost in transport (sdk-notes gotcha 11), the turn hit its cap
      // while still researching, or the model simply stopped. Only a second miss is a block.
      const tool = fm.kind === 'epic' ? 'submit_breakdown' : 'submit_plan';
      const failed = result.toolFailures?.find((f) => f.tool === 'submit_plan' || f.tool === 'submit_breakdown');
      const capped = ['error_max_budget_usd', 'token_cap'].includes(result.subtype);
      const cap = result.subtype === 'token_cap' ? `${this.store.config.budget_tokens_per_plan_turn} tokens` : `$${this.store.config.budget_usd_per_plan_turn}`;
      const retried = Number(fm.op_data?.plan_retry_turns ?? 0);
      const why = failed ? `its ${failed.tool} call failed in transport (${failed.error})` : capped ? `it hit the ${cap} planning-turn cap (${result.subtype === 'token_cap' ? 'budget_tokens_per_plan_turn' : 'budget_usd_per_plan_turn'}) while still working` : 'it ended without calling submit_plan';
      if (retried < 1) {
        this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), plan_retry_turns: retried + 1 } } }, { activity: { actor: 'app', text: `no plan yet: ${why}; asking the session for it now` } }], 'engine');
        await this.runTurnFor(id, phase, failed
          ? `Your ${failed.tool} call failed before it reached planestro (${failed.error}); nothing was recorded. This is a transport failure, not a problem with your plan or budget. Call ${failed.tool} again with the same plan, then end your turn.`
          : `Your planning turn ended without a plan: ${why}. Do not research further. Write the plan now from what you already know, as concretely as you can, and put anything still unknown in it as an open question for the user; then call ${tool} and end your turn.`);
        return;
      }
      this.block(id, 'no_plan', `${why}, and again after being asked for the plan${failed ? '; not a budget or plan problem — unblocking resumes the session' : ''}`);
      return;
    }
    await this.afterWorkTurn(id, phase, result);
  }

  /**
   * Why no turn of this phase can be started for the item on what it has left, or undefined when one
   * can (resumed, or fresh). The same choice runTurnFor makes, for a caller that must know before it
   * spends something on the turn. Only Claude turns are paid for in dollars.
   */
  private cannotStart(fm: ItemFrontmatter, phase: TurnPhase, fresh?: true | 'auto'): string | undefined {
    const def = this.store.config.models.find((m) => m.id === (phase === 'plan' ? fm.planner : fm.implementer));
    if (!def) return undefined;
    if (modelCapabilities(def).accounting === 'tokens') return (fm.tokens ?? 0) >= this.budgetOf(fm).tokens ? 'token budget exhausted' : (fm.agent_turns ?? 0) >= this.budgetOf(fm).turns ? 'turn budget exhausted' : undefined;
    const path = chooseTurnPath({ left: this.budgetOf(fm).usd - (fm.cost_usd ?? 0), estimate: fm.session_id ? this.resumeEstimateFor(fm, def.claude_model) : undefined, hasSession: Boolean(fm.session_id), fresh: phase === 'plan' ? undefined : fresh, freshAboveUsd: this.store.config.budget_usd_fresh_above });
    return path.path === 'stop' ? path.why : undefined;
  }

  /** Whether planestro commits for this item's implementer (engine_commits on its model row). */
  private commitsFor(fm: { implementer?: string }): boolean { return Boolean(this.store.config.models.find((m) => m.id === fm.implementer)?.engine_commits); }

  /** Stage and commit the worktree with the worker's own words as the message. Undefined when there was nothing to commit or it failed (said in Activity). */
  private async commitForWorker(id: string, summary: string): Promise<string | undefined> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const cwd = this.absWorktree(fm.worktree!);
    const { clean, byproducts } = await this.worktreeDirt(cwd);
    if (clean) return undefined;
    const label = this.store.config.models.find((m) => m.id === fm.implementer)?.label ?? fm.implementer;
    const first = summary.split('\n')[0].slice(0, 72);
    try { return await this.ports.git.commitAll(cwd, `${id}: ${first}\n\n${summary}\n\nCommitted by planestro for ${label} (engine_commits).`, byproducts); }
    catch (e) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `could not commit the session's work for it: ${(e as Error).message.slice(0, 200)}` } }], 'engine'); return undefined; }
  }

  /**
   * op_data without the dirty-tree reminder count (the same object when there is none). The count is
   * spent per stretch of dirty turns: a clean turn, an unblock, a retry or a hand-back starts it again,
   * or one more turn end re-blocked an item seconds after it was unblocked (dogfood p54, HH-215).
   */
  private static withoutDirtyCount<T extends Record<string, unknown> | undefined>(opData: T): T {
    if (opData?.dirty_tree_turns === undefined) return opData;
    const { dirty_tree_turns: _spent, ...rest } = opData;
    return rest as T;
  }

  /** Deterministic "is it really done": clean tree + commits ahead of the base. */
  private async afterWorkTurn(id: string, phase: TurnPhase, result: TurnResult): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) return; // the person decides what is done now; the hand-back runs this check again
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    let { clean, dirty } = await this.worktreeDirt(cwd);
    // It reported done and left the work uncommitted, and its model's commits are planestro's (p11).
    const summary = result.done ?? (fm.op_data?.done_summary as string | undefined);
    if (!clean && summary && this.commitsFor(fm)) {
      const head = await this.commitForWorker(id, summary);
      if (head) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `committed the session's work for it (${head.slice(0, 7)}, ${dirty.length} file${dirty.length === 1 ? '' : 's'}): its model's commits are planestro's (engine_commits)` } }], 'engine'); ({ clean, dirty } = await this.worktreeDirt(cwd)); }
    }
    // A turn that parked on a permission or question is not judged: its answer's turn, queued
    // behind it, is the one that can clean the tree, so no reminder is spent on it (dogfood p54, HH-222).
    if (!clean && result.parked) return;
    if (!clean) {
      // A reminder the item cannot pay for is not spent (HH-247: it was sent at the instant the budget
      // stopped the item, so it could never act). The stop says which files, for whoever can commit them without a turn.
      const cannot = this.cannotStart(fm, phase, 'auto');
      if (cannot) { this.block(id, 'over_budget', `the worktree has ${dirty.length} uncommitted file${dirty.length === 1 ? '' : 's'} (${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}) and the item cannot pay for a turn to commit them: ${cannot}. Nothing was started. commit_paths commits the ones that belong without a turn; finish_from_worktree (retry_op in review) carries on from there`); return; }
      const tries = Number(fm.op_data?.dirty_tree_turns ?? 0) + 1;
      if (tries > 2) { this.block(id, 'dirty_tree', `the worktree still has uncommitted changes after ${tries - 1} reminders: ${dirty.slice(0, 5).join(', ')}`); return; }
      this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), dirty_tree_turns: tries } } }, { activity: { actor: 'app', text: `worktree dirty after turn (${dirty.length} files); asking the session to commit` } }], 'engine');
      await this.runTurnFor(id, phase, this.store.renderPrompt('commit-dirty-tree', item, { dirty_files: dirty.join('\n') }), [], [], { fresh: 'auto' });
      return;
    }
    const opData = LiveEngine.withoutDirtyCount(fm.op_data);
    if (opData !== fm.op_data) this.store.mutateItem(id, [{ set: { op_data: opData } }], 'engine'); // clean: the next dirty turn gets its reminders afresh
    await this.ports.git.fetch(this.repo);
    const { ahead } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    // A loop item whose turn ended before it was green and before it was done carries on (#171), not to a pull request.
    if (fm.status === 'IN_PROGRESS' && fm.loop && !summary && result.numTurns > 0 && !loopGreen(fm.loop_state)) { await this.carryOnLoop(id, phase); return; }
    if (fm.status === 'IN_PROGRESS') {
      if (ahead === 0) { this.block(id, 'no_commits', 'the session reported done but the branch has no commits ahead of its base'); return; }
      if (await this.blockOversize(id)) return;
      // Only after a turn: retry_op, finish_from_worktree and a restart's carry-on come here with no turn (numTurns 0) and open the PR as they are.
      if (!summary && result.numTurns > 0) {
        // Its report is what the reviewer reads (#99): HH-248 and HH-249 committed and ended without it, so the check tally
        // and the capture paths their approval notes asked for were lost. One short follow-up asks for it, right away while
        // the conversation is warm; then the pull request opens with or without it.
        const cannot = fm.op_data?.report_nudged ? 'asked once already' : this.cannotStart(fm, phase, 'auto');
        if (!cannot) {
          this.store.mutateItem(id, [{ set: { op_data: { ...(this.store.requireItem(id).file.frontmatter.op_data ?? {}), report_nudged: true } } }, { activity: { actor: 'app', text: 'turn ended with commits but without report_done; asking the session for its report before the pull request' } }], 'engine');
          await this.runTurnFor(id, phase, this.reportNudge(fm), [], [], { fresh: 'auto' });
          return;
        }
        // The nudge ended silent too (or could not be paid for): the PR opens, and the orchestrator reads the last message (#196).
        const said = this.finalLine(result);
        this.store.mutateItem(id, [{ activity: { actor: 'app', text: `turn ended with commits but without report_done (${cannot}); proceeding to a pull request. Its last message${said ? `: "${said}"` : ' was empty'}; the orchestrator reads it` } }], 'engine');
        await this.openPr(id, summary, result);
        return;
      }
      await this.openPr(id, summary);
      return;
    }
    if (fm.status === 'IN_REVIEW') {
      if (await this.blockOversize(id)) return;
      const head = await this.ports.git.revParse(cwd, 'HEAD');
      const moved = head !== fm.ci_head_sha;
      const held = Boolean(fm.skip_merge);
      const heldText = this.draftsWhileHeld(id) ? 'held, so it is pushed for review but not merged; its PR is a draft, so CI runs once the hold is released' : 'held, so it is pushed for CI and review but not merged';
      // A turn here that reports nothing is read by the orchestrator (#196): HH-373's worker explained itself twice in its
      // last message after the PR opened, and the line "re-checking" was all anyone saw, for eight hours.
      const silent = this.silentTurn(result);
      const said = silent ? this.finalLine(result) : '';
      this.store.mutateItem(id, [
        { set: { ci_result: 'pending', op_data: { ...(opData ?? {}), needs_session_rebase: false } } },
        { activity: { actor: 'app', text: `${moved ? `session updated the branch (${head.slice(0, 7)}); ${held ? heldText : 're-entering the merge pipeline'}` : 'session finished without changing the branch; re-checking'}${silent ? `. It ended without report_done or report_blocked${said ? `, saying: "${said}"` : ' and said nothing'}; the orchestrator reads its last message` : ''}` } },
      ], 'engine');
      if (silent) this.wakeOrchestrator('turn_ended_silent', id, this.silentTurnData(id, result, moved ? head : undefined));
      this.heldPolledAt.delete(id);
      void this.tick();
    }
  }

  /** A worker turn that ran and ended with no report of its own (#196); a parked turn is waiting, not silent. */
  private silentTurn(result: TurnResult): boolean {
    return result.numTurns > 0 && !result.done && !result.blocked && !result.parked;
  }

  /** The first line of the session's final message, for the Activity log. */
  private finalLine(result: TurnResult): string {
    const line = result.text.trim().split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    return line.length > 200 ? `${line.slice(0, 199)}…` : line;
  }

  /** What the orchestrator needs to act on a silent turn without opening its transcript (#196). */
  private silentTurnData(id: string, result: TurnResult, movedTo: string | undefined, opened?: number): Record<string, unknown> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const text = result.text.trim();
    return {
      final_message: text ? (text.length > 1800 ? `${text.slice(0, 1800)}…` : text) : '(none: the turn ended with no text)',
      branch: movedTo ? `moved to ${movedTo.slice(0, 7)}` : 'unchanged',
      hold: fm.skip_merge ? (heldReasonOf(fm) ?? 'held (no reason given)') : 'none',
      ci: `${fm.ci_result ?? '—'}${fm.ci_head_sha ? ` (last run read for ${fm.ci_head_sha.slice(0, 7)})` : ''}`,
      policy: `The worker's turn ended without report_done or report_blocked${opened ? `, even after it was asked for its report; planestro opened PR #${opened} anyway` : ''}. Its final message above is what it said. If it reports a problem, a question or something it could not do, act on it: message_session with what it needs, unblock or retry what stopped, or leave the user one decision card. If it says the work is complete and nothing is wrong, there is nothing to do: end the wake. Do not repeat a message you already sent it.`,
    };
  }

  /**
   * A loop item's turn ended mid-loop (#171): its session is asked to carry on from its last tally. Only on
   * progress: a turn that reported no new iteration since the last carry-on blocks the item (`loop_stalled`),
   * so a session that stops iterating is never resumed forever; the iteration budget bounds the rest.
   */
  private async carryOnLoop(id: string, phase: TurnPhase): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const max = fm.loop!.max_iterations;
    const st = fm.loop_state; const at = st?.iteration ?? 0;
    const tally = st ? `${st.passing}/${st.total} passing` : 'no iteration reported';
    const last = fm.op_data?.loop_carried_at;
    if (typeof last === 'number' && last >= at) { this.block(id, 'loop_stalled', `the turn ended mid-loop again without reporting a new iteration (still at ${at}/${max}, ${tally}). ${await this.loopDiffSummary(id)}`); return; }
    const cannot = this.cannotStart(fm, phase, 'auto');
    if (cannot) { this.block(id, 'loop_stalled', `the turn ended mid-loop (iteration ${at}/${max}, ${tally}) and the item cannot pay for another turn: ${cannot}. ${await this.loopDiffSummary(id)}`); return; }
    this.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), loop_carried_at: at } } }, { activity: { actor: 'app', text: `the turn ended mid-loop (iteration ${at}/${max}, ${tally}); asking the session to carry on` } }], 'engine');
    await this.runTurnFor(id, phase, this.turnRunner.withLoopNote(id, `Your turn ended before the loop was green, and you did not report it done. Carry on from where you are: the next iteration, then report_iteration. ${max - at} iteration${max - at === 1 ? '' : 's'} left. If you cannot get it green, report_blocked with what you learned.`), [], [], { fresh: 'auto' });
  }

  /** The one follow-up for a turn that committed without report_done (#99): the report, and nothing else. */
  private reportNudge(fm: ItemFrontmatter): string {
    const notes = String(fm.op_data?.approval_notes ?? '').trim();
    return [
      'Your work is committed, but you ended your turn without calling report_done, so there is no report for the reviewer.',
      'Call report_done now with your summary: what you changed and why, the result of the checks you ran (the tally), and anything a reviewer should know (choices you made, what you left out).',
      ...(notes ? [`The approval notes asked for this in your report as well:\n${notes.slice(0, 1500)}`] : []),
      'Do not change or commit anything else. Then end your turn.',
    ].join('\n\n');
  }

  /** `silent`: the turn that led here ended without a report, so the wake is that turn's (#196), not a plain pr_opened. */
  private async openPr(id: string, summary?: string, silent?: TurnResult): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: 'not opening a pull request: you have this item (taken over)' } }], 'engine'); return; }
    const cwd = this.absWorktree(fm.worktree!);
    const base = this.store.derived(item).base_branch!;
    const implementer = this.store.config.models.find((m) => m.id === fm.implementer);
    const held = Boolean(implementer?.hold_for_review);
    const holdInto = this.holdIntoReason(base, fm.skip_merge);
    // A PR held for a person opens as a draft: no CI while it waits, one run once it is released (dogfood f6). A hold
    // that waits on the orchestrator or the worker needs a CI verdict, so its PR opens ready (#195).
    const draft = this.store.config.ci.draft_while_held && (held || Boolean(holdInto) || holdWaitsOnPerson(fm));
    const opId = this.store.journal.begin('creating_pr', id, { branch: fm.branch, base });
    this.store.mutateItem(id, [{ set: { op: 'pushing', op_started_at: this.now() } }], 'engine');
    await this.ports.git.pushSetUpstream(cwd, fm.branch!);
    this.store.mutateItem(id, [{ set: { op: 'creating_pr', op_started_at: this.now() } }], 'engine');
    const existing = (await this.ports.gh.prList(this.github, { head: fm.branch!, state: 'open' }))[0];
    if (existing && draft && !existing.isDraft) await this.ports.gh.setDraft(this.github, existing.number, true);
    const pr = existing ? { number: existing.number, url: existing.url } : await this.ports.gh.createPr(this.github, {
      base, head: fm.branch!, title: `${fm.title} (${id})`, draft,
      body: `${summary ?? getSection(item.file, 'Description').slice(0, 1500)}\n\n---\nplanestro item **${id}** · plan:\n\n${getSection(item.file, 'Plan').slice(0, 3000)}${closesLine(fm)}\n\n🤖 Opened by planestro`,
    });
    this.store.mutateItem(id, [
      { transition: { to: 'IN_REVIEW', actor: 'engine' } },
      { set: { pr: pr.number, ci_result: 'pending', ...(held ? { review_hold: true } : {}), ...(draft ? { op_data: { ...(this.store.requireItem(id).file.frontmatter.op_data ?? {}), pr_draft: true } } : {}) } },
      { unset: ['op', 'op_started_at'] },
      { activity: { actor: 'app', text: `opened PR #${pr.number} → ${base} (${pr.url})${draft ? ' as a draft: it is held, so CI waits until the hold is released' : ''}` } },
      ...(held ? [{ activity: { actor: 'app' as const, text: `will wait for your review before merging: ${implementer!.label} is a hold_for_review model` } }] : []),
      ...(holdInto ? this.holdOps(holdInto, 'app') : []),
    ], 'engine', { commit: `${id}: open PR #${pr.number}` });
    this.store.journal.end(opId, id, 'ok', { pr: pr.number });
    this.note('info', `${id}: PR #${pr.number} opened against ${base}`);
    if (silent) this.wakeOrchestrator('turn_ended_silent', id, this.silentTurnData(id, silent, undefined, pr.number));
    else this.wakeOrchestrator('pr_opened', id);
    void this.tick();
  }

  // ---- merge and CI (#404, seam 8): the merge chain and held items live in mergePipeline.ts; CI waits, red runs, rerun_ci,
  // runner stalls and the review-stall wake in ciWatch.ts ----
  /** The serial merge chain's tail (MergePipeline.mergeChain). */
  private get mergeChain(): Promise<void> { return this.mergePipeline.mergeChain; }
  /** One pass through the serial merge chain (MergePipeline.mergeStep). */
  private mergeStep(id: string, opts: { hold?: boolean } = {}): Promise<void> { return this.mergePipeline.mergeStep(id, opts); }
  /** The merge itself, on a head the chain has just seen green on the base tip (MergePipeline.merge). */
  private merge(id: string, opId: string, base: string, headSha: string, baseSha?: string): Promise<void> { return this.mergePipeline.merge(id, opId, base, headSha, baseSha); }
  /** The merge step's one look at CI for a head (MergePipeline.greenFor): replaced here, it is replaced there. */
  private get greenFor(): MergePipeline['greenFor'] { return this.mergePipeline.greenFor; }
  private set greenFor(fn: MergePipeline['greenFor']) { this.mergePipeline.greenFor = fn; }
  /** driveHeld's last look at each held item (MergePipeline.heldPolledAt). */
  private get heldPolledAt(): Map<string, number> { return this.mergePipeline.heldPolledAt; }
  /** Items whose CI wait is polling (CiWatch.ciWaits). */
  private get ciWaits(): Set<string> { return this.ciWatch.ciWaits; }
  /** The CI wait's clock (CiWatch.ciNow): replaced here, it is replaced there. */
  get ciNow(): () => number { return this.ciWatch.ciNow; }
  set ciNow(fn: () => number) { this.ciWatch.ciNow = fn; }
  /** The runner stalls' gathering window (CiWatch.runnerStallGatherMs). */
  get runnerStallGatherMs(): number { return this.ciWatch.runnerStallGatherMs; }
  set runnerStallGatherMs(ms: number) { this.ciWatch.runnerStallGatherMs = ms; }
  /** Items whose CI waits on a runner label that looks stalled or offline (CiWatch.runnerStalls, #216). */
  runnerStalls(): { label: string; items: string[]; since: string; woken: boolean; stalls: RunnerStall[] }[] { return this.ciWatch.runnerStalls(); }
  /** A red CI run for a head (CiWatch.onCiRed). */
  private onCiRed(id: string, opId: string, headSha: string, logText: string | undefined, source: 'github' | 'local', canFix = true): Promise<void> { return this.ciWatch.onCiRed(id, opId, headSha, logText, source, canFix); }
  /** A known flake's one re-run per head (CiWatch.rerunIfFlaky). */
  private rerunIfFlaky(id: string, headSha: string): Promise<number | undefined> { return this.ciWatch.rerunIfFlaky(id, headSha); }
  /** rerun_ci (CiWatch.rerunCi, #139). */
  rerunCi(id: string, by: 'user' | 'orchestrator' = 'user'): Promise<string> { return this.ciWatch.rerunCi(id, by); }

  /** An untracked file `worktrees.byproducts` names: something the project's tools regenerate in any worktree (Godot's `.import` sidecars), never a session's work. */
  private isByproduct(path: string): boolean {
    return this.store.config.worktrees.byproducts.some((p) => matchesGlob(p.includes('/') ? path : basename(path), p));
  }

  /** The worktree's uncommitted work: what `git status` lists, less untracked byproducts (dogfood p52). */
  private async worktreeDirt(cwd: string): Promise<{ clean: boolean; dirty: string[]; byproducts: string[] }> {
    if (!this.store.config.worktrees.byproducts.length) return { ...(await this.ports.git.status(cwd)), byproducts: [] };
    const { tracked, untracked } = await this.ports.git.dirtyDetail(cwd);
    const byproducts = untracked.filter((f) => this.isByproduct(f));
    const dirty = [...tracked, ...untracked.filter((f) => !this.isByproduct(f))];
    return { clean: dirty.length === 0, dirty, byproducts };
  }

  // ---- sync with base (#404, seam 6): an epic waiting on its base (#204) lives in baseSync.ts ----
  /** Epics waiting on their base, looked at once a minute (BaseSync.baseWaitPolledAt). */
  private get baseWaitPolledAt(): Map<string, number> { return this.baseSync.baseWaitPolledAt; }

  /** The runners' state (#216), read at most every 30 s so a fleet of workers asking never hammers the API; undefined when the port cannot tell. */
  private runnerReport?: { report: RunnerReport; at: string };
  private runnersAt = 0;
  /** `maxAgeMs`: what planestro's own background checks accept is older (a read is a call per open run), so a deep queue stays well inside GitHub's rate limit. */
  private async readRunners(maxAgeMs = 30_000): Promise<{ report: RunnerReport; at: string } | undefined> {
    if (!this.ports.gh.runners || !this.store.config.code_repo.github) return undefined;
    if (this.runnerReport && Date.now() - this.runnersAt < maxAgeMs) return this.runnerReport;
    // A read under way is shared: a caller arriving during the first one got "cannot tell", and each started its own.
    if (this.runnersRead) return this.runnersRead;
    this.runnersAt = Date.now();
    const gh = this.ports.gh;
    this.runnersRead = (async () => {
      try { this.runnerReport = { report: await gh.runners!(this.github, this.ciWorkflow), at: this.now() }; } catch (e) { if (!this.runnerReport) throw e; }
      return this.runnerReport;
    })().finally(() => { this.runnersRead = undefined; });
    return this.runnersRead;
  }
  private runnersRead?: Promise<{ report: RunnerReport; at: string } | undefined>;
  /** What the orchestrator's runner_status and a worker's runners_busy answer: read by planestro's own gh, so no session needs a Bash rule for it. */
  async runnerStatus(): Promise<string> {
    if (!this.store.config.code_repo.github) return 'not available: code_repo.github is not configured, so there are no GitHub runners to read';
    try {
      const r = await this.readRunners();
      return r ? runnerStatusText(r.report, this.github, r.at) : 'not available: this planestro cannot read runners';
    } catch (e) { return `not available: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 300)}`; }
  }

  // ---- cleanup and reconcile (#404, seam 4): cleanup, the reconciler and every move-aside live in cleanupReconcile.ts ----
  /** Cross-check persisted state against the world, one pass at a time (CleanupReconcile.reconcile). */
  reconcile(source: 'startup' | 'periodic' | 'manual'): Promise<string[]> { return this.cleanupReconcile.reconcile(source); }
  /** A merged item's worktree and branches, removed on positive evidence (CleanupReconcile.cleanup). */
  private cleanup(id: string): Promise<void> { return this.cleanupReconcile.cleanup(id); }

  // ---- epics (#404, seam 5): planning, breakdown approval, the integration branch and epic PRs live in epics.ts ----
  /** Have an epic's planner propose its children (Epics.planEpic). */
  planEpic(id: string, why?: string): Promise<void> { return this.epics.planEpic(id, why); }
  /** Create the approved children, open the epic and queue what can start (Epics.approveBreakdown). */
  approveBreakdown(id: string, edited?: BreakdownChild[], opts: { queue?: boolean } = {}): Promise<string[]> { return this.epics.approveBreakdown(id, edited, opts); }
  /** Children the user rendered from a list, added to an epic (Epics.addChildren). */
  addChildren(id: string, children: BreakdownChild[], opts: { queue?: boolean } = {}): Promise<string[]> { return this.epics.addChildren(id, children, opts); }
  /** Push the integration branch and open the epic (Epics.openEpic). */
  openEpic(id: string): Promise<void> { return this.epics.openEpic(id); }
  /** Open the epic PR into its base (Epics.submitEpic). */
  submitEpic(id: string): Promise<void> { return this.epics.submitEpic(id); }
  /** The epic page's "Sync with base" (Epics.syncBase). */
  syncBase(id: string): Promise<void> { return this.epics.syncBase(id); }

  // ---- externally driven items (watched) ----
  private lastExternalPoll = 0;
  private async driveExternal(): Promise<void> {
    const externals = this.store.listItems().filter((i) => { const fm = i.file.frontmatter; return this.store.derived(i).flavor === 'external' && (fm.merge_policy ?? 'watch') === 'watch' && !fm.blocked && (fm.status === 'IN_PROGRESS' || fm.status === 'IN_REVIEW'); });
    if (!externals.length || Date.now() - this.lastExternalPoll < 60_000) return;
    this.lastExternalPoll = Date.now();
    for (const item of externals) {
      const fm = item.file.frontmatter;
      try {
        let pr = fm.pr ? await this.ports.gh.prView(this.github, fm.pr) : undefined;
        if (!pr && fm.branch) pr = (await this.ports.gh.prList(this.github, { head: fm.branch, state: 'all' }))[0];
        if (!pr) continue;
        if (fm.status === 'IN_PROGRESS') {
          this.store.mutateItem(item.id, [
            { transition: { to: 'IN_REVIEW', actor: 'engine' } },
            { set: { pr: pr.number, branch: fm.branch ?? pr.headRefName, ci_result: 'pending' } },
            { activity: { actor: 'app', text: `linked PR #${pr.number} (${pr.url})` } },
          ], 'engine', { commit: `${item.id}: link PR #${pr.number}` });
        }
        if (pr.state === 'MERGED' && this.store.requireItem(item.id).file.frontmatter.status === 'IN_REVIEW') {
          this.store.mutateItem(item.id, [
            { transition: { to: 'MERGED', actor: 'engine' } },
            { set: { merged_at: pr.mergedAt ? isoLocal(new Date(pr.mergedAt)) : this.now(), ci_result: 'green' } },
            { activity: { actor: 'app', text: `observed merge of PR #${pr.number} into ${pr.baseRefName}` } },
          ], 'engine', { commit: `${item.id}: merge (observed)` });
          this.announce('on_merge', `${item.id} merged`, `PR #${pr.number} merged into ${pr.baseRefName}: ${item.file.frontmatter.title}`, item.id);
          await this.cleanupReconcile.cleanup(item.id);
        } else if (pr.state === 'CLOSED') {
          await this.blockClosedPr(item.id, pr.number);
        }
      } catch (e) { this.note('warn', `${item.id}: external poll failed: ${(e as Error).message}`); }
    }
  }

  /**
   * A PR closed outside planestro (#205, HH-375): its close event says by whom. A commit that closed it (a closing
   * keyword, "fixes #563", in another PR's merge message) is named on the item, in Notes and in the stop, so nobody
   * takes it for the user's decision; reopening it is the user's (reopenPr). An event that cannot be read says less.
   */
  private async blockClosedPr(id: string, n: number): Promise<void> {
    const by = await this.ports.gh.prClosedBy?.(this.github, n).catch(() => null) ?? null;
    if (by?.commit) {
      const note = `PR #${n} was closed by commit ${by.commit.slice(0, 7)}${by.pr ? ` (merge of #${by.pr})` : ''}: GitHub closing keyword, probably not intended`;
      const cur = this.store.requireItem(id).file.frontmatter;
      const notes = getSection(this.store.requireItem(id).file, 'Notes');
      this.store.mutateItem(id, [
        { section: 'Notes', body: notes ? `${notes}\n\n${note}.` : `${note}.` },
        { set: { op_data: { ...(cur.op_data ?? {}), pr_closed_by: { commit: by.commit, ...(by.pr ? { pr: by.pr } : {}), ...(by.actor ? { actor: by.actor } : {}), ...(by.at ? { at: by.at } : {}) } } } },
      ], 'engine', { commit: `${id}: PR #${n} closed by ${by.commit.slice(0, 7)}` });
      this.block(id, 'pr_closed_externally', `${note}. Nobody decided to close it; only the user reopens it (Reopen and resume)`);
    } else this.block(id, 'pr_closed_externally', `PR #${n} was closed without merging${by?.actor ? `, by @${by.actor}` : ''}`);
  }

  /** What reopenPr would refuse that the store can tell without GitHub: checked when a card offering it is filed. */
  private reopenRefusal(id: string): string | null {
    const fm = this.store.getItem(id)?.file.frontmatter;
    if (!fm) return `there is no item ${id}`;
    if (fm.status !== 'IN_REVIEW' || !fm.pr || fm.blocked_reason !== 'pr_closed_externally') return `${id} has no pull request closed outside planestro`;
    if (fm.taken_over) return `${id} is taken over: the user is finishing it by hand`;
    return this.busyWith(id) ?? null;
  }

  /**
   * Reopen and resume (#205): reopen the item's PR that was closed outside planestro and go back to where it was, waiting
   * for CI on the head it has (an external item is watched again). The user's: reopening is an external write, and the
   * close may have been meant. Nothing is asked of the orchestrator. Returns what happened, or why not, in words.
   */
  async reopenPr(id: string): Promise<string> {
    const refusal = this.reopenRefusal(id);
    if (refusal) return `not possible: ${refusal}`;
    const fm = this.store.requireItem(id).file.frontmatter;
    const n = fm.pr!;
    const pr = await this.ports.gh.prView(this.github, n);
    if (pr.state === 'MERGED') return `not possible: PR #${n} is merged; planestro takes that in by itself`;
    if (pr.state === 'CLOSED') await this.ports.gh.reopenPr(this.github, n);
    const { pr_closed_by: _by, ...od } = fm.op_data ?? {};
    const external = this.store.derived(this.store.requireItem(id)).flavor === 'external';
    const head = pr.headRefOid;
    this.store.mutateItem(id, [
      { unset: ['blocked', 'blocked_reason', 'triage', ...(fm.awaiting === 'user' ? ['awaiting', 'awaiting_data'] : [])] },
      { set: { ci_result: 'pending', op_data: od, ...(external ? {} : { ci_head_sha: head, op: 'awaiting_ci', op_started_at: this.now() }) } },
      { activity: { actor: 'user', text: `reopened PR #${n} and resumed ${external ? 'watching it' : `the CI wait (head ${head.slice(0, 7)})`}` } },
    ], 'user', { commit: `${id}: reopen PR #${n}` });
    this.poke();
    return `reopened PR #${n}; ${external ? 'watching it again' : `waiting for CI on ${head.slice(0, 7)}`}`;
  }

  // ---- helpers ----
  private makeTools(id: string): TurnTools {
    const s = this.store;
    /** A plain item's plan, recorded; `epic` says it reads as an epic breakdown, which approval then refuses (#69, HH-198). */
    const handIn = (plan: string, epic?: EpicFlag): string => {
      const cur = s.requireItem(id).file.frontmatter;
      const ops: ItemOp[] = [{ section: 'Plan', body: plan }];
      // The planner went on without the permission it had asked for: that request is moot, and must not be mistaken for the plan's own wait.
      if (cur.awaiting === 'permission' || cur.awaiting_data?.kind === 'permission') ops.push({ unset: ['awaiting', 'awaiting_data'] });
      // A late submit cures a no_plan block (e.g. after an MCP transport failure ate the first attempt).
      if (cur.blocked && cur.blocked_reason === 'no_plan') ops.push({ unset: ['blocked', 'blocked_reason', 'triage'] });
      const delegated = cur.status === 'PLAN_IN_PROGRESS' && this.planDelegated(cur);
      if (cur.status === 'PLAN_IN_PROGRESS') ops.push({ transition: { to: 'PLAN_READY', actor: 'engine' } });
      // A new plan is a new decision: whoever had it last time, it starts with the orchestrator again if delegated,
      // and whether it reads as an epic is judged again from this plan alone.
      const { plan_handed_back: _spent, plan_retry_turns: _retried, looks_like_epic: _earlier, ...opData } = cur.op_data ?? {};
      if (cur.op_data?.plan_handed_back || cur.op_data?.plan_retry_turns || cur.op_data?.looks_like_epic || epic) ops.push({ set: { op_data: { ...opData, ...(epic ? { looks_like_epic: epic } : {}) } } });
      if (delegated) ops.push({ set: { awaiting: 'orchestrator' } });
      if (epic) ops.push({ activity: { actor: 'app', text: `this reads as an epic, not one item: ${epic.reason}. Approval is refused; convert it to an epic` } });
      const stated = epic ? null : holdShapeOf(plan);
      if (stated) ops.push({ activity: { actor: 'app', text: `its plan states a merge hold: "${stated.quote}". Approving it can hold its pull request` } });
      s.mutateItem(id, ops, 'engine', { commit: `${id}: submit plan` });
      this.note(epic ? 'warn' : 'info', `${id}: plan submitted — ${epic ? `it reads as an epic (${epic.reason}): convert it rather than approve it` : delegated ? 'the orchestrator decides (you asked it to)' : 'needs your approval'}`);
      this.wakeOrchestrator('plan_review', id);
      return epic?.source === 'breakdown'
        ? 'Breakdown recorded by planestro as this item\'s plan, flagged as an epic: the user decides whether to convert it. End your turn now.'
        : 'Plan recorded by planestro. End your turn now; you will be resumed once it is approved.';
    };
    return {
      submit_breakdown: async (plan, children) => {
        const cur = s.requireItem(id).file.frontmatter;
        // A plain item's planner that finds an epic says so with the breakdown itself: the plan is recorded and
        // flagged, so nobody approves it as one item, and the user converts it (#69, HH-198).
        if (cur.kind !== 'epic') {
          if (cur.parent) return `Rejected: this item is a child of epic ${cur.parent}, and epics do not nest. Plan it as one item with submit_plan, or report_blocked if it cannot be one.`;
          const list = (Array.isArray(children) ? children : []).filter((c): c is ProposedChild => typeof c?.title === 'string' && c.title.trim() !== '');
          if (list.length < 2) return 'Rejected: a breakdown needs at least two children, each with a title. If this is one piece of work, hand in your plan with submit_plan.';
          const proposed = list.map((c) => ({ title: c.title.trim(), ...(typeof c.description === 'string' ? { description: c.description.trim() } : {}), ...(typeof c.implementer === 'string' && c.implementer ? { implementer: c.implementer } : {}), ...(Array.isArray(c.depends_on) && c.depends_on.length ? { depends_on: c.depends_on } : {}) }));
          return handIn(plan, { reason: `its planner handed in a breakdown of ${list.length} child items instead of one plan`, source: 'breakdown', children: proposed });
        }
        if (cur.status === 'PLAN_READY' && getSection(s.requireItem(id).file, 'Plan').trim() === demoteH1(plan).trim() && JSON.stringify(cur.awaiting_data?.children) === JSON.stringify(children)) return 'Breakdown already recorded by planestro. End your turn now.';
        const problem = validateBreakdown(children, s.config.models, s.config.categories);
        if (problem) { s.mutateItem(id, [{ activity: { actor: 'app', text: `breakdown rejected back to the planner: ${problem}` } }], 'engine'); return `Rejected: ${problem}. Fix that and call submit_breakdown again.`; }
        const ops: ItemOp[] = [{ section: 'Plan', body: plan }];
        if (cur.blocked && cur.blocked_reason === 'no_plan') ops.push({ unset: ['blocked', 'blocked_reason', 'triage'] });
        if (cur.status === 'PLAN_IN_PROGRESS') ops.push({ transition: { to: 'PLAN_READY', actor: 'engine' } });
        ops.push({ set: { awaiting_data: { children, requested_at: this.now() } } });
        s.mutateItem(id, ops, 'engine', { commit: `${id}: submit breakdown` });
        this.note('info', `${id}: breakdown of ${(children as unknown[]).length} children submitted — needs your approval`);
        return 'Breakdown recorded by planestro. End your turn now; the user will review the children.';
      },
      submit_plan: async (plan) => {
        const cur = s.requireItem(id).file.frontmatter;
        if (cur.kind === 'epic') return 'Rejected: this is an epic. Hand in its children with submit_breakdown.';
        // A retry of a hand-in that did land (the transport failed on the way back): no second commit or review wake.
        if (cur.status === 'PLAN_READY' && getSection(s.requireItem(id).file, 'Plan').trim() === demoteH1(plan).trim()) return 'Plan already recorded by planestro. End your turn now; you will be resumed once it is approved.';
        const shape = epicShapeOf(plan);
        return handIn(plan, shape ? { reason: shape, source: 'plan' } : undefined);
      },
      add_note: async (markdown, attach, flags) => {
        const cur = getSection(s.requireItem(id).file, 'Notes');
        s.mutateItem(id, [{ section: 'Notes', body: cur ? `${cur}\n\n${markdown}` : markdown }], 'engine', { commit: `${id}: worker note` });
        const att = this.workerTools.attachFromWorktree(id, attach);
        const flagged = flags === undefined ? '' : this.workerTools.addReviewFlags(id, flags);
        return `Note recorded.${att ? ` ${att}` : ''}${flagged ? ` ${flagged}` : ''}`;
      },
      append_activity: async (text) => { s.mutateItem(id, [{ activity: { actor: 'worker', text } }], 'engine'); return 'Recorded.'; },
      report_progress: async (parts) => this.recordParts(id, parts) ?? 'Recorded.',
      report_iteration: async (passing, total, note) => this.recordIteration(id, passing, total, note),
      report_done: async (summary, parts, hold, attach, review, flags) => {
        // A loop item is done when it is green, and hands off with its review (#171); before anything is recorded.
        const loopRefusal = this.loopDoneRefusal(id, review);
        if (loopRefusal) return loopRefusal;
        // Debug instrumentation is fenced in markers and gone before the hand-in (#240): refused in words, nothing recorded.
        const marked = await this.debugMarkersLeft(id);
        if (marked) return marked;
        const before = s.requireItem(id).file.frontmatter;
        // A retry of a report that did land (#167): nothing is recorded twice, the loop's review included.
        const repeat = before.op_data?.done_summary === summary && (!hold || before.skip_merge);
        const bad = parts === undefined ? undefined : this.recordParts(id, parts);
        const att = this.workerTools.attachFromWorktree(id, attach);
        const filed = !repeat && this.fileLoopReview(id, review);
        const cur = s.requireItem(id).file.frontmatter;
        if (repeat) return `Already recorded by planestro${bad ? `, but ${bad}` : '.'}${att ? ` ${att}` : ''} End your turn now.`;
        const ops: ItemOp[] = [{ set: { op_data: { ...(cur.op_data ?? {}), done_summary: summary } } }, { activity: { actor: 'worker', text: `done: ${summary.slice(0, 300)}` } }];
        // The hand-off's pictures and flags (#372): what the page shows first, flagged pictures before the rest.
        const handoff = this.workerTools.reviewHandoff(id, flags);
        ops.push(...handoff.ops);
        // The worker that knows its pull request must wait says so (#97). Recorded here, with the done: the pull
        // request is opened from the item as persisted, and no drive path sees the item before this turn ends.
        const asked = typeof hold === 'string' && cur.kind !== 'epic' && (cur.status === 'IN_PROGRESS' || cur.status === 'IN_REVIEW') && !cur.skip_merge ? hold.trim() : '';
        // A loop's hand-off is held for the user's review of what it did, unless the worker named its own hold (#171).
        const loopHold = !asked && filed && cur.status === 'IN_PROGRESS' && !cur.skip_merge && !cur.op_data?.hold_waived ? `loop review: ${cur.loop_state!.passing}/${cur.loop_state!.total} checks green after ${cur.loop_state!.iteration} iteration${cur.loop_state!.iteration === 1 ? '' : 's'}; read the review on the item before releasing it` : '';
        const held = (asked !== '' || loopHold !== '') && !cur.op_data?.hold_waived;
        if (held) ops.push(...this.holdOps(asked || loopHold, asked ? 'worker' : 'app'));
        // A hold the user released, or left out at approval, is not put back by a later turn.
        else if (asked) ops.push({ activity: { actor: 'app', text: `the worker asked for a hold (${asked.slice(0, 200)}); not held: you released this item's hold, or approved its plan without one` } });
        s.mutateItem(id, ops, 'engine', held ? { commit: `${id}: skip merge` } : {});
        if (held) this.note('info', asked ? `${id}: its worker asked for the pull request to be held: ${asked.slice(0, 200)}` : `${id}: its loop is green; the pull request is held for your review`);
        // A hold that asks a person to look at pictures with none attached (#355): said to the worker, never refused.
        const unseen = held && asked && LOOK_AT_PICTURES.test(asked) && !handoff.attached ? ` The hold asks for a look at pictures, but this hand-off attached none: attach the whole set the hold names (\`attach\` on add_note, up to ${ATTACH_PER_CALL} a call), not a sample, before you end your turn.` : '';
        if (unseen) s.mutateItem(id, [{ activity: { actor: 'app', text: 'the hold asks for a look at pictures, but the hand-off attached none; the worker was told' } }], 'engine');
        return `Recorded${filed ? ', with your review filed on the item' : ''}${held ? ': planestro keeps the pull request out of the merge queue until the user releases the hold' : ''}${bad ? `, but ${bad}` : '.'}${att ? ` ${att}` : ''}${handoff.said ? ` ${handoff.said}` : ''}${unseen}${unseen ? '' : ' End your turn now.'}`;
      },
      report_blocked: async (reason, parts) => {
        // A park is a wait, not a block (#168): refused in words while the session waits on a ruling.
        const parked = parkedRefusal(s.requireItem(id).file.frontmatter);
        if (parked) return parked;
        if (parts !== undefined) this.recordParts(id, parts);
        const cur = s.requireItem(id).file.frontmatter;
        // A retry of a block that did land (#167): no second block, triage or wake.
        if (cur.blocked && cur.blocked_reason === 'agent_blocked' && cur.op_data?.blocked_report === reason) return 'Already recorded by planestro. End your turn now; planestro will resume you with the answer.';
        const { done_summary: _withdrawn, ...rest } = cur.op_data ?? {};
        s.mutateItem(id, [{ set: { op_data: { ...rest, blocked_report: reason } } }], 'engine');
        this.block(id, 'agent_blocked', reason, 'user'); return 'Recorded. End your turn now; planestro will resume you with the answer.';
      },
      hand_off: async (to, paths, note) => this.handOff(id, to, paths, note, 'worker'),
      request_audition: async (audition) => this.workerTools.requestAudition(id, audition),
      get_item: async () => serializeItemFile(s.requireItem(id).file),
      runners_busy: async () => this.runnerStatus(),
      ...(this.store.config.heavy_runs.enabled ? { run_heavy: async (commands: string[]) => this.runHeavy(id, commands) } : {}),
    };
  }

  // ---- heavy local runs (#218) ----
  private readonly heavyLock = new HeavyLock();
  /** The daily efficiency audit in flight (#348): one at a time, off the tick. */
  private auditing?: Promise<unknown>;
  private auditAbort?: AbortController;
  /** Its slot, once due, while automation runs and its model has usage: a model out of usage waits for the next tick. */
  private driveEfficiencyAudit(): void {
    if (this.auditing || this.stopping) return;
    const slot = auditSlotDue(this.store, new Date(Date.parse(this.now())));
    if (!slot) return;
    const pick = this.orchestrator.modelForWake();
    if (pick.exhaustedUntil || this.guarded(pick.runner, pick.account)) return;
    const abort = new AbortController(); this.auditAbort = abort;
    this.auditing = runEfficiencyAudit({ store: this.store, agents: this.ports.agents, orchestrator: this.orchestrator, log: (l, m) => this.note(l, m), signal: abort.signal }, slot)
      .catch((e) => this.note('error', `efficiency audit: ${(e as Error).message}`))
      .finally(() => { this.auditing = undefined; });
  }
  /** Each item's test-run records still being written (their tree is read first), in order (#347). */
  private readonly testRunWrites = new Map<string, Promise<void>>();

  /**
   * A worker command that ran tests (`test_runs.patterns`), journaled with the worktree's tree as it ended, for the
   * efficiency report's wasted runs (#347). Recorded only: nothing is refused or slowed by it. An unreadable tree is
   * left out, so that run is never called a repeat.
   */
  private recordTestRun(id: string, cwd: string, run: { command: string; ok: boolean; ms: number }, source: 'bash' | 'run_heavy'): Promise<void> {
    const shape = testRunShape(run.command, this.store.config.test_runs);
    if (!shape) return Promise.resolve();
    const ts = isoLocal();
    // Read at once, before the session's next edit; only the writes wait on each other, so the record keeps the order the runs ended in.
    const reading = this.ports.git.snapshot(cwd).then((s) => s.tree, () => undefined);
    const write = (this.testRunWrites.get(id) ?? Promise.resolve()).then(async () => {
      const tree = await reading;
      this.store.journal.append({ ts, type: TEST_RUN, item: id, actor: 'engine', data: { command: run.command.slice(0, 500), ok: run.ok, ms: run.ms, ...(tree ? { tree } : {}), ...shape, source } });
    }).catch(() => {});
    this.testRunWrites.set(id, write);
    void write.then(() => { if (this.testRunWrites.get(id) === write) this.testRunWrites.delete(id); });
    return write;
  }
  /**
   * A worker's heavy local run: what its rules (or the project's heavy patterns) let it run, in its worktree, one heavy
   * run at a time, each batch after any CI job on a runner sharing this host (`heavy_runs.shared_labels`) has ended.
   * The waits are the lock and CI, never a person (invariant 2); a turn that is stopped stops waiting.
   */
  private async runHeavy(id: string, commands: string[]): Promise<string> {
    const cfg = this.store.config.heavy_runs;
    const item = this.store.requireItem(id); const fm = item.file.frontmatter;
    if (!fm.worktree) return 'Rejected: this item has no worktree to run in.';
    const cwd = this.absWorktree(fm.worktree);
    const rules = this.store.permissionRules();
    const policy = makePolicy(this.store.config, this.store.derived(item).base_branch!, cwd, {}, rules);
    for (const command of commands) {
      const why = policy.deny({ tool: 'Bash', input: { command } });
      if (why) return `Rejected: ${why} Nothing was run.`;
      if (!allowedByRules({ tool: 'Bash', input: { command } }, [...BASE_ALLOWED.implement, ...rules.allow, ...heavyAllowRules(this.store.config)], cwd)) return `Rejected: run_heavy runs only commands your allow rules or the project's heavy_runs.patterns permit, and \`${command.slice(0, 200)}\` is neither. Nothing was run.`;
    }
    // The command sees what the worker's own commands would (#228), by its runner.
    const env = workerCommandEnv(this.store.config.models.find((m) => m.id === fm.implementer)?.runner ?? 'claude', this.store.config);
    const signal = this.turns.get(id)?.abort.signal;
    const stopped = () => signal?.aborted || this.stopping || this.store.requireItem(id).file.frontmatter.taken_over;
    const say = (text: string) => this.store.mutateItem(id, [{ activity: { actor: 'app', text: `heavy run: ${text}` } }], 'engine');
    const out: string[] = [];
    const t0 = Date.now();
    const holder = this.heavyLock.holder;
    const release = await this.heavyLock.acquire(id, signal);
    if (!release) return 'Stopped: this turn was stopped while waiting for the heavy-run lock. Nothing was run.';
    try {
      if (holder !== undefined) { const w = `waited ${took(Date.now() - t0)} for ${holder}'s heavy run`; out.push(w); say(w); }
      for (const [i, command] of commands.entries()) {
        const label = commands.length > 1 ? `batch ${i + 1}/${commands.length}: ` : '';
        if (cfg.yield_to_ci && cfg.shared_labels.length) {
          const w0 = Date.now(); let first: string[] | undefined; let unread = '';
          for (;;) {
            if (stopped()) return [...out, `Stopped: this turn was stopped while waiting for CI${label ? ` before ${label.slice(0, -2)}` : ''}.`].join('\n');
            let busy: string[] = [];
            try { const r = await this.readRunners(cfg.poll_s * 1000); busy = r ? ciOnSharedHost(r.report, cfg.shared_labels) : []; if (!r) unread = 'the runners cannot be read here (no code_repo.github or no runner report), so nothing was waited for'; }
            catch (e) { unread = `the runners could not be read (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}), so nothing was waited for`; }
            if (!busy.length) break;
            first ??= busy;
            await this.sleep(cfg.poll_s * 1000);
          }
          if (first) { const w = `${label}waited ${took(Date.now() - w0)} for CI on ${cfg.shared_labels.join(', ')} (${first.join('; ')})`; out.push(w); say(w); }
          else if (unread && i === 0) out.push(unread);
        }
        const r0 = Date.now();
        const r = await this.ports.proc.run(command, { cwd, timeoutMs: cfg.timeout_min * 60_000, ...env, ...(signal ? { signal } : {}) });
        await this.recordTestRun(id, cwd, { command, ok: r.code === 0, ms: Date.now() - r0 }, 'run_heavy');
        const tail = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim().slice(-4000);
        out.push(`${label}\`${command}\` exited ${r.code}${tail ? `:\n${tail}` : ''}`);
        if (r.code !== 0 && i < commands.length - 1) { out.push(`The batches after it were not run.`); break; }
      }
      say(`ran ${commands.length === 1 ? `\`${commands[0].slice(0, 120)}\`` : `${commands.length} batches`} in ${took(Date.now() - t0)}`);
      return out.join('\n');
    } finally { release(); }
  }

  // ---- loop until green (#171) ----
  /**
   * One iteration of a loop item, as the worker tallies it: logged, persisted in `loop_state`, and counted
   * against `loop.max_iterations`. The iteration that spends the budget without going green blocks the item
   * (`loop_cap`) with the tally and the branch's diff, so a loop never runs on by itself.
   */
  private async recordIteration(id: string, passing: number, total: number, note: string): Promise<string> {
    const cur = this.store.requireItem(id).file.frontmatter;
    if (!cur.loop) return 'Not a loop item: this item has no iteration budget. Use append_activity for progress.';
    if (cur.status !== 'IN_PROGRESS' && cur.status !== 'IN_REVIEW') return `Not now: ${id} is ${cur.status}; iterations are reported while implementing.`;
    if (cur.blocked) return 'Not recorded: this item is blocked. End your turn now.';
    const bad = loopTallyProblem(passing, total);
    if (bad) return `Rejected: ${bad}. Call report_iteration again.`;
    const max = cur.loop.max_iterations;
    const iteration = (cur.loop_state?.iteration ?? 0) + 1;
    const line = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const state = { iteration, passing, total, ...(line ? { line } : {}), at: this.now() };
    this.store.mutateItem(id, [{ set: { loop_state: state } }, { activity: { actor: 'worker', text: loopLine(state, max) } }], 'engine');
    if (loopGreen(state)) return `Recorded: ${passing}/${total}, all green. Finish now: commit, then call report_done with your REVIEW.md as \`review\` and the captures as \`attach\`.`;
    if (iteration >= max) {
      this.block(id, 'loop_cap', `the loop spent its ${max} iteration${max === 1 ? '' : 's'} (loop.max_iterations) without going green: ${passing}/${total} passing at the last one${line ? ` (${line})` : ''}. ${await this.loopDiffSummary(id)}`);
      return `Recorded. That was the last of this item's ${max} iterations and it is not green, so planestro has blocked the item for the user with your tally and the branch's diff. Commit what you have, then end your turn now; do not iterate further.`;
    }
    return `Recorded: iteration ${iteration} of ${max}, ${passing}/${total} passing; ${max - iteration} left.`;
  }

  /** What the branch holds against its base, for a loop that stopped: the head and the files it changed. */
  private async loopDiffSummary(id: string): Promise<string> {
    try {
      const item = this.store.requireItem(id); const fm = item.file.frontmatter; const base = this.store.derived(item).base_branch;
      if (!fm.worktree || !base) return 'No branch to describe.';
      const cwd = this.absWorktree(fm.worktree);
      const head = await this.ports.git.revParse(cwd, 'HEAD');
      const files = await this.ports.git.changedFiles(cwd, `origin/${base}`, head);
      if (!files.length) return `Last diff: nothing committed ahead of ${base} (head ${head.slice(0, 7)}).`;
      return `Last diff (head ${head.slice(0, 7)} against ${base}): ${files.length} file${files.length === 1 ? '' : 's'} — ${files.slice(0, 12).map((f) => `${f.change} ${f.path}`).join(', ')}${files.length > 12 ? ', …' : ''}.`;
    } catch (e) { return `The diff could not be read: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}.`; }
  }

  /** Why a loop item's report_done is not taken yet (undefined: it is): not green, or its first hand-off without a review. */
  private loopDoneRefusal(id: string, review: string | undefined): string | undefined {
    const cur = this.store.requireItem(id).file.frontmatter;
    if (!cur.loop || cur.kind === 'epic') return undefined;
    const st = cur.loop_state;
    if (!loopGreen(st)) return `Rejected: this is a loop-until-green item and its last iteration ${st ? `was ${st.passing}/${st.total} passing` : 'was never reported'}. Report each iteration with report_iteration, and call report_done once every check passes (or report_blocked if they cannot). Nothing was recorded.`;
    if (cur.status === 'IN_PROGRESS' && !review?.trim()) return 'Rejected: a loop-until-green item hands off with its review. Call report_done again with the markdown of your REVIEW.md as `review` (each finding, its check, before and after, the checks satisfied) and the captures as `attach`. Nothing was recorded.';
    return undefined;
  }

  /**
   * Why report_done is not taken while the branch still adds a debug marker (#240), naming each file and line; undefined when
   * none remains. Reads the worktree (commits, uncommitted and untracked files) against its merge base with the base, added
   * lines only, and records nothing, so asking again gets the same answer. A check that cannot run refuses nothing.
   */
  private async debugMarkersLeft(id: string): Promise<string | undefined> {
    const item = this.store.requireItem(id); const fm = item.file.frontmatter; const base = this.store.derived(item).base_branch;
    if (!fm.worktree || !base) return undefined;
    try { return debugMarkerRefusal(await this.ports.git.addedLinesWith(this.absWorktree(fm.worktree), `origin/${base}`, DEBUG_MARKER), base); }
    catch { return undefined; }
  }

  /** A loop's REVIEW.md, filed on the item: in its Notes, where the page shows it, and as a managed attachment. */
  private fileLoopReview(id: string, review: string | undefined): boolean {
    const cur = this.store.requireItem(id).file;
    if (!cur.frontmatter.loop || !review?.trim()) return false;
    const st = cur.frontmatter.loop_state;
    const heading = `## Loop review${st ? ` (iteration ${st.iteration}, ${st.passing}/${st.total} green)` : ''}`;
    const body = `${heading}\n\n${demoteH1(review.trim())}`;
    const notes = getSection(cur, 'Notes');
    this.store.mutateItem(id, [{ section: 'Notes', body: notes ? `${notes}\n\n${body}` : body }, { activity: { actor: 'app', text: 'filed the loop\'s REVIEW.md in Notes' } }], 'engine', { commit: `${id}: loop review` });
    try { this.store.addManagedAttachment(id, 'REVIEW.md', Buffer.from(review.trim() + '\n'), 'engine'); }
    catch (e) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `REVIEW.md not attached (it is in Notes): ${(e as Error).message.slice(0, 160)}` } }], 'engine'); }
    return true;
  }

  // ---- worker tools (#404, seam 1): attachments, the review hand-off, auditions and hand-offs live in workerTools.ts ----
  /** A take of the audition the item waits on, and nothing else (WorkerTools.auditionFile). */
  auditionFile(id: string, path: string): Promise<Buffer | null> { return this.workerTools.auditionFile(id, path); }
  /** One item's files, given to another before any branch merges (WorkerTools.handOff). */
  handOff(from: string, to: string, paths: string[], note: string, by: 'worker' | 'orchestrator' | 'user' = 'worker'): Promise<string> { return this.workerTools.handOff(from, to, paths, note, by); }

  // ---- accounts (#242): a second login or key for the same runner ----
  /** The account a turn on `def` runs on for this item: the item's for that runner, its model row's, or the default login. */
  private accountFor(fm: { account?: string }, def: ModelDef): { account: Account } | { missing: string; why: string } {
    return resolveAccount(this.store.local, def.runner ?? 'claude', { item: fm.account, model: def.account });
  }
  /** Whether that account's usage guard holds its new turns. */
  private guarded(runner: string, account?: string): boolean { return Boolean(this.store.local.engine.provider_guards?.[guardKey(runner, account)]); }
  private guardedFor(fm: { account?: string }, def: ModelDef): boolean {
    const acct = this.accountFor(fm, def);
    return 'account' in acct && this.guarded(def.runner ?? 'claude', acct.account.name);
  }
  /** What a turn on `account` is given: its login's config folder, and the other accounts' folders as secrets. */
  private accountTurnOptions(account: Account): { account?: AccountCredentials; secretDirs?: string[] } {
    const dirs = Object.values(this.store.local.accounts ?? {}).flatMap((a) => (a.home ? [a.home] : []));
    return {
      ...(account.name !== DEFAULT_ACCOUNT ? { account: { name: account.name, ...(account.home ? { home: account.home } : {}) } } : {}),
      ...(dirs.length ? { secretDirs: dirs } : {}),
    };
  }

  /**
   * Retry once at the reset (#296, HH-441): a usage stop of an item already authorized to run waits, not needing anyone, until
   * its model's recorded outage ends (plus the guard's minute; `at` only when later), then the tick retries its step once
   * (driveTimedRetries, as #241's). Persisted in `op_data.usage_retry`, so nothing sleeps until then and a restart keeps it.
   * Asked by the orchestrator from triage and by the user's "Wait for the reset"; a second exhaustion stops as before.
   */
  retryAtReset(id: string, at: string | undefined, by: 'user' | 'orchestrator'): string {
    const fm = this.store.getItem(id)?.file.frontmatter;
    if (!fm) return `not possible: there is no item ${id}`;
    if (fm.taken_over) return `not possible: the user has taken ${id} over`;
    if (fm.blocked_reason !== 'usage_exhausted') return `not possible: ${id} is not stopped for usage`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const spent = (fm.op_data?.usage_retry as { retried_at?: string } | undefined)?.retried_at;
    if (spent && by === 'orchestrator') return `not possible: ${id} was already retried once at a reset (${spent}) and ran out of usage again; it is the user's call now`;
    const wanted = at === undefined ? undefined : Date.parse(at);
    if (wanted !== undefined && !Number.isFinite(wanted)) return `not recorded: at must be an ISO time, not "${at}"`;
    const requested = findModel(this.store.config, fm.status === 'PLAN_IN_PROGRESS' ? fm.planner : fm.implementer);
    const acct = requested ? this.accountFor(fm, requested) : undefined;
    // When a model it may run on comes back: the earliest end among its chain's outages, on its account.
    const view = acct && 'account' in acct ? unavailableView(this.store.local.model_unavailable, acct.account.name) : undefined;
    const outs = requested ? (fm.allow_model_fallback === true ? fallbackChain(this.store.config, requested) : [requested]).map((m) => unavailableEntry(view, m.id, new Date(Date.now()))) : [];
    const reset = outs.length && outs.every(Boolean) ? Math.min(...outs.map((o) => Date.parse(o!.until))) : undefined;
    if (reset === undefined && wanted === undefined) return `not recorded: no outage is recorded for ${id}'s model any more, so nothing waits; retry_op runs its step now`;
    const due = new Date(Math.max(wanted ?? 0, reset !== undefined ? reset + USAGE_RESUME_GRACE_MS : 0)).toISOString();
    this.store.mutateItem(id, [
      { set: { op_data: { ...(fm.op_data ?? {}), usage_retry: { due_at: due, by } } } },
      { unset: ['triage'] },
      { activity: { actor: by, text: `waits for ${requested?.label ?? 'its model'}'s usage to reset; planestro retries its step once at ${due}` } },
    ], by, { commit: `${id}: retry at usage reset` });
    return `${id} waits, not needing anyone, and planestro retries once at ${due}`;
  }


  /** `stall`: the runner the stop waits on (#216): it joins that runner's one signal instead of a triage of its own. */
  private block(id: string, reason: string, detail: string, awaiting: 'user' | undefined = 'user', stall?: RunnerStall, card?: Omit<Decision, 'requested_at' | 'reason'>): void {
    // No space left (#161): whatever stopped on it, the cause is the disk, which no instruction fixes. Said as such, never
    // triaged, and the guard reads the disk at once (it pauses everything else rather than let each item fail in turn).
    // Only a generic stop is renamed: one with its own reason (cleanup_dirty keeps its invariant-7 story) keeps it, and the disk is still read.
    if (/\bENOSPC\b|No space left on device/i.test(detail)) { if (['agent_blocked', 'engine_error', 'turn_error'].includes(reason)) reason = 'disk_full'; void this.guards.checkDisk(true); }
    try {
      const cur = this.store.requireItem(id).file.frontmatter;
      // The person who has the item is already looking at it: a stop is said, not raised (dogfood p28: a worker still
      // running under a take-over blocked HH-136, by then in review with its PR, as agent_blocked).
      if (cur.taken_over) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: `not blocked (${reason}), since you have this item: ${detail.replace(/\s+/g, ' ').slice(0, 300)}` } }], 'engine'); return; }
      // A stop for a person goes to the orchestrator first (triage); it resolves it or asks one plain question.
      const triage = card ? { on: false, ops: [] as ItemOp[] } : stall ? { on: false, ops: [{ set: { op_data: { ...(cur.op_data ?? {}), runner_stall: this.ciWatch.stallMark(stall) } } }, { activity: { actor: 'app', text: `not triaged: runner ${stall.label} looks stalled or offline, and every item waiting on it is said in one signal; it waits for CI again by itself once a runner takes a job` } }] as ItemOp[] } : this.triage.triageOps(cur, reason);
      // A card that was waiting for an answer is about a stop that no longer exists: this block replaces it (HH-162, dogfood p42).
      const { decision: staleCard, ...restData } = cur.awaiting_data ?? {};
      this.store.mutateItem(id, [
        { set: { blocked: true, blocked_reason: reason, ...(awaiting ? { awaiting } : {}) } },
        ...(staleCard ? [(Object.keys(restData).length ? { set: { awaiting_data: restData } } : { unset: ['awaiting_data'] }) as ItemOp, { activity: { actor: 'app', text: 'the decision card it had is withdrawn: this block replaces it' } } as ItemOp] : []),
        ...(cur.op ? [{ unset: ['op', 'op_started_at'] } as ItemOp] : []),
        { activity: { actor: 'app', text: `BLOCKED (${reason}): ${detail.replace(/\s+/g, ' ').slice(0, 500)}` } },
        ...triage.ops,
        // A card the engine can file itself (#242) is the user's call from the start: no triage, no wake.
        ...(card ? [{ set: { awaiting_data: { ...restData, decision: { ...card, requested_at: this.now(), reason } } } } as ItemOp, { activity: { actor: 'app', text: `decision needed: ${card.question}` } } as ItemOp] : []),
      ], 'engine', { commit: `${id}: blocked (${reason})` });
      this.note('warn', `${id} blocked: ${reason} — ${detail.slice(0, 200)}${triage.on ? ' (the orchestrator is triaging it)' : ''}`);
      if (triage.on) this.slots.wakeWhenIdle(id, `blocked_${reason}`, { detail: detail.slice(0, 2000) });
      else if (!stall && !card && (JUDGMENT_BLOCKS as readonly string[]).includes(reason)) this.wakeOrchestrator(`blocked_${reason}`, id, { detail: detail.slice(0, 2000) });
    } catch (e) { this.note('error', `could not record block on ${id}: ${(e as Error).message}`); }
  }


  continueAfterProviderSwitch(id: string): void {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (this.guards.paused || this.guards.draining || this.stopping || !fm.op_data?.fresh_brief || fm.awaiting || fm.blocked || fm.taken_over || fm.resume_after || fm.op_data?.pending_turn || this.busyWith(id)) return;
    if (fm.status !== 'IN_PROGRESS' && fm.status !== 'PLAN_IN_PROGRESS') return;
    if (findModel(this.store.config, fm.status === 'PLAN_IN_PROGRESS' ? fm.planner : fm.implementer)?.external) return;
    if ((fm.op_data.fresh_brief as { role?: string }).role === 'plan' && fm.status !== 'PLAN_IN_PROGRESS') return;
    this.queueTurn(id, fm.status === 'PLAN_IN_PROGRESS' ? 'plan' : 'implement', 'Continue from the current persisted state.', [], [], { carryOn: true });
  }
  modelSwitchRefusal(id: string): string | undefined { return this.busyWith(id); }
  private busyWith(id: string): string | undefined { return this.jobs.has(id) || this.turns.has(id) ? `${id} has a step running; let it finish first` : undefined; }

  private async orchestratorUnblocks(id: string, message?: string, syncFirst = false, fresh = false): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (!fm.blocked && fm.awaiting !== 'user') return `nothing to unblock: ${id} is not blocked${fm.awaiting ? ` (it is awaiting ${fm.awaiting}; answer that instead)` : ''}`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const noFresh = fresh ? this.freshRefusal(fm, message) : undefined;
    if (noFresh) return `not possible: ${noFresh}`;
    // Sync first (p29): the branch takes in what merged since it was cut before the session resumes; a refusal leaves it blocked.
    if (syncFirst) return this.syncWithBase(id, { by: 'orchestrator', unblock: { message: message?.trim() || undefined, fresh } });
    await this.unblock(id, message?.trim() || undefined, 'orchestrator', { fresh });
    return message?.trim() && this.phaseFor(fm.status) ? (fresh ? 'unblocked; a fresh session starts with a brief and your message as its task' : 'unblocked; the session resumes with your message') : 'unblocked; the pipeline retries from where it stopped';
  }

  /**
   * Commit named files in an item's worktree, with no model turn (#64): HH-247 resumed a long
   * conversation for $46 to run two `git add … && git commit` that had already been approved. Which
   * files belong to the change is a judgment, so whoever calls this names them; that they are there to
   * commit is checked here (each must be one of the worktree's own dirty files). It never pushes and
   * never unblocks: finish_from_worktree, or retry_op for an item in review, carries on from the commit.
   */
  async commitPaths(id: string, paths: string[], message: string, by: 'user' | 'orchestrator' = 'orchestrator'): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (this.guards.paused || this.guards.draining || this.stopping) return `not now: automation is ${this.guards.paused ? 'paused' : 'stopping'}; nothing was committed`;
    if (this.store.derived(item).flavor !== 'worker' || (fm.status !== 'IN_PROGRESS' && fm.status !== 'IN_REVIEW')) return `not possible: ${id} is ${fm.status}; only a worker item in progress or in review has work to commit`;
    if (fm.taken_over) return `not now: the user has taken ${id} over`;
    if (!fm.worktree || !fm.branch) return `not possible: ${id} has no worktree or branch`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    if (fm.op) return `not now: ${id} is ${fm.op.replace(/_/g, ' ')}; let it finish first`;
    if (fm.awaiting && fm.awaiting !== 'user') return `not now: ${id} is awaiting ${fm.awaiting.replace(/_/g, ' ')}; answer that first`;
    const cwd = this.absWorktree(fm.worktree);
    if (!(await this.ports.git.worktreeList(this.repo)).some((w) => w.path === cwd && !w.prunable)) return `not possible: the worktree ${fm.worktree} is missing; use recreate_worktree`;
    const inFlight = await this.ports.git.inProgressOp(cwd);
    if (inFlight) return `refused: a ${inFlight} is unfinished in ${fm.worktree}; a commit now would be part of it. It needs a session (unblock_item) or a person`;
    const subject = message.trim().split('\n')[0];
    if (!subject) return 'refused: the commit needs a message';
    const named = [...new Set(paths.map((p) => p.trim().replace(/^\.\//, '')).filter(Boolean))];
    if (!named.length) return 'refused: name the files to commit';
    const bad = named.find((p) => isAbsolute(p) || p.startsWith('-') || p.split('/').some((part) => part === '..' || part === '.git'));
    if (bad) return `refused: "${bad}" is not a path inside the worktree (relative paths only, no "..", nothing under .git)`;
    const detail = await this.ports.git.dirtyDetail(cwd);
    const dirty = new Set([...detail.tracked, ...detail.untracked]);
    const absent = named.filter((p) => !dirty.has(p));
    if (absent.length) return `refused: ${absent.slice(0, 5).join(', ')} ${absent.length === 1 ? 'is' : 'are'} not among the worktree's uncommitted files (${[...dirty].slice(0, 8).join(', ') || 'it is clean'}); name files exactly as listed, one by one`;
    const byproduct = named.find((p) => detail.untracked.includes(p) && this.store.config.worktrees.byproducts.some((g) => matchesPathPattern(p, g)));
    if (byproduct) return `refused: ${byproduct} is a byproduct the project's tools regenerate (worktrees.byproducts), never part of a change`;
    const opId = this.store.journal.begin('commit_paths', id, { paths: named, by });
    let head: string;
    try { head = await this.ports.git.commitPaths(cwd, named, `${subject}${message.trim().includes('\n') ? `\n${message.trim().split('\n').slice(1).join('\n')}` : ''}\n\nCommitted by planestro for ${by === 'orchestrator' ? 'the orchestrator' : 'the user'}, without a session turn.`); }
    catch (e) { this.store.journal.end(opId, id, 'failed', { error: (e as Error).message.slice(0, 300) }); return `failed: git would not commit them: ${(e as Error).message.slice(0, 300)}`; }
    this.store.journal.end(opId, id, 'ok', { head, paths: named });
    const left = (await this.worktreeDirt(cwd)).dirty;
    this.store.mutateItem(id, [{ activity: { actor: by, text: `committed ${named.length} file${named.length === 1 ? '' : 's'} without a session turn (${head.slice(0, 7)} "${subject.slice(0, 72)}"): ${named.slice(0, 8).join(', ')}${named.length > 8 ? ', …' : ''}${left.length ? `; still uncommitted: ${left.slice(0, 5).join(', ')}` : '; the tree is clean'}` } }], by, { commit: `${id}: commit paths${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    const next = fm.status === 'IN_PROGRESS' ? 'finish_from_worktree opens the pull request from here' : 'retry_op sends it back through the merge pipeline, which pushes the commit';
    return `committed ${head.slice(0, 7)}: ${named.length} file${named.length === 1 ? '' : 's'}. ${left.length ? `Still uncommitted: ${left.slice(0, 8).join(', ')} (commit what belongs the same way; the rest needs a session or a person).` : `The tree is clean: ${next}.`} Nothing was pushed and ${id} is as ${fm.blocked ? 'blocked' : 'it was'}.`;
  }

  private async orchestratorAnswers(id: string, answers: Record<string, string>): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.awaiting !== 'question') return `nothing to answer: ${id} is not waiting on a question`;
    if (!Object.keys(answers ?? {}).length) return 'give at least one answer';
    await this.respond(id, { kind: 'question', answers }, 'orchestrator');
    return 'answered; the session resumes with your answers';
  }

  private orchestratorSetsFields(id: string, fields: Record<string, unknown>): string {
    const item = this.store.requireItem(id);
    const refused = Object.keys(fields ?? {}).filter((k) => !(ORCHESTRATOR_FIELDS as readonly string[]).includes(k));
    if (refused.length) return `not permitted: ${refused.join(', ')}. You may set only ${ORCHESTRATOR_FIELDS.join(', ')}; nothing was changed.${refused.includes('mcp_budget') ? ' An MCP budget is the user\'s: ask_user_decision with an option that carries set_mcp_budget (the number the plan states), and their tap sets it.' : ''}`;
    if (!Object.keys(fields ?? {}).length) return 'no fields given';
    const set: Record<string, unknown> = {}; const unset: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) { if (k === 'depends_on') set.depends_on = []; else unset.push(k); continue; }
      if (k === 'parent') {
        const p = this.store.getItem(String(v));
        if (!p || p.file.frontmatter.kind !== 'epic') return `not changed: ${String(v)} is not an epic`;
        if (item.file.frontmatter.kind === 'epic') return `not changed: ${id} is an epic; epics do not nest`;
        set.parent = p.id;
      } else if (k === 'depends_on') {
        if (!Array.isArray(v) || v.some((d) => typeof d !== 'string')) return 'not changed: depends_on is a list of item ids';
        const missing = (v as string[]).filter((d) => d === id || !this.store.getItem(d));
        if (missing.length) return `not changed: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not another item`;
        set.depends_on = v;
      } else if (k === 'implementer') {
        if (!this.store.config.models.some((m) => m.id === v)) return `not changed: ${String(v)} is not a model id (${this.store.config.models.map((m) => m.id).join(', ')})`;
        set.implementer = v;
      } else if (k === 'base_branch_override') {
        if (typeof v !== 'string' || !v.trim()) return 'not changed: base_branch_override is a branch name, or null';
        set.base_branch_override = v.trim();
      } else {
        if (typeof v !== 'boolean') return `not changed: ${k} is true, false or null`;
        set[k] = v;
      }
    }
    const said = [...Object.entries(set).map(([k, v]) => `${k} = ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`), ...unset.map((k) => `${k} cleared`)].join(', ');
    let modelOps: ItemOp[] = [];
    if ('implementer' in set || unset.includes('implementer')) {
      try { modelOps = itemModelSwitchOps(this.store, this, id, { implementer: String(set.implementer ?? this.store.config.defaults.implementer) }); }
      catch (e) { return `not changed: ${(e as Error).message}`; }
      delete set.implementer; const index = unset.indexOf('implementer'); if (index >= 0) unset.splice(index, 1);
    }
    this.store.mutateItem(id, [...modelOps, ...(Object.keys(set).length ? [{ set } as ItemOp] : []), ...(unset.length ? [{ unset } as ItemOp] : []), { activity: { actor: 'orchestrator', text: `set ${said}` } }], 'orchestrator', { commit: `${id}: fields (orchestrator)` });
    const d = this.store.derived(this.store.requireItem(id));
    this.poke();
    return `set ${said}. Base branch is now ${d.base_branch ?? `unresolved (${d.base_branch_error})`}${item.file.frontmatter.worktree && ('parent' in fields || 'base_branch_override' in fields) ? '; the existing worktree was not moved (recreate_worktree does that)' : ''}.`;
  }

  /** The base a worktree was cut from, as its creation was journalled (the item's base may have changed since). */
  private journalledBase(id: string): string | undefined {
    const begin = this.store.journal.read({ item: id, type: 'op.begin' }).reverse().find((e) => e.data?.op === 'creating_worktree' && typeof e.data?.base === 'string');
    return begin?.data?.base as string | undefined;
  }

  /**
   * Replace a worktree that holds no work with a fresh one from the item's current base (invariant 7:
   * positive evidence first — a clean tree, and every commit on the branch, local and pushed, already
   * on the old or the new base). The removal and setup run as the item's job; it ends by unblocking.
   */
  async recreateWorktree(id: string, message?: string): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    if (d.flavor !== 'worker') return `not possible: ${id} is not a worker item with a session worktree`;
    if (fm.taken_over) return `not possible: the user has taken ${id} over`;
    if (!['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'].includes(fm.status)) return `not possible: ${id} is ${fm.status}; only an item still planning or implementing gets a new worktree`;
    if (fm.pr) return `not possible: ${id} already has pull request #${fm.pr}`;
    if (!fm.worktree || !fm.branch) return `not possible: ${id} has no worktree recorded`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const base = d.base_branch;
    if (!base) return `not possible: ${d.base_branch_error ?? 'the base branch cannot be resolved'}`;
    const dir = this.absWorktree(fm.worktree);
    const branch = fm.branch;
    const bases = [...new Set([base, this.journalledBase(id)].filter((b): b is string => Boolean(b)))];
    let entry: { path: string } | undefined;
    let localTip: string | null = null, remoteTip: string | null = null;
    try {
      await this.ports.git.fetch(this.repo);
      entry = (await this.ports.git.worktreeList(this.repo)).find((w) => w.path === dir && !w.prunable);
      if (entry) {
        const { clean, dirty } = await this.worktreeDirt(dir);
        if (!clean) return `refused: ${fm.worktree} has uncommitted changes (${dirty.slice(0, 5).join(', ')}); nothing was touched`;
        let empty = false;
        for (const b of bases) if ((await this.ports.git.aheadBehind(dir, `origin/${b}`, 'HEAD')).ahead === 0) { empty = true; break; }
        if (!empty) return `refused: ${branch} has commits that are not on origin/${bases.join(' or origin/')}; recreating would lose work, so nothing was touched`;
      } else if (await this.ports.git.localBranchExists(this.repo, branch)) {
        const tip = await this.ports.git.revParse(this.repo, `refs/heads/${branch}`);
        if (!(await this.anyAncestor(tip, bases))) return `refused: the local branch ${branch} has commits that are not on origin/${bases.join(' or origin/')}; nothing was touched`;
      }
      localTip = await this.ports.git.localBranchExists(this.repo, branch) ? await this.ports.git.revParse(this.repo, `refs/heads/${branch}`) : null;
      if (localTip && !(await this.anyAncestor(localTip, bases))) return `refused: local branch ${branch} has unmerged commits; nothing was touched`;
      const remote = remoteTip = await this.ports.git.remoteBranchSha(this.repo, branch);
      if (remote && !(await this.anyAncestor(remote, bases))) return `refused: the pushed branch ${branch} has commits that are not on origin/${bases.join(' or origin/')}; nothing was touched`;
    } catch (e) { return `refused: could not verify the worktree holds no work (${(e as Error).message.slice(0, 200)}); nothing was touched`; }
    const note = message?.trim() || `planestro recreated your worktree (${fm.worktree}, branch ${branch}) from origin/${base}. It holds none of your earlier edits (there were none to keep). Continue your ${fm.status === 'IN_PROGRESS' ? 'implementation of the approved plan' : 'planning'} from there.`;
    const hadWorktree = Boolean(entry);
    this.runJob(id, async () => {
      const opId = this.store.journal.begin('creating_worktree', id, { branch, dir, base, recreate: true });
      this.store.mutateItem(id, [{ set: { op: 'creating_worktree', op_started_at: this.now() } }, { activity: { actor: 'orchestrator', text: `recreating ${fm.worktree} on ${branch} from origin/${base}${hadWorktree ? '' : ' (the old one was gone)'}` } }], 'engine', { commit: `${id}: recreate worktree` });
      if (hadWorktree) { const kept = await this.cleanupReconcile.setAsideBeforeRemove(id, dir); if (kept) this.store.mutateItem(id, [{ activity: { actor: 'app', text: kept } }], 'engine'); }
      if (hadWorktree) await this.ports.git.worktreeRemove(this.repo, dir, false);
      await this.ports.git.worktreePrune(this.repo);
      await this.ports.git.deleteLocalBranch(this.repo, branch, localTip);
      await this.ports.git.deleteRemoteBranch(this.repo, branch, remoteTip);
      await this.ports.git.worktreeAdd(this.repo, dir, branch, `origin/${base}`);
      if (!(await this.runSetupHooks(id, dir, opId))) return;
      this.store.mutateItem(id, [{ unset: ['op', 'op_started_at'] }], 'engine');
      this.store.journal.end(opId, id, 'ok');
      const cur = this.store.requireItem(id).file.frontmatter;
      if (cur.blocked || cur.awaiting === 'user') await this.unblock(id, cur.status === 'PLAN_READY' ? undefined : note, 'orchestrator');
    });
    return `recreating ${fm.worktree} from origin/${base}: setup hooks run, then the item is unblocked${fm.status === 'PLAN_READY' ? ' (its plan still waits for approval)' : ' and its session resumed with ' + (message?.trim() ? 'your message' : 'a note that the worktree is new')}.`;
  }

  private async anyAncestor(sha: string, bases: string[]): Promise<boolean> {
    for (const b of bases) if (await this.ports.git.isAncestor(this.repo, sha, `origin/${b}`)) return true;
    return false;
  }

  /** `after_worktree_create`, one hook at a time within the local-job limit; a failure blocks the item. */
  private async runSetupHooks(id: string, dir: string, opId: string): Promise<boolean> {
    this.store.mutateItem(id, [{ set: { op: 'importing', op_started_at: this.now() } }], 'engine');
    for (const hook of this.store.config.hooks.after_worktree_create) {
      const r = await this.slots.withLocalJobSlot(() => this.ports.proc.run(hook, { cwd: dir, timeoutMs: 20 * 60_000 }));
      if (r.code !== 0) { this.store.journal.end(opId, id, 'failed', { hook, code: r.code }); this.block(id, 'hook_failed', `${hook} exited ${r.code}: ${r.stderr.slice(-400)}`); return false; }
      this.store.mutateItem(id, [{ activity: { actor: 'app', text: `hook ok: ${hook}` } }], 'engine');
    }
    return true;
  }

  /** Re-run what a transient failure stopped, by the same doors the pipeline itself uses. */

  /** With `message` (an unblock of an engine-owned stop, #211), it goes to Activity and with any session the retry resumes. */
  async retryOp(id: string, by: 'user' | 'orchestrator' | 'engine' = 'orchestrator', message?: string): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) return `not now: the user has taken ${id} over`;
    if (!fm.blocked) return `nothing to retry: ${id} is not blocked`;
    if (fm.awaiting && fm.awaiting !== 'user') return `not now: ${id} is awaiting ${fm.awaiting}; answer that instead`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const reason = fm.blocked_reason ?? 'blocked';
    // A held rebase nothing will finish is aborted first, and a message on a sync conflict is that session's guidance next time (HH-532).
    if (fm.op_data?.rebase_continue && !fm.op_data?.pending_turn) await this.baseSync.dropHeldRebase(id, `retrying after ${reason}`);
    if (fm.status === 'IN_REVIEW' && reason === 'sync_conflict' && message?.trim()) {
      const { rebase_declined: _declined, ...rest } = this.store.requireItem(id).file.frontmatter.op_data ?? {};
      this.store.mutateItem(id, [{ set: { op_data: { ...rest, rebase_hint: message.trim() } } }], 'engine');
    }
    const opData = LiveEngine.withoutDirtyCount(this.store.requireItem(id).file.frontmatter.op_data);
    const clear = (text: string, extra: ItemOp[] = []): void => { this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, ...(opData !== fm.op_data ? [{ set: { op_data: opData } } as ItemOp] : []), ...extra, { activity: { actor: by === 'engine' ? 'app' : by, text: message ? `${text}: ${message}` : by === 'engine' ? `${text} (automatic, once: the turn produced nothing)` : text } }], by, { commit: `${id}: retry${by === 'user' ? '' : ` (${by === 'engine' ? 'automatic' : by})`}` }); };
    const resume = (by !== 'user'
      ? `The last step stopped on a transient failure (${reason}), which has been retried. Nothing of yours was lost: check your worktree and continue where you left off.`
      : `The user unblocked this item (it had stopped: ${reason}). Nothing of yours was lost: check your worktree and continue where you left off.`) + (message ? `\n\n${message}` : '');
    // A conflict once handed to a session that never finished it is the pipeline's again: it re-syncs, and a conflict comes back to a session.
    if (fm.status === 'IN_REVIEW') { clear(`retrying the merge pipeline after ${reason}`, [{ set: { ci_result: 'pending', op_data: { ...(opData ?? {}), needs_session_rebase: false } } }]); this.poke(); return /^ci_red/.test(reason) ? 'retrying: it re-enters the merge pipeline, which reads the same CI run again (it does not run CI again: use rerun_ci to re-run its failed jobs)' : 'retrying: it re-enters the merge pipeline'; }
    if (fm.status === 'MERGED') { clear(`retrying cleanup after ${reason}`); this.runJob(id, () => this.cleanupReconcile.cleanup(id)); return 'retrying the cleanup (it still needs positive evidence before deleting anything)'; }
    // An epic in progress has no session and no worktree (#439): what it can retry is its integration branch; its children drive the rest.
    if (fm.kind === 'epic' && fm.status === 'IN_PROGRESS') {
      clear(`retrying after ${reason}: checking the integration branch; the children drive the rest`);
      this.runJob(id, () => this.epics.ensureEpicBranch(id));
      return 'retrying: the epic\'s integration branch is checked (opened from its base if missing); its children carry on';
    }
    if (this.store.derived(item).flavor !== 'worker' || !fm.worktree) return `not possible: nothing in ${fm.status} to retry for ${id}; use unblock_item`;
    const dir = this.absWorktree(fm.worktree);
    const exists = (await this.ports.git.worktreeList(this.repo).catch(() => [])).some((w) => w.path === dir && !w.prunable);
    if (fm.status === 'PLAN_IN_PROGRESS' && !exists && !fm.session_id) {
      clear(`retrying setup after ${reason} (the worktree was never made)`, [{ transition: { to: 'QUEUED', actor: 'engine' } }]);
      this.poke();
      return 'retrying: back in the queue, so setup runs again from the start';
    }
    if (!exists) return `not possible: the worktree ${fm.worktree} is missing; use recreate_worktree`;
    if (fm.status === 'IN_PROGRESS') {
      const { clean } = await this.worktreeDirt(dir);
      const base = this.store.derived(item).base_branch;
      const ahead = clean && base ? (await this.ports.git.aheadBehind(dir, `origin/${base}`, 'HEAD')).ahead : 0;
      if (ahead > 0) {
        clear(`retrying after ${reason}: the work is committed, opening the pull request again`);
        this.runJob(id, () => this.afterWorkTurn(id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done: String(fm.op_data?.done_summary ?? '') || undefined }));
        return 'retrying: the committed work goes to a pull request';
      }
    }
    if (!this.phaseFor(fm.status)) return `not possible: nothing in ${fm.status} to retry for ${id}`;
    await this.unblock(id, resume, by, { retried: true });
    return 'retrying: the session is resumed';
  }

  /** A worker's structured progress (f4): validated, stored on the item, summarised in Activity. Returns the problem, or undefined. */
  private recordParts(id: string, parts: unknown): string | undefined {
    const v = validateParts(parts);
    if (!v.ok) return `the parts were not recorded: ${v.error}.`;
    this.store.mutateItem(id, [{ set: { parts: v.value } }, { activity: { actor: 'worker', text: `progress: ${partsSummary(v.value)}` } }], 'engine');
    return undefined;
  }

  /** An item's caps: its own budget_usd / budget_turns / budget_tokens when set, else the project's. Each names the setting for messages. */
  private budgetOf(fm: { budget_usd?: number; budget_turns?: number; budget_tokens?: number }): { usd: number; usdKey: string; turns: number; turnsKey: string; tokens: number; tokensKey: string } {
    const c = this.store.config;
    return {
      usd: fm.budget_usd ?? c.budget_usd_per_item, usdKey: fm.budget_usd !== undefined ? 'budget_usd on this item' : 'budget_usd_per_item',
      turns: fm.budget_turns ?? c.budget_turns_per_item, turnsKey: fm.budget_turns !== undefined ? 'budget_turns on this item' : 'budget_turns_per_item',
      tokens: fm.budget_tokens ?? c.budget_tokens_per_item, tokensKey: fm.budget_tokens !== undefined ? 'budget_tokens on this item' : 'budget_tokens_per_item',
    };
  }

  /**
   * "Finish from here" (dogfood f2): the work is committed on the worker branch and the item could
   * not reach a pull request on its own (over budget, a size gate, a runner that could not commit,
   * a block of any kind). One action runs planestro's own path from a clean, ahead worktree: any
   * stop is cleared, and the deterministic done check opens the pull request. Refuses anything
   * that is not that: a dirty tree, nothing ahead of the base, a running step, the wrong status.
   */
  async finishFromWorktree(id: string, by: 'user' | 'orchestrator' = 'user'): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.status !== 'IN_PROGRESS' || this.store.derived(item).flavor !== 'worker' || !fm.worktree) return `not possible: ${id} is ${fm.status}${fm.worktree ? '' : ' with no worktree'}; only a worker item in progress can be finished from its worktree`;
    if (fm.taken_over) return `not now: ${id} is taken over; hand it back and planestro runs this same check`;
    const busy = this.busyWith(id); if (busy) return `not now: ${busy}`;
    const cwd = this.absWorktree(fm.worktree);
    const base = this.store.derived(item).base_branch;
    if (!base) return `not possible: ${id} has no base branch`;
    let { clean, dirty } = await this.worktreeDirt(cwd);
    // A model whose commits are planestro's leaves its work in the tree: committing it is this step's first half (#55).
    if (!clean && this.commitsFor(fm)) {
      const head = await this.commitForWorker(id, String(fm.op_data?.done_summary ?? '') || `work committed by planestro to finish ${id} from its worktree`);
      if (head) this.store.mutateItem(id, [{ activity: { actor: by, text: `finish from here: committed the session's work first (${head.slice(0, 7)}, ${dirty.length} file${dirty.length === 1 ? '' : 's'}; engine_commits)` } }], by);
      ({ clean, dirty } = await this.worktreeDirt(cwd));
    }
    if (!clean) return `not possible: the worktree has uncommitted changes (${dirty.slice(0, 5).join(', ')}); commit or discard them first`;
    await this.ports.git.fetch(this.repo);
    const { ahead } = await this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD');
    if (ahead === 0) return `not possible: the branch has nothing ahead of origin/${base}; if the work landed some other way, close the item as done`;
    const stopped = fm.blocked ? ` (it was blocked: ${fm.blocked_reason})` : fm.awaiting ? ` (it was awaiting ${fm.awaiting})` : '';
    this.store.mutateItem(id, [
      { unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] },
      { activity: { actor: by, text: `finish from here: ${ahead} commit${ahead === 1 ? '' : 's'} ahead of origin/${base}, tree clean; opening the pull request${stopped}` } },
    ], by, { commit: `${id}: finish from worktree${by === 'orchestrator' ? ' (orchestrator)' : ''}` });
    this.runJob(id, () => this.afterWorkTurn(id, 'implement', { subtype: 'success', isError: false, costUsd: 0, numTurns: 0, text: '', done: String(fm.op_data?.done_summary ?? '') || undefined }));
    return `finishing: ${ahead} commit${ahead === 1 ? '' : 's'} go to a pull request`;
  }

  /**
   * What an item has left and what its next turn costs before any work, for the orchestrator's packet
   * (#64): the numbers it needs to pick the step that fits without asking anyone. Undefined for an item
   * with no dollar budget to speak of (no Claude session phase).
   */
  private budgetLine(id: string): string | undefined {
    const fm = this.store.getItem(id)?.file.frontmatter;
    const phase = fm ? this.phaseFor(fm.status) : null;
    if (!fm || !phase) return undefined;
    const def = this.store.config.models.find((m) => m.id === (phase === 'plan' ? fm.planner : fm.implementer));
    if (!def) return undefined;
    const b = this.budgetOf(fm);
    if (modelCapabilities(def).accounting === 'tokens') return `${def.label}: ${(fm.tokens ?? 0).toLocaleString()} / ${b.tokens.toLocaleString()} tokens, ${fm.agent_turns ?? 0} / ${b.turns} turns; dollar cost not reported`;
    const left = b.usd - (fm.cost_usd ?? 0);
    const e = fm.session_id ? this.resumeEstimateFor(fm, def.claude_model) : undefined;
    const head = `Budget: $${(fm.cost_usd ?? 0).toFixed(2)} spent of $${b.usd} (${b.usdKey}), $${left.toFixed(2)} left.`;
    if (!fm.session_id) return `${head} It has no conversation yet, so nothing to reload.`;
    if (!e) return `${head} What resuming its conversation costs is not known yet (no turn has been quoted); planestro asks the CLI before the first request and declines a resume the item cannot pay for.`;
    const fits = left >= e.usd + MIN_TURN_USD;
    const freshFits = left >= FRESH_FLOOR_USD && phase !== 'plan';
    return [
      `${head} Resuming its conversation reloads ${Math.round(e.tokens / 1000)}k tokens first: about $${e.usd.toFixed(2)} before any work${e.isWarm ? ` (the cache is still warm; $${e.cold.toFixed(2)} once it expires)` : ''}.`,
      fits ? 'A resume fits what is left.' : `A resume does NOT fit what is left: planestro will not start one.`,
      phase === 'plan' ? '' : freshFits ? `A fresh session fits (unblock_item with fresh: true and the task as the message): it gets a brief from the item and git, not the old conversation, and needs about $${FRESH_FLOOR_USD}.` : `A fresh session needs about $${FRESH_FLOOR_USD}, which is not left either.`,
      phase === 'plan' ? '' : 'Work that is already in the worktree needs no session at all: commit_paths commits named files, then finish_from_worktree (retry_op in review) carries on.',
      !fits && !freshFits ? `Only money is missing: a card with raise_budget_usd of at least $${minRaiseUsd(e, left, false)} to resume, or $${minRaiseUsd(e, left, true)} with fresh: true.` : '',
    ].filter(Boolean).join(' ');
  }

  // ---- triage (#404, seam 7): needs-you triage, decision cards and what a card's option does live in triage.ts ----
  /** The user answered a decision card (Triage.answerDecision). */
  answerDecision(id: string, answer: { choice?: string; text?: string }): Promise<void> { return this.triage.answerDecision(id, answer); }
  /** The orchestrator's ask_user_decision (Triage.askUserDecision). */
  private askUserDecision(id: string, input: DecisionInput): string { return this.triage.askUserDecision(id, input); }


  // ---- sync with base (#404, seam 6): syncs, held rebases and an epic's conflict retry live in baseSync.ts ----
  /** "Sync with base" between turns (BaseSync.syncWithBase). */
  syncWithBase(id: string, opts: { by?: 'user' | 'orchestrator'; unblock?: { message?: string; fresh?: boolean } } = {}): Promise<string> { return this.baseSync.syncWithBase(id, opts); }
  /** The orchestrator's resolve_epic_conflict (BaseSync.retryEpicConflict). */
  retryEpicConflict(id: string, hint: string | undefined, by: 'user' | 'orchestrator' = 'orchestrator'): Promise<string> { return this.baseSync.retryEpicConflict(id, hint, by); }

  /** Why this item cannot be given a fresh conversation, in words; undefined when it can. */
  private freshRefusal(fm: { id: string; status: Status; worktree?: string }, message?: string): string | undefined {
    const phase = this.phaseFor(fm.status);
    if (!message?.trim()) return 'a fresh session needs a message: it is the task in its brief, and the new conversation knows nothing else of what to do';
    if (phase !== 'implement' && phase !== 'fix') return `${fm.id} is ${fm.status}: a fresh session is for work in progress or in review. A planning conversation is the basis of its plan and is resumed`;
    if (!fm.worktree) return `${fm.id} has no worktree for a fresh session to work in`;
    return undefined;
  }

  /** User-driven unblock: clears the flag and, if the item is in a session phase, resumes with a message. With `fresh`, in a new conversation that gets a brief. */
  async unblock(id: string, message?: string, by: 'user' | 'orchestrator' | 'engine' = 'user', opts: { fresh?: boolean; retried?: boolean } = {}): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.taken_over) throw new Error(`${id} is taken over: hand it back instead`);
    const refusal = opts.fresh ? this.freshRefusal(fm, message) : undefined;
    if (refusal) throw new Error(refusal);
    // Without a message there is nothing to tell a session, so "unblock" means "carry on from where
    // it stopped": the same step retry_op takes (open the PR for committed work, re-enter the merge
    // pipeline, requeue a setup that never ran, resume the session). Clearing the flag alone left
    // items idle with nothing driving them (HH-115, HH-125).
    // A stop that is planestro's own (a server-side git or gh failure, a restart mid-op) is retried the
    // same way with a message too: the session can't fix it, and resuming it cost a turn and a re-block (#211).
    const engineStop = /^(engine_error|interrupted_)/.test(fm.blocked_reason ?? '');
    // A rebase left stopped for a session that is no longer coming to it (HH-532) is aborted: the item goes on from its branch as it was.
    if (fm.op_data?.rebase_continue && !fm.op_data?.pending_turn && !this.busyWith(id)) await this.baseSync.dropHeldRebase(id, 'unblocked');
    if ((!message || (engineStop && !opts.fresh)) && !opts.retried && fm.blocked && !this.busyWith(id)) {
      const r = await this.retryOp(id, by, message);
      if (!/^(not possible|nothing to retry|not now)/.test(r)) return;
    }
    const now = this.store.requireItem(id).file.frontmatter;
    const opData = LiveEngine.withoutDirtyCount(now.op_data);
    this.store.mutateItem(id, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data', 'triage'] }, ...(opData !== now.op_data ? [{ set: { op_data: opData } } as ItemOp] : []), { activity: { actor: by === 'engine' ? 'app' : by, text: `unblocked${by === 'engine' ? ' (automatic retry)' : ''}${message && by !== 'engine' ? `: ${message}` : ''}` } }], by, { commit: `${id}: unblock${by === 'user' ? '' : ` (${by === 'engine' ? 'automatic' : by})`}` });
    const phase = this.sessionPhaseOf(fm);
    // The message is an instruction that stands on its own, so the engine may give it to a fresh conversation (#64); `fresh` asks for one.
    if (message && phase) this.queueTurn(id, phase, message, [], [], { fresh: opts.fresh ? true : 'auto', note: by === 'orchestrator' ? 'the orchestrator' : by === 'engine' ? 'planestro, retrying a turn that failed before it did anything' : 'a decision from the user' });
    // p50: a merged item that stopped in cleanup (a worktree removal failed) retries it now, the path reconcile takes
    // five minutes later; with a message, or a retry that declined, clearing the flag alone left it MERGED until then.
    else if (fm.status === 'MERGED') this.runJob(id, () => this.cleanupReconcile.cleanup(id));
    else void this.tick();
  }

  /** One file over `review.max_file_bytes` stops the item before a pull request carries it anywhere. */
  private async blockOversize(id: string): Promise<boolean> {
    const refs = this.reviewUndo.reviewRefs(id);
    if (!refs) return false;
    const { max_file_bytes, max_file_bytes_by_ext } = this.store.config.review;
    const mb = (n: number) => `${Math.round(n / 1e6 * 10) / 10} MB`;
    // The limit for a file: its extension's (".ogg" or "ogg" in config), else the project-wide one.
    const limitFor = (path: string): { bytes: number; key: string } => {
      const ext = extname(path).toLowerCase();
      const hit = Object.entries(max_file_bytes_by_ext).find(([k]) => (k.startsWith('.') ? k : `.${k}`).toLowerCase() === ext);
      return hit ? { bytes: hit[1], key: `review.max_file_bytes_by_ext["${hit[0]}"]` } : { bytes: max_file_bytes, key: 'review.max_file_bytes' };
    };
    const big = (await this.ports.git.changedFiles(refs.cwd, refs.base, refs.head).catch(() => [])).filter((f) => (f.bytes ?? 0) > limitFor(f.path).bytes);
    if (!big.length) return false;
    this.block(id, 'asset_too_large', `${big.map((f) => { const l = limitFor(f.path); return `${f.path} (${mb(f.bytes ?? 0)}) exceeds ${l.key} (${mb(l.bytes)})`; }).join('; ')}; shrink it, or raise that limit (a per-extension one in review.max_file_bytes_by_ext for a kind of file that is legitimately big) and unblock`);
    return true;
  }

  // ---- review and Undo (#404, seam 2): the review panel, its refs and what a branch delivered live in reviewUndo.ts ----
  /** What the branch changed, for the review panel (ReviewUndo.reviewImages). */
  reviewImages(id: string): Promise<ReviewImage[]> { return this.reviewUndo.reviewImages(id); }
  /** One changed file's blob, before or after (ReviewUndo.reviewImage). */
  reviewImage(id: string, path: string, side: 'before' | 'after'): Promise<Buffer | null> { return this.reviewUndo.reviewImage(id, path, side); }
  /** One changed text file's diff (ReviewUndo.reviewDiff). */
  reviewDiff(id: string, path: string): Promise<ReviewDiff | null> { return this.reviewUndo.reviewDiff(id, path); }

  /** Send a reviewed item back to the session that made it. The hold stays: the revision comes back for review. */
  async requestReviewChanges(id: string, note: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    if (fm.status !== 'IN_REVIEW' || fm.awaiting !== 'review') throw new Error(`${id} is not waiting for a review`);
    if (fm.taken_over) throw new Error(`${id} is taken over: hand it back first`);
    if (!note.trim()) throw new Error('say what should change');
    this.store.mutateItem(id, [{ unset: ['awaiting', 'awaiting_data'] }, { set: { op_data: { ...(fm.op_data ?? {}), review_nudged: false } } }, { activity: { actor: 'user', text: `review: changes requested: ${note.trim()}` } }], 'user', { commit: `${id}: request review changes` });
    this.runJob(id, () => this.runTurnFor(id, 'fix', `The user reviewed what you delivered and asks for changes:\n\n${note.trim()}\n\nRevise it in your worktree, commit on your branch, leave the tree clean, and finish as before. It will come back to the user for another look.`, [], [], { fresh: 'auto', note: 'your review' }));
  }

  /**
   * Why a pull request into `base` opens held (review.hold_into), or nothing. LM-2's epic PR into main, which deploys to
   * production, merged five minutes after it opened: the project's rule was to hold it for a playtest, and nothing had.
   */
  private holdIntoReason(base: string, alreadyHeld?: boolean): string | undefined {
    if (alreadyHeld || !this.store.config.review.hold_into.includes(base)) return undefined;
    return `a pull request into ${base}: held for you before it merges (review.hold_into)`;
  }

  /**
   * The one way a hold is put on an item (#97): out of the merge queue, with the reason on the item and in its log. Who
   * it waits on (#195) decides whether its PR is drafted: the user's and the app's holds for a person (review.hold_into,
   * a loop's review) wait on a person; the orchestrator's and the worker's wait on an agent and hold the merge only.
   */
  private holdOps(reason: string, by: 'user' | 'orchestrator' | 'worker' | 'app', waitsOn: 'person' | 'agent' = by === 'user' || by === 'app' ? 'person' : 'agent'): ItemOp[] {
    const why = reason.trim().replace(/\s+/g, ' ').slice(0, 300);
    return [{ set: { skip_merge: true, hold_reason: why, hold_waits_on: waitsOn } }, { activity: { actor: by, text: `held out of the merge queue: ${why}` } }];
  }

  /** Whether the item's PR is drafted while it is held (#195): `ci.draft_while_held`, and a hold that waits on a person. */
  private draftsWhileHeld(id: string): boolean {
    const item = this.store.requireItem(id);
    const base = this.store.derived(item).base_branch;
    return this.store.config.ci.draft_while_held && holdWaitsOnPerson(item.file.frontmatter, Boolean(base && this.store.config.review.hold_into.includes(base)));
  }

  private orchestratorHolds(id: string, reason: string): string {
    this.store.requireItem(id);
    if (!reason?.trim()) return 'not held: say why, the reason is shown on the item';
    this.store.mutateItem(id, this.holdOps(reason, 'orchestrator'), 'orchestrator', { commit: `${id}: skip merge` });
    return 'held';
  }

  /**
   * Let a held pull request merge: a review hold the user has now approved, or a plain `skip_merge`.
   * The item goes back through the merge pipeline rather than straight to the merge — the base may
   * have moved while it waited. A green run is kept only on evidence that it still describes what
   * would merge (dogfood p15: releases reset it to pending by reflex); anything else is asked again.
   */
  /** The PR head's changed paths against its base (three-dot), with that head: what a review approves. */
  private async changedPaths(id: string): Promise<{ sha: string; paths: string[] } | undefined> {
    const item = this.store.requireItem(id); const fm = item.file.frontmatter; const base = this.store.derived(item).base_branch;
    if (!fm.worktree || !base || !fm.branch) return undefined;
    const cwd = this.absWorktree(fm.worktree);
    const sha = (await this.ports.git.remoteBranchSha(this.repo, fm.branch)) ?? await this.ports.git.revParse(cwd, 'HEAD');
    const paths = (await this.ports.git.changedFiles(cwd, `origin/${base}`, sha)).map((f) => f.path).sort();
    return { sha, paths };
  }

  /**
   * The orchestrator returns a held item to the merge queue (unskip_merge). A change held after review (#74) has its head's
   * paths approved in the same write that drops the hold (#209): read first, so a merge that sees the release never sees
   * the old approved set and holds the same paths again. Paths it cannot read are not approved blind: the hold stays.
   */
  private async orchestratorUnskips(id: string): Promise<string> {
    const fm = this.store.requireItem(id).file.frontmatter;
    // A hold that waits on a person (the user's Approve and hold, review.hold_into, a loop's review) is theirs to release (#339).
    if (fm.skip_merge && fm.hold_waits_on === 'person') return `not permitted: ${id}'s hold waits on the user${heldReasonOf(fm) ? ` (${heldReasonOf(fm)})` : ''}, so only they release it, with Release hold on its page. Nothing was changed. To put it to them, ask with ask_user.`;
    const scoped = Boolean(fm.op_data?.approved_scope);
    const scope = scoped ? await this.changedPaths(id).catch(() => undefined) : undefined;
    if (scoped && !scope) return 'not returned: its changed paths could not be read, so releasing it would not approve them; try again';
    this.store.mutateItem(id, [{ unset: ['skip_merge'] }, { set: { ci_result: 'pending', op_data: this.releasedOpData(id, scope) } }, { activity: { actor: 'orchestrator', text: 'returned to the merge queue' } }], 'orchestrator', { commit: `${id}: unskip merge` });
    return scope ? `returned; its approved change is now ${scope.paths.length} path${scope.paths.length === 1 ? '' : 's'} at ${scope.sha.slice(0, 7)}` : 'returned';
  }

  /** A released hold's op_data, read after the release's awaits so nothing written meanwhile is lost: the hold is waived, and what it approved recorded. */
  private releasedOpData(id: string, scope?: { sha: string; paths: string[] }): Record<string, unknown> {
    return { ...(this.store.requireItem(id).file.frontmatter.op_data ?? {}), hold_waived: true, ...(scope ? { approved_scope: scope } : {}) };
  }

  /** Paths the head about to merge changes that the approved head did not (#74), or none: a CI fix turn or an engine commit after approval. */
  private async outsideApprovedScope(id: string, sha: string): Promise<string[]> {
    const approved = this.store.requireItem(id).file.frontmatter.op_data?.approved_scope as { sha?: string; paths?: string[] } | undefined;
    if (!approved?.paths || approved.sha === sha) return [];
    const now = await this.changedPaths(id).catch(() => undefined);
    if (!now) return [];
    const ok = new Set(approved.paths);
    return now.paths.filter((p) => !ok.has(p));
  }

  async releaseHold(id: string, note?: string): Promise<void> {
    const fm = this.store.requireItem(id).file.frontmatter;
    // A hold put on at approval, or by the worker, before there is a pull request to let through: it is simply dropped (#97).
    if (fm.status === 'IN_PROGRESS' && fm.skip_merge) {
      this.store.mutateItem(id, [{ unset: ['skip_merge'] }, { set: { op_data: { ...(fm.op_data ?? {}), hold_waived: true } } }, { activity: { actor: 'user', text: `hold dropped: its pull request will merge as usual${note?.trim() ? `: ${note.trim()}` : ''}` } }], 'user', { commit: `${id}: release hold` });
      return;
    }
    if (fm.status !== 'IN_REVIEW') throw new Error(`${id} is ${fm.status}; only an item in review can be released to merge`);
    if (!fm.review_hold && !fm.skip_merge) throw new Error(`${id} is not held`);
    if (fm.awaiting && fm.awaiting !== 'review') throw new Error(`${id} is awaiting ${fm.awaiting}; answer that first`);
    const keep = fm.ci_result === 'green' && await this.greenStillCurrent(id).catch(() => false);
    // What was approved (#74, HH-214): the reviewed head's changed paths. A later commit outside them is held before it
    // merges (outsideApprovedScope); releasing that hold approves the new set. Only an item that waited for review has one.
    const scope = fm.review_hold || fm.op_data?.approved_scope ? await this.changedPaths(id).catch(() => undefined) : undefined;
    this.store.mutateItem(id, [
      { unset: ['review_hold', 'skip_merge', ...(fm.awaiting === 'review' ? ['awaiting', 'awaiting_data'] : [])] },
      ...(keep ? [] : [{ set: { ci_result: 'pending' as const } }]),
      { set: { op_data: this.releasedOpData(id, scope) } },
      { activity: { actor: 'user', text: `approved for merge${note?.trim() ? `: ${note.trim()}` : ''}` } },
      ...(keep ? [{ activity: { actor: 'app' as const, text: `CI stays green: ${fm.ci_head_sha!.slice(0, 7)} is still the PR's head and on its base's tip, so it merges without a new run` } }] : []),
    ], 'user', { commit: `${id}: release hold` });
    void this.tick();
  }

  /** Evidence, not memory: the green head is still the PR branch and the worktree, and it sits on the base tip after a fresh fetch. */
  private async greenStillCurrent(id: string): Promise<boolean> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const base = this.store.derived(item).base_branch;
    if (!fm.ci_head_sha || !fm.branch || !fm.worktree || !base) return false;
    await this.ports.git.fetch(this.repo);
    const cwd = this.absWorktree(fm.worktree);
    const [remote, local, { behind }] = await Promise.all([this.ports.git.remoteBranchSha(this.repo, fm.branch), this.ports.git.revParse(cwd, 'HEAD'), this.ports.git.aheadBehind(cwd, `origin/${base}`, 'HEAD')]);
    return remote === fm.ci_head_sha && local === remote && behind === 0;
  }

  /**
   * User-driven "close as done": the work landed some other way, so the item finishes without a
   * pull request. The worktree and branch are removed only on positive evidence that they hold
   * nothing (invariant 7: a clean tree and no commit ahead of a freshly fetched base); anything
   * else is left in place and named in the Activity log — closing never discards work.
   */
  // ---- discard (#135, HH-286) ----
  /** Why this item cannot be discarded, or null. Only work planestro is doing on a worker item: an epic, an external item and finished work are not. */
  discardRefusal(id: string): string | null {
    const item = this.store.getItem(id);
    if (!item) return `there is no item ${id}`;
    const fm = item.file.frontmatter; const d = this.store.derived(item);
    if (d.flavor === 'epic') return `${id} is an epic: discard its children, or icebox it before it opens`;
    if (d.flavor === 'external') return `${id} is implemented outside planestro: icebox it, or close it as done`;
    // An iceboxed child is discarded to let its epic finish without it: that only takes it off the epic.
    const icedChild = fm.status === 'ICEBOX' && Boolean(fm.parent);
    if (!icedChild && (!findTransition(fm.status, 'ICEBOX', 'user', d.flavor) || fm.status === 'NOT_YET_SUBMITTED')) return `${id} is ${fm.status}; only work in progress (queued through in review), or an iceboxed epic child, is discarded`;
    if (this.jobs.has(id) && !this.turns.has(id)) return `${id} has a step running (${fm.op?.replace(/_/g, ' ') ?? 'an engine step'}); discard it when that ends`;
    return null;
  }

  /** What the Discard dialog shows: its branch, whether that is on the remote and at which tip (the delete is leased to it), and its pull request. */
  async discardPreview(id: string): Promise<{ refusal: string | null; branch?: string; remote_sha: string | null; pr?: number }> {
    const fm = this.store.requireItem(id).file.frontmatter;
    const refusal = this.discardRefusal(id);
    const remote = !refusal && fm.branch ? await this.ports.git.remoteBranchSha(this.repo, fm.branch).catch(() => null) : null;
    return { refusal, ...(fm.branch ? { branch: fm.branch } : {}), remote_sha: remote, ...(fm.pr ? { pr: fm.pr } : {}) };
  }

  /**
   * Discard (#135): the user drops work planestro is doing. A live turn is stopped (and waited for), the pull
   * request closed with the reason, and the item taken off its epic and put in the icebox, so the epic does not
   * wait on it. The branch on the remote is deleted only on the user's word (`deleteBranch`), and only at the
   * tip they were shown (`expectSha`, leased): a commit since then keeps it. The tips go in the Activity log
   * first, so a deleted branch can be restored. Uncommitted files are set aside in .displaced/, never deleted.
   * Without deleteBranch the local worktree and branch go only on positive evidence (invariant 7): a clean tree
   * whose HEAD is what the remote holds. Returns what happened, in words; throws only before anything is changed.
   */
  async discard(id: string, reason: string, opts: { deleteBranch?: boolean; expectSha?: string; from?: string } = {}): Promise<string> {
    const why = reason.trim();
    if (!why) throw new Error('say why it is discarded: it goes on the closed pull request');
    let refusal = this.discardRefusal(id);
    if (refusal) throw new Error(refusal);
    // A live turn is stopped and waited for: nothing is removed under a running session.
    if (this.turns.has(id)) {
      const { ops, said } = this.stopSessionWork(id, 'you discarded this item');
      if (ops.length || said.length) this.store.mutateItem(id, [...ops, { activity: { actor: 'app', text: `discarding: stopped ${said.join(', ')}` } }], 'engine');
      await this.jobs.get(id)?.catch(() => undefined);
      refusal = this.discardRefusal(id);
      if (refusal) throw new Error(refusal);
    }
    let release!: () => void;
    this.jobs.set(id, new Promise<void>((r) => { release = r; }));
    try {
      const fm = this.store.requireItem(id).file.frontmatter;
      const said: string[] = [];
      const brief = (e: unknown) => (e as Error).message.replace(/\s+/g, ' ').slice(0, 200);
      if (fm.pr) {
        const pr = await this.ports.gh.prView(this.github, fm.pr);
        if (pr.state === 'MERGED') throw new Error(`its pull request #${fm.pr} has merged: it is not discarded`);
        if (pr.state === 'OPEN') { await this.ports.gh.closePr(this.github, fm.pr, `Discarded in planestro: ${why}`); said.push(`closed pull request #${fm.pr}`); }
        else said.push(`pull request #${fm.pr} was already closed`);
      }
      const { ops } = this.stopSessionWork(id, 'you discarded this item');
      const unset = ['blocked', 'blocked_reason', 'parent', 'resume_after'];
      let removed = false;
      if (fm.worktree && fm.branch) {
        const cwd = this.absWorktree(fm.worktree); const branch = fm.branch;
        const remote = await this.ports.git.remoteBranchSha(this.repo, branch).catch(() => null);
        const head = await this.ports.git.revParse(cwd, 'HEAD').catch(() => null);
        if (opts.deleteBranch && remote) {
          if (opts.expectSha && remote !== opts.expectSha) said.push(`kept branch ${branch}: it moved to ${remote.slice(0, 7)} after you looked (${opts.expectSha.slice(0, 7)}), and nothing on it was deleted`);
          else {
            // The tips first: a deleted branch is restored from these (GitHub's "Restore branch", or git push origin <sha>:refs/heads/<branch>).
            this.store.mutateItem(id, [{ activity: { actor: 'app', text: `deleting branch ${branch}: remote tip ${remote}${head && head !== remote ? `, local tip ${head}` : ''}` } }], 'engine');
            const r = await this.ports.git.deleteRemoteBranchAt(this.repo, branch, remote);
            if (r === 'moved') said.push(`kept branch ${branch}: it moved on the remote while it was being deleted`);
            else {
              said.push(r === 'deleted' ? `deleted branch ${branch} on the remote (tip ${remote.slice(0, 7)})` : `branch ${branch} was already gone from the remote`);
              try {
                const w = await this.worktreeDirt(cwd); const dirty = [...w.dirty, ...w.byproducts];
                const aside = dirty.length ? join(this.store.worktreesRoot(), '.displaced', `${branch.replace(/[\/\\]/g, '-')}-${this.now().replace(/[:+]/g, '-')}`) : undefined;
                if (aside) { await this.ports.git.moveAside(cwd, dirty, aside); said.push(`set ${dirty.length} uncommitted file${dirty.length === 1 ? '' : 's'} aside in ${relative(this.repo, aside)}`); }
                // What git ignores goes with a forced remove: worktrees.keep_on_remove is set aside first, as cleanup does (invariant 7).
                const kept = await this.cleanupReconcile.setAsideBeforeRemove(id, cwd); if (kept) said.push(kept);
                await this.ports.git.worktreeRemove(this.repo, cwd, true);
                await this.ports.git.worktreePrune(this.repo);
                await this.ports.git.deleteLocalBranch(this.repo, branch, head);
                removed = true; said.push('removed its worktree and local branch');
              } catch (e) { said.push(`removing its worktree stopped partway (${brief(e)}); finish it by hand`); }
            }
          }
        } else {
          const clean = await this.worktreeDirt(cwd).then((w) => w.clean).catch(() => false);
          if (!remote) said.push(`kept its worktree and branch ${branch}: the branch is not on the remote, so they are the only copy`);
          else if (!clean) said.push(`kept its worktree and branch ${branch}: it has uncommitted changes`);
          else if (head !== remote) said.push(`kept its worktree and branch ${branch}: its local commits are not all on the remote`);
          else {
            try { const kept = await this.cleanupReconcile.setAsideBeforeRemove(id, cwd); if (kept) said.push(kept); await this.ports.git.worktreeRemove(this.repo, cwd, false); await this.ports.git.worktreePrune(this.repo); await this.ports.git.deleteLocalBranch(this.repo, branch, head); removed = true; said.push(`removed its worktree and local branch (everything is on the remote branch ${branch}, which is kept)`); }
            catch (e) { said.push(`removing its worktree stopped partway (${brief(e)}); finish it by hand`); }
          }
        }
      }
      if (removed) unset.push('worktree', 'branch', 'session_id', 'session_context', 'pr', 'ci_result');
      else if (fm.pr) unset.push('pr', 'ci_result');
      const from = fm.parent;
      this.store.mutateItem(id, [
        ...ops,
        ...(fm.status === 'ICEBOX' ? [] : [{ transition: { to: 'ICEBOX', actor: 'user' } } as ItemOp]),
        { unset },
        { activity: { actor: 'user', text: `discarded${opts.from ? ` by ${opts.from}` : ''}: ${why}` } },
        { activity: { actor: 'app', text: [...(from ? [`taken off epic ${from}`] : []), ...said].join('; ') || 'nothing else to undo' } },
      ], 'user', { commit: `${id}: discard` });
      if (from && this.store.getItem(from)) this.store.mutateItem(from, [{ activity: { actor: 'app', text: `${id} discarded: ${why}. It is no longer one of this epic's children.` } }], 'engine', { commit: `${from}: ${id} discarded` });
      this.note('info', `${id}: discarded`);
      return [`${id} discarded`, ...(from ? [`taken off epic ${from}`] : []), ...said].join('; ');
    } finally { this.jobs.delete(id); release(); void this.tick(); }
  }

  /** Why this item cannot be closed as done, or null: what closeAsDone would throw. A card option that closes it is checked with it (#126). */
  closeAsDoneRefusal(id: string): string | null {
    const item = this.store.getItem(id);
    if (!item) return `there is no item ${id}`;
    const fm = item.file.frontmatter;
    if (!findTransition(fm.status, 'FINISHED', 'user', this.store.derived(item).flavor)) return `${id} is ${fm.status}; it cannot be closed as done from there`;
    if (fm.pr) return `${id} has pull request #${fm.pr}; merge or close that instead`;
    if (this.turns.has(id) || this.jobs.has(id)) return `${id} has a step running; wait for it to park, then close it`;
    return null;
  }

  async closeAsDone(id: string, reason?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const d = this.store.derived(item);
    const refusal = this.closeAsDoneRefusal(id);
    if (refusal) throw new Error(refusal);
    const left = d.flavor === 'worker' && fm.worktree && fm.branch ? await this.cleanupReconcile.releaseUnusedWorktree(this.absWorktree(fm.worktree), fm.branch, d.base_branch) : undefined;
    this.store.mutateItem(id, [
      { transition: { to: 'FINISHED', actor: 'user' } },
      { activity: { actor: 'user', text: `closed as done without a pull request${reason?.trim() ? `: ${reason.trim()}` : ''}` } },
      ...(left ? [{ activity: { actor: 'app' as const, text: left } }] : []),
    ], 'user', { commit: `${id}: close as done` });
    this.note('info', `${id}: closed as done`);
    void this.tick();
  }

  // ---- item ↔ epic (#69, HH-198) ----
  /**
   * Change an item's kind while nothing has run for implementation (kindConversionRefusal says where).
   * Its description stays; its plan (or an epic's breakdown) moves to Notes, which the other kind's
   * planner reads; its planning checkout is removed only on positive evidence that it holds nothing
   * (invariant 7), and work in it refuses the conversion. What was not yet submitted stays in the
   * backlog; what was, carries on as the new kind: an epic has its breakdown planned (planEpic), an
   * item is queued. Returns what happened, in words.
   */
  async convertKind(id: string, to: 'item' | 'epic', by: 'user' | 'orchestrator' = 'user', why?: string): Promise<string> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const busy = this.turns.has(id) || this.jobs.has(id);
    // A plan review is decided while the planner's turn is still ending (as approvePlan): the conversion waits for that turn.
    const winding = busy && fm.status === 'PLAN_READY';
    const refused = kindConversionRefusal(winding ? { ...fm, op: undefined } : fm, to, this.store.derived(item).children.length);
    if (refused) throw new Error(`not converted: ${refused}`);
    const as = to === 'epic' ? 'an epic' : 'an item';
    if (winding) {
      this.queueFollowUp(id, async () => {
        try { const out = await this.convertHeld(id, to, by, why); if (out.plan) await out.plan(); else this.poke(); }
        catch (e) { this.store.mutateItem(id, [{ activity: { actor: 'app', text: (e as Error).message } }], 'engine'); }
      });
      return `${id} converts to ${as} as soon as its planning turn has ended`;
    }
    if (busy) throw new Error(`not converted: ${id} has a turn or step running; convert it once it has parked`);
    // Held as the item's job while its checkout is checked and removed, so no admission, turn or wake starts on it meanwhile.
    let release!: () => void;
    this.jobs.set(id, new Promise<void>((r) => { release = r; }));
    let out: { said: string; plan?: () => Promise<void> };
    try { out = await this.convertHeld(id, to, by, why); } finally { this.jobs.delete(id); this.followUps.delete(id); this.slots.pendingWakes.delete(id); release(); }
    if (out.plan) this.runJob(id, out.plan); else this.poke();
    return out.said;
  }

  /** The conversion itself, by whoever holds the item's job slot; `plan` is an epic's breakdown turn, to run in that slot. */
  private async convertHeld(id: string, to: 'item' | 'epic', by: 'user' | 'orchestrator', why?: string): Promise<{ said: string; plan?: () => Promise<void> }> {
    const item = this.store.requireItem(id);
    const refused = kindConversionRefusal(item.file.frontmatter, to, this.store.derived(item).children.length);
    if (refused) throw new Error(`not converted: ${refused}`);
    const out = await this.convertNow(id, to, by, why);
    const plan = out.next === 'plan' ? this.epics.beginEpicPlan(id, 'converted to an epic, so its planner breaks it down') : undefined;
    if (out.next === 'queue') this.store.transition(id, 'QUEUED', by);
    const said = `${out.said}${plan ? '; its breakdown is being planned' : out.next === 'queue' ? '; queued to be planned as one item' : ''}`;
    this.note('info', said);
    return { said, plan };
  }

  private async convertNow(id: string, to: 'item' | 'epic', by: 'user' | 'orchestrator', why?: string): Promise<{ said: string; next?: 'plan' | 'queue' }> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    const was = fm.kind ?? 'item';
    let released: string | undefined;
    if (fm.worktree) {
      const cwd = this.absWorktree(fm.worktree);
      if (was === 'epic') {
        // An epic's planning checkout is detached and was only ever read: a clean tree is the whole proof (as approveBreakdown).
        const st = await this.ports.git.status(cwd).catch(() => undefined);
        if (st && !st.clean) throw new Error(`not converted: the breakdown's planning checkout ${fm.worktree} has uncommitted changes`);
        if (st) { await this.ports.git.worktreeRemove(this.repo, cwd, false); await this.ports.git.worktreePrune(this.repo); released = `removed the breakdown's read-only planning checkout ${fm.worktree}`; }
      } else if (fm.branch) {
        const unused = await this.cleanupReconcile.unusedWorktree(cwd, fm.branch, this.store.derived(item).base_branch);
        if ('keep' in unused) throw new Error(`not converted: ${id}'s worktree ${fm.worktree} may hold work (${unused.keep}), and nothing with work in it is removed. Clear it by hand first, or keep it as an item`);
        released = await this.cleanupReconcile.removeUnusedWorktree(cwd, fm.branch, this.store.derived(item).base_branch!, unused.remote, unused.local);
      }
    }
    // The text crosses over: the new kind's planner reads Notes (plan-item and plan-epic both quote them).
    const plan = getSection(item.file, 'Plan').trim();
    const proposed = (was === 'epic' ? fm.awaiting_data?.children : epicFlagOf(fm)?.children) as ProposedChild[] | undefined;
    const carried = plan || proposed?.length ? [
      `### ${was === 'epic' ? 'Breakdown proposed while this was an epic' : 'Plan written while this was one item'} (converted ${this.now().slice(0, 10)})`, '',
      to === 'epic' ? 'Its planner planned this request as one item. Start the breakdown from it: keep what holds, and split the work into children.' : 'The epic planner proposed this before it became one item. Plan it as one piece of work; the children only show how the work divides.',
      ...(plan ? ['', plan] : []),
      ...(proposed?.length ? ['', 'Children proposed:', ...proposed.map((c, i) => `- ${i}: **${c.title}**${c.implementer ? ` (${c.implementer})` : ''}${c.depends_on?.length ? `, after ${c.depends_on.join(', ')}` : ''}${c.description ? ` — ${c.description}` : ''}`)] : []),
    ].join('\n') : '';
    const notes = getSection(item.file, 'Notes').trim();
    const reset = fm.status !== 'NOT_YET_SUBMITTED' && fm.status !== 'ICEBOX';
    const a = (text: string, actor: 'user' | 'orchestrator' | 'app' = by): ItemOp => ({ activity: { actor, text } });
    this.store.mutateItem(id, [
      // Not a lifecycle transition: the item starts over as the other kind, from the backlog (or stays in the icebox).
      { set: { kind: to, ...(reset ? { status: 'NOT_YET_SUBMITTED' as const } : {}) } },
      // What belonged to the other kind's planning goes with it; the new planner starts a conversation of its own.
      { unset: ['worktree', 'branch', 'session_id', 'agent_sessions', 'op', 'op_started_at', 'op_data', 'awaiting', 'awaiting_data', 'triage', 'blocked', 'blocked_reason', 'resume_after', 'plan_revisions', 'skip_merge', 'hold_reason'] },
      ...(carried ? [{ section: 'Notes', body: notes ? `${notes}\n\n${carried}` : carried }, { section: 'Plan', body: '' }] : []),
      ...(reset ? [a(`status ${fm.status} → NOT_YET_SUBMITTED`)] : []),
      a(`converted to ${to === 'epic' ? 'an epic' : 'an item'}${why?.trim() ? `: ${why.trim()}` : ''}${carried ? `. The ${was === 'epic' ? 'breakdown' : 'plan'} is kept in Notes for its new planner` : ''}`),
      ...(released ? [a(released, 'app')] : []),
    ], by, { commit: `${id}: convert to ${to}` });
    const said = `${id} converted to ${to === 'epic' ? 'an epic' : 'an item'}${released ? ` (${released})` : ''}`;
    if (!reset) return { said };
    if (to === 'epic') return { said, next: 'plan' };
    const d = this.store.derived(this.store.requireItem(id));
    if (d.flavor === 'worker' && d.deps_satisfied && !d.base_branch_error) return { said, next: 'queue' };
    return { said: `${said}; left in the backlog (${d.flavor !== 'worker' ? 'an external item is not planned' : d.base_branch_error ?? 'its dependencies are not merged yet'})` };
  }

  // ---- take-over: a person finishes the item by hand (dogfood p28) ----
  /**
   * Everything that would drive this item's session, stopped: the live turn is aborted through its
   * own controller (its runTurnFor ends as `killed`, so nothing is left waiting on anyone), and the
   * turn queued behind it, a triage wake held for it, queued messages, a one-shot resume, a parked
   * request of the session's and triage are dropped. Returns the ops that clear what is persisted,
   * and what was stopped, in words.
   */
  private stopSessionWork(id: string, why: string): { ops: ItemOp[]; said: string[] } {
    const fm = this.store.requireItem(id).file.frontmatter;
    const said: string[] = [];
    const turn = this.turns.get(id);
    if (turn) { this.scheduler.stoppedFor.set(id, why); turn.abort.abort(); said.push(`its ${turn.phase} turn`); }
    const followUp = this.followUps.delete(id);
    if (followUp) said.push('the turn queued behind it');
    const { pending_turn: deferred, active_turn: _active, ...keptData } = fm.op_data ?? {};
    if (deferred && !followUp) said.push('its deferred instruction');
    if (this.slots.pendingWakes.delete(id)) said.push('an orchestrator wake');
    this.scheduler.idleSince.delete(id);
    const pending = (fm.op_data?.pending_messages as string[] | undefined) ?? [];
    if (pending.length) said.push(`${pending.length} queued message${pending.length === 1 ? '' : 's'}`);
    if (fm.resume_after) said.push(`the resume after ${waitsFor(fm.resume_after)}`);
    const parked = fm.awaiting === 'permission' || fm.awaiting === 'question' || fm.awaiting === 'audition' || (fm.awaiting === 'orchestrator' && fm.awaiting_data?.kind === 'permission');
    if (parked) said.push(`its parked ${fm.awaiting === 'question' ? 'question' : fm.awaiting === 'audition' ? 'audition' : 'permission request'}`);
    if (fm.triage) said.push('triage');
    const unset = [...(fm.resume_after ? ['resume_after'] : []), ...(fm.triage ? ['triage'] : []), ...(parked ? ['awaiting', 'awaiting_data'] : [])];
    return { said, ops: [
      ...(deferred !== undefined || _active !== undefined || pending.length ? [{ set: { op_data: { ...keptData, pending_messages: [] } } } as ItemOp] : []),
      ...(unset.length ? [{ unset } as ItemOp] : []),
    ] };
  }

  // ---- review and Undo (#404, seam 2): per-turn checkpoints and Undo last turn (#234) live in reviewUndo.ts ----
  /** What the Undo dialog shows (ReviewUndo.undoTurnPreview). */
  undoTurnPreview(id: string): Promise<UndoTurnPreview> { return this.reviewUndo.undoTurnPreview(id); }
  /** Undo last turn, user-only, on positive evidence (ReviewUndo.undoTurn). */
  undoTurn(id: string, expect: string): Promise<string> { return this.reviewUndo.undoTurn(id, expect); }

  /**
   * "I'm taking this over": the person finishes the item by hand. Its session is stopped and what was
   * queued for it dropped (stopSessionWork); a block, a decision card or a review wait is theirs now
   * and is cleared with it, and a plan waiting for approval stays waiting. Until handBack nothing
   * automatic drives it: no admission, turn, orchestrator wake, stall, triage, fix turn or merge.
   * Its CI is still read. User-only: the orchestrator's tools refuse the item instead.
   */
  async takeOver(id: string, note?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (fm.taken_over) throw new Error(`${id} is already yours`);
    if (this.store.derived(item).flavor !== 'worker' || !['QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'].includes(fm.status)) throw new Error(`${id} is ${fm.status}; only a worker item planestro is driving can be taken over`);
    const { ops, said } = this.stopSessionWork(id, 'you took this item over');
    const theirs = fm.awaiting === 'user' || fm.awaiting === 'review';
    if (fm.blocked) said.push(`its block (${fm.blocked_reason ?? 'blocked'})`);
    if (fm.op_data?.needs_session_rebase) said.push('the conflict handed to its session');
    this.store.mutateItem(id, [
      ...ops,
      { set: { taken_over: { since: this.now(), ...(note?.trim() ? { note: note.trim() } : {}) } } },
      ...(fm.blocked || theirs ? [{ unset: ['blocked', 'blocked_reason', ...(theirs ? ['awaiting', 'awaiting_data'] : [])] } as ItemOp] : []),
      // A plan the orchestrator was reviewing is the person's to approve while they have the item; the hand-back delegates it again.
      ...(fm.status === 'PLAN_READY' && fm.awaiting === 'orchestrator' ? [{ set: { awaiting: 'plan_approval' } } as ItemOp] : []),
      { activity: { actor: 'user', text: `took this item over by hand${note?.trim() ? `: ${note.trim()}` : ''}${said.length ? `; stopped ${said.join(', ')}` : ''}. Nothing automatic drives it until you hand it back.` } },
    ], 'user', { commit: `${id}: take over` });
    this.heldPolledAt.delete(id);
    this.note('info', `${id}: taken over by hand${said.length ? ` (stopped ${said.join(', ')})` : ''}`);
  }

  /**
   * The person is done with it. planestro carries on from the item as it is now (invariant 3), by
   * the doors it already has: an item in review re-enters the merge pipeline (its CI is asked for
   * again, for whatever head it now has); work planning or in progress takes the stall check, so a
   * clean worktree ahead of its base goes to a pull request and anything else resumes the session,
   * told that someone else had the worktree; a merged one is cleaned up on positive evidence.
   */
  async handBack(id: string, note?: string): Promise<void> {
    const item = this.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (!fm.taken_over) throw new Error(`${id} is not taken over`);
    const said = note?.trim() ? `: ${note.trim()}` : '';
    const inReview = fm.status === 'IN_REVIEW' && Boolean(fm.pr);
    const carryOn = ['PLAN_IN_PROGRESS', 'IN_PROGRESS'].includes(fm.status) && Boolean(fm.worktree);
    const next = inReview ? 'it re-enters the merge pipeline' : carryOn ? 'planestro carries on from where the work stands' : fm.status === 'MERGED' ? 'its merged branch is cleaned up' : 'planestro drives it again';
    const opData = LiveEngine.withoutDirtyCount(fm.op_data);
    this.store.mutateItem(id, [
      { unset: ['taken_over'] },
      ...(opData !== fm.op_data ? [{ set: { op_data: opData } } as ItemOp] : []),
      ...(inReview ? [{ set: { ci_result: 'pending', op_data: { ...(opData ?? {}), needs_session_rebase: false } } } as ItemOp] : []),
      { activity: { actor: 'user', text: `handed back to planestro${said}; ${next}` } },
    ], 'user', { commit: `${id}: hand back` });
    // queued, not dropped: the turn the take-over stopped may still be winding down
    if (fm.status === 'MERGED') this.queueFollowUp(id, () => this.cleanupReconcile.cleanup(id));
    else if (carryOn) this.queueFollowUp(id, () => this.carryOnStalled(id, { why: 'handed back', who: 'the user handing the item back', say: `The user took this item over and worked on it by hand, and has now handed it back to you${said}. Your worktree may have changed while they had it: check \`git status\` and \`git log\` first, then continue from where the work stands.` }));
    else void this.tick();
  }

  /**
   * The user moved the item into review by hand (they opened its pull request themselves): its
   * session's work is over, so a live turn is stopped and what was queued for it dropped, as a
   * take-over does. Left running, HH-136's worker hit the person's half-made edits and blocked an
   * item that was by then in review with its PR (dogfood p28).
   */
  stopForReview(id: string): void {
    const { ops, said } = this.stopSessionWork(id, 'the item was moved into review by hand');
    if (!said.length) return;
    this.store.mutateItem(id, [...ops, { activity: { actor: 'app', text: `moved into review by hand: stopped ${said.join(', ')}` } }], 'engine', { commit: `${id}: stop the session (moved to review)` });
  }




  private absWorktree(rel: string): string { return isAbsolute(rel) ? rel : join(this.repo, rel); }

  private note(level: 'info' | 'warn' | 'error', message: string): void {
    const e: ServerEvent = { type: 'engine.log', level, message };
    this.log.push(e); if (this.log.length > 500) this.log.shift();
    this.emit(e);
  }
}
