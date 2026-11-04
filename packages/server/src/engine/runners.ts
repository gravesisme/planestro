import type { OpenJob, RunnerInfo, RunnerReport } from './ports.ts';

/** Labels every self-hosted runner of a kind carries: they name no machine, so a row is kept for the rest. */
const GENERIC = new Set(['self-hosted', 'linux', 'macos', 'windows', 'x64', 'arm', 'arm64']);
const specific = (labels: string[]): string[] => labels.filter((l) => !GENERIC.has(l.toLowerCase()));
/** The name a job's `runs-on` goes by: its labels that name a machine, else all of them. */
export const labelOf = (labels: string[]): string => (specific(labels).length ? specific(labels) : labels).join(' + ') || '(none)';
/** The runners that can take a job: those carrying every label it asks for. */
const eligible = (report: RunnerReport, labels: string[]): RunnerInfo[] => report.runners.filter((r) => labels.every((l) => r.labels.some((x) => x.toLowerCase() === l.toLowerCase())));

/** Every label the runners carry or the open jobs ask for, by its name, with the labels a runner needs for it. */
function labelsIn(report: RunnerReport): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const j of report.jobs) labels.set(labelOf(j.labels), j.labels);
  for (const r of report.runners) for (const l of specific(r.labels)) if (!labels.has(l)) labels.set(l, [l]);
  return labels;
}

export interface LabelRow { label: string; runners: number; online: number; busy: number; idle: number; queued: number; running: number }
/** One row per label the runners carry or the open jobs ask for (#216). */
export function labelRows(report: RunnerReport): LabelRow[] {
  return [...labelsIn(report)].map(([label, ls]) => {
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

/**
 * Why an item's CI run waits on a runner that is not coming (#216): its runners are offline, or (#519) every one is busy and
 * no job has started or finished on the label for `quiet_min`. A busy label whose jobs move is a queue, never a stall.
 * A marker persisted before #519 has no `why`.
 */
export interface RunnerStall { label: string; labels: string[]; run_id: number; queued: boolean; why?: 'offline' | 'quiet'; quiet_min?: number }
/** How a stall is said, in the banner, the Activity and the wake. */
export function stallWords(s: Pick<RunnerStall, 'label' | 'why' | 'quiet_min'>): string {
  return s.why === 'offline' ? `runner ${s.label} is offline`
    : s.why === 'quiet' ? `runner ${s.label} looks stalled: every runner is busy and no job has started or finished on it for ${Math.round(s.quiet_min ?? 0)} min`
    : `runner ${s.label} looks stalled or offline`;
}

/**
 * When a job last started or finished on each label, as planestro has watched it (#519). A reading's signature for a
 * label is its runners' online/busy state and its in-progress jobs; a change is progress. Kept in memory: after a restart
 * a busy label is watched afresh, so it is called stalled later, never sooner.
 */
export class LabelProgress {
  private seen = new Map<string, { sig: string; since: number }>();
  observe(report: RunnerReport, now: number): void {
    for (const [label, ls] of labelsIn(report)) {
      const sig = [
        ...eligible(report, ls).map((r) => `${r.name}:${r.online ? 'on' : 'off'}:${r.busy ? 'busy' : 'idle'}`),
        ...report.jobs.filter((j) => j.status === 'in_progress' && labelOf(j.labels) === label).map((j) => `${j.runId}@${j.runner ?? ''}`),
      ].sort().join(',');
      const had = this.seen.get(label);
      if (had?.sig !== sig) this.seen.set(label, { sig, since: now });
    }
  }
  /** Minutes since anything moved on the label; 0 for one never watched. */
  quietMin(label: string, now: number): number { const s = this.seen.get(label); return s ? Math.max(0, now - s.since) / 60_000 : 0; }
}

/** How quiet a label is (minutes), and how long it may be with every runner busy before it is a stall. Unset: never. */
export interface Quiet { quietMin(label: string): number; windowMin: number }

/**
 * The run's open jobs, judged against the runners that could take them: a queued job no runner is online for, or one every
 * online runner is busy for while the label is quiet past the window; or a running job whose runner went offline. A job
 * no self-hosted runner can take (GitHub-hosted) is never judged.
 */
export function stallOf(report: RunnerReport, runId: number, quiet?: Quiet): RunnerStall | undefined {
  for (const j of report.jobs.filter((x) => x.runId === runId)) {
    const rs = eligible(report, j.labels);
    if (!rs.length) continue;
    const label = labelOf(j.labels);
    const stall = { label, labels: j.labels, run_id: runId, queued: j.status === 'queued' };
    if (j.status !== 'queued') { if (j.runner && rs.find((r) => r.name === j.runner)?.online === false) return { ...stall, why: 'offline' }; continue; }
    if (!rs.some((r) => r.online)) return { ...stall, why: 'offline' };
    const q = quiet?.quietMin(label) ?? 0;
    if (quiet && !rs.some((r) => r.online && !r.busy) && q >= quiet.windowMin) return { ...stall, why: 'quiet', quiet_min: q };
  }
  return undefined;
}

/**
 * A runner for the label is back: one is online and idle, one is running a job of a run that waited on it, or (#519) one
 * is online and the label has moved within the window. A run missing from the report is no evidence (the report reads a
 * capped number of runs).
 */
export function recovered(report: RunnerReport, stalls: RunnerStall[], quiet?: Quiet): boolean {
  const labels = stalls[0]?.labels ?? [];
  const rs = eligible(report, labels);
  if (rs.some((r) => r.online && !r.busy)) return true;
  if (quiet && stalls[0] && rs.some((r) => r.online) && quiet.quietMin(stalls[0].label) < quiet.windowMin) return true;
  return stalls.some((s) => report.jobs.some((j: OpenJob) => j.runId === s.run_id && j.status === 'in_progress' && labelOf(j.labels) === s.label));
}
