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

/** Whether a reading trips the guard: a rejected window, a warning (with `on_warning`), or utilization at the threshold. */
export function usageGuardTrips(cfg: UsageGuardSettings, s: RateLimitSnapshot | undefined): boolean {
  if (!cfg.enabled || !s) return false;
  return s.status === 'rejected' || (cfg.on_warning && s.status === 'allowed_warning') || (s.utilization !== undefined && s.utilization >= cfg.threshold);
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
