/**
 * The usage guard: a subscription's rate-limit windows, as the Agent SDK reports them on every
 * turn (`rate_limit_event`), and the rule that pauses automation before a window runs out.
 */
export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** The latest rate-limit reading a turn saw: its window, how full it is (0..1) and when it resets (ISO). */
export interface RateLimitSnapshot { status: RateLimitStatus; window: string; utilization?: number; resetsAt?: string }

export interface UsageGuardSettings { enabled: boolean; threshold: number; on_warning: boolean; auto_resume: boolean }

const SEVERITY: Record<RateLimitStatus, number> = { allowed: 0, allowed_warning: 1, rejected: 2 };

/** The more pressing of two readings: a worse status first, then the fuller window. */
export function worseRateLimit(a: RateLimitSnapshot | undefined, b: RateLimitSnapshot): RateLimitSnapshot {
  if (!a) return b;
  if (SEVERITY[b.status] !== SEVERITY[a.status]) return SEVERITY[b.status] > SEVERITY[a.status] ? b : a;
  return (b.utilization ?? -1) >= (a.utilization ?? -1) ? b : a;
}

/**
 * A reading this close to its window's reset does not trip the guard (#579): the window is about to refill, so a pause
 * would protect nothing and, with `auto_resume` off, would hold the provider until someone came back to retry it.
 * A `rejected` reading still trips: that window is spent, and turns would fail until it resets.
 */
export const USAGE_GUARD_RESET_MARGIN_MS = 10 * 60_000;

/** Whether a reading's window resets within the margin (or already has: a stale reading). False when it names no reset. */
export function resetsWithinMargin(s: RateLimitSnapshot, now = Date.now()): boolean {
  const at = s.resetsAt ? Date.parse(s.resetsAt) : NaN;
  return Number.isFinite(at) && at - now < USAGE_GUARD_RESET_MARGIN_MS;
}

/**
 * Whether a reading trips the guard: a rejected window, or a warning (with `on_warning`) or utilization at the threshold
 * on a window that is not about to reset (`USAGE_GUARD_RESET_MARGIN_MS`).
 */
export function usageGuardTrips(cfg: UsageGuardSettings, s: RateLimitSnapshot | undefined, now = Date.now()): boolean {
  if (!cfg.enabled || !s) return false;
  if (s.status === 'rejected') return true;
  if (resetsWithinMargin(s, now)) return false;
  return (cfg.on_warning && s.status === 'allowed_warning') || (s.utilization !== undefined && s.utilization >= cfg.threshold);
}

const WINDOW_LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day Opus', seven_day_sonnet: '7-day Sonnet', seven_day_overage_included: '7-day', overage: 'overage' };
/** `five_hour` → `5-hour`, for people. */
export function usageWindowLabel(window: string): string { return WINDOW_LABELS[window] ?? window.replace(/_/g, ' '); }

/** `87%`, or undefined when the provider gave no utilization. */
export function usagePercent(utilization: number | undefined): string | undefined { return utilization === undefined ? undefined : `${Math.round(utilization * 100)}%`; }

/** `6:20 pm` in local time (with the weekday when it is not today). */
export function localClock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

/** A provider guard as it is stored (`UsageGuardState`), read here without the schema so the web can use it. */
export interface ProviderGuard { window: string; status: RateLimitStatus; utilization?: number; resets_at?: string; tripped_at?: string; resume_at?: string }

/** `claude` → `Claude`, `codex` → `Codex`, a named account's guard (`claude:work`, #242) → `Claude (work)`. */
export function guardProviderLabel(key: string): string {
  const at = key.indexOf(':');
  const runner = at > 0 ? key.slice(0, at) : key;
  const name = runner === 'codex' ? 'Codex' : runner === 'claude' ? 'Claude' : runner;
  return at > 0 ? `${name} (${key.slice(at + 1)})` : name;
}

/** The window the guard paused for has reset. A guard with no reset time never says so. */
export function guardWindowReset(g: ProviderGuard, now = Date.now()): boolean {
  const at = g.resets_at ? Date.parse(g.resets_at) : NaN;
  return Number.isFinite(at) && at <= now;
}

/** Whether planestro will lift this guard by itself (`usage_guard.auto_resume`, and a resume time recorded at the trip). */
export function guardResumesItself(g: ProviderGuard, cfg: Pick<UsageGuardSettings, 'auto_resume'>): boolean {
  return cfg.auto_resume && Boolean(g.resume_at) && Number.isFinite(Date.parse(g.resume_at!));
}

/** The guard waits on the user (#579): its window has reset and nothing will resume the provider but a retry by hand. */
export function guardNeedsYou(g: ProviderGuard, cfg: Pick<UsageGuardSettings, 'auto_resume'>, now = Date.now()): boolean {
  return guardWindowReset(g, now) && !guardResumesItself(g, cfg);
}

/** How many provider guards wait on the user: counted beside the items in "Needs you". */
export function guardsNeedingYou(guards: Record<string, ProviderGuard> | undefined, cfg: Pick<UsageGuardSettings, 'auto_resume'>, now = Date.now()): string[] {
  return Object.entries(guards ?? {}).filter(([, g]) => guardNeedsYou(g, cfg, now)).map(([key]) => key);
}

/**
 * A provider guard in words, for the top bar, the status menu and the operator MCP: what is paused and why, and what
 * ends it. Once the window has reset and a retry by hand is needed, it says that instead of the reading.
 */
export function guardSays(key: string, g: ProviderGuard, cfg: Pick<UsageGuardSettings, 'auto_resume'>, now = Date.now()): string {
  const who = guardProviderLabel(key);
  const retry = `Retry ${who}`;
  const auto = guardResumesItself(g, cfg);
  const clock = (iso: string) => localClock(iso, new Date(now));
  if (guardWindowReset(g, now)) return auto ? `${who} usage window has reset · resumes by itself at ${clock(g.resume_at!)}` : `${who} usage window has reset · nothing new starts on ${who} until you press ${retry}`;
  const pct = usagePercent(g.utilization);
  const why = pct ? `${usageWindowLabel(g.window)} window at ${pct}` : `${usageWindowLabel(g.window)} window ${g.status === 'rejected' ? 'used up' : 'near its limit'}`;
  const until = auto ? `resumes by itself at ${clock(g.resume_at!)}` : g.resets_at ? `the window resets at ${clock(g.resets_at)}, then press ${retry}` : `nothing new starts on ${who} until you press ${retry}`;
  return `${who} paused for usage (${why}) · ${until}`;
}
