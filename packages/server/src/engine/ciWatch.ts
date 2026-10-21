import { getSection, fenceExternal, timeoutKilledIn } from '@planestro/shared';
import type { DataStore } from '../store/DataStore.ts';
import type { Ports, TurnPhase, CiQueue, RunnerReport } from './ports.ts';
import type { BaseSync } from './baseSync.ts';
import { findWorkflow, infraPatternIn, prSkippedByPaths } from './ciFilters.ts';
import { TRANSIENT } from './transient.ts';
import { runnerStatusText, stallOf, recovered, type RunnerStall } from './runners.ts';
import { recordCiResult } from '../concurrency.ts';

/**
 * CI watching (#404, seam 8): reading CI for a head, outside the serial merge chain. The wait itself (waitForCi, pollCi: a
 * just-pushed head's propagation lag, a run queued for a runner, skipped and cancelled runs, a project whose CI does not run
 * for the change, a GitHub outage waited through), the run's timing (#179) and each attempt's verdict journaled as
 * `ci.result` (#330); a red run (onCiRed): a known flake or the infrastructure's re-run once per head (#219), the session's
 * no-change report re-run once, then ci_red_parked (onSameRedRun, #201); rerun_ci (#139, #174); runners that look stalled or
 * offline, said once per label (#216); and the item in review that nothing moves (review_stalled, #201). What each verdict
 * does to the merge (watchCi) stays with the merge pipeline; the runner report itself is shared with heavy runs, so it
 * stays in LiveEngine, and the CI queue's reading is admission's (Scheduler). LiveEngine owns one and delegates to it; this is what
 * it needs from the engine, and nothing more.
 */
export interface CiWatchContext {
  readonly store: DataStore;
  readonly ports: Pick<Ports, 'git' | 'gh'>;
  /** `owner/repo` of the code repo (throws when code_repo.github is not configured). */
  readonly github: string;
  /** The project's CI workflow, by name. */
  readonly ciWorkflow: string;
  /** Read live: a CI wait ends ('stopping') when the engine stops. */
  readonly stopping: boolean;
  /** Turns this engine started, items with a job in flight and jobs queued behind them: read only (a session or step on the item is something coming). */
  readonly turns: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<string, unknown>;
  readonly followUps: ReadonlyMap<string, unknown>;
  /** The workflow's queue repository-wide, as admission control last read it (#170). */
  readonly ciQueue: CiQueue | undefined;
  /** An epic's red that is likely its base's waits for the base (#204). */
  readonly baseSync: Pick<BaseSync, 'waitForBaseFix'>;
  now(): string;
  sleep(ms: number): Promise<void>;
  absWorktree(rel: string): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  block(id: string, reason: string, detail: string): void;
  tick(): Promise<void>;
  poke(): void;
  /** Why an item cannot take a step now (a job or a turn running), or undefined. */
  busyWith(id: string): string | undefined;
  queueTurn(id: string, phase: TurnPhase, prompt: string, extraAllowed: string[], oneShotCommands: string[], opts: { fresh?: true | 'auto' }): void;
  wakeOrchestrator(type: string, item?: string, data?: Record<string, unknown>): void;
  /** A runner taking jobs again sends the items it blocked back to CI. */
  retryOp(id: string, by: 'engine', message?: string): Promise<string>;
  /** The workflow's queue, read at most once a minute. */
  refreshCiQueue(): Promise<CiQueue | undefined>;
  /** The runners' state (#216), cached; `maxAgeMs` is how old a reading the caller accepts. */
  readRunners(maxAgeMs?: number): Promise<{ report: RunnerReport; at: string } | undefined>;
}

/** The newest Activity line that says something moved: planestro, the session or a person, not the orchestrator's own notes (#201). */
function lastMovingLine(activity: string): { ts: string; at: number; text: string } | undefined {
  const lines = activity.split('\n').filter((l) => l.startsWith('- '));
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^- (\S+) \[([^\]]+)\] (.*)$/.exec(lines[i]);
    if (!m || m[2] === 'orchestrator') continue;
    const at = Date.parse(m[1]);
    if (Number.isFinite(at)) return { ts: m[1], at, text: m[3].slice(0, 300) };
  }
  return undefined;
}
/** How old a runner reading planestro's own stall checks accept (#216): each read costs a GitHub call per open run. */
const RUNNER_CHECK_MS = 2 * 60_000;
/** How long a just-pushed head may still read as the old sha from `gh pr view` before it counts as a real move. */
const HEAD_PROPAGATION_GRACE_MS = 90_000;
/**
 * Polls in a row (10 s apart) that find only skipped runs for a ready PR's head before planestro
 * sends ready_for_review again. GitHub starts the event's run within seconds; a minute of nothing
 * but skipped runs means the event landed on another head, and no run is coming by itself.
 */
const SKIPPED_REFIRE_POLLS = 6;
/** Polls in a row that the head's newest run stays cancelled before planestro re-runs it (about a minute at the start). */
const CANCELLED_RERUN_POLLS = 6;

export class CiWatch {
  constructor(private readonly ctx: CiWatchContext) {}

  /** What the last CI poll of each item's wait saw, and when: a run queued or running is something coming (#201). */
  private ciSeen = new Map<string, { state: string; at: number }>();
  private reviewIdleSince = new Map<string, number>();

  /**
   * The backstop for an item in review that nothing moves (#201): no CI queued or running, no session, no stop, and no
   * Activity from planestro, the session or the user for `ci.stall_wake_min`. HH-383 sat on a red run for 7½ hours that
   * way. The orchestrator is woken once per stall (keyed by the last line that moved it), never to act by itself.
   */
  driveReviewStalls(): void {
    const after = this.ctx.store.config.ci.stall_wake_min * 60_000;
    if (!after) return;
    const now = Date.now();
    const looked = new Set<string>();
    for (const item of this.ctx.store.listItems()) {
      const fm = item.file.frontmatter;
      if (fm.status !== 'IN_REVIEW' || fm.kind === 'epic' || fm.blocked || fm.awaiting || fm.triage || fm.taken_over || fm.skip_merge || fm.resume_after) continue;
      if (this.ctx.store.derived(item).flavor === 'external' || fm.op === 'running_local_checks') continue;
      // Driven: a session, a step other than a CI wait, or a wait that has not polled yet or last saw its run queued or running.
      const seen = this.ciSeen.get(item.id);
      const waiting = this.ciWaits.has(item.id);
      const driven = this.ctx.turns.has(item.id) || this.ctx.followUps.has(item.id) || (this.ctx.jobs.has(item.id) && !waiting)
        || (waiting && (!seen || seen.state === 'pending')) || (seen?.state === 'pending' && now - seen.at < 2 * 60_000);
      looked.add(item.id);
      if (driven) { this.reviewIdleSince.delete(item.id); continue; }
      // Undriven across ticks, not between two steps (a restart clears an op a tick before its job starts again).
      const since = this.reviewIdleSince.get(item.id) ?? now;
      this.reviewIdleSince.set(item.id, since);
      if (now - since < Math.min(after, 60_000)) continue;
      const last = lastMovingLine(getSection(item.file, 'Activity'));
      if (!last || now - last.at < after) continue;
      const mark = `${fm.ci_head_sha ?? ''}@${last.ts}`;
      if (fm.op_data?.review_stalled === mark) continue;
      const idleMin = Math.round((now - last.at) / 60_000);
      const run = fm.op_data?.ci as { runId?: number; url?: string } | undefined;
      this.ctx.store.mutateItem(item.id, [{ set: { op_data: { ...(fm.op_data ?? {}), review_stalled: mark } } }], 'engine');
      this.ctx.note('warn', `${item.id}: in review with nothing moving it for ${idleMin} min; waking the orchestrator`);
      this.ctx.wakeOrchestrator('review_stalled', item.id, {
        idle_min: idleMin, ci_result: fm.ci_result ?? 'none', ...(run?.url ? { run: run.url } : {}), head: fm.ci_head_sha ?? '', last_activity: last.text,
        note: 'Nothing is driving this item: no CI run is queued or running, no session turn, no stop. Read its Activity and CI, then act (rerun_ci, retry_op, message_session, unblock_item) or ask the user.',
      });
    }
    for (const id of this.reviewIdleSince.keys()) if (!looked.has(id)) this.reviewIdleSince.delete(id);
  }

  /**
   * The timing of the run a CI wait ended on (#179): each attempt's creation, queue, first job start and end, its jobs as
   * GitHub names them, and the re-runs planestro or a person asked for on this head, with why. Kept in `op_data.ci_timing`
   * and on the wait's `op.end` (`timing`); `ci.result` stays the per-attempt verdict, joined to it by run id and attempt.
   * Read once the wait is over, never while it polls; a port or run it cannot read records what it has.
   */
  async noteCiTiming(id: string, opId: string, headSha: string): Promise<void> {
    const fm = this.ctx.store.getItem(id)?.file.frontmatter;
    const run = fm?.op_data?.ci as { runId?: number; url?: string; attempt?: number; sha?: string } | undefined;
    if (!fm || !run?.runId || (run.sha && run.sha !== headSha)) return;
    const od = fm.op_data ?? {};
    const reruns: Record<string, unknown>[] = [];
    if (od.ci_cancel_rerun === headSha) reruns.push({ reason: 'cancelled', by: 'app' });
    const flake = od.flake_rerun as { sha?: string; attempt?: number; check?: string } | undefined;
    if (flake?.sha === headSha) reruns.push({ reason: flake.check?.startsWith('infrastructure') ? 'infrastructure' : flake.check === 'no change from the session' ? 'same_red' : 'flaky', by: 'app', ...(flake.attempt ? { attempt: flake.attempt } : {}), ...(flake.check ? { check: flake.check } : {}) });
    const asked = od.ci_rerun as { sha?: string; attempt?: number; by?: string } | undefined;
    if (asked?.sha === headSha && !(asked.by === 'app' && flake?.sha === headSha && flake.attempt === asked.attempt)) reruns.push({ reason: 'rerun_ci', by: asked.by ?? 'user', ...(asked.attempt ? { attempt: asked.attempt } : {}) });
    const last = run.attempt ?? 1;
    const attempts: unknown[] = [];
    if (this.ctx.ports.gh.runTiming) for (let n = Math.max(1, last - 4); n <= last; n++) {
      const t = await this.ctx.ports.gh.runTiming(this.ctx.github, run.runId, n).catch(() => undefined);
      if (t) attempts.push(t);
    }
    const timing = { run_id: run.runId, attempt: last, head: headSha, ...(run.url ? { url: run.url } : {}), attempts, reruns };
    this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), ci_timing: timing } } }], 'engine');
    this.ctx.store.journal.note(opId, { timing });
  }

  /**
   * A known flake gets one re-run of its failed jobs for this head before a session is paid to "fix"
   * it (HH-122's atlas_layout_check: an 80 ms wall-clock bound on a 2-vCPU runner). Returns the
   * attempt to wait for, or undefined when this red is to be handled as a red.
   */
  async rerunIfFlaky(id: string, headSha: string): Promise<number | undefined> {
    const patterns = this.ctx.store.config.ci.flaky_checks;
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const ci = fm.op_data?.ci as { runId?: number; attempt?: number } | undefined;
    if (!patterns.length || !ci?.runId || (fm.op_data?.flake_rerun as { sha?: string } | undefined)?.sha === headSha) return undefined;
    const log = await this.ctx.ports.gh.runFailedLog(this.ctx.github, ci.runId, 120);
    this.sawCi(id, { state: 'failure', ...ci, sha: headSha }, log);
    const known = patterns.find((c) => log.includes(c));
    if (!known) return undefined;
    try { await this.ctx.ports.gh.rerunFailed(this.ctx.github, ci.runId); }
    catch (e) { this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `could not re-run the failed jobs of run ${ci.runId}: ${(e as Error).message.slice(0, 200)}` } }], 'engine'); return undefined; }
    const attempt = (ci.attempt ?? 1) + 1;
    this.ctx.store.mutateItem(id, [
      { set: { op_data: { ...(fm.op_data ?? {}), flake_rerun: { sha: headSha, runId: ci.runId, attempt, check: known } } } },
      { activity: { actor: 'app', text: `CI red for ${headSha.slice(0, 7)} on a known flaky check (${known}, ci.flaky_checks); re-running the failed jobs once before handing it to the session` } },
    ], 'engine', { commit: `${id}: re-run flaky CI` });
    return attempt;
  }

  /**
   * A red run whose failed log matches an infrastructure pattern (`ci.infra_patterns` and the built-ins, #219) is the
   * runner's, not the change's (HH-327: the check runner's results dir vanished from a shared $TMPDIR mid-suite, 401/401
   * FAIL, and a fix turn was spent on it). Its failed jobs are re-run once for this head, under the same one-per-head
   * `flake_rerun` marker as a known flake (#201), with no fix turn and no counted red. Matched again once that re-run is
   * spent, it blocks ci_infra naming the pattern, for the orchestrator. Returns the attempt to wait for, 'blocked', or
   * undefined when this red is not the infrastructure's.
   */
  async rerunIfInfra(id: string, opId: string, headSha: string): Promise<number | 'blocked' | undefined> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const ci = fm.op_data?.ci as { runId?: number; url?: string; attempt?: number } | undefined;
    if (!ci?.runId) return undefined;
    const log = await this.ctx.ports.gh.runFailedLog(this.ctx.github, ci.runId, 120);
    this.sawCi(id, { state: 'failure', ...ci, sha: headSha }, log);
    const hit = infraPatternIn(log, this.ctx.store.config.ci.infra_patterns);
    if (!hit) return undefined;
    const named = `${hit.pattern}, ${hit.source}`;
    let why = 'planestro already re-ran its failed jobs once for this head';
    if ((fm.op_data?.flake_rerun as { sha?: string } | undefined)?.sha !== headSha) {
      try {
        await this.ctx.ports.gh.rerunFailed(this.ctx.github, ci.runId);
        const attempt = (ci.attempt ?? 1) + 1;
        this.ctx.store.mutateItem(id, [
          { set: { op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), flake_rerun: { sha: headSha, runId: ci.runId, attempt, check: `infrastructure: ${hit.pattern}` } } } },
          { activity: { actor: 'app', text: `CI red for ${headSha.slice(0, 7)} matches an infrastructure pattern (${named}); re-running the failed jobs once, with no fix turn and not counted as a code failure` } },
        ], 'engine', { commit: `${id}: re-run CI after an infrastructure failure` });
        return attempt;
      } catch (e) { why = `its failed jobs could not be re-run (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)})`; }
    }
    // Recorded as the head's red run, so rerun_ci can send it again once the runner is fixed; ci_failed_count is untouched.
    const re = new RegExp(hit.pattern, 'm');
    const line = log.split('\n').find((l) => re.test(l))?.trim() ?? '';
    const cur = this.ctx.store.requireItem(id).file.frontmatter;
    this.ctx.store.mutateItem(id, [
      { unset: ['op', 'op_started_at'] },
      { set: { ci_result: 'red', op_data: { ...(cur.op_data ?? {}), last_red: { runId: ci.runId, sha: headSha, ...(ci.attempt ? { attempt: ci.attempt } : {}) } } } },
    ], 'engine');
    this.ctx.store.journal.end(opId, id, 'failed', { reason: 'ci_infra', pattern: hit.pattern });
    this.ctx.block(id, 'ci_infra', `CI run ${ci.runId} for ${headSha.slice(0, 7)}${ci.url ? ` (${ci.url})` : ''} matched the infrastructure pattern ${hit.pattern} again (${hit.source}), and ${why}${line ? `: "${line.slice(0, 300)}"` : ''}. The runner's failure, not the change's: fix the runner (disk, temp dir, service), then rerun_ci. If the pattern caught a real failure, unblock_item with what to fix`);
    return 'blocked';
  }

  async onCiRed(id: string, opId: string, headSha: string, logText: string | undefined, source: 'github' | 'local', canFix = true): Promise<void> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    const ci = fm.op_data?.ci as { runId?: number; url?: string; attempt?: number } | undefined;
    // The same completed run re-observed (e.g. a manual re-run was just requested and the
    // run hasn't flipped to in_progress yet) is the SAME verdict, not a second failure.
    // A newer attempt of that run (its failed jobs re-run on GitHub by hand) is a new verdict.
    const lastRed = fm.op_data?.last_red as { runId?: number; sha?: string; attempt?: number } | undefined;
    if (source === 'github' && lastRed && lastRed.runId === ci?.runId && lastRed.sha === headSha && (ci?.attempt ?? 1) <= (lastRed.attempt ?? 1)) {
      // Nothing is coming for it once the session is done with it (#201): HH-383's worker reported "no code change, re-run
      // it" and this branch re-read the same red run every 30 s for 7½ hours, with no re-run and no one told.
      if (!this.ctx.turns.has(id) && !this.ctx.followUps.has(id) && !fm.skip_merge) { await this.onSameRedRun(id, opId, headSha); return; }
      this.ctx.store.mutateItem(id, [
        { unset: ['op', 'op_started_at'] },
        { set: { ci_result: 'pending' } },
        { activity: { actor: 'app', text: `same red run ${ci?.runId} re-observed for ${headSha.slice(0, 7)}; not counted again (waiting for a re-run or a new push)` } },
      ], 'engine');
      this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'same_red_run' });
      await this.ctx.sleep(30_000);
      void this.ctx.tick();
      return;
    }
    const count = (fm.ci_failed_count ?? 0) + 1;
    const log = logText ?? (ci?.runId ? await this.ctx.ports.gh.runFailedLog(this.ctx.github, ci.runId, 120) : '(no run id)');
    if (source === 'github' && ci?.runId) this.sawCi(id, { state: 'failure', ...ci, sha: headSha }, log);
    this.ctx.store.mutateItem(id, [
      { unset: ['op', 'op_started_at'] },
      { set: { ci_result: 'red', ci_failed_count: count, op_data: { ...(fm.op_data ?? {}), last_red: { runId: ci?.runId, sha: headSha, ...(ci?.attempt ? { attempt: ci.attempt } : {}) } } } },
      { activity: { actor: 'app', text: `CI red (${source}, attempt ${count}) for ${headSha.slice(0, 7)}${ci?.url ? ` ${ci.url}` : ''}` } },
    ], 'engine', { commit: `${id}: CI red (${count})` });
    this.ctx.store.journal.end(opId, id, 'failed', { reason: 'ci_red', count });
    if (this.ctx.store.requireItem(id).file.frontmatter.taken_over) { this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: 'no fix turn: you have this item (taken over)' } }], 'engine'); return; }
    if (!canFix) {
      // An epic's red that is likely the base's waits for the base (#204), once; red again after that comes here as ever.
      const waited = fm.kind === 'epic' && source === 'github' ? await this.ctx.baseSync.waitForBaseFix(id, headSha, log) : undefined;
      if (waited === true) return;
      this.ctx.block(id, 'ci_red', `CI is red and there is no session to hand the failure to; investigate by hand${waited ?? ''}`);
      return;
    }
    if (count >= 2) { this.ctx.block(id, 'ci_red_twice', `CI failed ${count} times`); this.ctx.wakeOrchestrator('ci_red_again', id, { failed_log: fenceExternal(log.slice(0, 3000), `ci-log ${ci?.runId ? `run ${ci.runId}` : 'local run'}`) }); return; }
    // A CI log carries output of tests others merged (#340): fenced.
    this.ctx.queueTurn(id, 'fix', this.ctx.store.renderPrompt('ci-failed', this.ctx.store.requireItem(id), { ci: { attempt: String(count), run_url: ci?.url ?? '(local run)', failed_log: fenceExternal(log, `ci-log ${ci?.runId ? `run ${ci.runId}` : 'local run'}`) } }), [], [], { fresh: 'auto' });
  }

  /**
   * The head's red run, already counted, read again with no session on the item and no re-run coming: the session looked
   * and changed nothing (a fix turn's "no code change: not caused by this change"). Its failed jobs are re-run once per
   * head, under the same `flake_rerun` marker as a known flake, and only that attempt counts: green merges, red is a
   * second failure (ci_red_twice). Past that one re-run, or when it cannot be sent, it stops as ci_red_parked, which the
   * orchestrator triages with the session's report in hand. It never waits here (#201).
   */
  private async onSameRedRun(id: string, opId: string, headSha: string): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const ci = fm.op_data?.ci as { runId?: number; url?: string; attempt?: number } | undefined;
    const done = String(fm.op_data?.done_summary ?? '').replace(/\s+/g, ' ').trim();
    const said = done ? `; the session reported: "${done.length > 600 ? `${done.slice(0, 599)}…` : done}"` : '';
    const run = `CI run ${ci?.runId ?? '?'} for ${headSha.slice(0, 7)}${ci?.url ? ` (${ci.url})` : ''}`;
    this.ctx.store.journal.end(opId, id, 'aborted', { reason: 'same_red_run' });
    let why = `planestro already re-ran its failed jobs once for this head`;
    if ((fm.op_data?.flake_rerun as { sha?: string } | undefined)?.sha !== headSha && ci?.runId) {
      try {
        await this.ctx.ports.gh.rerunFailed(this.ctx.github, ci.runId);
        const attempt = (ci.attempt ?? 1) + 1;
        const { last_red: _red, ...od } = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {};
        this.ctx.store.mutateItem(id, [
          { set: { ci_result: 'pending', op: 'awaiting_ci', op_started_at: this.ctx.now(), op_data: { ...od, flake_rerun: { sha: headSha, runId: ci.runId, attempt, check: 'no change from the session' }, ci_rerun: { sha: headSha, runId: ci.runId, attempt, by: 'app' } } } },
          { activity: { actor: 'app', text: `${run} is still red and the session changed nothing${said ? ' (see its report)' : ''}; re-running its failed jobs once (attempt ${attempt}), and that attempt's verdict is the one that counts` } },
        ], 'engine', { commit: `${id}: re-run CI after a no-change report` });
        this.ctx.poke();
        return;
      } catch (e) { why = `its failed jobs could not be re-run (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)})`; }
    }
    this.ctx.store.mutateItem(id, [{ set: { ci_result: 'red' } }], 'engine');
    this.ctx.block(id, 'ci_red_parked', `${run} is red and nothing is coming for it: the session made no change and ${why}${said}. A flake: rerun_ci. A real failure: unblock_item with what to fix`);
  }

  /** The CI wait's clock: a seam a test can drive. */
  ciNow = (): number => Date.now();
  private ciSkipCache = new Map<string, string | null>();
  /** Why the project's CI workflow runs nothing for this head's pull request (prSkippedByPaths), or null; read once per head, from the head itself. */
  private async ciSkipsHead(id: string, sha: string): Promise<string | null> {
    const key = `${id}@${sha}`;
    if (this.ciSkipCache.has(key)) return this.ciSkipCache.get(key)!;
    let why: string | null = null;
    try {
      const item = this.ctx.store.requireItem(id); const fm = item.file.frontmatter; const base = this.ctx.store.derived(item).base_branch;
      if (fm.worktree && base) {
        const cwd = this.ctx.absWorktree(fm.worktree);
        const paths = (await this.ctx.ports.git.trackedAt(cwd, sha, ['.github/workflows'])).filter((p) => /\.ya?ml$/.test(p));
        const texts = await Promise.all(paths.map(async (path) => ({ path, text: (await this.ctx.ports.git.readBlob(cwd, sha, path))?.toString('utf8') ?? '' })));
        const wf = findWorkflow(texts, this.ctx.ciWorkflow);
        if (wf) {
          const r = prSkippedByPaths(wf.doc, (await this.ctx.ports.git.changedFiles(cwd, `origin/${base}`, sha)).map((f) => f.path));
          why = r ? `${wf.path} ${r}` : null;
        }
      }
    } catch { why = null; }   // cannot tell: wait for a run as before
    this.ciSkipCache.set(key, why);
    return why;
  }

  /** Mark (or unmark) a waiting item's run as queued on a stalled runner; a marker that still holds is kept, with its time and wake. */
  private async markRunnerStall(id: string): Promise<void> {
    const stall = await this.runnerStallFor(id);
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const had = fm.op_data?.runner_stall as RunnerStall | undefined;
    if (stall ? had?.label === stall.label && had.run_id === stall.run_id : !had) return;
    const { runner_stall: _was, ...rest } = fm.op_data ?? {};
    this.ctx.store.mutateItem(id, [{ set: { op_data: stall ? { ...rest, runner_stall: this.stallMark(stall) } : rest } }], 'engine');
  }
  /** A gathering window: items that stall on one label within it are said in one wake. */
  runnerStallGatherMs = 2 * 60_000;
  /** Is this item's CI run waiting on a runner that is not coming? Read from the cached runner report; never throws. */
  async runnerStallFor(id: string): Promise<RunnerStall | undefined> {
    const run = (this.ctx.store.getItem(id)?.file.frontmatter.op_data?.ci as { runId?: number } | undefined)?.runId;
    if (!run) return undefined;
    const r = await this.ctx.readRunners(RUNNER_CHECK_MS).catch(() => undefined);
    return r ? stallOf(r.report, run) : undefined;
  }
  /** The marker an item carries while it waits on a stalled label; one already woken for that label joins it without a wake of its own. */
  stallMark(stall: RunnerStall): RunnerStall & { at: string; woken?: boolean } {
    const woken = this.runnerStalls().some((g) => g.label === stall.label && g.woken);
    return { ...stall, at: this.ctx.now(), ...(woken ? { woken: true } : {}) };
  }
  /**
   * Items whose CI waits on a runner label that looks stalled or offline (#216): blocked ci_timeout on it, or still
   * polling with their run queued on it. One banner and one wake per label, never a triage per item.
   */
  runnerStalls(): { label: string; items: string[]; since: string; woken: boolean; stalls: RunnerStall[] }[] {
    const groups = new Map<string, { label: string; items: string[]; since: string; woken: boolean; stalls: RunnerStall[] }>();
    for (const i of this.ctx.store.listItems()) {
      const fm = i.file.frontmatter;
      const m = fm.op_data?.runner_stall as (RunnerStall & { at: string; woken?: boolean }) | undefined;
      if (!m || fm.taken_over || !((fm.blocked && fm.blocked_reason === 'ci_timeout') || (!fm.blocked && this.ciWaits.has(i.id)))) continue;
      const g = groups.get(m.label) ?? { label: m.label, items: [], since: m.at, woken: false, stalls: [] };
      g.items.push(i.id); g.stalls.push(m); g.woken ||= Boolean(m.woken); if (m.at < g.since) g.since = m.at;
      groups.set(m.label, g);
    }
    return [...groups.values()];
  }
  private drivingRunnerStalls = false;
  /**
   * Once a label's gathering window has passed, one wake says every item waiting on it; once a runner takes a job
   * again, the stall is over: the items it blocked wait for CI again by themselves, and the banner goes (#216).
   */
  async driveRunnerStalls(): Promise<void> {
    if (this.drivingRunnerStalls) return;
    const groups = this.runnerStalls();
    if (!groups.length) return;
    this.drivingRunnerStalls = true;
    try {
      const r = await this.ctx.readRunners(RUNNER_CHECK_MS).catch(() => undefined);
      for (const g of groups) {
        if (r && recovered(r.report, g.stalls)) {
          this.ctx.note('info', `runner ${g.label} is taking jobs again: ${g.items.join(', ')} wait for CI again`);
          for (const id of g.items) {
            const fm = this.ctx.store.requireItem(id).file.frontmatter;
            const { runner_stall: _over, ...rest } = fm.op_data ?? {};
            this.ctx.store.mutateItem(id, [{ set: { op_data: rest } }], 'engine');
            if (fm.blocked) await this.ctx.retryOp(id, 'engine', `a runner for ${g.label} is taking jobs again`);
          }
          continue;
        }
        const blocked = g.items.filter((id) => this.ctx.store.requireItem(id).file.frontmatter.blocked).length;
        if (g.woken || (g.items.length < 2 && !blocked) || Date.now() - Date.parse(g.since) < this.runnerStallGatherMs) continue;
        for (const id of g.items) { const fm = this.ctx.store.requireItem(id).file.frontmatter; this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(fm.op_data ?? {}), runner_stall: { ...(fm.op_data?.runner_stall as object), woken: true } } } }], 'engine'); }
        this.ctx.note('warn', `runner ${g.label} looks stalled or offline: ${g.items.join(', ')} are waiting on it`);
        this.ctx.wakeOrchestrator('runner_stalled', undefined, {
          runner: `${g.label} looks stalled or offline: ${g.items.join(', ')} ${g.items.length === 1 ? 'is' : 'are'} waiting on it (${blocked} blocked ci_timeout, ${g.items.length - blocked} still waiting for a runner)`,
          runners: r ? runnerStatusText(r.report, this.ctx.github, r.at) : '(could not read the runners)',
          policy: 'One signal for every item waiting on this runner label, instead of a triage each. Do not re-run or retry them one by one: once a runner for it takes a job again, planestro sends the blocked ones back to waiting for CI by itself. Judge what the runner needs (a machine asleep or offline, a billing block, a full queue) from runner_status; if it needs a person, ask the user once (ask_user) for all of them.',
        });
      }
    } finally { this.drivingRunnerStalls = false; }
  }
  ciQueueNote(): string { return this.ctx.ciQueue ? ` (CI queue: ${this.ctx.ciQueue.queued} queued, ${this.ctx.ciQueue.running} running)` : ''; }

  /**
   * Poll the named workflow for `sha`. 10 s cadence for the first 2 min, then 30 s.
   *
   * `previousSha` is the head the pipeline's own push replaced. GitHub's API lags a push by a
   * few seconds, so the first `gh pr view` after a force-push still reports that sha; reading
   * it as "someone moved the head" aborted the merge in ~4 s, released the merge chain, and
   * the next item rebased and pushed too — one merge fired a fresh CI run for every open PR.
   * Within HEAD_PROPAGATION_GRACE_MS the old sha is lag and we keep polling; anything else is
   * a real move. 'stopping' is the engine shutting down, which says nothing about CI.
   */
  async waitForCi(id: string, branch: string, sha: string, pr: number, previousSha: string | null = null, minAttempt = 0): Promise<'green' | 'red' | 'blocked' | 'moved' | 'timeout' | 'queue_timeout' | 'stopping' | 'taken_over' | 'skipped' | 'cancelled'> {
    this.ciWaits.add(id);
    try { return await this.pollCi(id, branch, sha, pr, previousSha, minAttempt); } finally { this.ciWaits.delete(id); }
  }
  /** Items whose CI wait is polling: a wait is not a step running, so the user may re-run a cancelled run under it (#174). */
  ciWaits = new Set<string>();

  private ciOutage = new Map<string, number>();
  /**
   * One GitHub read of a CI wait. A blip GitHub's own retries (about a minute) did not ride out is waited through here,
   * said once in the Activity log, until the wait's own `ci.timeout_min`: blocking `engine_error` sent every item
   * waiting on CI to triage at once. Undefined means "poll again"; anything not transient fails the wait as before.
   */
  private async ciRead<T>(id: string, sha: string, started: number, read: () => Promise<T>): Promise<T | undefined> {
    try { const v = await read(); this.ciOutage.delete(id); return v; }
    catch (e) {
      const msg = (e as Error).message;
      if (!TRANSIENT.test(msg) || this.ctx.stopping || (this.ciNow() - started) / 60_000 > this.ctx.store.config.ci.timeout_min) { this.ciOutage.delete(id); throw e; }
      const n = (this.ciOutage.get(id) ?? 0) + 1; this.ciOutage.set(id, n);
      if (n === 1) this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `GitHub did not answer about CI for ${sha.slice(0, 7)} (${msg.replace(/\s+/g, ' ').slice(0, 160)}); still waiting` } }], 'engine');
      await this.ctx.sleep(Math.min(5 * 60_000, 30_000 * n));
      return undefined;
    }
  }

  private async pollCi(id: string, branch: string, sha: string, pr: number, previousSha: string | null, minAttempt: number): Promise<'green' | 'red' | 'blocked' | 'moved' | 'timeout' | 'queue_timeout' | 'stopping' | 'taken_over' | 'skipped' | 'cancelled'> {
    // The project's CI runs nothing for this change (its own path filters): there is nothing to wait for, and nothing to stand in for (HH-324).
    const notRun = await this.ciSkipsHead(id, sha);
    if (notRun) {
      const cur = this.ctx.store.requireItem(id).file.frontmatter;
      if (cur.op_data?.ci_not_run !== sha) this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci_not_run: sha } } }, { activity: { actor: 'app', text: `CI does not run for ${sha.slice(0, 7)}: ${notRun}; nothing to check, so it counts as green` } }], 'engine');
      return 'green';
    }
    // The wait's clock; a run planestro re-queues starts it again (HH-323, HH-326, HH-328 timed out minutes after their re-run).
    let started = this.ciNow();
    // When a runner first had the run (#170): ci.timeout_min counts from here. A run queued for a runner is
    // waiting, not failing: on Oct 1 (HH) four healthy items blocked ci_timeout behind a 3-5 h self-hosted queue.
    let runningSince: number | null = null;
    let queueNoted = 0;
    let sawRun = false;
    let skippedPolls = 0;
    let cancelledPolls = 0;
    let need = minAttempt;
    while (true) {
      if (this.ctx.stopping) return 'stopping';
      // Read on every poll, so a timeout changed in Settings reaches a wait already running (#173).
      const cfg = this.ctx.store.config.ci;
      // A re-run asked for by rerun_ci (#139) keeps its run id: only its new attempt is the verdict, whoever waits.
      // Read on every poll too: the user may re-run a cancelled run while this wait polls it (#174), and the wait's clock starts again.
      const asked = this.ctx.store.getItem(id)?.file.frontmatter.op_data?.ci_rerun as { sha?: string; attempt?: number } | undefined;
      if (asked?.sha === sha && (asked.attempt ?? 0) > need) { need = asked.attempt!; started = this.ciNow(); runningSince = null; cancelledPolls = 0; }
      // A person took the item over while its CI ran: the merge chain is not held for them.
      if (this.ctx.store.getItem(id)?.file.frontmatter.taken_over) return 'taken_over';
      const view = await this.ciRead(id, sha, started, () => this.ctx.ports.gh.prView(this.ctx.github, pr));
      if (!view) continue;
      if (view.state === 'MERGED') return 'green';
      if (view.headRefOid !== sha) {
        const lagging = previousSha !== null && view.headRefOid === previousSha && this.ciNow() - started < HEAD_PROPAGATION_GRACE_MS;
        if (!lagging) return 'moved';
        await this.ctx.sleep(10_000);
        continue;
      }
      const ci = await this.ciRead(id, sha, started, () => this.ctx.ports.gh.ciForSha(this.ctx.github, branch, sha, this.ctx.ciWorkflow));
      if (!ci) continue;
      this.ciSeen.set(id, { state: ci.state, at: Date.now() });
      this.sawCi(id, ci);
      const elapsedMin = (this.ciNow() - started) / 60_000;
      if (ci.runId && ci.state !== 'skipped') { sawRun = true; const cur = this.ctx.store.requireItem(id).file.frontmatter; const seen = cur.op_data?.ci as { runId?: number; attempt?: number; sha?: string } | undefined; if (seen?.runId !== ci.runId || seen?.attempt !== ci.attempt || seen?.sha !== sha) this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci: { runId: ci.runId, url: ci.url, sha, ...(ci.attempt ? { attempt: ci.attempt } : {}) } } } }], 'engine'); }
      if (ci.state === 'success') return 'green';
      // A re-run keeps its run id: until its attempt shows up, the completed run is the old verdict.
      const stale = need > 0 && (ci.attempt ?? 0) < need;
      if (ci.state === 'failure' && !stale) return (ci.runId && await this.ctx.ports.gh.isBillingBlocked(this.ctx.github, ci.runId)) ? 'blocked' : 'red';
      // Cancelled is usually superseded: a newer run for this head takes its place, and ciForSha reads the newest.
      // When the newest stays cancelled nothing is coming (HH-321: a concurrency group cancelled it, and two
      // 45-minute waits followed). Its jobs are re-run once per head, and that attempt is what is waited for.
      cancelledPolls = ci.state === 'cancelled' && !stale ? cancelledPolls + 1 : 0;
      if (cancelledPolls >= CANCELLED_RERUN_POLLS && ci.runId) {
        cancelledPolls = 0;
        const cur = this.ctx.store.requireItem(id).file.frontmatter;
        // Its one re-run was cancelled too (or never started): nothing is coming, and the timeout is hours away (#174).
        if (cur.op_data?.ci_cancel_rerun === sha) return 'cancelled';
        let note: string;
        try { await this.ctx.ports.gh.rerunAll(this.ctx.github, ci.runId); need = (ci.attempt ?? 1) + 1; started = this.ciNow(); runningSince = null; note = `CI run ${ci.runId} for ${sha.slice(0, 7)} was cancelled and no other run replaced it; re-running it`; }
        catch (e) { note = `CI run ${ci.runId} for ${sha.slice(0, 7)} was cancelled and could not be re-run (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}); waiting for a new run`; }
        this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), ci_cancel_rerun: sha } } }, { activity: { actor: 'app', text: note } }], 'engine');
      }
      // Only skipped runs (a draft guard skipped every job) checked nothing: not red, and on a ready PR
      // not coming by itself either, when ready_for_review landed on the head the push replaced.
      skippedPolls = ci.state === 'skipped' ? skippedPolls + 1 : 0;
      if (skippedPolls >= SKIPPED_REFIRE_POLLS && !view.isDraft) { await this.refireReady(id, pr, sha); skippedPolls = 0; }
      // p48: still only skipped once ready_for_review was sent again (or the PR is a draft, so it is never sent) is its own
      // stop, not ci_blocked: Actions did run, and the local gate is no answer to a job condition that skips everything.
      if (ci.state === 'skipped' && !sawRun && elapsedMin > cfg.start_timeout_min && (view.isDraft || this.ctx.store.requireItem(id).file.frontmatter.op_data?.ci_refired === sha)) return 'skipped';
      if (ci.state === 'none' && !sawRun && elapsedMin > cfg.start_timeout_min) return 'blocked';
      // A runner took it (or it ended): it no longer waits on a stalled runner (#216).
      if (!(ci.state === 'pending' && ci.queued) && this.ctx.store.requireItem(id).file.frontmatter.op_data?.runner_stall) { const { runner_stall: _over, ...rest } = this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}; this.ctx.store.mutateItem(id, [{ set: { op_data: rest } }], 'engine'); }
      // A run (or a re-run's new attempt) waiting for a runner has not started its clock; once a job runs, it has.
      if (ci.state === 'pending' && ci.queued) runningSince = null;
      else if (ci.state === 'pending' && runningSince === null) runningSince = this.ciNow();
      if (runningSince !== null) { if ((this.ciNow() - runningSince) / 60_000 > cfg.timeout_min) return 'timeout'; }
      else if (ci.state === 'pending' && ci.queued) {
        if (elapsedMin > cfg.queue_timeout_min) return 'queue_timeout';
        // Queued past ci.start_timeout_min on a runner that looks stalled or offline: one signal per label, with the others on it (#216).
        if (elapsedMin > cfg.start_timeout_min) await this.markRunnerStall(id);
        // Say so once an hour, with the queue it is in, so a long wait reads as a queue and not a stall.
        if (elapsedMin >= 30 && elapsedMin - queueNoted >= 60) {
          queueNoted = elapsedMin;
          const q = await this.ctx.refreshCiQueue();
          this.ctx.store.mutateItem(id, [{ activity: { actor: 'app', text: `CI run for ${sha.slice(0, 7)} has waited ${Math.round(elapsedMin)} min for a runner${q ? ` (${q.queued} queued, ${q.running} running)` : ''}; it is queued, not failing` } }], 'engine');
        }
      }
      else if (elapsedMin > cfg.timeout_min) return 'timeout';
      await this.ctx.sleep(elapsedMin < 2 ? 10_000 : 30_000);
    }
  }

  /**
   * Every run for this ready PR's head skipped its jobs: the ready_for_review event landed on another
   * head (HH-180: marked ready while GitHub still showed the head the push replaced), so no run is
   * coming. Draft and ready again sends the event for this head, once per head: a head that is still
   * only skipped after that waits out ci.start_timeout_min, then blocks as ci_skipped (p48).
   */
  private async refireReady(id: string, pr: number, sha: string): Promise<void> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (fm.op_data?.ci_refired === sha) return;
    await this.ctx.ports.gh.setDraft(this.ctx.github, pr, true);
    await this.ctx.ports.gh.setDraft(this.ctx.github, pr, false);
    const cur = this.ctx.store.requireItem(id).file.frontmatter;
    this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(cur.op_data ?? {}), ci_refired: sha } } }, { activity: { actor: 'app', text: `every CI run for ${sha.slice(0, 7)} skipped its jobs (the PR was a draft when they started) and no other run came; sent ready for review again so CI runs on it` } }], 'engine');
  }

  /**
   * Re-run the failed jobs of the head's red CI run (#139, HH-307, HH-284): a suspected flake, with nothing to fix in
   * the branch. Only that run for an unchanged head; the orchestrator gets one per head (a real failure is not retried
   * in a loop), the user as many as they like. The block or triage clears, and the CI wait counts only the new attempt
   * (`op_data.ci_rerun`); a red attempt counts as a failure again. Returns what happened, or why not, in words.
   */
  /** What rerunCi would refuse that the store can tell without GitHub: checked when a card offering it is filed (#162). */
  rerunRefusal(id: string): string | null {
    const fm = this.ctx.store.getItem(id)?.file.frontmatter;
    if (!fm) return `there is no item ${id}`;
    if (fm.status !== 'IN_REVIEW' || !fm.pr) return `${id} has no pull request in review`;
    if (!(fm.op_data?.last_red as { runId?: number } | undefined)?.runId && !(fm.op_data?.last_cancelled as { runId?: number } | undefined)?.runId) return `${id} has no red or cancelled CI run on record`;
    return null;
  }

  async rerunCi(id: string, by: 'user' | 'orchestrator' = 'user'): Promise<string> {
    const item = this.ctx.store.requireItem(id);
    const fm = item.file.frontmatter;
    if (by === 'orchestrator' && fm.taken_over) return `not now: the user has taken ${id} over`;
    if (fm.status !== 'IN_REVIEW' || !fm.pr || !fm.branch) return `not possible: ${id} has no pull request in review`;
    // A CI wait that is polling is not a step running (#174): its run may be cancelled with nothing coming, and that run is re-run under it.
    const waiting = this.ciWaits.has(id) && !this.ctx.turns.has(id);
    const busy = this.ctx.busyWith(id); if (busy && !waiting) return `not now: ${busy} (a CI wait that is still running is not red)`;
    if (waiting) return this.rerunUnderWait(id, by);
    const red = (fm.op_data?.last_red ?? fm.op_data?.last_cancelled) as { runId?: number; sha?: string } | undefined;
    const cancelled = !fm.op_data?.last_red;
    if (!red?.runId || !red.sha) return `not possible: ${id} has no red or cancelled CI run on record`;
    const view = await this.ctx.ports.gh.prView(this.ctx.github, fm.pr);
    if (view.headRefOid !== red.sha) return `not possible: the head moved to ${view.headRefOid.slice(0, 7)} after run ${red.runId} (${red.sha.slice(0, 7)}); the new head's own run is what counts`;
    const ci = await this.ctx.ports.gh.ciForSha(this.ctx.github, fm.branch, red.sha, this.ctx.ciWorkflow);
    const want = cancelled ? 'cancelled' : 'failure';
    if (ci.runId !== red.runId || ci.state !== want) return `not possible: run ${red.runId} is not the head's ${cancelled ? 'cancelled' : 'red'} run any more (it is ${ci.state}${ci.runId && ci.runId !== red.runId ? `, run ${ci.runId}` : ''})`;
    // planestro's own re-run after a no-change report (#201) is not the orchestrator's one.
    const prev = fm.op_data?.ci_rerun as { sha?: string; by?: string } | undefined;
    if (by === 'orchestrator' && prev?.sha === red.sha && prev.by !== 'app') return `not possible: you already re-ran CI once for ${red.sha.slice(0, 7)}; a second red on the same head is the user's to judge (or the session's to fix). If something has changed since (a runner's full disk freed, a fix landed), leave ask_user_decision with an option carrying action { tool: "rerun_ci", args: { id: "${id}" } }: their tap re-runs it`;
    // A cancelled run's jobs are all re-run, as the wait's own re-run does; a red one's failed jobs only.
    if (cancelled) await this.ctx.ports.gh.rerunAll(this.ctx.github, red.runId); else await this.ctx.ports.gh.rerunFailed(this.ctx.github, red.runId);
    const attempt = (ci.attempt ?? 1) + 1;
    const { last_red: _red, last_cancelled: _cancelled, ...od } = fm.op_data ?? {};
    this.ctx.store.mutateItem(id, [
      { unset: ['blocked', 'blocked_reason', 'triage', ...(fm.awaiting === 'user' ? ['awaiting', 'awaiting_data'] : [])] },
      { set: { ci_result: 'pending', ci_head_sha: red.sha, op: 'awaiting_ci', op_started_at: this.ctx.now(), op_data: { ...od, ci_rerun: { sha: red.sha, runId: red.runId, attempt, by } } } },
      { activity: { actor: by, text: `${cancelled ? 're-ran cancelled CI run' : 're-ran the failed jobs of CI run'} ${red.runId} for ${red.sha.slice(0, 7)} (attempt ${attempt}); waiting for that attempt` } },
    ], by, { commit: `${id}: re-run CI` });
    this.ctx.poke();
    return `${cancelled ? 're-running cancelled run' : 're-running the failed jobs of run'} ${red.runId} (attempt ${attempt}); its verdict is the one that counts`;
  }

  /**
   * rerunCi while the item's CI wait polls (#174): only a run that is cancelled, which the wait would otherwise sit on
   * until ci.timeout_min. Recorded before the re-run is sent, so the wait counts only the new attempt and does not
   * re-run it a second time; nothing else changes on the item, and the same wait goes on (no second wait starts).
   */
  private async rerunUnderWait(id: string, by: 'user' | 'orchestrator'): Promise<string> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const sha = fm.ci_head_sha;
    if (!sha || !fm.branch) return `not possible: ${id} has no head waiting for CI`;
    const ci = await this.ctx.ports.gh.ciForSha(this.ctx.github, fm.branch, sha, this.ctx.ciWorkflow);
    if (ci.state === 'failure') return `not now: run ${ci.runId} for ${sha.slice(0, 7)} just failed and the CI wait reports it red within a poll; re-run it after that`;
    if (ci.state !== 'cancelled' || !ci.runId) return `not now: CI for ${sha.slice(0, 7)} is ${ci.state === 'pending' ? 'still running' : ci.state}; a CI wait that is still running is not red`;
    const prev = fm.op_data?.ci_rerun as { sha?: string; attempt?: number } | undefined;
    const attempt = (ci.attempt ?? 1) + 1;
    if (prev?.sha === sha && (prev.attempt ?? 0) >= attempt) return `not now: run ${ci.runId} was already re-run (attempt ${prev.attempt}); its attempt has not shown up yet`;
    if (by === 'orchestrator' && prev?.sha === sha) return `not possible: you already re-ran CI once for ${sha.slice(0, 7)}; leave ask_user_decision with an option carrying action { tool: "rerun_ci", args: { id: "${id}" } }: their tap re-runs it`;
    const setRerun = (rerun: unknown) => this.ctx.store.mutateItem(id, [{ set: { op_data: { ...(this.ctx.store.requireItem(id).file.frontmatter.op_data ?? {}), ci_rerun: rerun } } }], 'engine');
    setRerun({ sha, runId: ci.runId, attempt, by });
    try { await this.ctx.ports.gh.rerunAll(this.ctx.github, ci.runId); }
    catch (e) { setRerun(prev ?? null); return `not possible: run ${ci.runId} could not be re-run (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)})`; }
    this.ctx.store.mutateItem(id, [{ activity: { actor: by, text: `re-ran cancelled CI run ${ci.runId} for ${sha.slice(0, 7)} (attempt ${attempt}) while planestro waited on it; waiting for that attempt` } }], by, { commit: `${id}: re-run CI` });
    return `re-running cancelled run ${ci.runId} (attempt ${attempt}); the CI wait already running counts only that attempt`;
  }

  /** A CI verdict, remembered once per run attempt for the concurrency guard (#330); a red's log says whether a check was killed at its timeout. */
  sawCi(id: string, ci: { state: string; runId?: number; attempt?: number; sha?: string; timedOut?: boolean }, log?: string): void {
    if (ci.state === 'success') recordCiResult(this.ctx.store, id, { run_id: ci.runId, attempt: ci.attempt, sha: ci.sha, outcome: 'success', timeout_killed: false });
    else if (ci.state === 'cancelled' && ci.timedOut) recordCiResult(this.ctx.store, id, { run_id: ci.runId, attempt: ci.attempt, sha: ci.sha, outcome: 'cancelled', timeout_killed: true });
    else if (ci.state === 'failure' && log !== undefined) recordCiResult(this.ctx.store, id, { run_id: ci.runId, attempt: ci.attempt, sha: ci.sha, outcome: 'failure', timeout_killed: timeoutKilledIn(log) });
  }
}
