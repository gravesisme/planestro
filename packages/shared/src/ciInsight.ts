import type { JournalEntry } from './events.ts';

// ---- CI breakdown and aggregates (#181, #182): read from what a CI wait already recorded (#179), never a new poll ----

/**
 * One attempt of a CI run, timed as GitHub reports it (#179): when the run was created, when this attempt was queued
 * (`run_started_at`), when it ended, and each job as GitHub names it, with no interpretation. `runner` is set only on
 * a job a runner took, so a job that never left the queue has no start that counts.
 */
export interface CiJobTiming { name: string; status?: string; conclusion?: string; created_at?: string; started_at?: string; completed_at?: string; runner?: string }
export interface CiAttemptTiming { attempt: number; status?: string; conclusion?: string; created_at?: string; queued_at?: string; first_job_started_at?: string; completed_at?: string; jobs: CiJobTiming[] }
/** What a CI wait leaves on the item (`op_data.ci_timing`) and on its `op.end` (`timing`). */
export interface CiTiming { run_id: number; attempt: number; head?: string; url?: string; attempts: CiAttemptTiming[]; reruns: { reason: string; by: string; attempt?: number; check?: string }[] }

const ms = (from?: string, to?: string): number | undefined => {
  if (!from || !to) return undefined;
  const d = Date.parse(to) - Date.parse(from);
  return Number.isFinite(d) && d >= 0 ? d : undefined;
};

/**
 * Queued: this attempt's start (`queued_at`; a re-run keeps the run's `created_at`, so that would count the first attempt
 * too) until a runner started its first job. Running: from that start until the attempt completed.
 */
export function attemptDurations(a: CiAttemptTiming): { queued_ms?: number; running_ms?: number } {
  return { queued_ms: ms(a.queued_at ?? a.created_at, a.first_job_started_at), running_ms: ms(a.first_job_started_at, a.completed_at) };
}

export interface CiJobBreakdown { name: string; ms?: number; conclusion?: string; status?: string; runner?: string }
export interface CiAttemptBreakdown { attempt: number; conclusion?: string; status?: string; queued_ms?: number; running_ms?: number; jobs: CiJobBreakdown[] }
export interface CiBreakdown { run_id: number; url?: string; head?: string; attempt: number; reruns: number; rerun_reasons: string[]; latest?: CiAttemptBreakdown; attempts: CiAttemptBreakdown[] }

/** An item's CI at a glance (#181): the latest attempt's queue, run and jobs by GitHub's names, and its re-runs. */
export function ciBreakdown(raw: unknown): CiBreakdown | undefined {
  const t = raw as Partial<CiTiming> | undefined;
  if (!t || typeof t.run_id !== 'number' || !Array.isArray(t.attempts)) return undefined;
  const attempts = [...t.attempts].sort((a, b) => a.attempt - b.attempt).map((a): CiAttemptBreakdown => ({
    attempt: a.attempt, ...(a.conclusion ? { conclusion: a.conclusion } : {}), ...(a.status ? { status: a.status } : {}), ...attemptDurations(a),
    jobs: (a.jobs ?? []).map((j) => ({ name: j.name, ...(j.runner ? { ms: ms(j.started_at, j.completed_at) } : {}), ...(j.conclusion ? { conclusion: j.conclusion } : {}), ...(j.status ? { status: j.status } : {}), ...(j.runner ? { runner: j.runner } : {}) })),
  }));
  const attempt = t.attempt ?? attempts.at(-1)?.attempt ?? 1;
  const reasons = (t.reruns ?? []).map((r) => (r.by && r.by !== 'app' ? `${r.reason} (${r.by})` : r.reason));
  return { run_id: t.run_id, ...(t.url ? { url: t.url } : {}), ...(t.head ? { head: t.head } : {}), attempt, reruns: Math.max(attempt - 1, reasons.length), rerun_reasons: reasons, latest: attempts.at(-1), attempts };
}

/** 1m 05s, 42s, 1h 03m: a CI duration as a person reads it. */
export function formatCiDuration(n: number | undefined): string {
  if (n === undefined) return '–';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Nearest-rank percentile of a list (undefined when empty). */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface CiDay { day: string; waits: number; runs: number; reruns: number }
export interface CiSpread { p50?: number; p90?: number; n: number }
export interface CiAggregates { days: CiDay[]; queue: CiSpread; run: CiSpread; totals: { waits: number; runs: number; reruns: number } }

/** The journal types `ciAggregates` reads. */
export const CI_INSIGHT_TYPES = ['op.begin', 'op.end'] as const;

/**
 * CI over a window of days (#182): waits per day (a `ci_wait` op begun), attempts timed per day and the re-runs among them,
 * and p50/p90 of queue and run time. An attempt is counted once, on the day the first wait that saw it ended: a wait after
 * a re-run records the earlier attempts again. Days are the journal's own (local) days, as the Usage page's are.
 */
export function ciAggregates(entries: JournalEntry[], opts: { days: number; today: string }): CiAggregates {
  const days: CiDay[] = [];
  const base = new Date(`${opts.today}T12:00:00Z`);
  for (let i = opts.days - 1; i >= 0; i--) days.push({ day: new Date(base.getTime() - i * 86_400_000).toISOString().slice(0, 10), waits: 0, runs: 0, reruns: 0 });
  const byDay = new Map(days.map((d) => [d.day, d]));
  const seen = new Set<string>();
  const queued: number[] = [], running: number[] = [];
  for (const e of [...entries].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const d = byDay.get(e.ts.slice(0, 10));
    if (!d) continue;
    if (e.type === 'op.begin' && e.data?.op === 'ci_wait') { d.waits++; continue; }
    const t = e.type === 'op.end' ? (e.data?.timing as Partial<CiTiming> | undefined) : undefined;
    if (!t || typeof t.run_id !== 'number' || !Array.isArray(t.attempts)) continue;
    for (const a of t.attempts) {
      const key = `${t.run_id}:${a.attempt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      d.runs++;
      if (a.attempt > 1) d.reruns++;
      const { queued_ms, running_ms } = attemptDurations(a);
      if (queued_ms !== undefined) queued.push(queued_ms);
      if (running_ms !== undefined) running.push(running_ms);
    }
  }
  const spread = (v: number[]): CiSpread => ({ ...(v.length ? { p50: percentile(v, 50), p90: percentile(v, 90) } : {}), n: v.length });
  const sum = (k: 'waits' | 'runs' | 'reruns') => days.reduce((n, d) => n + d[k], 0);
  return { days, queue: spread(queued), run: spread(running), totals: { waits: sum('waits'), runs: sum('runs'), reruns: sum('reruns') } };
}
