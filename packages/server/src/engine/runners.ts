import type { OpenJob, RunnerInfo, RunnerReport } from './ports.ts';

/** Labels every self-hosted runner of a kind carries: they name no machine, so a row is kept for the rest. */
const GENERIC = new Set(['self-hosted', 'linux', 'macos', 'windows', 'x64', 'arm', 'arm64']);
const specific = (labels: string[]): string[] => labels.filter((l) => !GENERIC.has(l.toLowerCase()));
/** The name a job's `runs-on` goes by: its labels that name a machine, else all of them. */
export const labelOf = (labels: string[]): string => (specific(labels).length ? specific(labels) : labels).join(' + ') || '(none)';
/** The runners that can take a job: those carrying every label it asks for. */
const eligible = (report: RunnerReport, labels: string[]): RunnerInfo[] => report.runners.filter((r) => labels.every((l) => r.labels.some((x) => x.toLowerCase() === l.toLowerCase())));

export interface LabelRow { label: string; runners: number; online: number; busy: number; idle: number; queued: number; running: number }
/** One row per label the runners carry or the open jobs ask for (#216). */
export function labelRows(report: RunnerReport): LabelRow[] {
  const labels = new Map<string, string[]>();
  for (const j of report.jobs) labels.set(labelOf(j.labels), j.labels);
  for (const r of report.runners) for (const l of specific(r.labels)) if (!labels.has(l)) labels.set(l, [l]);
  return [...labels].map(([label, ls]) => {
    const rs = eligible(report, ls);
    const jobs = report.jobs.filter((j) => labelOf(j.labels) === label);
    return { label, runners: rs.length, online: rs.filter((r) => r.online).length, busy: rs.filter((r) => r.online && r.busy).length, idle: rs.filter((r) => r.online && !r.busy).length, queued: jobs.filter((j) => j.status === 'queued').length, running: jobs.filter((j) => j.status === 'in_progress').length };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/** What the runner_status / runners_busy tools answer: online, busy and queued per label, as of the reading. */
export function runnerStatusText(report: RunnerReport, repo: string, at: string): string {
  const rows = labelRows(report);
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const lines = rows.map((r) => r.runners
    ? `${r.label}: ${n(r.runners, 'runner')}, ${r.online} online${r.runners > r.online ? ` (${r.runners - r.online} offline)` : ''}, ${r.busy} busy, ${r.idle} idle; ${n(r.queued, 'job')} queued, ${r.running} running${r.online === 0 ? ' — OFFLINE' : r.idle === 0 && r.queued > 0 ? ' — no idle runner' : ''}`
    : `${r.label}: GitHub-hosted (no self-hosted runner carries it); ${n(r.queued, 'job')} queued, ${r.running} running`);
  return [`CI runners for ${repo}, read ${at} (cached up to 30 s):`, ...(lines.length ? lines : ['no self-hosted runners are registered and no CI job is open (GitHub-hosted runners are not listed)'])].join('\n');
}

/** Why an item's CI run waits on a runner that is not coming (#216): an open job whose runners are all offline or busy. */
export interface RunnerStall { label: string; labels: string[]; run_id: number; queued: boolean }
/**
 * The run's open jobs, judged against the runners that could take them: a queued job no online runner is idle for, or a
 * running job whose runner went offline. A job no self-hosted runner can take (GitHub-hosted) is never judged.
 */
export function stallOf(report: RunnerReport, runId: number): RunnerStall | undefined {
  for (const j of report.jobs.filter((x) => x.runId === runId)) {
    const rs = eligible(report, j.labels);
    if (!rs.length) continue;
    const stuck = j.status === 'queued' ? !rs.some((r) => r.online && !r.busy) : Boolean(j.runner && rs.find((r) => r.name === j.runner)?.online === false);
    if (stuck) return { label: labelOf(j.labels), labels: j.labels, run_id: runId, queued: j.status === 'queued' };
  }
  return undefined;
}

/**
 * A runner for the label is back: one is online and idle, or one is running a job of a run that waited on it. A run
 * missing from the report is no evidence (the report reads a capped number of runs).
 */
export function recovered(report: RunnerReport, stalls: RunnerStall[]): boolean {
  const labels = stalls[0]?.labels ?? [];
  if (eligible(report, labels).some((r) => r.online && !r.busy)) return true;
  return stalls.some((s) => report.jobs.some((j: OpenJob) => j.runId === s.run_id && j.status === 'in_progress' && labelOf(j.labels) === s.label));
}
