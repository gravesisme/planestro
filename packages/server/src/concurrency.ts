/**
 * The concurrency control (#330): `concurrency.max_sessions` and `runner_limits` raised and lowered from the status
 * popover, applied through the Settings write path (one semantic commit), each change journaled (`concurrency.changed`)
 * with who and why and the values before it, so the last one rolls back in one step. Its guard rails are the CI
 * results planestro saw (`ci.result`, written by the engine with whether a check was killed at its timeout), this
 * machine's load average and the self-hosted runners that share it; the judgment is `concurrencyAdvice` (shared).
 * The journal is the memory: what is kept here is a cache of it, read once per store.
 */
import { availableParallelism, loadavg, platform } from 'node:os';
import { z } from 'zod';
import { concurrencyAdvice, raiseNeedsConfirm, limitsLabel, type CiResultSeen, type Config, type ConcurrencyChange, type ConcurrencyLimits, type HostLoad } from '@planestro/shared';
import type { DataStore } from './store/DataStore.ts';
import type { Engine } from './engine/Engine.ts';
import { applyConfigSettings } from './settingsWrite.ts';

export const CI_RESULT = 'ci.result';
export const CONCURRENCY_CHANGED = 'concurrency.changed';
const KEEP = 200;

interface Ledger { ci: CiResultSeen[]; seen: Set<string>; last?: ConcurrencyChange }
const ledgers = new WeakMap<DataStore, Ledger>();
const runKey = (runId: number, attempt?: number) => `${runId}:${attempt ?? 1}`;

function ledgerOf(store: DataStore): Ledger {
  let l = ledgers.get(store);
  if (l) return l;
  l = { ci: [], seen: new Set() };
  for (const e of store.journal.read()) {
    if (e.type === CI_RESULT && e.data) {
      const r = { at: e.ts, ...(e.item ? { item: e.item } : {}), ...e.data } as CiResultSeen;
      l.ci.push(r);
      if (r.run_id) l.seen.add(runKey(r.run_id, r.attempt));
    } else if (e.type === CONCURRENCY_CHANGED && e.data) l.last = { at: e.ts, by: e.actor, ...e.data } as ConcurrencyChange;
  }
  l.ci = l.ci.slice(-KEEP);
  ledgers.set(store, l);
  return l;
}

/** The CI results planestro saw, oldest first (at most the last 200). */
export function recentCi(store: DataStore): CiResultSeen[] { return ledgerOf(store).ci; }
export function lastConcurrencyChange(store: DataStore): ConcurrencyChange | undefined { return ledgerOf(store).last; }

/** One CI verdict, once per run attempt: the engine calls this wherever it learns one. */
export function recordCiResult(store: DataStore, item: string | undefined, r: { run_id?: number; attempt?: number; outcome: CiResultSeen['outcome']; timeout_killed: boolean; sha?: string }): void {
  const l = ledgerOf(store);
  if (r.run_id) { const k = runKey(r.run_id, r.attempt); if (l.seen.has(k)) return; l.seen.add(k); }
  const data = { outcome: r.outcome, timeout_killed: r.timeout_killed, ...(r.run_id ? { run_id: r.run_id } : {}), ...(r.attempt ? { attempt: r.attempt } : {}), ...(r.sha ? { sha: r.sha } : {}) };
  const e = store.journal.append({ type: CI_RESULT, ...(item ? { item } : {}), actor: 'engine', data });
  l.ci.push({ at: e.ts, ...(item ? { item } : {}), ...data });
  if (l.ci.length > KEEP) l.ci.shift();
}

/** This machine's load (1, 5, 15 min) and cores; undefined where the OS has no load average (Windows reports zeros). */
export function hostLoad(): HostLoad | undefined {
  if (platform() === 'win32') return undefined;
  return { load: loadavg().map((n) => Math.round(n * 100) / 100) as [number, number, number], cpus: availableParallelism() };
}

export const limitsOf = (config: Config): ConcurrencyLimits => ({ max_sessions: config.concurrency.max_sessions, runner_limits: { ...config.concurrency.runner_limits } });

/** Whether a self-hosted CI runner on this machine is busy; `unknown` when which runners share it is not configured or not readable. */
export interface LocalRunners { state: 'busy' | 'idle' | 'unknown'; labels: string[]; detail: string[] }

export async function concurrencyView(store: DataStore, engine: Engine, host: HostLoad | undefined) {
  const cfg = store.config.concurrency;
  const labels = store.config.heavy_runs.shared_labels;
  let ci_runner: LocalRunners;
  if (!labels.length) ci_runner = { state: 'unknown', labels, detail: ['which runners share this machine is not set (heavy_runs.shared_labels)'] };
  else if (!engine.localRunners) ci_runner = { state: 'unknown', labels, detail: ['this engine does not read runners'] };
  else ci_runner = await engine.localRunners().catch((e) => ({ state: 'unknown' as const, labels, detail: [(e as Error).message.slice(0, 200)] }));
  const last = lastConcurrencyChange(store);
  const advice = concurrencyAdvice({ current: cfg.max_sessions, ci: recentCi(store), host, last_change: last, now: Date.now() }, cfg.guard);
  return {
    limits: { max_sessions: cfg.max_sessions, max_local_jobs: cfg.max_local_jobs, runner_limits: cfg.runner_limits },
    slots: { max: cfg.max_sessions, ...slotUsageOf(engine) },
    host: host ?? null,
    ci_runner,
    advice,
    guard: cfg.guard,
    last_change: last ?? null,
    rollback: last ? last.from : null,
  };
}

/** Agents running, turns and ready items waiting for a session slot, and each limited runner's turns. */
export function slotUsageOf(engine: Engine): { running: number; waiting: number; runners: Record<string, { running: number; waiting: number }> } {
  return engine.slotUsage?.() ?? { running: engine.sessions().filter((s) => s.busy).length, waiting: 0, runners: {} };
}

const ChangeBody = z.object({
  max_sessions: z.number().int().positive().optional(),
  runner_limits: z.record(z.string().min(1), z.number().int().positive()).optional(),
  reason: z.string().max(500).optional(),
  confirm: z.boolean().optional(),
}).strict();

/**
 * Apply new limits as `by`. A person's raise of max_sessions above the recommendation is refused (409, `needs_confirm`)
 * unless confirmed; a runner limit shares the session slots, so it never adds agents and never needs one. Returns the change.
 */
export function changeConcurrency(store: DataStore, raw: unknown, by: 'user' | 'engine', opts: { host?: HostLoad; auto?: boolean; rollback?: boolean } = {}): ConcurrencyChange {
  const body = ChangeBody.parse(raw);
  const from = limitsOf(store.config);
  const to: ConcurrencyLimits = { max_sessions: body.max_sessions ?? from.max_sessions, runner_limits: { ...from.runner_limits, ...(body.runner_limits ?? {}) } };
  const runners = Object.keys(to.runner_limits).filter((k) => to.runner_limits[k] !== from.runner_limits[k]);
  if (to.max_sessions === from.max_sessions && !runners.length) throw new Error(`nothing to change: already ${limitsLabel(from)}`);
  if (by === 'user' && !body.confirm) {
    const advice = concurrencyAdvice({ current: from.max_sessions, ci: recentCi(store), host: opts.host, last_change: lastConcurrencyChange(store), now: Date.now() }, store.config.concurrency.guard);
    if (raiseNeedsConfirm(from.max_sessions, to.max_sessions, advice)) {
      throw Object.assign(new Error(`${to.max_sessions} sessions is above the recommended ${advice.recommended_max}${advice.reasons.length ? `: ${advice.reasons.join('; ')}` : ''}. Confirm to apply it anyway`), { status: 409, needs_confirm: true });
    }
  }
  applyConfigSettings(store, { concurrency: { ...(to.max_sessions !== from.max_sessions ? { max_sessions: to.max_sessions } : {}), ...(runners.length ? { runner_limits: to.runner_limits } : {}) } });
  const reason = body.reason?.trim();
  const data = { from, to, ...(reason ? { reason } : {}), ...(opts.auto ? { auto: true } : {}), ...(opts.rollback ? { rollback: true } : {}) };
  const e = store.journal.append({ type: CONCURRENCY_CHANGED, actor: by, data });
  const change: ConcurrencyChange = { at: e.ts, by, ...data };
  ledgerOf(store).last = change;
  return change;
}

/** Back to the values before the last change: itself a change, journaled the same way (so it can be rolled back too). */
export function rollbackConcurrency(store: DataStore, raw: unknown, by: 'user' | 'engine', opts: { host?: HostLoad; auto?: boolean } = {}): ConcurrencyChange {
  const body = z.object({ reason: z.string().max(500).optional(), confirm: z.boolean().optional() }).strict().parse(raw ?? {});
  const last = lastConcurrencyChange(store);
  if (!last) throw new Error('no concurrency change to roll back');
  const reason = body.reason?.trim() || `roll back to ${limitsLabel(last.from)}`;
  return changeConcurrency(store, { max_sessions: last.from.max_sessions, runner_limits: last.from.runner_limits, reason, ...(body.confirm ? { confirm: true } : {}) }, by, { ...opts, rollback: true });
}
