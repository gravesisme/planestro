import type { TurnResult } from './ports.ts';

/** Failures a retry cannot fix: a person logs in, a usage window resets, a cap is raised, a CLI is installed, a conversation is gone. */
const NEVER = new Set(['auth_required', 'usage_exhausted', 'token_cap', 'error_max_budget_usd', 'error_max_turns', 'cli_too_old', 'spawn_error', 'session_lost']);
/** Exhausted quota said in words (Codex's rate_limited covers both), or a full disk (#161): neither comes back in seconds. */
const QUOTA = /usage limit|quota|billing|credit balance|\bENOSPC\b|No space left on device/i;
/** A 4xx other than a timeout or a rate limit is the request's own fault: the same request fails the same way. */
const CLIENT_ERROR = /\b(?:API Error:?|status(?: code)?:?|HTTP(?:\/[\d.]+)?)\s*4(?!08|29)\d\d\b/i;

/** Text other than an API error the CLI printed in the model's place. */
const saidAnything = (text: string): boolean => text.split('\n').some((l) => l.trim() && !/^API Error: \d{3}\b/.test(l.trim()));

/**
 * A failed turn that produced nothing (#241): no message, no tool call, no file change, no report, no park. Only this
 * kind is retried by itself, once; what decides is the output, not the subtype alone (an app-server overload arrives
 * as `runner_error`, a dropped connection as `connection_lost`).
 */
export function quietTransientFailure(r: TurnResult): boolean {
  if (!r.isError || NEVER.has(r.subtype)) return false;
  if (r.acted || saidAnything(r.text) || r.done || r.planSubmitted || r.blocked || r.parked || r.undelivered || r.toolFailures?.length) return false;
  const said = `${r.error ?? ''} ${r.usageLimit?.message ?? ''}`;
  return !QUOTA.test(said) && !CLIENT_ERROR.test(said);
}
