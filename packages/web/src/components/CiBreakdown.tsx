import type { ItemFrontmatter } from '@planestro/shared/view';
import { ciBreakdown, formatCiDuration as dur } from '@planestro/shared/view';

// ---- an item's CI at a glance (#181): queued, running, each job by GitHub's own name, re-runs ----
// Read from what the last CI wait recorded (`op_data.ci_timing`, #179); nothing here asks GitHub again.

const tone = (c?: string) => (c === 'success' ? 'ok' : c === 'failure' || c === 'timed_out' ? 'hot' : c === 'cancelled' ? 'wait' : '');

/** The card's one-line summary, with every job in its title. Shown only while a run's timing is known. */
export function CiCardTag({ fm }: { fm: ItemFrontmatter }) {
  const b = ciBreakdown(fm.op_data?.ci_timing);
  const a = b?.latest;
  if (!b || !a || (a.queued_ms === undefined && a.running_ms === undefined)) return null;
  const jobs = a.jobs.map((j) => `${j.name}: ${j.ms !== undefined ? dur(j.ms) : j.status ?? 'not started'}${j.conclusion ? ` (${j.conclusion})` : ''}`).join('\n');
  const title = `CI run ${b.run_id}, attempt ${b.attempt}: queued ${dur(a.queued_ms)}, running ${dur(a.running_ms)}${b.reruns ? `; re-run ${b.reruns}× (${b.rerun_reasons.join(', ') || 'by hand'})` : ''}${jobs ? `\n${jobs}` : ''}`;
  return <span className={`tag ${tone(a.conclusion)}`} title={title}>CI {dur(a.queued_ms)} queued · {dur(a.running_ms)}{b.reruns ? ` · ${b.reruns} re-run${b.reruns === 1 ? '' : 's'}` : ''}</span>;
}

/** The item page's breakdown: the latest attempt's queue and run time and its jobs, then the earlier attempts. */
export function CiBreakdownDetail({ fm }: { fm: ItemFrontmatter }) {
  const b = ciBreakdown(fm.op_data?.ci_timing);
  if (!b?.latest) return null;
  const a = b.latest;
  return (
    <div className="ci-breakdown small">
      <div>
        {b.url ? <a href={b.url} target="_blank" rel="noreferrer">run {b.run_id}</a> : <>run {b.run_id}</>}{b.attempt > 1 ? `, attempt ${b.attempt}` : ''}
        {a.conclusion && <> <span className={`tag ${tone(a.conclusion)}`}>{a.conclusion}</span></>}
      </div>
      <div className="muted">queued {dur(a.queued_ms)} · running {dur(a.running_ms)}</div>
      {a.jobs.length > 0 && <ul className="ci-jobs">{a.jobs.map((j, i) => <li key={`${j.name}-${i}`} title={j.runner ? `on ${j.runner}` : 'no runner took it'}><span className="ci-job-name">{j.name}</span> <span className="muted">{j.ms !== undefined ? dur(j.ms) : j.status ?? 'not started'}</span>{j.conclusion && j.conclusion !== 'success' && <> <span className={`tag ${tone(j.conclusion)}`}>{j.conclusion}</span></>}</li>)}</ul>}
      {b.reruns > 0 && <div className="muted">re-run {b.reruns}×{b.rerun_reasons.length ? `: ${b.rerun_reasons.join(', ')}` : ' (by hand on GitHub)'}{b.attempts.length > 1 ? ` · earlier: ${b.attempts.slice(0, -1).map((x) => `#${x.attempt} ${x.conclusion ?? x.status ?? '?'} ${dur(x.running_ms)}`).join(', ')}` : ''}</div>}
    </div>
  );
}
