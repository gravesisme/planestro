import type { Config } from '@planestro/shared';
import type { RunnerReport } from './ports.ts';
import type { PermissionRedirect } from '@planestro/shared';
import { allowedByRules, BASE_ALLOWED, type Policy } from './policy.ts';

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

/**
 * How long one planestro tool call may take on Claude (#502): the in-process server's own timeout, so a run_heavy that
 * waits its turn and runs a 2-hour harness is never cut by an `MCP_TOOL_TIMEOUT` in the environment (the CLI's default
 * is ~28 h; an `sdk` server has no idle timeout). The batches' own limit is `heavy_runs.timeout_min`.
 */
export const PLANESTRO_TOOL_TIMEOUT_MS = 24 * 3_600_000;

/**
 * What a worker hears when its foreground Bash call hit its timeout (#502): Claude Code caps a foreground command at
 * 10 minutes and moves one that runs past it to the background. run_heavy holds a run of any length as one call.
 */
export const LONG_RUN_NOTE = "That command ran past the 10-minute cap on a foreground Bash call and was moved to the background. For a command that runs longer than that (a browser or e2e harness, a long suite), run it with planestro's run_heavy tool instead: it holds one run of any length (up to heavy_runs.timeout_min) as a single call and answers with its exit code and output tail, and it counts as one foreground run. Do not split the run into pieces to fit the cap.";

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

/**
 * What run_heavy makes of one command (#583): `denied` is a deny rule's (or a redirect's, or a built-in refusal's)
 * own words; `unlisted` is a command neither the allow rules nor, with heavy runs on, the heavy patterns cover.
 */
export type HeavyVerdict = { ok: true } | { ok: false; why: 'denied'; reason: string } | { ok: false; why: 'unlisted'; patterns: boolean };

/**
 * Whether run_heavy runs `command`: nothing a deny refuses, and only what the built-in readers, the allow rules or
 * (with `heavy_runs.enabled`) the heavy patterns cover. The one judgment: run_heavy's own call and what the
 * orchestrator is told on a delegated permission request (#583) both read it, so the two cannot drift.
 * `policy` is the item's, built WITHOUT the heavy redirects (they refuse the very commands run_heavy is for).
 */
export function heavyVerdict(command: string, o: { config: Config; policy: Policy; allow: string[]; cwd: string }): HeavyVerdict {
  const req = { tool: 'Bash', input: { command } };
  const reason = o.policy.deny(req);
  if (reason) return { ok: false, why: 'denied', reason };
  if (allowedByRules(req, [...BASE_ALLOWED.implement, ...o.allow, ...heavyAllowRules(o.config)], o.cwd)) return { ok: true };
  return { ok: false, why: 'unlisted', patterns: o.config.heavy_runs.enabled };
}

/** What the worker hears when run_heavy refuses a command, with what it would take for it to run there (#583). Undefined: it runs. */
export function heavyRejection(command: string, v: HeavyVerdict): string | undefined {
  if (v.ok) return undefined;
  if (v.why === 'denied') return `Rejected: ${v.reason} Nothing was run.`;
  const takes = v.patterns
    ? 'It would run here only once the user adds a heavy_runs.patterns entry or an allow rule that covers it'
    : "It would run here only once the user adds an allow rule that covers it (heavy-run turn-taking is off in this project, so heavy_runs.patterns grant nothing)";
  return `Rejected: run_heavy runs only commands your allow rules or the project's heavy_runs.patterns permit, and \`${command.slice(0, 200)}\` is neither. Nothing was run. ${takes}; you cannot add either, and calling run_heavy again with it will be refused the same way. Use a command the rules already cover, or run this one as a plain Bash call, which asks for permission. If it was already denied there, report_blocked and name the command, so the user can add the pattern.`;
}

/**
 * The line a delegated Bash permission request carries (#583): whether run_heavy would take the command as it
 * stands, so a denial never sends the worker to a tool that refuses it too (HH-941).
 */
export function heavyRouteNote(v: HeavyVerdict): string {
  if (v.ok) return "run_heavy: the worker's run_heavy tool would run this command as it stands, as one call of any length. If the only trouble with the request is a long or heavy run made as a plain Bash call, you can deny it and say to run it with run_heavy.";
  const tail = 'Do not send the worker to run_heavy with it: a denial that does leaves the worker with no way to run it.';
  if (v.why === 'denied') return `run_heavy: the worker's run_heavy tool would refuse this command too (${v.reason.replace(/\s+/g, ' ').slice(0, 300)}). ${tail}`;
  const covers = v.patterns ? "the allow rules or the project's heavy-command patterns (heavy_runs.patterns) cover, and this command is neither" : 'the allow rules cover (heavy-command patterns are off in this project), and this command is not';
  return `run_heavy: the worker's run_heavy tool would refuse this command too: it runs only what ${covers}. ${tail} If this is a long or heavy run that belongs there, that takes a new ${v.patterns ? 'pattern or allow rule' : 'allow rule'}, which only the user adds: ask_user and name it, or allow the command this once as it is, or deny it with a route that works.`;
}

/** `3m 12s`, `45s`, `under a second`. */
export function took(ms: number): string {
  if (ms < 1000) return 'under a second';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
