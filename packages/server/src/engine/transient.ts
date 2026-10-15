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
 * Codex's apply_patch refusing a patch with several operations on one file (#344): the model's habit, not the turn's
 * fault, and the same thread carries on once told. Codex still ends the whole turn on it, so it is retried once like a
 * quiet failure even though the turn did things first.
 */
export const PATCH_REJECTED = /multiple operations target/i;

/** What the retry of a rejected patch says to the session (#344). */
export const PATCH_REJECTED_RETRY = 'Your last apply_patch was rejected because several of its operations targeted the same file, and that ended the turn. Write each file in one operation: rewrite a small JSON or manifest file whole rather than patching it several times.';

/** A turn Codex ended over a rejected patch (#344), with no report, question or park of its own. */
export function patchRejected(r: TurnResult): boolean {
  return r.isError && !NEVER.has(r.subtype) && !(r.done || r.planSubmitted || r.blocked || r.parked || r.undelivered) && PATCH_REJECTED.test(`${r.error ?? ''}\n${r.text}`);
}

/**
 * A failed turn that produced nothing (#241): no message, no tool call, no file change, no report, no park. Only this
 * kind is retried by itself, once; what decides is the output, not the subtype alone (an app-server overload arrives
 * as `runner_error`, a dropped connection as `connection_lost`).
 */
export function quietTransientFailure(r: TurnResult): boolean {
  if (patchRejected(r)) return true;
  if (!r.isError || NEVER.has(r.subtype)) return false;
  if (r.acted || saidAnything(r.text) || r.done || r.planSubmitted || r.blocked || r.parked || r.undelivered || r.toolFailures?.length) return false;
  const said = `${r.error ?? ''} ${r.usageLimit?.message ?? ''}`;
  return !QUOTA.test(said) && !CLIENT_ERROR.test(said);
}
