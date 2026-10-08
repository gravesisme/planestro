/**
 * Concurrency guard rails (#330). The limit is the machine, not the number: HH's checks were killed at their timeouts
 * (rc=137) while the self-hosted Mac that runs both CI and the workers sat at a load average of 60–92. A raise is
 * recommended one step at a time, while the last CI results planestro saw had no timeout kill and the machine is not
 * loaded; anything above that needs an explicit confirm. Lowering never asks.
 */

/** `concurrency.guard` in planestro.yml; the schema holds the same defaults. */
export interface ConcurrencyGuard {
  /** How many of the most recent CI results planestro saw are looked at. */
  ci_window: number;
  /** 5-minute load average per CPU core at or above which a raise is not recommended. */
  max_load_per_cpu: number;
  /** After a raise, the next one is recommended only once this many minutes have passed. */
  settle_min: number;
  /** Opt-in: a raise followed by a timeout-killed check (or `step_down_load_per_cpu` over 15 minutes) is rolled back on the tick. */
  auto_step_down: boolean;
  step_down_load_per_cpu: number;
}
export const CONCURRENCY_GUARD_DEFAULTS: ConcurrencyGuard = { ci_window: 10, max_load_per_cpu: 1, settle_min: 30, auto_step_down: false, step_down_load_per_cpu: 2 };

/** A CI verdict planestro saw (journal `ci.result`): `timeout_killed` when a check was killed at its time limit. */
export interface CiResultSeen { at: string; outcome: 'success' | 'failure' | 'cancelled'; timeout_killed: boolean; run_id?: number; attempt?: number; item?: string }
export interface ConcurrencyLimits { max_sessions: number; runner_limits: Record<string, number> }
/** One change (journal `concurrency.changed`): who, why, and the values before and after. `auto`: the engine's step-down. */
export interface ConcurrencyChange { at: string; by: string; reason?: string; from: ConcurrencyLimits; to: ConcurrencyLimits; auto?: boolean; rollback?: boolean }
/** os.loadavg() (1, 5, 15 min) and the core count. */
export interface HostLoad { load: [number, number, number]; cpus: number }

export interface ConcurrencyAdvice {
  /** No timeout kill in the window, and the machine under `max_load_per_cpu`. */
  healthy: boolean;
  /** Healthy, and not still settling after a raise. */
  raise_ok: boolean;
  /** For max_sessions: one above the current value when a raise is fine, the current value while it settles, one below when not healthy. */
  recommended_max: number;
  /** Why not, in words; empty when a raise is fine. */
  reasons: string[];
  kills: number; seen: number; window: number;
  load_per_cpu?: number;
}

/** A check killed at its time limit: rc=137 / exit code 137 (SIGKILL), or GitHub's job time limit. */
export function timeoutKilledIn(log: string): boolean {
  return /\brc[=:]\s*137\b|exit(?:ed)? (?:with )?(?:code|status) 137\b|\bSIGKILL\b|\bKilled: 9\b|exceeded the maximum execution time/i.test(log);
}

const raised = (c: ConcurrencyChange): boolean => c.to.max_sessions > c.from.max_sessions || Object.entries(c.to.runner_limits).some(([k, v]) => v > (c.from.runner_limits[k] ?? Infinity));
const perCpu = (load: number, cpus: number): number => Math.round((load / cpus) * 10) / 10;

export function concurrencyAdvice(input: { current: number; ci: CiResultSeen[]; host?: HostLoad; last_change?: ConcurrencyChange; now: number }, guard: ConcurrencyGuard): ConcurrencyAdvice {
  const recent = input.ci.slice(-guard.ci_window);
  const kills = recent.filter((r) => r.timeout_killed).length;
  const reasons: string[] = [];
  if (kills) reasons.push(`${kills} of the last ${recent.length} CI results ${kills === 1 ? 'was' : 'were'} killed at a timeout`);
  const load5 = input.host && input.host.cpus > 0 ? input.host.load[1] : undefined;
  const lpc = load5 !== undefined ? perCpu(load5, input.host!.cpus) : undefined;
  if (lpc !== undefined && lpc >= guard.max_load_per_cpu) reasons.push(`load ${Math.round(load5! * 10) / 10} over 5 min on ${input.host!.cpus} cores (${lpc} per core; ${guard.max_load_per_cpu} is the limit)`);
  const healthy = reasons.length === 0;
  const c = input.last_change;
  const ago = c ? (input.now - Date.parse(c.at)) / 60_000 : Infinity;
  const settling = Boolean(c && c.to.max_sessions > c.from.max_sessions && ago < guard.settle_min);
  if (healthy && settling) reasons.push(`raised ${Math.max(0, Math.round(ago))} min ago: let it settle for ${guard.settle_min} min before raising again`);
  const raise_ok = healthy && !settling;
  const recommended_max = raise_ok ? input.current + 1 : healthy ? input.current : Math.max(1, input.current - 1);
  return { healthy, raise_ok, recommended_max, reasons, kills, seen: recent.length, window: guard.ci_window, ...(lpc !== undefined ? { load_per_cpu: lpc } : {}) };
}

/** A raise of max_sessions above the recommendation; lowering never needs one. */
export function raiseNeedsConfirm(from: number, to: number, advice: ConcurrencyAdvice): boolean {
  return to > from && to > advice.recommended_max;
}

/**
 * Auto-step-down (opt-in): the last change raised something, a person made it, and since then a check was killed at
 * a timeout or the 15-minute load per core reached `step_down_load_per_cpu`. Returns why, or undefined. A step-down
 * is a lowering, so it is never stepped down again.
 */
export function stepDownDue(input: { last_change?: ConcurrencyChange; ci: CiResultSeen[]; host?: HostLoad; now: number }, guard: ConcurrencyGuard): string | undefined {
  const c = input.last_change;
  if (!guard.auto_step_down || !c || c.auto || !raised(c)) return undefined;
  const since = Date.parse(c.at);
  const kill = input.ci.find((r) => r.timeout_killed && Date.parse(r.at) > since);
  if (kill) return `a CI check was killed at a timeout after the raise${kill.item ? ` (${kill.item}${kill.run_id ? `, run ${kill.run_id}` : ''})` : ''}`;
  if (input.host && input.host.cpus > 0) {
    const lpc = perCpu(input.host.load[2], input.host.cpus);
    if (lpc >= guard.step_down_load_per_cpu) return `load ${Math.round(input.host.load[2] * 10) / 10} over 15 min on ${input.host.cpus} cores (${lpc} per core) after the raise`;
  }
  return undefined;
}

/** "2 / codex 1": a set of limits as the rollback button names it. */
export function limitsLabel(l: ConcurrencyLimits): string {
  return [String(l.max_sessions), ...Object.entries(l.runner_limits).map(([k, v]) => `${k} ${v}`)].join(' / ');
}
