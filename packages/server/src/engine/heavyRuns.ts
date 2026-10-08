import type { Config } from '@planestro/shared';
import type { RunnerReport } from './ports.ts';
import type { PermissionRedirect } from '@planestro/shared';

// ---- heavy local runs (#218) ----
// HH-432's boss checks lost to the watchdog on the Mac runner while two workers ran stress batches on the same
// machine: each checked the runners once, at the start, and a CI job that began mid-batch competed with both.
// A worker's run_heavy runs its command through planestro: one heavy run at a time, and before each batch a wait
// while a CI job runs on a runner label that shares this host. Waiting on a lock or a CI job is not waiting on a person.

/** One heavy run at a time, first come first served; a waiter whose turn is stopped leaves the queue. */
export class HeavyLock {
  holder?: string;
  private readonly waiters: { owner: string; go: () => void }[] = [];
  /** Resolves with the release once `owner` holds the lock, or with undefined when `signal` aborts first. */
  acquire(owner: string, signal?: AbortSignal): Promise<(() => void) | undefined> {
    const release = () => { this.holder = this.waiters[0]?.owner; this.waiters.shift()?.go(); };
    if (this.holder === undefined) { this.holder = owner; return Promise.resolve(release); }
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const w = { owner, go: () => { signal?.removeEventListener('abort', leave); resolve(release); } };
      const leave = () => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); resolve(undefined); } };
      this.waiters.push(w);
      signal?.addEventListener('abort', leave, { once: true });
    });
  }
}

const has = (labels: string[], shared: string[]) => labels.some((l) => shared.some((s) => s.toLowerCase() === l.toLowerCase()));

/**
 * What a heavy run yields to on the runner labels that share this host: a job running on one, a busy runner carrying
 * one, a job queued for one that an online runner there will take. A queued job no online runner can take never ends
 * the wait by starting, so it is not waited on. Empty: nothing to yield to.
 */
export function ciOnSharedHost(report: RunnerReport, shared: string[]): string[] {
  if (!shared.length) return [];
  const out: string[] = [];
  const online = report.runners.filter((r) => r.online && has(r.labels, shared));
  for (const j of report.jobs) {
    if (!has(j.labels, shared)) continue;
    if (j.status === 'in_progress') out.push(`run ${j.runId} running${j.runner ? ` on ${j.runner}` : ''}`);
    else if (online.some((r) => j.labels.every((l) => r.labels.some((x) => x.toLowerCase() === l.toLowerCase())))) out.push(`run ${j.runId} queued`);
  }
  for (const r of online) if (r.busy && !report.jobs.some((j) => j.runner === r.name)) out.push(`runner ${r.name} busy`);
  return out;
}

export const HEAVY_REDIRECT = "This is a heavy local run: run it through planestro's run_heavy tool, which runs one heavy run at a time on this machine and waits while CI runs on a runner that shares it";

/** The project's heavy-command patterns as redirects to run_heavy: a Bash call that matches one is refused with the way to run it. */
export function heavyRedirects(config: Config): PermissionRedirect[] {
  const h = config.heavy_runs;
  return h.enabled ? h.patterns.map((p) => ({ rule: /^Bash\(.*\)$/.test(p.trim()) ? p.trim() : `Bash(${p.trim()} *)`, message: HEAVY_REDIRECT })) : [];
}

/** The same patterns as allow rules: what run_heavy runs besides what the allow rules already permit. */
export function heavyAllowRules(config: Config): string[] {
  return heavyRedirects(config).map((r) => r.rule);
}

/** `3m 12s`, `45s`, `under a second`. */
export function took(ms: number): string {
  if (ms < 1000) return 'under a second';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
